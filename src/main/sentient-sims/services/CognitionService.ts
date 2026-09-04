import log from 'electron-log';
import { StageId } from '../pipeline/stages';
import { pushdiag } from './ActionDispatcherService';
import { ApiContext } from './ApiContext';
import { SimStateEntry, SimStateReport } from '../models/SimStateReport';
import { CognitionIntent, offeredActions, validateIntent } from '../models/CognitionIntent';
import { offLoadoutActions } from '../models/ActionLoadout';
import { InteractionOutcomeEvent } from '../models/ActionIntent';
import { GradedOutcomeEvent } from './OutcomeVerdictService';
import { AIActionType } from '../models/AIActionType';
import { LLMExchange } from '../models/InteractionEventResult';
import {
  ACTION_CHOICE_SYSTEM_PROMPT,
  ACTION_OPTIONS_SYSTEM_PROMPT,
  ACTION_REVIEW_SYSTEM_PROMPT,
  TICK_MONOLOGUE_SYSTEM_PROMPT,
  TICK_SCORES_SYSTEM_PROMPT,
  buildCognitionUserPrompt,
  parseActionChoice,
  parseActionOptions,
  parseTickScores,
} from '../util/formatCognitionPrompt';

// Per-sim lifecycle. PENDING_OUTCOME is the never-re-push rule made structural: a sim
// with an intent in flight cannot deliberate again until the outcome POST closes it or
// the distance-aware timeout expires (a pushed interaction quietly routing for 45s is
// WORKING — cancel-and-repush resets the walk from zero).
type SimPhase = 'IDLE' | 'DELIBERATING' | 'PENDING_OUTCOME' | 'COOLDOWN';

type SimRuntime = {
  phase: SimPhase;
  cooldownUntil: number;
  // Deliberation timestamps within the last hour (per-sim budget)
  deliberatedAt: number[];
  pendingRequestId?: string;
  pendingTimer?: ReturnType<typeof setTimeout>;
  pendingAction?: string;
  // action key -> suppressed-until timestamp; kept out of the offered vocabulary
  // until the moment passes (see recentlyFailedActions)
  suppressedUntil: Map<string, number>;
  // action key -> backoff-until after the mod's preflight declared the intent
  // unexecutable ('ineligible': broken fix object). The critical-need rule lane ignores
  // suppressedUntil by design but MUST respect this map — retrying an impossible fix at
  // report cadence writes an identical failure memory every 5s (observed live
  // 2026-08-07: use_toilet vs a broken toilet at bladder -100)
  fixIneligibleUntil: Map<string, number>;
  // The last action this service dispatched for the sim — guards against re-dispatching
  // it while the sim is still busy executing it (see the redispatch guard in deliberate)
  lastDispatch?: { action: string; at: number };
  // A directed scene's Reflection scored this sim over threshold: the next eligible tick
  // skips monologue/scores and stages the Action Scene directly
  armedDesire?: { score: number; reason?: string; thought?: string; at: number };
  // G-10: the dispatched intent with its remaining automatic retries (transient causes only)
  pendingIntent?: { intent: CognitionIntent; entry: SimStateEntry; retriesLeft: number };
};

// G-10: outcome causes (mod's ss_failure_reasons) that mean "the moment was wrong, the
// verb is fine" — the only ones an automatic retry may spend itself on. Everything else
// (ineligible, no provider, relationship, age, broken object) is structural: no retry.
const TRANSIENT_OUTCOME_CAUSES = new Set([
  'target_left',
  'target_leaving_lot',
  'sim_left_lot',
  'mixer_stage_timeout',
  'bumped_from_queue',
  'bumped_by_higher_priority',
  'canceled_before_running',
  'could_not_route_or_transition',
  'social_group_dissolved',
  'target_object_changed',
]);
const RETRY_DELAY_MS = 4_000;

// Base allowance for an in-flight intent before the synthetic close; routing distance
// adds ~1s per meter, doubled for margin (the club DJ booth run took ~45s over 50m).
const PENDING_BASE_MS = 90_000;
const MS_PER_METER = 1_000;

// Duration-heavy verbs: the base allowance is a ROUTING budget, and it was being spent
// as an EXECUTION one. Measured live 2026-08-16 over the last 10 pushes of a session:
// normal verbs closed in 0.6-3.3s, long ones in 39-49s, and 3 of 10 sat at exactly the
// 90.3s ceiling and came back 'success late=true ... still running when the app timed
// out'. The work completed every time; only the bookkeeping was wrong — and each of
// those cost a 90s pending window plus a suppression on a verb that WORKS. The hint
// keys off how long the verb runs, not (as the old watch-list entry guessed) whether it
// is an aggregate: clean_up itself finished in 38s that day.
const LONG_RUNNING_ACTIONS = new Set([
  'sleep',
  'nap',
  'watch_tv',
  'read_book',
  'write',
  'write_book',
  'program',
  'browse_web',
  'paint',
  'workout',
  'jog',
  'fish',
  'garden',
  'play_piano',
  'play_guitar',
  'practice_speech',
  'cook_meal',
  'clean_up',
  'listen_to_music',
  'stargaze',
  'play_chess',
  'deep_conversation',
  'chat',
]);
const LONG_RUNNING_PENDING_MS = 240_000;

// How long an action that just failed/was ineligible stays out of a sim's offered
// vocabulary. The world state that made it fail rarely changes within a few ticks, so
// re-offering it immediately produces an identical failure in a loop (observed live: a
// mailbox with no payable bill lured 'pay_bills' retries every tick until fixed).
const FAILED_ACTION_SUPPRESS_MS = 10 * 60_000;

// Benign closes — 'canceled' (engine churn bumped the push off the queue) and pending
// timeouts (the world never answered) — never proved the action is impossible, so they
// sit out only briefly. Observed live: a guest-occupied toilet canceled one use_toilet,
// and the flat 10-minute window locked the ONLY bladder fix out of the vocabulary while
// the model re-picked it every tick.
const BENIGN_CLOSE_SUPPRESS_MS = 90_000;

// A busy sim proposing the SAME action we just dispatched is re-picking, not planning:
// proxy pushes (cook_meal) close as success instantly while the real chain runs, so the
// in-flight guard doesn't catch the repeat — observed live: a second cook_meal queued
// while the first meal was still on the stove. Raw affordance names in activity.running
// don't map cleanly back to whitelist keys, so guard on our own dispatch history instead.
const REDISPATCH_WHILE_BUSY_MS = 2 * 60_000;

// Idle/stand/emotion animations are the game filling dead time, not activity: a sim
// "running" Emotion_Idle is standing around. Treating them as busy blocked legitimate
// dispatches and starved the go-home rule (both observed live).
function isIdleAnimation(name: string): boolean {
  // sit/seating: a PASSIVELY sitting sim is parked, not busy — observed live: she sat
  // in a chair for minutes while every tick logged "busy; not urgent enough to
  // interrupt" (active seated verbs like watch_tv report their own name, not 'sit')
  return /^(idle|stand|sim-stand|emotion_idle|sit|seating)/i.test(name);
}

// Which need each whitelist action addresses (values match the report's needs keys).
// Two uses while a sim is BUSY: a same-need pick is redundant (mid-cook grab_snack is
// double-fixing hunger — observed live), and a different-need pick may only interrupt
// when that need is urgently low (a shower at hygiene 31 canceled the only TV time she'd
// had all day — observed live).
const ACTION_NEED_CATEGORY: Record<string, string> = {
  grab_snack: 'hunger',
  cook_meal: 'hunger',
  sleep: 'energy',
  nap: 'energy',
  take_shower: 'hygiene',
  brush_teeth: 'hygiene',
  use_toilet: 'bladder',
  watch_tv: 'fun',
  read_book: 'fun',
  browse_web: 'fun',
  play_piano: 'fun',
  dance: 'fun',
  chat: 'social',
  go_out: 'social',
};

