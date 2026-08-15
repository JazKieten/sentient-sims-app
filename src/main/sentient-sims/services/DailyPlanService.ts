import log from 'electron-log';
import { ApiContext } from './ApiContext';
import { DailyPlan, DailyPlanGoalReview, DailyPlanSource, GoalVerdict } from '../models/DailyPlan';
import { GoalPoolEntry, SimStateEntry } from '../models/SimStateReport';
import { DISCRETIONARY_ACTIONS, DISCRETIONARY_GROUPS, ROMANCE_ACTIONS, isRomanceAge } from '../models/ActionLoadout';
import { AIActionType } from '../models/AIActionType';
import { describePlanGoal } from '../util/formatCognitionPrompt';

// Each game day a household sim carries a plan: 1-2 goals picked FROM THE GAME'S OWN
// objectives (the mod's goal_pool — aspiration steps, promotion requirements, daily
// tasks, wants), one free-form persona sentence ("who I want to be today"), and a
// discretionary action loadout (D&D spell prep: the day's personality, chosen once,
// filtered mechanically all day). Primary author is the sleep-boundary diary call
// (AIService.runSceneReflection); this service owns validation, persistence, and the
// lazy mid-day fallback for sims that never slept or an app that just restarted.
//
// Everything fails open: no plan, invalid goals, a too-small loadout — all degrade to
// pre-plan behavior, never to a crippled sim.

const MAX_GOALS = 2;
// G-5: keys forced in to serve chosen goals may push the loadout past dailyLoadoutSize
// by this much before the model's own lowest picks are trimmed to make room
const GOAL_COVERAGE_TOLERANCE = 2;
// G-8: a goal carried this many planned days with an 'ignored' verdict is called out;
// one more and it is withheld from the pool for STUCK_GOAL_WITHHOLD_DAYS
const STUCK_GOAL_DAYS = 3;
const STUCK_GOAL_WITHHOLD_DAYS = 2;
// Fewer surviving keys than this and the loadout is treated as absent (no filter): a
// parse hiccup must not strip a sim's whole discretionary vocabulary for a day
const MIN_LOADOUT = 3;
const PERSONA_MAX_CHARS = 200;
// A broken provider must not be hammered at report cadence
const PLAN_FAILURE_COOLDOWN_MS = 10 * 60_000;

// What validate() threw away and why. Silent drops were the reason 6/6 sleep-planner
// rows in the 08-04..08-14 playtest DB carried `goals: []` with nobody able to say
// whether the model never named a goal or named one that failed to bind.
export type PlannerReject = {
  field: 'goals' | 'loadout';
  value: string;
  reason: string;
};

export type PlannerOutput = {
  goals: GoalPoolEntry[];
  persona?: string;
  loadout?: string[];
  rejected?: PlannerReject[];
};

// The social keys the planner may count as lot-served whenever anyone is around
const SOCIAL_KEYS = [
  'chat', 'ask_about_day', 'ask_about_career', 'get_to_know', 'deep_conversation', 'compliment_outfit',
  'gossip', 'apologize', 'tell_joke', 'tell_funny_story', 'hug', 'flirt', 'kiss', 'insult', 'invite_in',
];

// G-6: tolerant goal-id binding. Exact match was silent about the shapes the model
// actually returns: trailing spaces, different case, "id: X", the LABEL instead of the
// id, or the label's leading words. 6/6 sleep rows in the playtest DB had goals: [].
export function bindGoalId(raw: string, pool: GoalPoolEntry[]): GoalPoolEntry | undefined {
  const cleaned = raw.trim().replace(/^id:\s*/i, '').replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!cleaned) {
    return undefined;
  }
  const exact = pool.find((entry) => entry.id === cleaned);
  if (exact) {
    return exact;
  }
  const folded = cleaned.toLowerCase();
  const caseless = pool.find((entry) => entry.id.toLowerCase() === folded);
  if (caseless) {
    return caseless;
  }
  const byLabel = pool.find((entry) => entry.label.trim().toLowerCase() === folded);
  if (byLabel) {
    return byLabel;
  }
  // "id — label" or the label with its source prefix stripped
  const loose = pool.find(
    (entry) =>
      folded.startsWith(entry.id.toLowerCase()) ||
      entry.label.toLowerCase().endsWith(folded) ||
      (folded.length >= 12 && entry.label.toLowerCase().includes(folded)),
  );
  return loose;
}

