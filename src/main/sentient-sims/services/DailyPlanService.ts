import log from 'electron-log';
import { ApiContext } from './ApiContext';
import { DailyPlan, DailyPlanGoalReview, DailyPlanSource, GoalVerdict } from '../models/DailyPlan';
import { GoalPoolEntry, SimStateEntry } from '../models/SimStateReport';
import { DISCRETIONARY_ACTIONS, DISCRETIONARY_GROUPS, ROMANCE_ACTIONS, isRomanceAge } from '../models/ActionLoadout';
import { AIActionType } from '../models/AIActionType';

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
// Fewer surviving keys than this and the loadout is treated as absent (no filter): a
// parse hiccup must not strip a sim's whole discretionary vocabulary for a day
const MIN_LOADOUT = 3;
const PERSONA_MAX_CHARS = 200;
// A broken provider must not be hammered at report cadence
const PLAN_FAILURE_COOLDOWN_MS = 10 * 60_000;

export type PlannerOutput = {
  goals: GoalPoolEntry[];
  persona?: string;
  loadout?: string[];
};

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
  validate(raw: Record<string, unknown>, pool: GoalPoolEntry[], age?: string): PlannerOutput {
    const poolById = new Map(pool.map((entry) => [entry.id, entry]));
    const goals: GoalPoolEntry[] = [];
    if (Array.isArray(raw.goals)) {
      raw.goals.forEach((goalId) => {
        if (goals.length >= MAX_GOALS || typeof goalId !== 'string') {
          return;
        }
        const entry = poolById.get(goalId.trim());
        if (entry && !goals.some((existing) => existing.id === entry.id)) {
          goals.push(entry);
        }
      });
    }

    const persona =
      typeof raw.persona === 'string' && raw.persona.trim().length > 1
        ? raw.persona.trim().slice(0, PERSONA_MAX_CHARS)
        : undefined;

    let loadout: string[] | undefined;
    if (Array.isArray(raw.loadout)) {
      const keys = raw.loadout
        .filter((key): key is string => typeof key === 'string')
        .map((key) =>
          key
            .trim()
            .toLowerCase()
            .replace(/[\s-]+/g, '_'),
        )
        .filter((key) => DISCRETIONARY_ACTIONS.has(key))
        .filter((key) => !ROMANCE_ACTIONS.has(key) || isRomanceAge(age));
      const deduped = [...new Set(keys)].slice(0, this.ctx.settings.dailyLoadoutSize);
      loadout = deduped.length >= MIN_LOADOUT ? deduped : undefined;
    }

    return { goals, persona, loadout };
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
  buildChoicesBlock(pool: GoalPoolEntry[], includeYesterday?: DailyPlan, age?: string): string {
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
      lines.push(`- id: ${entry.id} — ${entry.label}`);
    });
    const loadoutSize = this.ctx.settings.dailyLoadoutSize;
    lines.push('', `ACTION STYLES you may prepare for the day — pick ${loadoutSize} keys, ONLY from these:`);
    Object.entries(DISCRETIONARY_GROUPS).forEach(([group, keys]) => {
      // A non-adult is never shown the romance group at all — a key the model was never
      // offered is one it cannot pick, which is cheaper than filtering it afterwards
      const offered = isRomanceAge(age) ? keys : keys.filter((key) => !ROMANCE_ACTIONS.has(key));
      if (offered.length > 0) {
        lines.push(`${group}: ${offered.join(', ')}`);
      }
    });
    return lines.join('\n');
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
      const loadoutSize = this.ctx.settings.dailyLoadoutSize;

      const systemPrompt = `You are the inner voice of one Sim in The Sims 4, setting intentions for the rest of today.
Reply with ONLY a JSON object:
{"goals": ["<goal id>"], "persona": "one sentence", "loadout": ["<action key>"]}
- "goals": 1 or 2 ids chosen ONLY from GOAL OPTIONS — what this Sim genuinely cares about finishing today.
- "persona": one short first-person sentence of stage direction — who this Sim wants to be today (their character, not a task).
- "loadout": exactly ${loadoutSize} action keys chosen ONLY from ACTION STYLES — the activities and ways of relating this Sim will reach for today. Match them to the persona and goals.`;

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
        this.buildChoicesBlock(pool, undefined, age),
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
          const validated = this.validate(parsed, pool, age);
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