// A busy sim is only interrupted for a need at least this low (or an emergency intent)
const NEED_URGENT_INTERRUPT = -25;

// Below this a physical need is a mechanical failure in progress (accident, starvation)
// and fixing it is a RULE, not a model decision — observed live: bladder -99 while the
// model kept picking grab_snack at hunger 94 and sitting down
const NEED_CRITICAL = -85;

// need -> the action that fixes it, tried in snapshot-offered order. Energy is absent
// on purpose: passing out is the game's own self-resolving (and dramatically honest)
// failure mode.
const CRITICAL_NEED_FIXES: Record<string, string[]> = {
  bladder: ['use_toilet'],
  hunger: ['grab_snack', 'cook_meal'],
};

const RELEVANT_MEMORY_COUNT = 4;

// How long a scene-armed action desire stays live waiting for its sim to become
// eligible (the conversation to end, the cooldown to pass). Past this, the moment
// has passed — a desire from an hour-old scene should not fire out of nowhere.
const ARMED_DESIRE_TTL_MS = 10 * 60_000;

// A hung provider request (no response, no error) left a runtime in DELIBERATING
// forever and — with maxConcurrent 1 — deadlocked every future tick (observed live:
// total cognition silence after 21:41 while reports kept flowing). No model call may
// outlive this. 15s + one retry: the model answers in 1-3s when healthy, so a hang is
// connection-level and a fresh request usually lands — the original 45s single shot
// froze the whole loop per stall (observed live 4x in one evening).
const LLM_CALL_TIMEOUT_MS = 15_000;
const LLM_RETRIES = 1;

// Verbs that are DONE on success (service hired, bills paid, outing started) — the lot
// keeps offering them until the world catches up (broken sink stays 'broken' until the
// repairman arrives), so success must suppress re-picking just like failure does
// (observed live: hire_repair_service succeeded, re-picked 15s later, 'already hired')
// brush_teeth: quick hygiene ritual whose itch (low hygiene) it barely moves — without
// success-suppression the monologue re-wants it forever (observed live 2026-08-07:
// brushed 4x in 5 minutes, an Action Scene burned per re-pick)
const ONE_SHOT_ACTIONS = new Set(['hire_repair_service', 'pay_bills', 'call_firefighter', 'go_out', 'brush_teeth']);

// Below this energy, go_out leaves the vocabulary entirely: sleep first, party later.
// Without it the wrecked-rule and the social drive ping-ponged her home->bar->home
// (observed live: home for 17 seconds between trips)
const TOO_TIRED_TO_GO_OUT = -40;

