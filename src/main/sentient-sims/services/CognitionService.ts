import log from 'electron-log';
import { ApiContext } from './ApiContext';
import { SimStateEntry, SimStateReport } from '../models/SimStateReport';
import {
  CognitionIntent,
  normalizeActionKey,
  offeredActions,
  parseIntentJson,
  validateIntent,
} from '../models/CognitionIntent';
import { InteractionOutcomeEvent } from '../models/ActionIntent';
import { AIActionType } from '../models/AIActionType';
import {
  COGNITION_REVIEW_SYSTEM_PROMPT,
  COGNITION_SYSTEM_PROMPT,
  buildCognitionUserPrompt,
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
  // action key -> when it last closed unsuccessfully; suppressed from the offered
  // vocabulary until the window passes (see recentlyFailedActions)
  failedActionsAt: Map<string, number>;
  // The last action this service dispatched for the sim — guards against re-dispatching
  // it while the sim is still busy executing it (see the redispatch guard in deliberate)
  lastDispatch?: { action: string; at: number };
};

// Base allowance for an in-flight intent before the synthetic close; routing distance
// adds ~1s per meter, doubled for margin (the club DJ booth run took ~45s over 50m).
const PENDING_BASE_MS = 90_000;
const MS_PER_METER = 1_000;

// How long an action that just failed/was ineligible stays out of a sim's offered
// vocabulary. The world state that made it fail rarely changes within a few ticks, so
// re-offering it immediately produces an identical failure in a loop (observed live: a
// mailbox with no payable bill lured 'pay_bills' retries every tick until fixed).
const FAILED_ACTION_SUPPRESS_MS = 10 * 60_000;

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
  return /^(idle|stand|sim-stand|emotion_idle)/i.test(name);
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
const ONE_SHOT_ACTIONS = new Set(['hire_repair_service', 'pay_bills', 'call_firefighter', 'go_out']);