export function parsePlannerJson(raw: string): Record<string, unknown> | undefined {
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) {
    return undefined;
  }
  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export class DailyPlanService {
  private readonly ctx: ApiContext;

  // Latest plan per sim — repo reads only on day change / restart
  private readonly cache = new Map<string, DailyPlan>();

  private readonly inFlight = new Set<string>();

  private readonly failureCooldownUntil = new Map<string, number>();

  constructor(ctx: ApiContext) {
    this.ctx = ctx;
  }

  // The plan that governs simId today, or undefined (feature off, unknown day, no row).
  // Validity IS the day match: an app restart re-reads the row, a save that never slept
  // has no row and the lazy path fills it.
  activePlan(simId: string, absoluteDay: number | undefined): DailyPlan | undefined {
    if (!simId || absoluteDay === undefined || !this.ctx.settings.dailyGoalsEnabled) {
      return undefined;
    }
    const cached = this.cache.get(simId);
    if (cached && cached.absolute_day === absoluteDay) {
      return cached;
    }
    try {
      const plan = this.ctx.dailyPlanRepository.getPlan(simId, absoluteDay);
      if (plan) {
        this.cache.set(simId, plan);
      }
      return plan;
    } catch (error) {
      // DB not loaded yet — behave as planless rather than erroring the tick
      log.debug(`[DailyPlan] plan lookup failed for sim ${simId}: ${String(error)}`);
      return undefined;
    }
  }

  // Should the lazy planner fire for this sim now? (No plan for today, nothing already
  // generating, and not inside the failure backoff.)
  needsLazyPlan(simId: string, absoluteDay: number | undefined): boolean {
    if (!simId || absoluteDay === undefined || !this.ctx.settings.dailyGoalsEnabled) {
      return false;
    }
    if (this.inFlight.has(simId)) {
      return false;
    }
    if (Date.now() < (this.failureCooldownUntil.get(simId) ?? 0)) {
      return false;
    }
    return this.activePlan(simId, absoluteDay) === undefined;
  }

  // Validate raw planner output against the pool and the discretionary set — the same
  // bind-to-offered philosophy as validateIntent: anything not offered dies silently.
  // `age` gates romance: a non-adult, or a sim whose age we don't know, never keeps a
  // romance key even if the model names one.
  validate(
    raw: Record<string, unknown>,
    pool: GoalPoolEntry[],
    age?: string,
    ageBlocked?: string[],
    simLabel?: string,
  ): PlannerOutput {
    const rejected: PlannerReject[] = [];
    const goals: GoalPoolEntry[] = [];
    if (Array.isArray(raw.goals)) {
      raw.goals.forEach((goalId) => {
        if (goals.length >= MAX_GOALS) {
          rejected.push({ field: 'goals', value: String(goalId), reason: `more than ${MAX_GOALS} goals` });
          return;
        }
        if (typeof goalId !== 'string') {
          rejected.push({ field: 'goals', value: JSON.stringify(goalId), reason: 'goal id is not a string' });
          return;
        }
        const entry = bindGoalId(goalId, pool);
        if (!entry) {
          rejected.push({ field: 'goals', value: goalId, reason: 'id not in the offered goal pool' });
          return;
        }
        if (goals.some((existing) => existing.id === entry.id)) {
          rejected.push({ field: 'goals', value: goalId, reason: 'duplicate goal id' });
          return;
        }
        goals.push(entry);
      });
    } else if (raw.goals !== undefined) {
      rejected.push({ field: 'goals', value: JSON.stringify(raw.goals), reason: 'goals is not an array' });
    }

    // N-5: the persona is read DURING the day it describes; a nightly "Tomorrow, I..."
    // reads as a plan for the day after (observed in every sleep row of the playtest DB)
    const persona =
      typeof raw.persona === 'string' && raw.persona.trim().length > 1
        ? raw.persona
            .trim()
            .replace(/^tomorrow[,:]?\s+(i'll|i'm|i)(?=\s|$)/i, (_match, pronoun: string) => pronoun.charAt(0).toUpperCase() + pronoun.slice(1))
            .replace(/^tomorrow[,:]?\s+/i, '')
            .replace(/^\s+/, '')
            .replace(/^[a-z]/, (letter) => letter.toUpperCase())
            .slice(0, PERSONA_MAX_CHARS)
        : undefined;

    let loadout: string[] | undefined;
    if (Array.isArray(raw.loadout)) {
      const keys: string[] = [];
      raw.loadout.forEach((rawKey) => {
        if (typeof rawKey !== 'string') {
          rejected.push({ field: 'loadout', value: JSON.stringify(rawKey), reason: 'key is not a string' });
          return;
        }
        const key = rawKey
          .trim()
          .toLowerCase()
          .replace(/[\s-]+/g, '_');
        if (!DISCRETIONARY_ACTIONS.has(key)) {
          rejected.push({ field: 'loadout', value: rawKey, reason: 'not a discretionary action key' });
          return;
        }
        if (ROMANCE_ACTIONS.has(key) && !isRomanceAge(age)) {
          rejected.push({ field: 'loadout', value: rawKey, reason: `romance key for age ${age ?? 'unknown'}` });
          return;
        }
        // A prepped verb the sim's age cannot run is a wasted loadout slot for the day
        if ((ageBlocked ?? []).includes(key)) {
          rejected.push({ field: 'loadout', value: rawKey, reason: `the game blocks it for age ${age ?? 'unknown'}` });
          return;
        }
        if (keys.includes(key)) {
          rejected.push({ field: 'loadout', value: rawKey, reason: 'duplicate key' });
          return;
        }
        keys.push(key);
      });
      const size = this.ctx.settings.dailyLoadoutSize;
      keys.slice(size).forEach((key) => {
        rejected.push({ field: 'loadout', value: key, reason: `over the loadout size of ${size}` });
      });
      const deduped = keys.slice(0, size);
      // G-5: the loadout must be able to SERVE the chosen goals. Every discretionary key
      // that serves a chosen goal is force-included (age/romance rules still apply); past
      // size + tolerance the model's own lowest picks that serve no goal are trimmed.
      const serving = new Set<string>();
      goals.forEach((goal) => {
        (goal.action_keys ?? []).forEach((key) => {
          if (
            DISCRETIONARY_ACTIONS.has(key) &&
            (!ROMANCE_ACTIONS.has(key) || isRomanceAge(age)) &&
            !(ageBlocked ?? []).includes(key)
          ) {
            serving.add(key);
          }
        });
      });
      const missing = [...serving].filter((key) => !deduped.includes(key));
      missing.forEach((key) => {
        if (deduped.length < size + GOAL_COVERAGE_TOLERANCE) {
          deduped.push(key);
          return;
        }
        // Trim the last model pick that serves no goal
        for (let index = deduped.length - 1; index >= 0; index -= 1) {
          if (!serving.has(deduped[index])) {
            rejected.push({ field: 'loadout', value: deduped[index], reason: `trimmed to make room for goal-serving key ${key}` });
            deduped.splice(index, 1);
            deduped.push(key);
            return;
          }
        }
      });
      if (missing.length > 0) {
        log.info(`[DailyPlan] ${simLabel ?? 'sim'} loadout force-includes goal-serving keys: ${missing.join(', ')}`);
      }
      if (deduped.length >= MIN_LOADOUT) {
        loadout = deduped;
      } else if (deduped.length > 0) {
        deduped.forEach((key) => {
          rejected.push({ field: 'loadout', value: key, reason: `only ${deduped.length} keys survived (< ${MIN_LOADOUT}); loadout dropped` });
        });
      }
    } else if (raw.loadout !== undefined) {
      rejected.push({ field: 'loadout', value: JSON.stringify(raw.loadout), reason: 'loadout is not an array' });
    }

    if (rejected.length > 0) {
      log.info(
        `[DailyPlan] validate rejected for ${simLabel ?? 'sim'}: ${rejected
          .map((entry) => `${entry.field}:"${entry.value}" (${entry.reason})`)
          .join('; ')} — offered goal ids [${pool.map((entry) => entry.id).join(', ')}]`,
      );
    }
    if (Array.isArray(raw.goals) && raw.goals.length === 0) {
      log.info(`[DailyPlan] validate: ${simLabel ?? 'sim'} planner returned an EMPTY goals array (pool had ${pool.length} ids)`);
    }
    if (raw.goals === undefined) {
      log.info(`[DailyPlan] validate: ${simLabel ?? 'sim'} planner output had NO goals field (pool had ${pool.length} ids)`);
    }

    return { goals, persona, loadout, rejected: rejected.length > 0 ? rejected : undefined };
  }

  // Persist + cache a validated plan. Idempotent per (sim, day): an existing row wins —
  // a second nap re-fires the sleep boundary and must not overwrite the day's plan.
  //
  // The one exception: a sleep plan may replace a lazy/fallback row. A sim who goes to
  // bed after midnight is planning the day they are already in, and the lazy planner has
  // usually just filled that day with the cheap fallback (no diary, no yesterday's goals,
  // no review). The nightly call is strictly better, so it wins — but only once, and
  // never over another sleep plan.
  acceptPlan(
    simId: string,
    absoluteDay: number,
    output: PlannerOutput,
    source: DailyPlanSource,
  ): DailyPlan | undefined {
    const existing = this.activePlan(simId, absoluteDay);
    const upgrading = source === 'sleep' && existing !== undefined && existing.source !== 'sleep';
    if (existing && !upgrading) {
      log.info(`[DailyPlan] sim ${simId} already has a plan for day ${absoluteDay}; keeping it`);
      return existing;
    }
    const plan: DailyPlan = {
      sim_id: simId,
      absolute_day: absoluteDay,
      goals: output.goals,
      persona: output.persona,
      loadout: output.loadout,
      source,
      // savePlan is INSERT OR REPLACE — carry any verdicts already written onto this row
      // rather than dropping them with the old row
      review: existing?.review,
    };
    try {
      this.ctx.dailyPlanRepository.savePlan(plan);
      this.cache.set(simId, plan);
      log.info(
        `[DailyPlan] sim ${simId} day ${absoluteDay} (${source}${
          upgrading ? `, replacing ${existing?.source}` : ''
        }): goals [${plan.goals
          .map((goal) => goal.id)
          .join(', ')}], loadout [${(plan.loadout ?? []).join(', ')}]${plan.persona ? ` — "${plan.persona}"` : ''}`,
      );
      return plan;
    } catch (error) {
      log.warn(`[DailyPlan] failed to persist plan for sim ${simId}`, error);
      return undefined;
    }
  }

  // The nightly review of the day that just ended, graded by the diary call. Verdicts
  // for goal ids that were not in that day's plan are dropped.
  recordReview(simId: string, absoluteDay: number, rawReview: unknown) {
    const plan = this.activePlan(simId, absoluteDay);
    if (!plan || !Array.isArray(rawReview)) {
      return;
    }
    const planGoalIds = new Set(plan.goals.map((goal) => goal.id));
    const verdicts: GoalVerdict[] = ['met', 'partial', 'ignored'];
    const review: DailyPlanGoalReview[] = rawReview
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
      .map((entry) => ({
        id: typeof entry.id === 'string' ? entry.id : '',
        verdict: (typeof entry.verdict === 'string' ? entry.verdict : '') as GoalVerdict,
      }))
      .filter((entry) => planGoalIds.has(entry.id) && verdicts.includes(entry.verdict));
    if (review.length === 0) {
      return;
    }
    try {
      this.ctx.dailyPlanRepository.saveReview(simId, absoluteDay, review);
      const cached = this.cache.get(simId);
      if (cached && cached.absolute_day === absoluteDay) {
        cached.review = review;
      }
      log.info(
        `[DailyPlan] sim ${simId} day ${absoluteDay} reviewed: ${review
          .map((entry) => `${entry.id}=${entry.verdict}`)
          .join(', ')}`,
      );
    } catch (error) {
      log.warn(`[DailyPlan] failed to save review for sim ${simId}`, error);
    }
  }

  // Prompt fragment shared by the sleep and lazy planners: the goal pool (choose by id)
  // and the discretionary action styles (pick the day's loadout).
  buildChoicesBlock(
    pool: GoalPoolEntry[],
    includeYesterday?: DailyPlan,
    age?: string,
    ageBlocked?: string[],
    // G-5: what the current lot can serve (object/lot channels) — annotate, never filter:
    // the plan is for the whole day, and the sim may travel
    lotServes?: Set<string>,
    // G-8: goal id -> consecutive planned days it was 'ignored'
    stuck?: Map<string, number>,
  ): string {
    const lines: string[] = [];
    if (includeYesterday && includeYesterday.goals.length > 0) {
      // Pool-absence is game-verified completion ONLY for durable sources; wants
      // reroll constantly so a vanished want id proves nothing
      const poolIds = new Set(pool.map((entry) => entry.id));
      const yesterdayLines = includeYesterday.goals.map((goal) => {
        const verified = !poolIds.has(goal.id) && (goal.source === 'aspiration' || goal.source === 'promotion');
        return `- ${goal.label}${verified ? ' [the game marks this one complete]' : ''}`;
      });
      lines.push(`Yesterday's goals:`, ...yesterdayLines, '');
    }
    lines.push(`GOAL OPTIONS — choose by id, ONLY from this list:`);
    pool.forEach((entry) => {
      const days = stuck?.get(entry.id) ?? 0;
      if (days > STUCK_GOAL_DAYS && days <= STUCK_GOAL_DAYS + STUCK_GOAL_WITHHOLD_DAYS) {
        // Withheld: carried too long without moving — a break, not a ban
        return;
      }
      const carried =
        days >= STUCK_GOAL_DAYS
          ? ` [carried ${days} days without moving — change approach or choose something else]`
          : '';
      lines.push(`- id: ${entry.id} — ${describePlanGoal(entry)}${carried}`);
    });
    const loadoutSize = this.ctx.settings.dailyLoadoutSize;
    lines.push('', `ACTION STYLES you may prepare for the day — pick ${loadoutSize} keys, ONLY from these:`);
    Object.entries(DISCRETIONARY_GROUPS).forEach(([group, keys]) => {
      // A non-adult is never shown the romance group at all — a key the model was never
      // offered is one it cannot pick, which is cheaper than filtering it afterwards
      const offered = keys
        .filter((key) => isRomanceAge(age) || !ROMANCE_ACTIONS.has(key))
        .filter((key) => !(ageBlocked ?? []).includes(key))
        .map((key) => (lotServes && lotServes.size > 0 && !lotServes.has(key) ? `${key} (not on this lot)` : key));
      if (offered.length > 0) {
        lines.push(`${group}: ${offered.join(', ')}`);
      }
    });
    lines.push(
      '',
      'Your loadout must include at least one key that serves each goal you choose (see [serve it with]); a goal nothing serves is one to skip.',
    );
    return lines.join('\n');
  }

  // G-5: every whitelist key the current lot can serve, from the perception channels
  // (object action_keys, lot verbs, socials when anyone is around). Empty when unknown.
  static lotServedKeys(entry: SimStateEntry | undefined, lotActionKeys?: string[]): Set<string> {
    const keys = new Set<string>();
    (entry?.objects ?? []).forEach((object) => (object.action_keys ?? []).forEach((key) => keys.add(key)));
    (lotActionKeys ?? []).forEach((key) => keys.add(key));
    if ((entry?.sims ?? []).length > 0) {
      SOCIAL_KEYS.forEach((key) => keys.add(key));
    }
    return keys;
  }

  // G-8: goal id -> consecutive planned days (ending yesterday) on which it was 'ignored'.
  // Only aspiration/promotion goals can be stuck: wants reroll.
  stuckGoals(simId: string, todayAbsoluteDay: number): Map<string, number> {
    const counts = new Map<string, number>();
    const stopped = new Set<string>();
    for (let back = 1; back <= STUCK_GOAL_DAYS + STUCK_GOAL_WITHHOLD_DAYS + 1; back += 1) {
      let plan: DailyPlan | undefined;
      try {
        plan = this.ctx.dailyPlanRepository.getPlan(simId, todayAbsoluteDay - back);
      } catch {
        break;
      }
      if (!plan) {
        break;
      }
      const verdicts = new Map((plan.review ?? []).map((entry) => [entry.id, entry.verdict]));
      plan.goals.forEach((goal) => {
        if (stopped.has(goal.id) || (goal.source !== 'aspiration' && goal.source !== 'promotion')) {
          return;
        }
        if (verdicts.get(goal.id) === 'ignored') {
          counts.set(goal.id, (counts.get(goal.id) ?? 0) + 1);
        } else {
          stopped.add(goal.id);
        }
      });
    }
    return counts;
  }

  // Mid-day fallback planner: app restarted, the sim never slept, or the sleep-path
  // plan silently skipped. Fire-and-forget from the tick — the current tick proceeds
  // unfiltered and the NEXT tick picks the plan up.
  async generateLazy(entry: SimStateEntry, absoluteDay: number): Promise<void> {
    const simId = entry.sim_id;
    const pool = entry.self?.goal_pool;
    if (!simId || !pool || pool.length === 0 || !this.needsLazyPlan(simId, absoluteDay)) {
      return;
    }
    this.inFlight.add(simId);
    try {
      const simLabel = entry.sim_name ?? simId;
      const description = this.participantDescription(simId, simLabel);
      const traits = entry.self?.traits ?? [];
      const age = entry.self?.age;
      const ageBlocked = entry.self?.age_blocked;
      const loadoutSize = this.ctx.settings.dailyLoadoutSize;

      const systemPrompt = `You are the inner voice of one Sim in The Sims 4, setting intentions for the rest of today.
Reply with ONLY a JSON object:
{"goals": ["<goal id>"], "loadout": ["<action key>"], "persona": "one sentence"}
- "goals": 1 or 2 ids chosen ONLY from GOAL OPTIONS — what this Sim genuinely cares about finishing today. Prefer goals that list [serve it with] verbs.
- "loadout": exactly ${loadoutSize} action keys chosen ONLY from ACTION STYLES — the activities and ways of relating this Sim will reach for today. It MUST include the verbs that serve the chosen goals.
- "persona": one short first-person sentence of stage direction — who this Sim wants to be today (their character, not a task).`;

      const hourLine =
        entry.self?.needs !== undefined
          ? `Needs right now (-100 to 100): ${Object.entries(entry.self.needs)
              .sort(([, a], [, b]) => a - b)
              .slice(0, 4)
              .map(([need, value]) => `${need} ${value}`)
              .join(', ')}`
          : '';
      const userPrompt = [
        `You are ${simLabel}.`,
        description ? `About you: ${description}` : '',
        traits.length > 0 ? `Traits: ${traits.join(', ')}` : '',
        hourLine,
        '',
        this.buildChoicesBlock(
          pool,
          undefined,
          age,
          ageBlocked,
          DailyPlanService.lotServedKeys(entry, this.ctx.simStateCache?.getReport?.()?.lot?.action_keys),
          this.stuckGoals(simId, absoluteDay),
        ),
      ]
        .filter(Boolean)
        .join('\n');

      let output: PlannerOutput | undefined;
      for (let attempt = 0; attempt < 2 && !output; attempt += 1) {
        const shot = await this.ctx.ai.runOneShot(
          `Daily Plan (lazy): ${simLabel}`,
          systemPrompt,
          userPrompt,
          400,
          undefined,
          AIActionType.DAILY_PLAN,
        );
        const parsed = parsePlannerJson(shot.text);
        if (parsed) {
          const validated = this.validate(parsed, pool, age, ageBlocked, simLabel);
          if (validated.goals.length > 0 || validated.persona || validated.loadout) {
            output = validated;
          }
        }
      }
      if (output) {
        this.acceptPlan(simId, absoluteDay, output, 'lazy');
      } else {
        // Persist an empty placeholder so the lazy path stops re-firing all day —
        // planless behavior is the fallback, not a retry storm
        log.warn(`[DailyPlan] sim ${simId} lazy plan unparseable twice; writing fallback row`);
        this.acceptPlan(simId, absoluteDay, { goals: [] }, 'fallback');
      }
    } catch (error) {
      log.warn(`[DailyPlan] lazy plan generation failed for sim ${simId}`, error);
      this.failureCooldownUntil.set(simId, Date.now() + PLAN_FAILURE_COOLDOWN_MS);
    } finally {
      this.inFlight.delete(simId);
    }
  }

  participantDescription(simId: string, fullName: string): string | undefined {
    try {
      const participant = this.ctx.participantRepository.getParticipant({ id: simId, fullName });
      return participant.description || undefined;
    } catch {
      return undefined;
    }
  }
}