// Retry wrapper: each attempt gets a fresh request and its own timeout. Only the LAST
// failure propagates; earlier ones are logged and retried.
async function withRetry<T>(makeAttempt: () => Promise<T>, label: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= LLM_RETRIES; attempt += 1) {
    try {
      return await withTimeout(makeAttempt(), label);
    } catch (error) {
      lastError = error;
      if (attempt < LLM_RETRIES) {
        log.warn(`[Cognition] ${label} attempt ${attempt + 1} failed (${String(error)}); retrying`);
      }
    }
  }
  throw lastError;
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${LLM_CALL_TIMEOUT_MS}ms`));
    }, LLM_CALL_TIMEOUT_MS);
    (timer as { unref?: () => void }).unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// One LLM stage in the cognition lane. The timeout/retry clock starts when the stage
// LEAVES the queue — the lane runs one stage at a time below foreground dialogue work,
// so a stage can sit queued far longer than any healthy call runs. Wrapping the enqueue
// instead burned the whole 15s budget on queue wait under load and killed healthy
// stages, retrying them to the back of the line (observed live 2026-08-09 floodgates:
// 38 armed desires, 9 timeout deaths, 4 dispatches). Retrying inside the held slot also
// means a genuine provider stall retries immediately instead of re-queueing.
function runStage<T>(
  queue: { runCognition<R>(task: () => Promise<R>): Promise<R> },
  label: string,
  makeAttempt: () => Promise<T>,
): Promise<T> {
  return queue.runCognition(() => withRetry(makeAttempt, label));
}

export type CognitionStats = {
  deliberations: number;
  dispatches: number;
  suggestions: number;
  continues: number;
  invalidIntents: number;
  timeouts: number;
  // F5: successes the evidence contradicted. A run with any of these is not a clean run.
  suspectOutcomes: number;
};

export class CognitionService {
  private readonly ctx: ApiContext;

  private readonly runtimes = new Map<string, SimRuntime>();

  private readonly stats: CognitionStats = {
    deliberations: 0,
    dispatches: 0,
    suggestions: 0,
    continues: 0,
    invalidIntents: 0,
    timeouts: 0,
    suspectOutcomes: 0,
  };

  constructor(ctx: ApiContext) {
    this.ctx = ctx;
    ctx.simStateCache.onReport((report) => {
      this.onStateReport(report);
    });
  }

  getStats(): CognitionStats {
    return { ...this.stats };
  }

  getPhase(simId: string): SimPhase {
    return this.runtime(simId).phase;
  }

  // The Block 8 state push IS the tick driver — no independent timer. No reports
  // (zone loading, dead pipeline) means no deliberation, which is exactly right.
  onStateReport(report: SimStateReport) {
    if (!this.ctx.settings.cognitionEnabled || this.ctx.settings.cognitionAutonomyLevel === 'off') {
      return;
    }
    if (report.paused || report.lot?.clock?.paused) {
      return;
    }
    // No database, no cognition: right after an app restart reports arrive before
    // /db/load, and deliberating then loses every thought and memory (observed live)
    if (this.ctx.db?.isLoaded && !this.ctx.db.isLoaded()) {
      return;
    }
    const entries = report.sims ?? [];
    if (entries.length === 0) {
      return;
    }

    const maxConcurrent = this.ctx.settings.cognitionMaxConcurrent;
    let deliberating = [...this.runtimes.values()].filter((runtime) => runtime.phase === 'DELIBERATING').length;

    const now = Date.now();

    // G-7: daily planning is a background call that touches nothing in-game, so it
    // fires from the report for every household sim — including sims mid-conversation,
    // who never reach deliberate() (the in_social deliberation ban stays exactly as is)
    // and in the 08-04..08-14 playtest therefore never got a plan all day.
    const absoluteDayForPlans = report.lot?.clock?.absolute_day;
    if (absoluteDayForPlans !== undefined) {
      entries
        .filter((entry) => entry.is_household !== false && entry.sim_id)
        .forEach((entry) => {
          if (this.ctx.dailyPlan.needsLazyPlan(entry.sim_id, absoluteDayForPlans)) {
            void this.ctx.dailyPlan.generateLazy(entry, absoluteDayForPlans);
          }
        });
    }

    // Rule-based, no LLM: a critical physical need (accident/starvation imminent) gets
    // its fixing action dispatched directly — the model was watched fumbling this
    entries.forEach((entry) => {
      this.maybeFixCriticalNeed(entry, now);
    });

    // A wrecked sim away from home goes HOME as a rule — checked before the walk-in
    // rule so exhaustion outranks joining the party
    if (report.lot?.is_home === false) {
      entries.forEach((entry) => {
        this.maybeGoHomeExhausted(entry, now);
      });
    }

    // Rule-based, no LLM: an idle sim standing OFF the lot can't usefully deliberate —
    // at home send them home (go_home), at a venue walk them in (enter_lot); provenance
    // for both cases lives on maybeRejoinLot
    entries
      .filter((entry) => entry.self?.on_active_lot === false)
      .forEach((entry) => {
        this.maybeRejoinLot(entry, now, report.lot?.is_home === true);
      });

    const candidates = entries
      .filter((entry) => this.isEligible(entry, report, now))
      .sort((a, b) => this.urgencyScore(b, report) - this.urgencyScore(a, report));

    for (const [index, entry] of candidates.entries()) {
      if (deliberating >= maxConcurrent) {
        // Slot starvation was invisible in the playtest logs: a sim could sit eligible
        // for minutes behind one slow chain with no line saying so
        const skipped = candidates.slice(index).map((waiting) => waiting.sim_name ?? waiting.sim_id);
        log.info(
          `[Cognition] ${maxConcurrent} slot(s) busy; skipping ${skipped.length} eligible sim(s) this tick: ${skipped.join(', ')}`,
        );
        break;
      }
      deliberating += 1;
      void this.deliberate(entry, report).catch((error: unknown) => {
        log.error(`[Cognition] deliberation crashed for sim ${entry.sim_id}`, error);
        this.toCooldown(entry.sim_id);
      });
    }
  }

  // Closes the in-flight state. Wired from CognitionController.postOutcome so success
  // is only ever declared by the mod's outcome report — never by dispatch acceptance.
  onOutcome(event: GradedOutcomeEvent) {
    const runtime = this.runtimes.get(event.sim_id);
    if (!runtime) {
      return;
    }
    if (event.request_id && runtime.pendingRequestId && event.request_id !== runtime.pendingRequestId) {
      return;
    }
    const suspect = event.outcome === 'success' && event.verdict === 'suspect';
    if (runtime.phase !== 'PENDING_OUTCOME') {
      pushdiag(event.request_id, 'outcome', {
        sim_id: event.sim_id,
        action: event.action,
        outcome: event.outcome,
        // F5: 'late' now means the DISPATCHER had already closed the request. The old
        // flag meant 'this runtime is not PENDING_OUTCOME', which was also true for every
        // ask and debug dispatch the runtime never owned — two different facts under one
        // name, and the phantom report wore it.
        late: event.late ?? true,
        unowned: event.unowned,
        verdict: event.verdict,
        age_ms: event.dispatch_age_ms,
        decided_at: event.decided_at,
        phase: runtime.phase,
        cause: event.cause,
        reason: event.reason,
      });
      // The outcome landed after the 90s release already gave up on it. The release
      // suppressed the verb on the assumption the world never answered — but for a long
      // action the mod answers late with "still running when the app timed out; left it
      // running", so the world DID answer and the verb works. Leaving the suppression
      // told a Sim mid-song that playing guitar was "NOT possible right now, do not
      // choose" while her only goal that day was to practise an instrument (observed
      // live 2026-08-10). Lift it; never extend one from here.
      if (event.outcome === 'success' && !suspect && event.action && !ONE_SHOT_ACTIONS.has(event.action)) {
        runtime.suppressedUntil.delete(event.action);
      }
      if (suspect && event.action) {
        // Nothing confirmed this. Lifting the suppression here would put a verb the world
        // may still be refusing straight back in front of the model.
        this.stats.suspectOutcomes += 1;
      }
      return;
    }
    if (suspect) {
      // A success the evidence contradicts closes the pending state like a benign cancel:
      // the sim is freed to think again, but the verb sits out the short window so the
      // next tick cannot immediately re-pick the thing that just failed to happen.
      this.stats.suspectOutcomes += 1;
      runtime.pendingIntent = undefined;
      if (event.action) {
        runtime.suppressedUntil.set(event.action, Date.now() + BENIGN_CLOSE_SUPPRESS_MS);
      }
      this.clearPending(runtime);
      this.toCooldown(event.sim_id);
      log.info(
        `[Cognition] sim ${event.sim_id} '${event.action ?? ''}' reported success but nothing confirmed it; treating as unresolved`,
      );
      pushdiag(event.request_id, 'outcome', {
        sim_id: event.sim_id,
        action: event.action,
        outcome: event.outcome,
        verdict: 'suspect',
        decided_at: event.decided_at,
        claim: event.claim,
        ran: event.ran,
        sim_running: event.sim_running,
        age_ms: event.dispatch_age_ms,
      });
      return;
    }
    if (this.maybeRetryTransient(event, runtime)) {
      return;
    }
    runtime.pendingIntent = undefined;
    if (event.outcome !== 'success' && event.action) {
      // A cancel is churn, not proof — short window; real failures sit out the full one
      const window = event.outcome === 'canceled' ? BENIGN_CLOSE_SUPPRESS_MS : FAILED_ACTION_SUPPRESS_MS;
      runtime.suppressedUntil.set(event.action, Date.now() + window);
    }
    if (event.outcome === 'ineligible' && event.action) {
      // Preflight proved the intent can't execute at all (broken fix object) — the
      // critical-need rule lane must back off this action too, or it re-fires every
      // state report against the same impossibility
      runtime.fixIneligibleUntil.set(event.action, Date.now() + FAILED_ACTION_SUPPRESS_MS);
    }
    // One-shot verbs are DONE on success too — the lot re-offers them until the world
    // catches up (broken sink stays flagged until the repairman arrives), so a success
    // suppresses re-picking exactly like a failure would
    if (event.outcome === 'success' && event.action && ONE_SHOT_ACTIONS.has(event.action)) {
      runtime.suppressedUntil.set(event.action, Date.now() + FAILED_ACTION_SUPPRESS_MS);
    }
    this.clearPending(runtime);
    this.toCooldown(event.sim_id);
    log.info(`[Cognition] sim ${event.sim_id} '${event.action ?? ''}' closed: ${event.outcome}`);
    pushdiag(event.request_id, 'outcome', {
      sim_id: event.sim_id,
      action: event.action,
      outcome: event.outcome,
      interaction: event.interaction_name,
      cause: event.cause,
      reason: event.reason,
    });
  }

  private runtime(simId: string): SimRuntime {
    let runtime = this.runtimes.get(simId);
    if (!runtime) {
      runtime = {
        phase: 'IDLE',
        cooldownUntil: 0,
        deliberatedAt: [],
        suppressedUntil: new Map(),
        fixIneligibleUntil: new Map(),
      };
      this.runtimes.set(simId, runtime);
    }
    return runtime;
  }

  private isEligible(entry: SimStateEntry, report: SimStateReport, now: number): boolean {
    if (!entry.sim_id) {
      return false;
    }
    const runtime = this.runtime(entry.sim_id);
    if (runtime.phase === 'DELIBERATING' || runtime.phase === 'PENDING_OUTCOME') {
      return false;
    }
    if (runtime.phase === 'COOLDOWN') {
      if (now < runtime.cooldownUntil) {
        return false;
      }
      runtime.phase = 'IDLE';
    }

    // Suspension gates, all from the report (never from stale local guesses)
    if (entry.self?.on_active_lot === false) {
      return false;
    }
    if (entry.self?.in_ww_scene) {
      // WickedWhims stand-down: never direct or interrupt; a push would fail
      // "Subject is in sex." anyway
      return false;
    }
    if (entry.activity?.in_social) {
      // Scene deconfliction: mid-conversation sims carry the scene through the
      // dialogue pipeline, not through competing tick intents
      return false;
    }
    const running = entry.activity?.running ?? '';
    if (running === 'sleep' || running === 'nap') {
      return false;
    }

    // Per-sim hourly budget
    const hourAgo = now - 60 * 60 * 1000;
    runtime.deliberatedAt = runtime.deliberatedAt.filter((at) => at > hourAgo);
    if (runtime.deliberatedAt.length >= this.ctx.settings.cognitionPerSimHourlyBudget) {
      return false;
    }

    // Deliberation triggers: idle, urgent need, just went idle, or a live scene-armed
    // desire. A content, busy sim is left alone — continue-bias is structural, not a
    // prompt suggestion. Idle/stand animations count as idle: Emotion_Idle is the game
    // filling dead time.
    const isIdle =
      (!running || isIdleAnimation(running)) &&
      (entry.activity?.queue ?? []).every((queued) => isIdleAnimation(queued));
    const hasLowMotive = this.lowMotives(entry).length > 0;
    const wentIdle = (report.went_idle ?? []).includes(entry.sim_id);
    const armed = runtime.armedDesire !== undefined && now - runtime.armedDesire.at < ARMED_DESIRE_TTL_MS;
    if (runtime.armedDesire && !armed) {
      runtime.armedDesire = undefined;
    }
    // On-lot NPCs ride the report only so scene-armed desires can fire — they never
    // tick their own inner life (that spend belongs to the household), and the game
    // manages their needs itself
    if (entry.is_household === false) {
      return armed;
    }
    return isIdle || hasLowMotive || wentIdle || armed;
  }

  private maybeFixCriticalNeed(entry: SimStateEntry, now: number) {
    const simId = entry.sim_id;
    // NPC entries are desire-only passengers: the game runs their needs and homes
    if (!simId || entry.self?.in_ww_scene || entry.is_household === false) {
      return;
    }
    const runtime = this.runtime(simId);
    // Never-re-push still rules; only true in-flight states block. Cooldown does NOT —
    // this IS the emergency lane.
    if (runtime.phase === 'DELIBERATING' || runtime.phase === 'PENDING_OUTCOME') {
      return;
    }
    // The mod's stuck watchdog proved a pushed rescue starves behind this sim's running
    // head SI — every dispatch until it clears is doomed (live 2026-08-26: three
    // plausible-looking rescues while hunger fell -52 -> -61). Resumes the report after
    // blocked_by clears.
    if (entry.activity?.blocked_by) {
      log.info(`[Cognition] sim ${simId} rescue held: pushes starve behind ${entry.activity.blocked_by}`);
      return;
    }
    const needs = entry.self?.needs ?? {};
    const offered = offeredActions(entry);
    for (const [need, fixes] of Object.entries(CRITICAL_NEED_FIXES)) {
      const value = needs[need];
      if (typeof value !== 'number' || value >= NEED_CRITICAL) {
        continue;
      }
      // Deliberately ignores the suppression map: an accident-in-progress warrants
      // retrying even a just-canceled fix (a suppressed use_toilet at bladder -85 must
      // never mean peeing on the floor while the toilet works fine). The ineligible
      // backoff is the one exception — preflight proved the fix object itself unusable,
      // so retrying is spam, not urgency (observed live 2026-08-07: broken toilet,
      // use_toilet re-fired and wrote a failure memory every 5s report at bladder -100)
      const action = fixes.find(
        (fix) => offered.objectActions.has(fix) && (runtime.fixIneligibleUntil.get(fix) ?? 0) <= now,
      );
      if (!action) {
        continue;
      }
      if (this.ctx.settings.cognitionAutonomyLevel === 'suggest') {
        log.info(`[Cognition][suggest] sim ${simId} ${need} at ${value}; would rule-dispatch ${action}`);
        this.toCooldown(simId);
        return;
      }
      try {
        const requestId = this.ctx.actionDispatcher.dispatch({
          sim_id: simId,
          action,
          target_object_id: offered.objectActions.get(action),
          motivation: `${need} is critically low; handling it before anything else.`,
          source: 'cognition',
        });
        runtime.phase = 'PENDING_OUTCOME';
        runtime.pendingRequestId = requestId;
        runtime.pendingAction = action;
        runtime.lastDispatch = { action, at: Date.now() };
        this.stats.dispatches += 1;
        this.armPendingTimeout(simId, runtime, entry, { kind: 'action', action });
        log.info(`[Cognition] sim ${simId} ${need} at ${value} -> ${action} (rule, ${requestId})`);
      } catch (error) {
        log.warn(`[Cognition] critical-need dispatch refused for sim ${simId}`, error);
        this.toCooldown(simId);
      }
      return;
    }
  }

  // Away from home, the game's own passout fallback is a terrible night out: an
  // exhausted sim — or one starving somewhere with no food on offer — heads HOME as a
  // rule, no LLM; bed and fridge live there (observed live: Energy -79 at the bar while
  // the model kept trying the broken TV). Mid-social sims finish their conversation
  // first; the rule fires on the next report after it ends.
  private maybeGoHomeExhausted(entry: SimStateEntry, now: number) {
    const simId = entry.sim_id;
    if (!simId || entry.self?.in_ww_scene || entry.activity?.in_social || entry.is_household === false) {
      return;
    }
    const runtime = this.runtime(simId);
    if (runtime.phase === 'DELIBERATING' || runtime.phase === 'PENDING_OUTCOME') {
      return;
    }
    const needs = entry.self?.needs ?? {};
    const offered = offeredActions(entry);
    const exhausted = typeof needs.energy === 'number' && needs.energy < NEED_CRITICAL;
    const starvingNoFood =
      typeof needs.hunger === 'number' &&
      needs.hunger < NEED_CRITICAL &&
      !CRITICAL_NEED_FIXES.hunger.some((fix) => offered.objectActions.has(fix));
    if (!exhausted && !starvingNoFood) {
      return;
    }
    if (this.recentlyFailedActions(runtime).has('go_home')) {
      return;
    }
    const why = exhausted ? `energy ${needs.energy}` : `hunger ${needs.hunger} with no food here`;
    if (this.ctx.settings.cognitionAutonomyLevel === 'suggest') {
      log.info(`[Cognition][suggest] sim ${simId} is wrecked away from home (${why}); would go_home`);
      this.toCooldown(simId);
      return;
    }
    try {
      const requestId = this.ctx.actionDispatcher.dispatch({
        sim_id: simId,
        action: 'go_home',
        motivation: 'Completely worn out; calling it a night and heading home.',
        source: 'cognition',
      });
      runtime.phase = 'PENDING_OUTCOME';
      runtime.pendingRequestId = requestId;
      runtime.pendingAction = 'go_home';
      this.stats.dispatches += 1;
      this.armPendingTimeout(simId, runtime, entry, { kind: 'action', action: 'go_home' });
      log.info(`[Cognition] sim ${simId} is wrecked away from home (${why}) -> go_home (rule, ${requestId})`);
    } catch (error) {
      log.warn(`[Cognition] go_home dispatch refused for sim ${simId}`, error);
      this.toCooldown(simId);
    }
  }

  // Rule-based, no LLM: an idle sim standing OFF the lot can't usefully deliberate —
  // perception is street noise, no same-room sims to talk to. At home the fix is
  // go_home; at a venue it is enter_lot (observed live: she traveled to a bar, spawned
  // on the street, and stood outside thinking wistful thoughts while three sims drank
  // inside — nothing ever walked her in).
  private maybeRejoinLot(entry: SimStateEntry, now: number, isHome: boolean) {
    const simId = entry.sim_id;
    const action = isHome ? 'go_home' : 'enter_lot';
    const where = isHome ? 'off the home lot' : 'outside the venue lot';
    if (!simId || entry.is_household === false) {
      return;
    }
    const runtime = this.runtime(simId);
    if (runtime.phase === 'DELIBERATING' || runtime.phase === 'PENDING_OUTCOME') {
      return;
    }
    if (runtime.phase === 'COOLDOWN' && now < runtime.cooldownUntil) {
      return;
    }
    // Busy or mid-scene off-lot sims are living their life (walking somewhere, chatting);
    // only a standing-idle sim gets pulled in. Idle/stand animations count as idle —
    // observed live: a sim "running" idle_Energy in the street at 1am was never sent home
    if (entry.activity?.in_social || entry.self?.in_ww_scene) {
      return;
    }
    const running = entry.activity?.running ?? '';
    if (running && !isIdleAnimation(running)) {
      return;
    }
    if ((entry.activity?.queue ?? []).some((queued) => !isIdleAnimation(queued))) {
      return;
    }
    // A rejoin that just failed (e.g. "already at home" edge) must not retry every tick
    if (this.recentlyFailedActions(runtime).has(action)) {
      return;
    }
    if (this.ctx.settings.cognitionAutonomyLevel === 'suggest') {
      log.info(`[Cognition][suggest] sim ${simId} is idle ${where}; would dispatch ${action}`);
      this.toCooldown(simId);
      return;
    }
    try {
      const requestId = this.ctx.actionDispatcher.dispatch({
        sim_id: simId,
        action,
        motivation: isHome
          ? 'Wandering the street with nothing to do; heading home.'
          : 'Standing around outside; heading in to where the people are.',
        source: 'cognition',
      });
      runtime.phase = 'PENDING_OUTCOME';
      runtime.pendingRequestId = requestId;
      runtime.pendingAction = action;
      this.stats.dispatches += 1;
      this.armPendingTimeout(simId, runtime, entry, { kind: 'action', action });
      log.info(`[Cognition] sim ${simId} is idle ${where} -> ${action} (${requestId})`);
    } catch (error) {
      log.warn(`[Cognition] ${action} dispatch refused for sim ${simId}`, error);
      this.toCooldown(simId);
    }
  }

  private lowMotives(entry: SimStateEntry): string[] {
    const needs = entry.self?.needs ?? {};
    return Object.entries(needs)
      .filter(([, value]) => value < 30)
      .map(([need]) => need);
  }

  private urgencyScore(entry: SimStateEntry, report: SimStateReport): number {
    const emergency = (entry.self?.buffs ?? []).some((buff) => /death|fire|electrocut/i.test(buff));
    if (emergency) {
      return 1000;
    }
    const lows = this.lowMotives(entry);
    const worst = Math.min(100, ...Object.values(entry.self?.needs ?? {}));
    let score = lows.length * 10 + (30 - Math.min(worst, 30));
    if ((report.went_idle ?? []).includes(entry.sim_id ?? '')) {
      score += 5;
    }
    return score;
  }

  private async deliberate(entry: SimStateEntry, report: SimStateReport): Promise<void> {
    const simId = entry.sim_id;
    const runtime = this.runtime(simId);
    runtime.phase = 'DELIBERATING';
    runtime.deliberatedAt.push(Date.now());
    this.stats.deliberations += 1;

    // Recently-failed actions are cut from every offering channel before the model ever
    // sees them — retry loops die in code, not in the prompt
    const suppressed = this.recentlyFailedActions(runtime);
    if (suppressed.size > 0) {
      log.debug(`[Cognition] sim ${simId} suppressing recently failed actions: ${[...suppressed].join(', ')}`);
    }
    // Too tired to go out: with social pinned worst, the model sent her BACK out the
    // moment the wrecked-rule walked her home — a home->bar commute loop that starved
    // sleep, fun, and the broken fridge of any home time (observed live: walked in the
    // door and left again 17 seconds later)
    const energy = entry.self?.needs?.energy;
    if (typeof energy === 'number' && energy < TOO_TIRED_TO_GO_OUT) {
      suppressed.add('go_out');
    }

    // Daily plan: household sims carry a per-game-day plan (goals + persona + action
    // loadout). No plan for today yet (app restart, never slept) — fire the lazy
    // planner in the background and proceed unfiltered THIS tick; the next tick picks
    // it up. NPCs never plan.
    const absoluteDay = report.lot?.clock?.absolute_day;
    let plan;
    if (entry.is_household !== false && absoluteDay !== undefined) {
      plan = this.ctx.dailyPlan.activePlan(simId, absoluteDay);
      // (the lazy planner itself now fires from onStateReport — G-7)
    }
    // Off-loadout keys are cut from every offering channel like suppressed ones — but
    // NEVER added to the "NOT possible" line below: the hard filter means ABSENT from
    // the prompt, not named as forbidden
    const offLoadout = offLoadoutActions(plan?.loadout);
    // Verbs this sim's age cannot run are cut the same way: a child offered read_book
    // spends an Action Scene on a guaranteed refusal (live 2026-08-10, Mackenzie Scott)
    const ageBlocked = entry.self?.age_blocked ?? [];
    const narrowed =
      offLoadout.size === 0 && ageBlocked.length === 0
        ? suppressed
        : new Set([...suppressed, ...offLoadout, ...ageBlocked]);

    // Object/lot keys are narrowed through entryView below, but the SOCIAL list is
    // rendered from the static SOCIAL_ACTIONS set, so it needs the hidden keys handed to
    // it explicitly. Missing ageBlocked here left 'deep conversation' on a CHILD's offered
    // socials — the exact verb the game refuses her (caught live 2026-08-10).
    const hiddenActions = new Set([...offLoadout, ...ageBlocked]);

    const entryView = this.withoutSuppressedActions(entry, narrowed);
    const lotActionKeys = (report.lot?.action_keys ?? []).filter((key) => !narrowed.has(key));
    const reportView: SimStateReport =
      narrowed.size === 0 || !report.lot
        ? report
        : { ...report, lot: { ...report.lot, action_keys: lotActionKeys.length > 0 ? lotActionKeys : undefined } };

    const memoriesBlock = await this.relevantMemoriesBlock(entryView, absoluteDay);
    // hippocampus_recall: the semantic half of memory. Perceived sims are the focus, so
    // a tick about the person standing in front of you carries what you know about them.
    const factsBlock = this.knownFactsBlock(simId, entry, absoluteDay);
    const planBlock =
      plan && (plan.goals.length > 0 || plan.persona)
        ? {
            goals: plan.goals.map((goal) => ({
              label: goal.label,
              action_keys: goal.action_keys,
              reachable: goal.reachable,
            })),
            persona: plan.persona,
          }
        : undefined;
    // Whether the tick prompt actually carried TODAYS_PLAN is otherwise invisible:
    // cognition prompts are not logged, so a playtest cannot tell "no plan block" from
    // "not logged" (owed verification, live 2026-08-15).
    if (planBlock) {
      const planGoals = planBlock.goals.map((goal) => goal.label).join(', ');
      const withPersona = planBlock.persona ? ' + persona' : '';
      log.info(
        `[DailyPlan] tick prompt carries TODAYS_PLAN for ${entry.sim_name ?? simId}: ` +
          `${planBlock.goals.length} goal(s) [${planGoals}]${withPersona}`,
      );
    }
    const situationPrompt = buildCognitionUserPrompt(
      entryView,
      reportView,
      memoriesBlock,
      [...suppressed],
      planBlock,
      hiddenActions,
      factsBlock,
    );

    const simLabel = entry.sim_name ?? simId;
    const threshold = this.ctx.settings.cognitionActionScoreThreshold;
    // Every stage that shaped this tick, so the thought memory can show what led to it
    const tickExchanges: LLMExchange[] = [];

    // A directed scene's Reflection may have already produced this sim's monologue and
    // action score (armed via armDesireFromScene) — the tick then skips straight to the
    // Action Scene with a fresh snapshot.
    const armed = runtime.armedDesire;
    runtime.armedDesire = undefined;

    let thought: string | undefined;
    let actionScore: number;
    let actionReason: string | undefined;

    if (armed && Date.now() - armed.at < ARMED_DESIRE_TTL_MS) {
      thought = armed.thought;
      actionScore = armed.score;
      actionReason = armed.reason;
      log.info(
        `[Cognition] sim ${simId} acting on scene-armed desire ${actionScore}${actionReason ? ` (${actionReason})` : ''}`,
      );
    } else {
      // The tick D/M/R beat: monologue, then scores. The director's job at tick cadence
      // is deterministic — the situation prompt IS the briefing.
      const monologue = await runStage(this.ctx.generationQueue, 'tick monologue', () =>
        this.ctx.ai.runOneShot(
          `Cognition Monologue: ${simLabel}`,
          TICK_MONOLOGUE_SYSTEM_PROMPT,
          situationPrompt,
          120,
          undefined,
          AIActionType.COGNITION,
          undefined,
          { stageId: StageId.DEFAULT_MODE_MONOLOGUE },
        ),
      );
      tickExchanges.push(monologue.exchange);
      thought = monologue.text.trim().slice(0, 300);
      if (thought.length <= 1) {
        log.warn(`[Cognition] sim ${simId} produced no monologue; continuing`);
        this.stats.continues += 1;
        this.toCooldown(simId);
        return;
      }

      const scored = await runStage(this.ctx.generationQueue, 'tick scores', () =>
        this.ctx.ai.runOneShot(
          `Cognition Scores: ${simLabel}`,
          TICK_SCORES_SYSTEM_PROMPT,
          `${situationPrompt}\n\n${simLabel}'s inner monologue right now: ${thought}`,
          120,
          undefined,
          AIActionType.COGNITION,
          undefined,
          { stageId: StageId.LIMBIC_SALIENCE },
        ),
      );
      tickExchanges.push(scored.exchange);
      const tickScores = parseTickScores(scored.text);
      actionScore = tickScores?.action ?? 1;
      actionReason = tickScores?.reason;

      // The monologue is the sim's inner life regardless of what follows — stored as
      // their private memory, priced by the memory score
      this.storeThought(entry, { kind: 'continue', thought }, tickExchanges, tickScores?.memory);
      log.info(
        `[Cognition] sim ${simId} tick — memory ${tickScores?.memory ?? '?'}, action ${actionScore}${
          actionReason ? ` (${actionReason})` : ''
        }`,
      );
    }

    // The fast brain keeps the wheel below threshold: no Action Scene, no dispatch
    if (actionScore < threshold) {
      this.stats.continues += 1;
      this.toCooldown(simId);
      return;
    }

    // ACTION SCENE: the slow brain steps in — director options, the sim's choice, review
    const intent = await this.runActionScene({
      entryView,
      lotActionKeys,
      situationPrompt,
      simLabel,
      thought,
      actionReason,
      exchanges: tickExchanges,
      hiddenActions,
    });
    if (!intent || intent.kind !== 'action' || !intent.action) {
      this.stats.continues += 1;
      this.toCooldown(simId);
      return;
    }

    const runningNow = entry.activity?.running ?? '';
    const busy =
      (runningNow !== '' && !isIdleAnimation(runningNow)) ||
      (entry.activity?.queue ?? []).some((queued) => !isIdleAnimation(queued));

    // G-9: autonomy-echo guard. The mod reports the whitelist verb the sim is ALREADY
    // doing (reverse index, fallbacks included); dispatching that same verb would only
    // interrupt the fast brain's own rescue to restart it. Counted as continue.
    const runningKey = entry.activity?.running_action_key;
    if (runningKey && runningKey === intent.action) {
      this.stats.continues += 1;
      log.info(
        `[Cognition] sim ${simId} is already doing '${runningKey}' (autonomy); '${intent.action}' counted as continue`,
      );
      this.toCooldown(simId);
      return;
    }

    // Redispatch guard survives Full Autonomy: a busy sim choosing the SAME action (or
    // same need category) it was just dispatched is re-picking, not planning. The old
    // need-urgency interrupt bar is gone on purpose — an action score over threshold IS
    // the interrupt justification; the Scores prompt keeps content busy sims low and the
    // review stage catches clear mistakes.
    if (busy && runtime.lastDispatch && Date.now() - runtime.lastDispatch.at < REDISPATCH_WHILE_BUSY_MS) {
      const lastCategory = ACTION_NEED_CATEGORY[runtime.lastDispatch.action];
      const sameAction = runtime.lastDispatch.action === intent.action;
      const sameNeed = lastCategory !== undefined && lastCategory === ACTION_NEED_CATEGORY[intent.action];
      if (sameAction || sameNeed) {
        this.stats.continues += 1;
        log.info(
          `[Cognition] sim ${simId} is busy on recently dispatched '${runtime.lastDispatch.action}'; blocking '${intent.action}' (${sameAction ? 'same action' : 'same need'})`,
        );
        this.toCooldown(simId);
        return;
      }
    }

    if (this.ctx.settings.cognitionAutonomyLevel === 'suggest') {
      this.stats.suggestions += 1;
      log.info(
        `[Cognition][suggest] sim ${simId} would ${intent.action}` +
          (intent.target_sim_id ? ` with ${intent.target_sim_id}` : '') +
          (intent.motivation ? ` — ${intent.motivation}` : ''),
      );
      this.toCooldown(simId);
      return;
    }

    try {
      const requestId = this.ctx.actionDispatcher.dispatch({
        sim_id: simId,
        action: intent.action,
        target_sim_id: intent.target_sim_id,
        target_object_id: intent.target_object_id,
        motivation: intent.motivation ?? intent.thought,
        source: 'cognition',
      });
      runtime.phase = 'PENDING_OUTCOME';
      runtime.pendingRequestId = requestId;
      runtime.pendingAction = intent.action;
      runtime.lastDispatch = { action: intent.action, at: Date.now() };
      // G-10: the intent and its remaining automatic retries ride the pending state
      runtime.pendingIntent = { intent, entry, retriesLeft: Math.min(3, Math.max(0, intent.retries ?? 1)) };
      this.stats.dispatches += 1;
      this.armPendingTimeout(simId, runtime, entry, intent);
      log.info(`[Cognition] sim ${simId} -> ${intent.action} (${requestId})`);
    } catch (error) {
      // Dispatcher refused (already in flight — a race with a player push): back off
      log.warn(`[Cognition] dispatch refused for sim ${simId}`, error);
      this.toCooldown(simId);
    }
  }

  // A directed scene's Reflection stage found this sim wanting a change (action score at
  // or over threshold). Mid-scene is not the moment to dispatch — the desire is armed and
  // the next eligible tick stages the Action Scene from a fresh snapshot.
  armDesireFromScene(simId: string, desire: { score: number; reason?: string; thought?: string }) {
    if (!simId || desire.score < this.ctx.settings.cognitionActionScoreThreshold) {
      return;
    }
    const runtime = this.runtime(simId);
    runtime.armedDesire = { ...desire, at: Date.now() };
    log.info(
      `[Cognition] sim ${simId} armed action desire ${desire.score}${desire.reason ? ` (${desire.reason})` : ''}`,
    );
  }

  // The Action Scene: a choose-your-own-adventure beat. The director writes 3-5 options
  // MECHANICALLY BOUND to the offered vocabulary (validateIntent drops anything invented),
  // the sim picks one in character, and a reviewer sanity-checks the pick ({"choice": 0}
  // stands the scene down). Fails inert: any unparseable stage returns undefined and the
  // sim simply continues.
  private async runActionScene(params: {
    entryView: SimStateEntry;
    lotActionKeys: string[] | undefined;
    situationPrompt: string;
    simLabel: string;
    thought?: string;
    actionReason?: string;
    exchanges: LLMExchange[];
    // Belt-and-braces: the director never saw off-loadout or age-blocked keys (the
    // vocabulary was narrowed upstream), but if a stage names one anyway it dies here
    hiddenActions?: Set<string>;
  }): Promise<CognitionIntent | undefined> {
    const { entryView, lotActionKeys, situationPrompt, simLabel, thought, actionReason, exchanges, hiddenActions } =
      params;
    try {
      const optionsShot = await runStage(this.ctx.generationQueue, 'action options', () =>
        this.ctx.ai.runOneShot(
          `Action Options: ${simLabel}`,
          ACTION_OPTIONS_SYSTEM_PROMPT,
          `${situationPrompt}\n\n${simLabel}'s inner monologue: ${thought ?? '(none)'}${
            actionReason ? `\nWhat is pulling at them: ${actionReason}` : ''
          }`,
          400,
          undefined,
          AIActionType.ACTION_SCENE,
          undefined,
          { stageId: StageId.BASAL_GANGLIA_OPTIONS },
        ),
      );
      exchanges.push(optionsShot.exchange);
      const parsedOptions = parseActionOptions(optionsShot.text);
      if (!parsedOptions) {
        this.stats.invalidIntents += 1;
        log.warn(`[Cognition] ${simLabel} action options unparseable; standing down`);
        return undefined;
      }

      // Bind every option to the offered vocabulary; invented actions and targets die
      // here, silently — the menu the sim sees contains only executable choices
      const valid: { intent: CognitionIntent; label: string; key: string }[] = [];
      parsedOptions.options.forEach((option) => {
        const validated = validateIntent(
          {
            kind: 'action',
            action: option.action,
            target_sim_id: option.target_sim_id,
            target_object_id: option.target_object_id,
          },
          entryView,
          lotActionKeys,
        );
        if (!validated.ok || validated.intent.kind !== 'action' || !validated.intent.action) {
          return;
        }
        if (hiddenActions?.has(validated.intent.action)) {
          log.debug(`[Cognition] ${simLabel} action scene dropped hidden option '${validated.intent.action}'`);
          return;
        }
        const key = `${validated.intent.action}|${validated.intent.target_sim_id ?? ''}|${validated.intent.target_object_id ?? ''}`;
        if (!valid.some((existing) => existing.key === key)) {
          valid.push({ intent: validated.intent, label: option.label ?? validated.intent.action, key });
        }
      });
      if (valid.length === 0) {
        this.stats.invalidIntents += 1;
        log.warn(`[Cognition] ${simLabel} action scene produced no valid options; standing down`);
        return undefined;
      }
      const dropped = parsedOptions.options.length - valid.length;
      if (dropped > 0) {
        log.debug(`[Cognition] ${simLabel} action scene dropped ${dropped} invalid option(s)`);
      }

      const menu = valid.map((option, index) => `${index + 1}. [${option.intent.action}] ${option.label}`).join('\n');

      // A single valid option needs no choice call — the sim takes it, review still runs
      let pickedIndex = 0;
      let motivation: string | undefined;
      let retries: number | undefined;
      if (valid.length > 1) {
        const choiceShot = await runStage(this.ctx.generationQueue, 'action choice', () =>
          this.ctx.ai.runOneShot(
            `Action Choice: ${simLabel}`,
            ACTION_CHOICE_SYSTEM_PROMPT,
            `${parsedOptions.scene ?? ''}\n\nYou are ${simLabel}. Your inner monologue: ${thought ?? '(none)'}${
              actionReason ? `\nWhat is pulling at you: ${actionReason}` : ''
            }\n\nOptions:\n${menu}`,
            150,
            undefined,
            AIActionType.ACTION_SCENE,
            undefined,
            { stageId: StageId.BASAL_GANGLIA_CHOICE },
          ),
        );
        exchanges.push(choiceShot.exchange);
        const choice = parseActionChoice(choiceShot.text);
        if (choice && choice.choice >= 1 && choice.choice <= valid.length) {
          pickedIndex = choice.choice - 1;
        }
        motivation = choice?.motivation;
        retries = choice?.retries;
      }

      const reviewShot = await runStage(this.ctx.generationQueue, 'action review', () =>
        this.ctx.ai.runOneShot(
          `Action Review: ${simLabel}`,
          ACTION_REVIEW_SYSTEM_PROMPT,
          `${situationPrompt}\n\nOptions:\n${menu}\n\n${simLabel} chose: ${pickedIndex + 1} — [${valid[pickedIndex].intent.action}] ${valid[pickedIndex].label}${
            motivation ? `\nTheir motivation: ${motivation}` : ''
          }`,
          60,
          undefined,
          AIActionType.ACTION_SCENE,
          undefined,
          { stageId: StageId.BASAL_GANGLIA_REVIEW },
        ),
      );
      exchanges.push(reviewShot.exchange);
      const review = parseActionChoice(reviewShot.text);
      if (review) {
        if (review.choice === 0) {
          log.info(`[Cognition] ${simLabel} action review stood the scene down`);
          return undefined;
        }
        if (review.choice >= 1 && review.choice <= valid.length && review.choice - 1 !== pickedIndex) {
          log.info(
            `[Cognition] ${simLabel} action review adjusted choice: ${valid[pickedIndex].intent.action} -> ${valid[review.choice - 1].intent.action}`,
          );
          pickedIndex = review.choice - 1;
        }
      }

      return { ...valid[pickedIndex].intent, motivation: motivation ?? actionReason, thought, retries };
    } catch (error) {
      log.warn(`[Cognition] action scene failed for ${simLabel}; standing down`, error);
      return undefined;
    }
  }

  // Prunes expired entries and returns the still-suppressed action keys for this sim
  private recentlyFailedActions(runtime: SimRuntime): Set<string> {
    const now = Date.now();
    [...runtime.suppressedUntil.entries()].forEach(([action, until]) => {
      if (until < now) {
        runtime.suppressedUntil.delete(action);
      }
    });
    return new Set(runtime.suppressedUntil.keys());
  }

  private withoutSuppressedActions(entry: SimStateEntry, suppressed: Set<string>): SimStateEntry {
    if (suppressed.size === 0) {
      return entry;
    }
    return {
      ...entry,
      objects: (entry.objects ?? []).map((object) => ({
        ...object,
        action_keys: (object.action_keys ?? []).filter((key) => !suppressed.has(key)),
      })),
    };
  }

  private storeThought(
    entry: SimStateEntry,
    intent: CognitionIntent,
    exchanges: LLMExchange[] = [],
    importance?: number,
  ) {
    if (!intent.thought) {
      return;
    }
    // Dev mode reads this back on the thought memory: the deliberation (and review) that
    // decided what the sim does next, prompt and all. Isolated from the write below —
    // this is debug bookkeeping and must never cost the sim its thought.
    try {
      this.ctx.memoryTrace.recordPending([intent.thought], { pipeline: 'cognition', exchanges });
    } catch (error) {
      log.debug(`[Cognition] could not record thought trace for sim ${entry.sim_id}: ${String(error)}`);
    }

    try {
      // Thoughts constrain later retrieval (what a sim thinks shapes what it says). The
      // push shows the thought live in the mod's memories window; the mod keeps thought
      // rows off the subtitle/pause path, so tick cadence never pauses the game.
      this.ctx.memoryRepository.createMemory({
        memory: {
          content: intent.thought,
          location_id: Number(entry.location?.zone_id ?? 0),
          event_type: 'thought',
        },
        participants: [{ id: entry.sim_id }],
        // A thought is private: no other sim's retrieval may ever surface it. The
        // tick's own memory score prices it when the scores stage delivered one.
        index: { owner: entry.sim_id, importance },
      });
    } catch (error) {
      log.warn(`[Cognition] failed to store thought for sim ${entry.sim_id}`, error);
    }
  }

  // A facts lookup must never be able to stop a sim from thinking. Deliberation without
  // <KNOWN_FACTS> is the pre-3.1 behaviour, which is a fine degradation; deliberation
  // that throws is a sim standing still.
  private knownFactsBlock(simId: string, entry: SimStateEntry, today?: number): string {
    try {
      return this.ctx.semanticMemory.recall(simId, {
        mentionedSimIds: entry.sims.map((other) => other.sim_id),
        today,
      });
    } catch (error) {
      log.warn(`[Cognition] fact recall failed for sim ${simId}; deliberating without facts`, error);
      return '';
    }
  }

  // Retrieval is always on since 4.0.6 (the embedding provider config decides how it
  // scores); a Noop embedder still ranks by importance and recency.
  private async relevantMemoriesBlock(entry: SimStateEntry, today?: number): Promise<string | undefined> {
    try {
      const perceivedNames = (entry.sims ?? [])
        .map((perceived) => perceived.name)
        .filter((name): name is string => Boolean(name));
      const queryText = [entry.sim_name, ...perceivedNames, ...(entry.self?.wants ?? [])].join(' ');
      const participantIds = [entry.sim_id, ...(entry.sims ?? []).map((perceived) => perceived.sim_id)].filter(Boolean);
      const retrieved = await this.ctx.memoryRetrieval.retrieve({
        participantIds,
        queryText,
        k: RELEVANT_MEMORY_COUNT,
        excludeMemoryIds: [],
        // Deliberation is this sim's own head: only their private rows may surface
        ownerScope: [entry.sim_id],
        // The people actually here are what this tick is about: an old memory of the
        // sim standing in front of you should be reachable even when the recent window
        // is full of unrelated ticks.
        focusParticipantIds: entry.sims.map((perceived) => perceived.sim_id),
        // Decay on the clock the sim lives in
        today,
        // Echo-chamber brake: at most one of the sim's own tick-thoughts may surface —
        // fresh thoughts win on recency and were feeding the monologue its own words
        // back (35/39 rows one topic, measured live 2026-08-09)
        maxSelfAuthored: 1,
      });
      if (retrieved.length === 0) {
        return undefined;
      }
      const lines = retrieved.map(
        (result) => result.memory.content ?? result.memory.observation ?? result.memory.pre_action ?? '',
      );
      return ['<RELEVANT_MEMORIES>', ...lines.filter(Boolean), '</RELEVANT_MEMORIES>'].join('\n');
    } catch (error) {
      log.warn('[Cognition] memory retrieval failed; deliberating without memories', error);
      return undefined;
    }
  }

  private armPendingTimeout(simId: string, runtime: SimRuntime, entry: SimStateEntry, intent: CognitionIntent) {
    const distance = this.targetDistance(entry, intent) ?? 10;
    const baseMs = intent.action && LONG_RUNNING_ACTIONS.has(intent.action) ? LONG_RUNNING_PENDING_MS : PENDING_BASE_MS;
    const timeoutMs = Math.max(baseMs, 2 * distance * MS_PER_METER + PENDING_BASE_MS / 2);
    runtime.pendingTimer = setTimeout(() => {
      if (runtime.phase !== 'PENDING_OUTCOME') {
        return;
      }
      this.stats.timeouts += 1;
      log.warn(
        `[Cognition] sim ${simId} '${runtime.pendingAction}' produced no outcome in ${Math.round(timeoutMs / 1000)}s; releasing`,
      );
      pushdiag(runtime.pendingRequestId, 'timeout', {
        sim_id: simId,
        action: runtime.pendingAction,
        waited_s: Math.round(timeoutMs / 1000),
        distance_m: distance,
      });
      // A timed-out action gets the BENIGN window: the world never answered, which is
      // churn, not proof it can't work — but it still sits out long enough that the
      // model can't re-pick it immediately (observed live: sit -> timeout -> sit again
      // 20s later; also observed: a guest-occupied toilet timing out once must not
      // lock the only bladder fix away for 10 minutes)
      if (runtime.pendingAction) {
        runtime.suppressedUntil.set(runtime.pendingAction, Date.now() + BENIGN_CLOSE_SUPPRESS_MS);
      }
      // Release the dispatcher's in-flight entry too — otherwise a lost dispatch (mod
      // websocket down) blocks every future dispatch for this sim until the 10-min TTL
      this.ctx.actionDispatcher.release?.(runtime.pendingRequestId);
      this.clearPending(runtime);
      this.toCooldown(simId);
    }, timeoutMs);
    runtime.pendingTimer.unref?.();
  }

  private targetDistance(entry: SimStateEntry, intent: CognitionIntent): number | undefined {
    if (intent.target_sim_id) {
      return (entry.sims ?? []).find((perceived) => perceived.sim_id === intent.target_sim_id)?.distance;
    }
    if (intent.target_object_id) {
      return (entry.objects ?? []).find((object) => object.object_id === intent.target_object_id)?.distance;
    }
    return undefined;
  }

  // G-10: an automatic re-dispatch of the same intent when the close was TRANSIENT and
  // the model budgeted a retry for it. Never for ineligible/failure/structural causes;
  // never past the model's own count (cap 3); never while the verb sits in a suppression
  // window (the 08-04 refire storm came from ignoring exactly that).
  private maybeRetryTransient(event: InteractionOutcomeEvent, runtime: SimRuntime): boolean {
    const pending = runtime.pendingIntent;
    if (!pending || event.outcome !== 'canceled' || pending.retriesLeft <= 0) {
      return false;
    }
    if (!event.cause || !TRANSIENT_OUTCOME_CAUSES.has(event.cause)) {
      return false;
    }
    const simId = event.sim_id;
    const action = pending.intent.action;
    if (!action || action !== event.action) {
      return false;
    }
    if (
      (runtime.suppressedUntil.get(action) ?? 0) > Date.now() ||
      (runtime.fixIneligibleUntil.get(action) ?? 0) > Date.now()
    ) {
      return false;
    }
    pending.retriesLeft -= 1;
    this.clearPending(runtime);
    runtime.phase = 'COOLDOWN';
    runtime.cooldownUntil = Date.now() + RETRY_DELAY_MS;
    pushdiag(event.request_id, 'retry', {
      sim_id: simId,
      action,
      cause: event.cause,
      retries_left: pending.retriesLeft,
    });
    log.info(
      `[Cognition] sim ${simId} '${action}' died to transient '${event.cause}'; retrying (${pending.retriesLeft} left)`,
    );
    const timer = setTimeout(() => {
      try {
        if (runtime.phase !== 'COOLDOWN' || this.ctx.actionDispatcher.getInFlight?.(simId)) {
          return;
        }
        const requestId = this.ctx.actionDispatcher.dispatch({
          sim_id: simId,
          action,
          target_sim_id: pending.intent.target_sim_id,
          target_object_id: pending.intent.target_object_id,
          motivation: pending.intent.motivation ?? pending.intent.thought,
          source: 'cognition',
        });
        runtime.phase = 'PENDING_OUTCOME';
        runtime.pendingRequestId = requestId;
        runtime.pendingAction = action;
        runtime.lastDispatch = { action, at: Date.now() };
        runtime.pendingIntent = pending;
        this.stats.dispatches += 1;
        this.armPendingTimeout(simId, runtime, pending.entry, pending.intent);
      } catch (error) {
        log.warn(`[Cognition] retry dispatch refused for sim ${simId}`, error);
        runtime.pendingIntent = undefined;
        this.toCooldown(simId);
      }
    }, RETRY_DELAY_MS);
    timer.unref?.();
    return true;
  }

  private clearPending(runtime: SimRuntime) {
    if (runtime.pendingTimer) {
      clearTimeout(runtime.pendingTimer);
    }
    runtime.pendingTimer = undefined;
    runtime.pendingRequestId = undefined;
    runtime.pendingAction = undefined;
  }

  private toCooldown(simId: string, multiplier = 1) {
    const runtime = this.runtime(simId);
    runtime.phase = 'COOLDOWN';
    runtime.cooldownUntil = Date.now() + this.ctx.settings.cognitionTickIntervalSeconds * 1000 * multiplier;
  }
}