// Retry wrapper: each attempt gets a fresh request and its own timeout. Only the LAST
// failure propagates; earlier ones are logged and retried.
async function withRetry<T>(makeAttempt: () => Promise<T>, label: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= LLM_RETRIES; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
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
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${LLM_CALL_TIMEOUT_MS}ms`)), LLM_CALL_TIMEOUT_MS);
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

export type CognitionStats = {
  deliberations: number;
  dispatches: number;
  suggestions: number;
  continues: number;
  invalidIntents: number;
  timeouts: number;
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
  };

  constructor(ctx: ApiContext) {
    this.ctx = ctx;
    ctx.simStateCache.onReport((report) => this.onStateReport(report));
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

    // Rule-based, no LLM: a critical physical need (accident/starvation imminent) gets
    // its fixing action dispatched directly — the model was watched fumbling this
    entries.forEach((entry) => this.maybeFixCriticalNeed(entry, now));

    // A wrecked sim away from home goes HOME as a rule — checked before the walk-in
    // rule so exhaustion outranks joining the party
    if (report.lot?.is_home === false) {
      entries.forEach((entry) => this.maybeGoHomeExhausted(entry, now));
    }

    // Rule-based, no LLM: an idle sim standing OFF the lot can't usefully deliberate —
    // at home send them home (go_home), at a venue walk them in (enter_lot); provenance
    // for both cases lives on maybeRejoinLot
    entries
      .filter((entry) => entry.self?.on_active_lot === false)
      .forEach((entry) => this.maybeRejoinLot(entry, now, report.lot?.is_home === true));

    const candidates = entries
      .filter((entry) => this.isEligible(entry, report, now))
      .sort((a, b) => this.urgencyScore(b, report) - this.urgencyScore(a, report));

    for (const entry of candidates) {
      if (deliberating >= maxConcurrent) {
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
  onOutcome(event: InteractionOutcomeEvent) {
    const runtime = this.runtimes.get(event.sim_id);
    if (!runtime || runtime.phase !== 'PENDING_OUTCOME') {
      return;
    }
    if (event.request_id && runtime.pendingRequestId && event.request_id !== runtime.pendingRequestId) {
      return;
    }
    if (event.outcome !== 'success' && event.action) {
      runtime.failedActionsAt.set(event.action, Date.now());
    }
    // One-shot verbs are DONE on success too — the lot re-offers them until the world
    // catches up (broken sink stays flagged until the repairman arrives), so a success
    // suppresses re-picking exactly like a failure would
    if (event.outcome === 'success' && event.action && ONE_SHOT_ACTIONS.has(event.action)) {
      runtime.failedActionsAt.set(event.action, Date.now());
    }
    this.clearPending(runtime);
    this.toCooldown(event.sim_id);
    log.info(`[Cognition] sim ${event.sim_id} '${event.action ?? ''}' closed: ${event.outcome}`);
  }

  private runtime(simId: string): SimRuntime {
    let runtime = this.runtimes.get(simId);
    if (!runtime) {
      runtime = { phase: 'IDLE', cooldownUntil: 0, deliberatedAt: [], failedActionsAt: new Map() };
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

    // Deliberation triggers: idle, urgent need, or just went idle. A content, busy sim
    // is left alone — continue-bias is structural, not a prompt suggestion. Idle/stand
    // animations count as idle: Emotion_Idle is the game filling dead time.
    const isIdle =
      (!running || isIdleAnimation(running)) &&
      (entry.activity?.queue ?? []).every((queued) => isIdleAnimation(queued));
    const hasLowMotive = this.lowMotives(entry).length > 0;
    const wentIdle = (report.went_idle ?? []).includes(entry.sim_id);
    return isIdle || hasLowMotive || wentIdle;
  }

  private maybeFixCriticalNeed(entry: SimStateEntry, now: number) {
    const simId = entry.sim_id;
    if (!simId || entry.self?.in_ww_scene) {
      return;
    }
    const runtime = this.runtime(simId);
    // Never-re-push still rules; only true in-flight states block. Cooldown does NOT —
    // this IS the emergency lane.
    if (runtime.phase === 'DELIBERATING' || runtime.phase === 'PENDING_OUTCOME') {
      return;
    }
    const needs = entry.self?.needs ?? {};
    const failed = this.recentlyFailedActions(runtime);
    const offered = offeredActions(entry);
    for (const [need, fixes] of Object.entries(CRITICAL_NEED_FIXES)) {
      const value = needs[need];
      if (typeof value !== 'number' || value >= NEED_CRITICAL) {
        continue;
      }
      const action = fixes.find((fix) => offered.objectActions.has(fix) && !failed.has(fix));
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
    if (!simId || entry.self?.in_ww_scene || entry.activity?.in_social) {
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
    if (!simId) {
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
    const emergency = (entry.self?.buffs ?? []).some(
      (buff) => /death|fire|electrocut/i.test(buff),
    );
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
    const entryView = this.withoutSuppressedActions(entry, suppressed);
    const lotActionKeys = (report.lot?.action_keys ?? []).filter((key) => !suppressed.has(key));
    const reportView: SimStateReport =
      suppressed.size === 0 || !report.lot
        ? report
        : { ...report, lot: { ...report.lot, action_keys: lotActionKeys.length > 0 ? lotActionKeys : undefined } };

    const memoriesBlock = await this.relevantMemoriesBlock(entryView);
    const userPrompt = buildCognitionUserPrompt(entryView, reportView, memoriesBlock, [...suppressed]);

    const oneShot = await withRetry(
      () =>
        this.ctx.generationQueue.runCognition(() =>
          this.ctx.ai.runOneShot('Cognition', COGNITION_SYSTEM_PROMPT, userPrompt, 400, undefined, AIActionType.COGNITION),
        ),
      'cognition deliberation',
    );

    const candidate = parseIntentJson(oneShot.text);
    let validated = validateIntent(candidate, entryView, lotActionKeys);
    if (!validated.ok) {
      this.stats.invalidIntents += 1;
      // The rejected action joins the suppression map so the NEXT prompt names it as
      // impossible — without this the model gets no signal and re-picks it every tick
      // (observed live: 3 straight pay_bills rejections after the bills were paid)
      if (candidate?.action) {
        runtime.failedActionsAt.set(normalizeActionKey(candidate.action), Date.now());
      }
      log.warn(`[Cognition] sim ${simId} invalid intent (${validated.reason}); degrading to continue`);
    }
    const modelIntent = validated.ok ? validated.intent : undefined;
    let intent = validated.ok ? validated.intent : validated.fallback;

    // Review dial (user directive: everything through some version of the reviewed
    // pipeline). Review-only at tick cadence — the full director stage belongs to scenes.
    if (validated.ok && intent.kind === 'action' && this.ctx.settings.cognitionPipeline === 'review') {
      intent = await this.reviewIntent(intent, entryView, userPrompt, lotActionKeys);
    }

    if (intent.kind === 'continue' || intent.kind === 'wait') {
      this.storeThought(entry, intent);
      this.stats.continues += 1;
      this.toCooldown(simId, intent.kind === 'wait' ? 2 : 1);
      return;
    }

    const runningNow = entry.activity?.running ?? '';
    const busy =
      (runningNow !== '' && !isIdleAnimation(runningNow)) ||
      (entry.activity?.queue ?? []).some((queued) => !isIdleAnimation(queued));
    const guardBlocks = (candidateIntent: CognitionIntent): string | undefined => {
      if (candidateIntent.kind !== 'action' || !candidateIntent.action || !busy || !runtime.lastDispatch) {
        return undefined;
      }
      if (Date.now() - runtime.lastDispatch.at >= REDISPATCH_WHILE_BUSY_MS) {
        return undefined;
      }
      if (runtime.lastDispatch.action === candidateIntent.action) {
        return 'same action';
      }
      const lastCategory = ACTION_NEED_CATEGORY[runtime.lastDispatch.action];
      if (lastCategory !== undefined && lastCategory === ACTION_NEED_CATEGORY[candidateIntent.action]) {
        return 'same need';
      }
      return undefined;
    };

    const blockReason = guardBlocks(intent);
    if (blockReason) {
      // Code guards outrank the reviewer: if review replaced a clean model intent with
      // one the guard rejects (observed live: model watch_tv -> review grab_snack while
      // cooking), restore the model's pick instead of losing the tick to continue
      if (modelIntent && modelIntent !== intent && !guardBlocks(modelIntent)) {
        log.info(
          `[Cognition] sim ${simId} review pick '${intent.action}' blocked (${blockReason}); restoring model intent '${modelIntent.kind === 'action' ? modelIntent.action : modelIntent.kind}'`,
        );
        intent = { ...modelIntent, thought: intent.thought ?? modelIntent.thought };
        if (intent.kind === 'continue' || intent.kind === 'wait') {
          this.stats.continues += 1;
          this.toCooldown(simId, intent.kind === 'wait' ? 2 : 1);
          return;
        }
      } else {
        this.stats.continues += 1;
        log.info(
          `[Cognition] sim ${simId} is busy on recently dispatched '${runtime.lastDispatch?.action}'; blocking '${intent.action}' (${blockReason})`,
        );
        this.toCooldown(simId);
        return;
      }
    }

    // Interrupt bar: a genuinely busy sim only gets interrupted for a need that is
    // urgently low or an emergency. Everything else waits for idle — the game's queue is
    // not a planning buffer (observed live: a shower at hygiene 31 canceled her TV time).
    if (busy && intent.kind === 'action' && intent.action && intent.urgency !== 'emergency') {
      const needKey = ACTION_NEED_CATEGORY[intent.action];
      const needValue = needKey ? entry.self?.needs?.[needKey] : undefined;
      const urgent = typeof needValue === 'number' && needValue < NEED_URGENT_INTERRUPT;
      if (!urgent) {
        this.stats.continues += 1;
        log.info(
          `[Cognition] sim ${simId} is busy; '${intent.action}' (${needKey ?? 'no need'} ${needValue ?? 'n/a'}) is not urgent enough to interrupt`,
        );
        this.toCooldown(simId);
        return;
      }
    }

    // Thoughts are stored only for intents that survived the guards: a blocked action's
    // justification is a falsehood ("I smell bad" at hygiene 78, observed live) that
    // would poison retrieval as if it were her real inner state
    this.storeThought(entry, intent);

    if (this.ctx.settings.cognitionAutonomyLevel === 'suggest') {
      this.stats.suggestions += 1;
      log.info(
        `[Cognition][suggest] sim ${simId} would ${intent.action}` +
          `${intent.target_sim_id ? ` with ${intent.target_sim_id}` : ''}` +
          `${intent.motivation ? ` — ${intent.motivation}` : ''}`,
      );
      this.toCooldown(simId);
      return;
    }

    try {
      const requestId = this.ctx.actionDispatcher.dispatch({
        sim_id: simId,
        action: intent.action ?? 'chat',
        target_sim_id: intent.target_sim_id,
        target_object_id: intent.target_object_id,
        motivation: intent.motivation ?? intent.thought,
        source: 'cognition',
      });
      runtime.phase = 'PENDING_OUTCOME';
      runtime.pendingRequestId = requestId;
      runtime.pendingAction = intent.action;
      runtime.lastDispatch = { action: intent.action ?? 'chat', at: Date.now() };
      this.stats.dispatches += 1;
      this.armPendingTimeout(simId, runtime, entry, intent);
      log.info(`[Cognition] sim ${simId} -> ${intent.action} (${requestId})`);
    } catch (error) {
      // Dispatcher refused (already in flight — a race with a player push): back off
      log.warn(`[Cognition] dispatch refused for sim ${simId}`, error);
      this.toCooldown(simId);
    }
  }

  private async reviewIntent(
    intent: CognitionIntent,
    entry: SimStateEntry,
    situationPrompt: string,
    lotActionKeys?: string[],
  ): Promise<CognitionIntent> {
    try {
      const review = await withRetry(
        () =>
          this.ctx.generationQueue.runCognition(() =>
            this.ctx.ai.runOneShot(
              'Cognition Review',
              COGNITION_REVIEW_SYSTEM_PROMPT,
              `${situationPrompt}\n\nChosen intent:\n${JSON.stringify(intent)}`,
              300,
              undefined,
              AIActionType.COGNITION,
            ),
          ),
        'cognition review',
      );
      const reviewed = validateIntent(parseIntentJson(review.text), entry, lotActionKeys);
      if (reviewed.ok) {
        if (JSON.stringify(reviewed.intent) !== JSON.stringify(intent)) {
          log.info(`[Cognition] review adjusted intent: ${intent.action} -> ${reviewed.intent.kind === 'action' ? reviewed.intent.action : reviewed.intent.kind}`);
        }
        return { ...reviewed.intent, thought: reviewed.intent.thought ?? intent.thought };
      }
    } catch (error) {
      log.warn('[Cognition] review pass failed; keeping original intent', error);
    }
    return intent;
  }

  // Prunes expired entries and returns the still-suppressed action keys for this sim
  private recentlyFailedActions(runtime: SimRuntime): Set<string> {
    const cutoff = Date.now() - FAILED_ACTION_SUPPRESS_MS;
    [...runtime.failedActionsAt.entries()].forEach(([action, at]) => {
      if (at < cutoff) {
        runtime.failedActionsAt.delete(action);
      }
    });
    return new Set(runtime.failedActionsAt.keys());
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

  private storeThought(entry: SimStateEntry, intent: CognitionIntent) {
    if (!intent.thought) {
      return;
    }
    try {
      // Thoughts constrain later retrieval (what a sim thinks shapes what it says), but
      // never subtitle or pause the game at tick cadence
      this.ctx.memoryRepository.createMemory(
        {
          memory: {
            content: intent.thought,
            location_id: Number(entry.location?.zone_id ?? 0),
            event_type: 'thought',
          },
          participants: [{ id: entry.sim_id }],
        },
        { notifyMod: false },
      );
    } catch (error) {
      log.warn(`[Cognition] failed to store thought for sim ${entry.sim_id}`, error);
    }
  }

  private async relevantMemoriesBlock(entry: SimStateEntry): Promise<string | undefined> {
    if (!this.ctx.settings.memoryRetrievalEnabled) {
      return undefined;
    }
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
    const timeoutMs = Math.max(PENDING_BASE_MS, 2 * distance * MS_PER_METER + PENDING_BASE_MS / 2);
    runtime.pendingTimer = setTimeout(() => {
      if (runtime.phase !== 'PENDING_OUTCOME') {
        return;
      }
      this.stats.timeouts += 1;
      log.warn(
        `[Cognition] sim ${simId} '${runtime.pendingAction}' produced no outcome in ${Math.round(timeoutMs / 1000)}s; releasing`,
      );
      // A timed-out action failed in every way that matters — suppress it like a failed
      // outcome, or the model re-picks it immediately (observed live: sit -> timeout ->
      // sit again 20s later)
      if (runtime.pendingAction) {
        runtime.failedActionsAt.set(runtime.pendingAction, Date.now());
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
