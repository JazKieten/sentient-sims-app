import log from 'electron-log';
import { thoughtMemoryFloor } from '../constants';
import { StageId } from '../pipeline/stages';
import { pushdiag } from './ActionDispatcherService';
import { ApiContext } from './ApiContext';
import type { AutonomyServices } from '../tiers/autonomy';
import { SimStateEntry, SimStateReport, VenueEntry } from '../models/SimStateReport';
import { CognitionIntent, offeredActions, SOCIAL_ACTIONS, validateIntent } from '../models/CognitionIntent';
import { DISCRETIONARY_ACTIONS, isBelowChild, offLoadoutActions } from '../models/ActionLoadout';
import { InteractionOutcomeEvent, VocabularyResult, VocabularyRow } from '../models/ActionIntent';
import { CognitionHoldReleased } from '../models/ModLogWebsocketMessage';
import type { IntentionRow } from '../models/IntentionRow';
import type { IntentionService } from './intentions/IntentionService';
import { ACTION_OPTIONS_PIE_SYSTEM_PROMPT } from '../pipeline/prompts/action';
import { offerableRows, whitelistRows } from '../util/formatVocabulary';
import { describeSim } from './plum/plumLiveSims';
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
  CognitionPromptExtras,
  parseActionChoice,
  parseActionOptions,
  parseTickScores,
} from '../util/formatCognitionPrompt';
import { memoryRecallText } from '../util/memoryRecallText';
import { deniedConversationActions } from '../util/conversationActions';
import { speciesWord } from '../util/alsoPresent';
import { canSpeak } from '../util/speechCapability';
import { markScenePaced } from '../util/pacedScenes';

// A sleeping sim has no tick. isAsleep lives in util/simSleep.ts (core: Plum's <live> block
// reads it too) and is re-exported here for the tier's own callers.
import { isAsleep } from '../util/simSleep';

export { isAsleep };

// Per-sim lifecycle. PENDING_OUTCOME is the never-re-push rule made structural: a sim
// with an intent in flight cannot deliberate again until the outcome POST closes it or
// the distance-aware timeout expires (a pushed interaction quietly routing for 45s is
// WORKING — cancel-and-repush resets the walk from zero).
type SimPhase = 'IDLE' | 'DELIBERATING' | 'PENDING_OUTCOME' | 'COOLDOWN';

type PendingConversation = {
  desire: ConversationDesire;
  sceneId: string;
  at: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: ConversationActionResult) => void;
};

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
  // skips monologue/scores and stages the Action Scene directly. targetSimId: the scene's
  // other participant when there were exactly two, so the vocabulary builds their menu
  armedDesire?: { score: number; reason?: string; thought?: string; at: number; targetSimId?: string };
  // The gate (autonomy part 1): a lane is asking the mod whether the moment is right. The
  // rule lanes became async with it, and this is their only re-entry guard: isEligible and
  // every lane return early while it is set.
  gating?: boolean;
  // G-10: the dispatched intent with its remaining automatic retries (transient causes only)
  pendingIntent?: { intent: CognitionIntent; entry: SimStateEntry; retriesLeft: number };
  // A reply to the player wants to act, but the reply is still airing: held until the
  // scene it came from closes (releaseConversationActions). Latest wins.
  pendingConversation?: PendingConversation;
  // When this sim's unbroken run of feeling bad AWAY from home started, for the
  // "I want to go home" rule. Cleared the moment the mood turns or they are home.
  miserableSince?: number;
  // The intention row the lane is firing right now (autonomy part 5): markInFlight clears
  // it on a dispatch, toCooldown reports it stood down otherwise
  activeRowId?: string;
  // The armed desire came from a row: a refused gate must clear it (collision 2)
  rowArmed?: boolean;
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

// Moods that mean "this place is doing this to me". A venue cannot fix any of them
// the way home can - a seat, a bed, a bathroom, quiet - so a sim who has felt this
// way continuously while OUT eventually wants to leave.
const LEAVE_WORTHY_MOODS = new Set(['uncomfortable', 'tense', 'sad', 'angry', 'embarrassed', 'bored', 'dazed']);

// How long that has to hold before the sim asks to go home. Reports arrive every
// few seconds, so this is the real filter on the rule: anything the lot CAN fix
// (a toilet, a chair, a drink) gets fixed inside this window by the sim's own
// deliberation, and what is left is a bad time the place is causing.
const MISERABLE_AWAY_MS = 5 * 60_000;

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

// The gate (autonomy part 1, 2026-10-21): how long a lane waits for the mod's moment answer,
// how long the vocabulary may take (one pie menu per target, 55-700 ms a Sim), how long a
// player-click hold stands without the mod's hold_released (the mod's own cap is 180 s), and
// how often a failing wire is worth a warning per Sim.
const MOMENT_QUERY_TIMEOUT_MS = 3_000;
const VOCABULARY_QUERY_TIMEOUT_MS = 5_000;
const HOLD_SAFETY_MS = 180_000;
const GATE_WARN_INTERVAL_MS = 60_000;

type GateLane = 'tick' | 'armed' | 'conversation' | 'critical_need' | 'go_home' | 'rejoin' | 'row';
const RULE_LANES = new Set<GateLane>(['critical_need', 'go_home', 'rejoin']);

// What the mod's `moment` query answers (interactions/ss_cognition_query.py)
type MomentAnswer = {
  ok?: boolean;
  key?: string | null;
  why?: string | null;
  head?: string | null;
  interrupts?: string | null;
  hold?: { interaction_id: string; name?: string } | null;
  at_work?: boolean;
  travel_prompt?: boolean;
  special?: string | null;
  in_ww_scene?: boolean;
  departing?: boolean;
};

type GateVerdict =
  | { open: true }
  | { open: false; key: string; why?: string; hold?: string; special?: string; travel_prompt?: boolean };

function pretty(text: string): string {
  return text.replace(/_/g, ' ');
}

// Objects the lot reports as broken (any condition but dirty): their verbs leave the
// vocabulary, so the model never spends a scene on a provider the game will refuse
function brokenProviderIds(report: SimStateReport | undefined): Set<string> {
  return new Set(
    (report?.lot?.conditions ?? [])
      .filter((condition) => condition.conditions.some((tag) => tag !== 'dirty'))
      .map((condition) => condition.object_id),
  );
}

// The verbs a live want needs: the goal pool's want entries carry their action keys, and a
// want name that IS a discretionary key counts too. Never hidden by the day's loadout (part 4).
function wantKeys(entry: SimStateEntry): Set<string> {
  const keys = new Set<string>();
  (entry.self?.goal_pool ?? [])
    .filter((goal) => goal.source === 'want')
    .forEach((goal) => {
      (goal.action_keys ?? []).forEach((key) => keys.add(key));
    });
  (entry.self?.wants ?? []).forEach((want) => {
    const key = want
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_');
    if (DISCRETIONARY_ACTIONS.has(key)) {
      keys.add(key);
    }
  });
  return keys;
}

// How long a scene-armed action desire stays live waiting for its sim to become
// eligible (the conversation to end, the cooldown to pass). Past this, the moment
// has passed — a desire from an hour-old scene should not fire out of nowhere.
const ARMED_DESIRE_TTL_MS = 10 * 60_000;
// A conversation action held for a scene that never closes (renderer gone, round never
// queued) is dropped after this rather than firing into some later, unrelated moment.
const PENDING_CONVERSATION_TTL_MS = 5 * 60_000;

// What a player-facing scene's scorer left a sim wanting (see actOnConversation)
export type ConversationDesire = {
  score: number;
  reason?: string;
  thought?: string;
  speaker: string;
  transcript: string;
  // The directed scene the reply airs in. Given, the action waits for that scene to
  // close so it never cancels the very reply it came from.
  sceneId?: string;
  // Stage and choose, but never dispatch (the bench replaying a conversation)
  suggestOnly?: boolean;
  // Who spoke (tiers/types ConversationActionRequest): a viewer is outside the world
  speakerKind?: 'sim' | 'player' | 'viewer';
  // The Sim the line was about, when the scene had exactly one other Sim
  targetSimId?: string;
};

export type ConversationActionResult = { acted: boolean; intent?: CognitionIntent; deferred?: boolean };

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

// Per-verb success cool-off overrides (default FAILED_ACTION_SUPPRESS_MS). go_out's
// outing occupies the sim through a loading screen already; the full 10 minutes on top
// mostly suppressed legitimate second outings after coming home. The home->bar
// ping-pong guard is TOO_TIRED_TO_GO_OUT, not this window.
const ONE_SHOT_SUPPRESS_MS: Record<string, number> = { go_out: 5 * 60_000 };

// Below this energy, go_out leaves the vocabulary entirely: sleep first, party later.
// Without it the wrecked-rule and the social drive ping-ponged her home->bar->home
// (observed live: home for 17 seconds between trips)
const TOO_TIRED_TO_GO_OUT = -40;

// J8: is there ANY verb the prompt would offer this tick? Object verbs and lot verbs
// come narrowed already; socials are rendered from the static SOCIAL_ACTIONS set minus
// the hidden keys, and only when someone awake is in the room to receive them.
function hasOfferedVerb(entryView: SimStateEntry, lotActionKeys: string[], hiddenActions: Set<string>): boolean {
  const offered = offeredActions(entryView, lotActionKeys);
  if (offered.objectActions.size > 0 || offered.lotActions.size > 0) {
    return true;
  }
  const awakeTarget = [...offered.simTargets.values()].some((target) => !target.asleep);
  return awakeTarget && [...SOCIAL_ACTIONS].some((action) => !hiddenActions.has(action));
}

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

  // Siblings in the autonomy tier (tiers/autonomy.ts), read when they are needed
  private readonly autonomy: Pick<AutonomyServices, 'actionDispatcher' | 'dailyPlan'> &
    Partial<Pick<AutonomyServices, 'modQuery' | 'intentions' | 'nightCall'>>;

  // The gate's holds: sim id -> the player click the mod said holds that Sim, until the mod's
  // hold_released names it (or HOLD_SAFETY_MS passes)
  private readonly holds = new Map<string, { interaction_id: string; name: string; at: number }>();

  // An older mod answered 'unknown kind': neither the moment nor the vocabulary query exists
  // there, so every lane fails open at no cost until the mod reconnects
  private queriesUnsupported = false;

  private readonly gateWarnedAt = new Map<string, number>();

  private pieOverrideWarned = false;

  // The one INFO line that says the legacy tick is off (part 7)
  private legacyTickLogged = false;

  constructor(
    ctx: ApiContext,
    autonomy: Pick<AutonomyServices, 'actionDispatcher' | 'dailyPlan'> &
      Partial<Pick<AutonomyServices, 'modQuery' | 'intentions' | 'nightCall'>>,
  ) {
    this.ctx = ctx;
    this.autonomy = autonomy;
    ctx.simStateCache.onReport((report) => {
      this.onStateReport(report);
    });
    autonomy.modQuery?.onHoldReleased((event) => {
      this.releaseHold(event);
    });
  }

  // --- the gate (autonomy part 1) ---------------------------------------------------------

  // Every lane asks this before a model call or a rule dispatch. In order: the setting; a
  // live hold (a player click the mod told us about, for EVERY lane, no query); the mod's
  // `moment` answer, failing OPEN on a wire failure (warned once a minute per Sim) and
  // latching fail-open on 'unknown kind' (an older mod); a new hold; a special state or a
  // travel prompt (every lane); then the rule lanes are through (the -85 rule is the 100%
  // path, decision 7) and the model lanes close on !ok or at work.
  private async gateFor(simId: string, lane: GateLane, targetSimId?: string): Promise<GateVerdict> {
    if (!this.ctx.settings.cognitionGateEnabled) {
      return { open: true };
    }
    const held = this.holds.get(simId);
    if (held) {
      if (Date.now() - held.at < HOLD_SAFETY_MS) {
        return { open: false, key: 'player_click', why: `the player clicked ${held.name}`, hold: held.name };
      }
      this.holds.delete(simId);
    }
    const modQuery = this.autonomy.modQuery;
    if (!modQuery || this.queriesUnsupported) {
      return { open: true };
    }
    const args: Record<string, unknown> = { sim_id: simId, lane };
    if (targetSimId) {
      args.target_sim_id = targetSimId;
    }
    const answer = await modQuery.query<MomentAnswer>('moment', args, MOMENT_QUERY_TIMEOUT_MS);
    if (!answer.ok) {
      if (/unknown kind/i.test(answer.error)) {
        log.info('[Cognition] the mod has no cognition query channel; the gate and the pie vocabulary stand down');
        this.queriesUnsupported = true;
      } else {
        const warnedAt = this.gateWarnedAt.get(simId) ?? 0;
        if (Date.now() - warnedAt > GATE_WARN_INTERVAL_MS) {
          this.gateWarnedAt.set(simId, Date.now());
          log.warn(`[Cognition] moment query for sim ${simId} failed (${answer.error}); gate open`);
        }
      }
      return { open: true };
    }
    const moment = answer.result;
    if (moment.hold?.interaction_id) {
      const name = moment.hold.name ?? 'an interaction';
      this.holds.set(simId, { interaction_id: moment.hold.interaction_id, name, at: Date.now() });
      return { open: false, key: 'player_click', why: moment.why ?? `the player clicked ${name}`, hold: name };
    }
    if (moment.special) {
      return { open: false, key: moment.special, why: moment.why ?? undefined, special: moment.special };
    }
    if (moment.travel_prompt) {
      return { open: false, key: 'travel_prompt', why: moment.why ?? undefined, travel_prompt: true };
    }
    if (RULE_LANES.has(lane)) {
      return { open: true };
    }
    if (moment.ok === false || moment.at_work) {
      return { open: false, key: moment.key ?? (moment.at_work ? 'at_work' : 'moment'), why: moment.why ?? undefined };
    }
    return { open: true };
  }

  // Read after an await, where TypeScript still believes the phase it narrowed before it
  private inFlight(simId: string): boolean {
    const { phase } = this.runtime(simId);
    return phase === 'DELIBERATING' || phase === 'PENDING_OUTCOME';
  }

  private refuseAtGate(simId: string, lane: GateLane, gate: Exclude<GateVerdict, { open: true }>) {
    pushdiag(undefined, 'gate', {
      sim_id: simId,
      lane,
      key: gate.key,
      why: gate.why,
      hold: gate.hold,
      special: gate.special,
      travel_prompt: gate.travel_prompt,
    });
    log.info(
      `[Cognition] sim ${simId} ${lane} lane closed at the gate: ${gate.key}${gate.why ? ` (${gate.why})` : ''}`,
    );
    this.toCooldown(simId);
  }

  // The mod says the click that held a Sim has ended: the hold goes and the Sim may think
  // again now rather than after the cooldown. A hold a newer click replaced stays.
  releaseHold(event: CognitionHoldReleased) {
    const interactionId = event.interaction_id;
    if (!interactionId) {
      return;
    }
    this.holds.forEach((hold, simId) => {
      if (hold.interaction_id !== interactionId) {
        return;
      }
      this.holds.delete(simId);
      const runtime = this.runtimes.get(simId);
      if (runtime && runtime.phase === 'COOLDOWN') {
        runtime.phase = 'IDLE';
      }
      log.info(`[Cognition] sim ${simId} released from the player's ${hold.name} (${event.finishing ?? 'ended'})`);
    });
  }

  // The mod's websocket closed: every hold is stale and the mod that reconnects may know
  // the queries this one did not
  onModDisconnected() {
    this.holds.clear();
    this.queriesUnsupported = false;
  }

  // --- the intention rows (autonomy part 5) ------------------------------------------------

  // The row list, when the tier carries it and the setting is on (collision 12: stubs
  // without either stay on the legacy paths)
  private rows(): IntentionService | undefined {
    return this.ctx.settings.intentionRowsEnabled ? this.autonomy.intentions : undefined;
  }

  // The per-tick deliberation (monologue, scores) and the Action Scene's review stage
  // (autonomy part 7): on only when cognitionLegacyTick says so, whether or not rows are on
  private legacyTick(): boolean {
    return this.ctx.settings.cognitionLegacyTick;
  }

  // The suspension the rule lanes skip and the row lane must not: off lot, a WickedWhims
  // scene, mid-social, asleep (factored out of isEligible)
  private suspended(entry: SimStateEntry): boolean {
    return (
      entry.self?.on_active_lot === false ||
      entry.self?.in_ww_scene === true ||
      entry.activity?.in_social === true ||
      isAsleep(entry)
    );
  }

  // --- the vocabulary (autonomy part 2) ----------------------------------------------------

  private pieVocabularyAvailable(): boolean {
    return (
      this.ctx.settings.cognitionVocabulary === 'pie' &&
      !this.queriesUnsupported &&
      this.autonomy.modQuery !== undefined
    );
  }

  // The mod's pie-menu rows for this Sim (and the desire's target), or undefined when the
  // setting is 'whitelist' or the query fails: the options prompt then falls back to the
  // whitelist exactly as before
  private async vocabularyFor(simId: string, targetSimId?: string): Promise<VocabularyResult | undefined> {
    if (!this.pieVocabularyAvailable()) {
      return undefined;
    }
    const args: Record<string, unknown> = { sim_id: simId };
    if (targetSimId) {
      args.target_sim_id = targetSimId;
    }
    const { modQuery } = this.autonomy;
    if (!modQuery) {
      return undefined;
    }
    const answer = await modQuery.query<VocabularyResult>('vocabulary', args, VOCABULARY_QUERY_TIMEOUT_MS);
    if (!answer.ok) {
      if (/unknown kind/i.test(answer.error)) {
        this.queriesUnsupported = true;
      }
      log.warn(`[Cognition] vocabulary query for sim ${simId} failed (${answer.error}); whitelist prompt instead`);
      return undefined;
    }
    if (!Array.isArray(answer.result.rows)) {
      log.warn(`[Cognition] vocabulary for sim ${simId} had no rows field; whitelist prompt instead`);
      return undefined;
    }
    return answer.result;
  }

  // --- what the prompt sees (autonomy part 3) ----------------------------------------------

  private promptExtras(
    simId: string,
    report: SimStateReport | undefined,
    vocabulary: CognitionPromptExtras['vocabulary'],
  ): CognitionPromptExtras {
    return {
      vocabulary,
      householdLines: this.householdLines(simId, report),
      directorLines: this.directorLines(simId),
      intentionLines: this.rows()?.promptLines(simId) ?? [],
    };
  }

  // The other household Sims right now (Plum's <live> line for each) and what each is already
  // on: on 10-21 Jonah and Alex were sent to the same bills 11 s apart
  private householdLines(simId: string, report: SimStateReport | undefined): string[] {
    const others = (report?.sims ?? []).filter(
      (sim) =>
        sim.sim_id &&
        sim.sim_id !== simId &&
        sim.is_household !== false &&
        speciesWord(sim.self?.species) === undefined,
    );
    if (others.length === 0) {
      return [];
    }
    const lines = others.map((sim) => {
      let line = describeSim(sim, false);
      const inFlight = this.autonomy.actionDispatcher.getInFlight(sim.sim_id)?.intent;
      const on = inFlight?.pie?.label ?? inFlight?.action ?? this.runtimes.get(sim.sim_id)?.pendingAction;
      if (on) {
        const first = (sim.sim_name ?? '').trim().split(/\s+/)[0] || `sim ${sim.sim_id}`;
        line += ` ${first} is already on: ${pretty(on)}.`;
      }
      return line;
    });
    return [`Your household right now: ${lines.join(' | ')}`];
  }

  // Plum's active beat, read off the wake service's public state: cognition must not kill a
  // whispered stargaze with clean_up (10-19). Two lines at most; nothing when there is nothing.
  private directorLines(simId: string): string[] {
    const lines: string[] = [];
    try {
      // The stubs of older tests carry no plum: the catch below answers with no lines
      for (const trigger of this.ctx.plum.wake.list({ live: true })) {
        if (!trigger.doing) {
          continue;
        }
        if (trigger.simId === simId) {
          lines.unshift(
            `A director has you on "${trigger.doing}"${trigger.note ? ` (${trigger.note})` : ''}; do not override it.`,
          );
        } else if (trigger.simName) {
          lines.push(`A director has ${trigger.simName} doing ${trigger.doing}.`);
        }
      }
      const status = this.ctx.ext.director?.status();
      if (status?.active && status.arc) {
        lines.push(`A director is running the scene: ${status.arc}.`);
      }
    } catch (error) {
      log.debug(`[Cognition] director lines unavailable: ${String(error)}`);
    }
    return lines.slice(0, 2);
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
    // Pets are on the report for the roster (ALSO_PRESENT, "which cats are here") and never
    // for cognition. The Calloways' dog Winston was deliberated like a person from 09-16:
    // pay_bills, play_guitar, shower and cook_meal all refused "not of a valid species", and
    // at least 8 go_out dispatches each put the travel-consent prompt up for a dog. Every
    // lane below (daily plans, need rules, go-home, rejoin, deliberation) reads `entries`.
    const entries = (report.sims ?? []).filter((entry) => speciesWord(entry.self?.species) === undefined);
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
          if (this.autonomy.dailyPlan.needsLazyPlan(entry.sim_id, absoluteDayForPlans)) {
            void this.autonomy.dailyPlan.generateLazy(entry, absoluteDayForPlans);
          }
        });
    }

    // Rule-based, no LLM: a critical physical need (accident/starvation imminent) gets
    // its fixing action dispatched directly — the model was watched fumbling this
    entries.forEach((entry) => {
      void this.maybeFixCriticalNeed(entry, now).catch((error: unknown) => {
        log.warn(`[Cognition] critical-need lane failed for sim ${entry.sim_id}`, error);
      });
    });

    // A wrecked sim away from home goes HOME as a rule — checked before the walk-in
    // rule so exhaustion outranks joining the party
    if (report.lot?.is_home === false) {
      entries.forEach((entry) => {
        void this.maybeGoHomeExhausted(entry, now).catch((error: unknown) => {
          log.warn(`[Cognition] go-home lane failed for sim ${entry.sim_id}`, error);
        });
      });
    }

    // ...and so does one who has simply been having a bad time out. Runs for every
    // entry, not just the away case, because the rule's clock has to be RESET at
    // home — otherwise a sim who was miserable indoors asks to turn around the
    // moment they arrive somewhere.
    entries.forEach((entry) => {
      void this.maybeGoHomeMiserable(entry, now, report.lot?.is_home !== false).catch((error: unknown) => {
        log.warn(`[Cognition] miserable lane failed for sim ${entry.sim_id}`, error);
      });
    });

    // Rule-based, no LLM: an idle sim standing OFF the lot can't usefully deliberate —
    // at home send them home (go_home), at a venue walk them in (enter_lot); provenance
    // for both cases lives on maybeRejoinLot
    entries
      .filter((entry) => entry.self?.on_active_lot === false)
      .forEach((entry) => {
        void this.maybeRejoinLot(entry, now, report.lot?.is_home === true).catch((error: unknown) => {
          log.warn(`[Cognition] rejoin lane failed for sim ${entry.sim_id}`, error);
        });
      });

    // The row lane (autonomy part 5): rows go first. For each household Sim not in flight,
    // not gating, not cooling down and not suspended, sync the list and fire the first row
    // whose preconditions hold; the legacy tick below deliberates a Sim only when no row
    // fired for them this report and none is in flight (decision 11).
    const intentions = this.rows();
    const rowFired = new Set<string>();
    if (intentions) {
      entries
        .filter((entry) => entry.is_household !== false && entry.sim_id)
        .forEach((entry) => {
          try {
            intentions.sync(entry, report);
          } catch (error) {
            log.warn(`[Rows] sync failed for sim ${entry.sim_id}`, error);
            return;
          }
          const runtime = this.runtime(entry.sim_id);
          if (runtime.gating || runtime.phase === 'DELIBERATING' || runtime.phase === 'PENDING_OUTCOME') {
            return;
          }
          // A desire armed before this Sim's first report (no list to add a row to then)
          // would wait for a legacy tick that no longer runs: it becomes a scene row now
          if (!this.legacyTick() && runtime.armedDesire && !runtime.rowArmed) {
            const { at, ...desire } = runtime.armedDesire;
            runtime.armedDesire = undefined;
            if (Date.now() - at < ARMED_DESIRE_TTL_MS) {
              intentions.addDeliberateRow(entry.sim_id, { source: 'scene', desire });
            }
          }
          if (runtime.phase === 'COOLDOWN' && now < runtime.cooldownUntil) {
            return;
          }
          if (this.suspended(entry)) {
            return;
          }
          const row = intentions.pick(entry, report, {
            suppressed: (key) =>
              this.recentlyFailedActions(runtime).has(key) || (runtime.fixIneligibleUntil.get(key) ?? 0) > now,
            usable: this.usableVerbs(entry, report),
          });
          if (!row) {
            return;
          }
          if (row.what.kind === 'deliberate') {
            if (deliberating >= maxConcurrent) {
              return;
            }
            deliberating += 1;
          }
          rowFired.add(entry.sim_id);
          void this.fireRow(entry, report, row).catch((error: unknown) => {
            log.error(`[Rows] firing ${row.id} crashed for sim ${entry.sim_id}`, error);
            this.toCooldown(entry.sim_id);
          });
        });
    }

    // The night call (part 6): a queued Sim's turn starts here when Plum is idle
    try {
      this.autonomy.nightCall?.tick(report);
    } catch (error) {
      log.warn('[Night] tick failed', error);
    }

    // Part 7: the legacy per-tick deliberation runs only behind cognitionLegacyTick
    if (!this.legacyTick()) {
      if (!this.legacyTickLogged) {
        this.legacyTickLogged = true;
        log.info('[Cognition] legacy tick off: rows decide (cognitionLegacyTick)');
      }
      return;
    }
    this.legacyTickLogged = false;

    const candidates = entries
      .filter((entry) => !rowFired.has(entry.sim_id) && !(intentions?.hasInFlight(entry.sim_id) ?? false))
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
    // The row that fired this push hears every outcome, late ones included (part 5)
    this.autonomy.intentions?.onOutcome(event);
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
      runtime.suppressedUntil.set(
        event.action,
        Date.now() + (ONE_SHOT_SUPPRESS_MS[event.action] ?? FAILED_ACTION_SUPPRESS_MS),
      );
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
    if (runtime.gating || runtime.phase === 'DELIBERATING' || runtime.phase === 'PENDING_OUTCOME') {
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
    if (isAsleep(entry)) {
      // Asleep: nothing to deliberate, and a low motive must not wake the inner voice
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
    const running = entry.activity?.running ?? '';
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

  private async maybeFixCriticalNeed(entry: SimStateEntry, now: number): Promise<void> {
    const simId = entry.sim_id;
    // NPC entries are desire-only passengers: the game runs their needs and homes
    if (!simId || entry.self?.in_ww_scene || entry.is_household === false) {
      return;
    }
    const runtime = this.runtime(simId);
    // Never-re-push still rules; only true in-flight states block. Cooldown does NOT —
    // this IS the emergency lane.
    if (runtime.gating || runtime.phase === 'DELIBERATING' || runtime.phase === 'PENDING_OUTCOME') {
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
      // The gate: a player's click and the special states hold even the emergency lane;
      // asleep, mid-social and at work do not (decision 7: the -85 rule is the 100% path)
      runtime.gating = true;
      try {
        const gate = await this.gateFor(simId, 'critical_need');
        if (this.inFlight(simId)) {
          return;
        }
        if (!gate.open) {
          this.refuseAtGate(simId, 'critical_need', gate);
          return;
        }
        if (this.ctx.settings.cognitionAutonomyLevel === 'suggest') {
          log.info(`[Cognition][suggest] sim ${simId} ${need} at ${value}; would rule-dispatch ${action}`);
          this.toCooldown(simId);
          return;
        }
        try {
          const requestId = this.autonomy.actionDispatcher.dispatch({
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
      } finally {
        runtime.gating = false;
      }
      return;
    }
  }

  // Away from home, the game's own passout fallback is a terrible night out: an
  // exhausted sim — or one starving somewhere with no food on offer — heads HOME as a
  // rule, no LLM; bed and fridge live there (observed live: Energy -79 at the bar while
  // the model kept trying the broken TV). Mid-social sims finish their conversation
  // first; the rule fires on the next report after it ends.
  private async maybeGoHomeExhausted(entry: SimStateEntry, now: number): Promise<void> {
    const simId = entry.sim_id;
    if (!simId || entry.self?.in_ww_scene || entry.activity?.in_social || entry.is_household === false) {
      return;
    }
    const runtime = this.runtime(simId);
    if (runtime.gating || runtime.phase === 'DELIBERATING' || runtime.phase === 'PENDING_OUTCOME') {
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
    runtime.gating = true;
    try {
      const gate = await this.gateFor(simId, 'go_home');
      if (this.inFlight(simId)) {
        return;
      }
      if (!gate.open) {
        this.refuseAtGate(simId, 'go_home', gate);
        return;
      }
      if (this.ctx.settings.cognitionAutonomyLevel === 'suggest') {
        log.info(`[Cognition][suggest] sim ${simId} is wrecked away from home (${why}); would go_home`);
        this.toCooldown(simId);
        return;
      }
      try {
        const requestId = this.autonomy.actionDispatcher.dispatch({
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
    } finally {
      runtime.gating = false;
    }
  }

  // Rule-based, no LLM: an idle sim standing OFF the lot can't usefully deliberate —
  // perception is street noise, no same-room sims to talk to. At home the fix is
  // go_home; at a venue it is enter_lot (observed live: she traveled to a bar, spawned
  // on the street, and stood outside thinking wistful thoughts while three sims drank
  // inside — nothing ever walked her in).
  // A sim who has been miserable for MISERABLE_AWAY_MS straight while OUT wants to go
  // home. Live 2026-09-19: two sims stood Uncomfortable in a museum indefinitely and
  // nothing in cognition ever proposed leaving — go_home IS offered there (the mod puts
  // it in the lot's action keys off the home lot) and the model simply never picks it
  // over whatever need is loudest. Mood is a fact about how the outing is GOING that no
  // need score captures: a sim can have every motive in the green and still be having a
  // bad time somewhere.
  //
  // This is a proposal, not a departure. The mod asks the player before anything travels
  // (travel/ss_travel_consent), so firing costs a notification the player can wave away,
  // and the mod keeps its own ten-minute cool-off per sim after they do.
  private async maybeGoHomeMiserable(entry: SimStateEntry, now: number, isHome: boolean): Promise<void> {
    const simId = entry.sim_id;
    if (!simId || entry.is_household === false) {
      return;
    }
    const runtime = this.runtime(simId);
    const mood = (entry.self?.mood ?? '').toLowerCase();
    if (isHome || !LEAVE_WORTHY_MOODS.has(mood)) {
      // Home, or feeling fine: the run is over either way. Any leave-worthy mood keeps
      // the clock running, because "uncomfortable then tense" is still one unbroken bad
      // time — it is the feeling bad that has to be continuous, not one flavour of it.
      runtime.miserableSince = undefined;
      return;
    }
    if (runtime.miserableSince === undefined) {
      runtime.miserableSince = now;
      return;
    }
    if (now - runtime.miserableSince < MISERABLE_AWAY_MS) {
      return;
    }
    // The same courtesy every other rule lane shows: never talk over a conversation,
    // never cut in on a sim already deciding or acting, never re-offer a verb the world
    // just refused.
    if (entry.self?.in_ww_scene || entry.activity?.in_social) {
      return;
    }
    if (runtime.gating || runtime.phase === 'DELIBERATING' || runtime.phase === 'PENDING_OUTCOME') {
      return;
    }
    if (this.recentlyFailedActions(runtime).has('go_home')) {
      return;
    }
    const minutes = Math.round((now - runtime.miserableSince) / 60_000);
    const why = `${mood} for ${minutes} min out`;
    runtime.gating = true;
    try {
      const gate = await this.gateFor(simId, 'go_home');
      if (this.inFlight(simId)) {
        return;
      }
      if (!gate.open) {
        this.refuseAtGate(simId, 'go_home', gate);
        return;
      }
      if (this.ctx.settings.cognitionAutonomyLevel === 'suggest') {
        log.info(`[Cognition][suggest] sim ${simId} is having a bad time out (${why}); would go_home`);
        runtime.miserableSince = now;
        this.toCooldown(simId);
        return;
      }
      try {
        const requestId = this.autonomy.actionDispatcher.dispatch({
          sim_id: simId,
          action: 'go_home',
          motivation: `Been ${mood} this whole time out; this place is not working, time to head home.`,
          source: 'cognition',
        });
        runtime.phase = 'PENDING_OUTCOME';
        runtime.pendingRequestId = requestId;
        runtime.pendingAction = 'go_home';
        // Restart rather than clear: if the player says stay, the sim is still out and
        // still miserable and may ask again later. The suppression window above is what
        // keeps that from becoming nagging.
        runtime.miserableSince = now;
        this.stats.dispatches += 1;
        this.armPendingTimeout(simId, runtime, entry, { kind: 'action', action: 'go_home' });
        log.info(`[Cognition] sim ${simId} is having a bad time out (${why}) -> go_home (rule, ${requestId})`);
      } catch (error) {
        log.warn(`[Cognition] miserable go_home dispatch refused for sim ${simId}`, error);
        this.toCooldown(simId);
      }
    } finally {
      runtime.gating = false;
    }
  }

  private async maybeRejoinLot(entry: SimStateEntry, now: number, isHome: boolean): Promise<void> {
    const simId = entry.sim_id;
    const action = isHome ? 'go_home' : 'enter_lot';
    const where = isHome ? 'off the home lot' : 'outside the venue lot';
    if (!simId || entry.is_household === false) {
      return;
    }
    const runtime = this.runtime(simId);
    if (runtime.gating || runtime.phase === 'DELIBERATING' || runtime.phase === 'PENDING_OUTCOME') {
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
    runtime.gating = true;
    try {
      const gate = await this.gateFor(simId, 'rejoin');
      if (this.inFlight(simId)) {
        return;
      }
      if (!gate.open) {
        this.refuseAtGate(simId, 'rejoin', gate);
        return;
      }
      if (this.ctx.settings.cognitionAutonomyLevel === 'suggest') {
        log.info(`[Cognition][suggest] sim ${simId} is idle ${where}; would dispatch ${action}`);
        this.toCooldown(simId);
        return;
      }
      try {
        const requestId = this.autonomy.actionDispatcher.dispatch({
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
    } finally {
      runtime.gating = false;
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

    // The gate, before any model call (autonomy part 1): the armed desire survives a
    // refusal (its TTL decides), so the next eligible tick asks again
    const lane: GateLane = runtime.armedDesire ? 'armed' : 'tick';
    const armedTargetSimId = runtime.armedDesire?.targetSimId;
    const gate = await this.gateFor(simId, lane, armedTargetSimId);
    if (!gate.open) {
      this.refuseAtGate(simId, lane, gate);
      return;
    }

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
    // A live note row (work in an hour, a visitor due) holds the travel verbs (part 5)
    this.rows()
      ?.heldKeys(simId, report)
      .forEach((key) => suppressed.add(key));

    // Daily plan: household sims carry a per-game-day plan (goals + persona + action
    // loadout). No plan for today yet (app restart, never slept) — fire the lazy
    // planner in the background and proceed unfiltered THIS tick; the next tick picks
    // it up. NPCs never plan.
    const absoluteDay = report.lot?.clock?.absolute_day;
    let plan;
    if (entry.is_household !== false && absoluteDay !== undefined) {
      plan = this.autonomy.dailyPlan.activePlan(simId, absoluteDay);
      // (the lazy planner itself now fires from onStateReport — G-7)
    }
    // Off-loadout keys are cut from every offering channel like suppressed ones — but
    // NEVER added to the "NOT possible" line below: the hard filter means ABSENT from
    // the prompt, not named as forbidden
    const offLoadout = offLoadoutActions(plan?.loadout);
    // Part 4: the loadout never hides a verb a live want needs
    wantKeys(entry).forEach((key) => offLoadout.delete(key));
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

    // A broken provider's verbs leave the vocabulary (part 3): the game refuses them anyway
    const brokenObjectIds = brokenProviderIds(report);
    const entryView = this.withoutSuppressedActions(entry, narrowed, brokenObjectIds);
    const lotActionKeys = (report.lot?.action_keys ?? []).filter((key) => !narrowed.has(key));

    // J8: an infant's age gate leaves nothing to pick — no object verb, no lot verb, every
    // social blocked — yet the tick still bought a monologue, scores and a three-stage
    // Action Scene that ended in "no valid options" (Jaz's 09-04 handoff, cause 8: five
    // paid round trips per infant tick). Below CHILD with an empty vocabulary the sim
    // simply rests; a toddler with 'dance' or 'sit' still offered thinks as before.
    if (isBelowChild(entry.self?.age) && !hasOfferedVerb(entryView, lotActionKeys, hiddenActions)) {
      log.debug(`[Cognition] sim ${simId} is ${entry.self?.age} with nothing offered; no deliberation`);
      this.stats.continues += 1;
      this.toCooldown(simId);
      return;
    }
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
    // go_out destinations for the prompt/action scene — only meaningful when the verb
    // survived narrowing (the prompt builder renders nothing otherwise)
    const venues = lotActionKeys.includes('go_out') ? report.venues : undefined;

    // Pie mode (autonomy part 2): the monologue and scores prompts carry the people and the
    // destinations but no whitelist lists; the options prompt below carries the mod's rows
    const pieMode = this.pieVocabularyAvailable();
    const extras = this.promptExtras(simId, report, { mode: pieMode ? 'pie' : 'whitelist' });
    const situationPrompt = buildCognitionUserPrompt(
      entryView,
      reportView,
      memoriesBlock,
      [...suppressed],
      planBlock,
      hiddenActions,
      factsBlock,
      venues,
      extras,
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
          60,
          undefined,
          AIActionType.COGNITION,
          undefined,
          { stageId: StageId.DEFAULT_MODE_MONOLOGUE },
        ),
      );
      tickExchanges.push(monologue.exchange);
      thought = monologue.text.trim().slice(0, 180);
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

    // The vocabulary (autonomy part 2): the mod's pie-menu rows for the options prompt,
    // or the whitelist prompt when the setting says so or the query fails
    let rows: VocabularyRow[] | undefined;
    let optionsPrompt = situationPrompt;
    if (pieMode) {
      const vocabulary = await this.vocabularyFor(simId, armedTargetSimId);
      const built = this.pieOptionsPrompt(vocabulary, narrowed, {
        entryView,
        reportView,
        memoriesBlock,
        suppressed,
        planBlock,
        hiddenActions,
        factsBlock,
        venues,
        lotActionKeys,
        extras,
      });
      rows = built.rows;
      optionsPrompt = built.prompt;
    }

    // ACTION SCENE: the slow brain steps in — director options, the sim's choice, review
    const intent = await this.runActionScene({
      entryView,
      lotActionKeys,
      situationPrompt: optionsPrompt,
      simLabel,
      thought,
      actionReason,
      exchanges: tickExchanges,
      hiddenActions,
      venues,
      rows,
    });
    this.dispatchChosenIntent({ simId, entry, runtime, intent, source: 'cognition' });
  }

  // The options prompt over the mod's rows, and the rows validateIntent binds to. A failed
  // or empty vocabulary means the whitelist prompt, as before.
  private pieOptionsPrompt(
    vocabulary: VocabularyResult | undefined,
    narrowed: Set<string>,
    parts: {
      entryView: SimStateEntry;
      reportView: SimStateReport;
      memoriesBlock?: string;
      suppressed: Set<string>;
      planBlock?: Parameters<typeof buildCognitionUserPrompt>[4];
      hiddenActions: Set<string>;
      factsBlock?: string;
      venues?: VenueEntry[];
      lotActionKeys: string[];
      extras: CognitionPromptExtras;
    },
  ): { prompt: string; rows?: VocabularyRow[] } {
    const { entryView, reportView, memoriesBlock, suppressed, planBlock, hiddenActions, factsBlock, venues, extras } =
      parts;
    if (!vocabulary) {
      return {
        prompt: buildCognitionUserPrompt(
          entryView,
          reportView,
          memoriesBlock,
          [...suppressed],
          planBlock,
          hiddenActions,
          factsBlock,
          venues,
          { ...extras, vocabulary: { mode: 'whitelist' } },
        ),
      };
    }
    const offerable = offerableRows(vocabulary.rows, narrowed);
    const whitelist = whitelistRows(offeredActions(entryView, parts.lotActionKeys), hiddenActions);
    const prompt = buildCognitionUserPrompt(
      entryView,
      reportView,
      memoriesBlock,
      [...suppressed],
      planBlock,
      hiddenActions,
      factsBlock,
      venues,
      {
        ...extras,
        vocabulary: {
          mode: 'pie',
          rows: { offered: offerable.offered, greyed: offerable.greyed, whitelist },
          cannotStartNow: vocabulary.cannot_start_now,
        },
      },
    );
    return { prompt, rows: [...offerable.offered, ...offerable.greyed, ...whitelist] };
  }

  // A reply to the player left this sim wanting to act — the scene's action score crossed
  // the conversation threshold ("you should go paint" answered with "yeah, I've been
  // meaning to"). The Action Scene is staged from the current snapshot once the reply has
  // finished airing (the scene it came from closes — see releaseConversationActions), over
  // the sim's offered vocabulary without the daily-loadout narrowing (the player may have
  // brought up anything the sim can do right now) but WITHOUT the idle/self-care verbs the
  // conversation never mentioned (util/conversationActions: on the 09-22 stream casual
  // lines turned into sit, use_toilet, practice_speech). Dispatched as 'conversation' with
  // the mod's default priority: it queues behind what the sim is doing and yields to the
  // player's own click like any cognition push. The tick's guards — autonomy echo,
  // redispatch while busy, suggest mode — still apply. When the sim cannot be staged
  // right now (no snapshot, a tick in flight, the feature off) the desire is armed for
  // the next tick instead, which is what every scene did before 2026-09-21.
  async actOnConversation(simId: string, desire: ConversationDesire): Promise<ConversationActionResult> {
    if (desire.score < this.ctx.settings.conversationActionScoreThreshold) {
      return { acted: false };
    }
    // A viewer is not in the world (part 4): their line is talk, never an order, unless the
    // player opted in. No arming either: the next tick must not act on it quietly.
    if (desire.speakerKind === 'viewer' && !this.ctx.settings.conversationActionsFromViewers) {
      log.info(
        `[Cognition] sim ${simId}: a viewer's line (${desire.speaker}) scored ${desire.score}; viewers never arm actions`,
      );
      return { acted: false };
    }
    if (!this.ctx.settings.conversationActionsEnabled || this.ctx.settings.cognitionAutonomyLevel === 'off') {
      this.armDesireFromScene(simId, desire);
      return { acted: false };
    }
    if (desire.sceneId && !desire.suggestOnly) {
      return this.holdConversationAction(simId, desire, desire.sceneId);
    }
    const entry = this.ctx.simStateCache.getSim(simId);
    const report = this.ctx.simStateCache.getReport();
    const runtime = this.runtime(simId);
    if (
      !entry ||
      !report ||
      (runtime.gating && !runtime.activeRowId) ||
      runtime.phase === 'DELIBERATING' ||
      runtime.phase === 'PENDING_OUTCOME'
    ) {
      // A row firing this very desire must not arm a second one (part 5)
      if (!runtime.activeRowId) {
        this.armDesireFromScene(simId, desire);
      }
      return { acted: false };
    }
    // The tick's own gates (part 4): asleep, mid-social or in a WickedWhims scene arms the
    // desire for later; the hourly budget counts this deliberation like any other
    if (isAsleep(entry) || entry.activity?.in_social || entry.self?.in_ww_scene) {
      if (!runtime.activeRowId) {
        this.armDesireFromScene(simId, desire);
      }
      return { acted: false };
    }
    const now = Date.now();
    runtime.deliberatedAt = runtime.deliberatedAt.filter((at) => at > now - 60 * 60 * 1000);
    if (runtime.deliberatedAt.length >= this.ctx.settings.cognitionPerSimHourlyBudget) {
      log.info(`[Cognition] sim ${simId} is over the hourly budget; the conversation action is dropped`);
      return { acted: false };
    }
    runtime.deliberatedAt.push(now);
    runtime.phase = 'DELIBERATING';
    this.stats.deliberations += 1;
    const simLabel = entry.sim_name ?? simId;
    log.info(
      `[Cognition] sim ${simId} acting on the conversation with ${desire.speaker}: action ${desire.score}${
        desire.reason ? ` (${desire.reason})` : ''
      }`,
    );
    try {
      const gate = await this.gateFor(simId, 'conversation', desire.targetSimId);
      if (!gate.open) {
        this.refuseAtGate(simId, 'conversation', gate);
        return { acted: false };
      }
      const suppressed = this.recentlyFailedActions(runtime);
      const energy = entry.self?.needs?.energy;
      if (typeof energy === 'number' && energy < TOO_TIRED_TO_GO_OUT) {
        suppressed.add('go_out');
      }
      this.rows()
        ?.heldKeys(simId, report)
        .forEach((key) => suppressed.add(key));
      const ageBlocked = entry.self?.age_blocked ?? [];
      // Idle and self-care verbs the conversation never brought up are off the menu:
      // out of the vocabulary the director sees AND caught by validateIntent if a stage
      // names one anyway
      const denied = deniedConversationActions(desire.transcript);
      const narrowed = new Set([...suppressed, ...ageBlocked, ...denied]);
      const hiddenActions = new Set([...ageBlocked, ...denied]);
      const brokenObjectIds = brokenProviderIds(report);
      const entryView = this.withoutSuppressedActions(entry, narrowed, brokenObjectIds);
      const lotActionKeys = (report.lot?.action_keys ?? []).filter((key) => !narrowed.has(key));
      const reportView: SimStateReport =
        narrowed.size === 0 || !report.lot
          ? report
          : { ...report, lot: { ...report.lot, action_keys: lotActionKeys.length > 0 ? lotActionKeys : undefined } };
      const absoluteDay = report.lot?.clock?.absolute_day;
      const plan =
        entry.is_household !== false && absoluteDay !== undefined
          ? this.autonomy.dailyPlan.activePlan(simId, absoluteDay)
          : undefined;
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
      const memoriesBlock = await this.relevantMemoriesBlock(entryView, absoluteDay);
      const factsBlock = this.knownFactsBlock(simId, entry, absoluteDay);
      const venues = lotActionKeys.includes('go_out') ? report.venues : undefined;
      const pieMode = this.pieVocabularyAvailable();
      const extras = this.promptExtras(simId, report, { mode: pieMode ? 'pie' : 'whitelist' });
      const vocabulary = pieMode ? await this.vocabularyFor(simId, desire.targetSimId) : undefined;
      const built = pieMode
        ? this.pieOptionsPrompt(vocabulary, narrowed, {
            entryView,
            reportView,
            memoriesBlock,
            suppressed,
            planBlock,
            hiddenActions,
            factsBlock,
            venues,
            lotActionKeys,
            extras,
          })
        : {
            prompt: buildCognitionUserPrompt(
              entryView,
              reportView,
              memoriesBlock,
              [...suppressed],
              planBlock,
              hiddenActions,
              factsBlock,
              venues,
              extras,
            ),
          };
      const viewerNote =
        desire.speakerKind === 'viewer'
          ? `\n${desire.speaker} is a viewer watching from outside the world: you cannot talk to, leave or confront them in the world.`
          : '';
      const situationPrompt = `${built.prompt}\n\nWhat was just said to you, in conversation with ${desire.speaker}:\n${desire.transcript}${viewerNote}`;
      const exchanges: LLMExchange[] = [];
      const intent = await this.runActionScene({
        entryView,
        lotActionKeys,
        situationPrompt,
        simLabel,
        thought: desire.thought,
        actionReason: desire.reason,
        exchanges,
        hiddenActions,
        venues,
        rows: built.rows,
      });
      const acted = this.dispatchChosenIntent({
        simId,
        entry,
        runtime,
        intent,
        source: 'conversation',
        motivation: desire.reason ? `After talking with ${desire.speaker}: ${desire.reason}` : undefined,
        suggestOnly: desire.suggestOnly,
      });
      return { acted, intent: intent?.kind === 'action' ? intent : undefined };
    } catch (error) {
      log.warn(`[Cognition] sim ${simId} could not act on the conversation`, error);
      this.toCooldown(simId);
      return { acted: false };
    }
  }

  // The reply is still airing: hold the action until the scene closes. On the 09-22
  // stream the follow-through dispatched while the voiced reply was playing and, with
  // preempt set, cancelled the social carrying it (15+ "[Scene] stopped (hard):
  // preempted", moodlets appraised on 0 heard lines). A second desire for the same sim
  // before release replaces the first — the player kept talking and the later line is
  // the subject now.
  private holdConversationAction(
    simId: string,
    desire: ConversationDesire,
    sceneId: string,
  ): Promise<ConversationActionResult> {
    const runtime = this.runtime(simId);
    this.dropPendingConversation(runtime, { acted: false, deferred: true });
    log.info(
      `[Cognition] sim ${simId} holds a conversation action (${desire.score}${
        desire.reason ? `, ${desire.reason}` : ''
      }) until scene ${sceneId} closes`,
    );
    return new Promise<ConversationActionResult>((resolve) => {
      const timer = setTimeout(() => {
        if (runtime.pendingConversation?.sceneId !== sceneId) {
          return;
        }
        log.info(`[Cognition] sim ${simId}: scene ${sceneId} never closed; dropping the held conversation action`);
        this.dropPendingConversation(runtime, { acted: false, deferred: true });
      }, PENDING_CONVERSATION_TTL_MS);
      timer.unref();
      runtime.pendingConversation = { desire, sceneId, at: Date.now(), timer, resolve };
    });
  }

  private dropPendingConversation(runtime: SimRuntime, result: ConversationActionResult) {
    const pending = runtime.pendingConversation;
    if (!pending) {
      return;
    }
    runtime.pendingConversation = undefined;
    clearTimeout(pending.timer);
    pending.resolve(result);
  }

  /**
   * The scene has closed (ran its course, or the game stopped it): every conversation
   * action held for it is staged now, from a fresh snapshot, with the reply fully heard.
   * Wired from ScenePlaybackRegistry.onSceneClosed.
   */
  releaseConversationActions(sceneId: string) {
    this.runtimes.forEach((runtime, simId) => {
      const pending = runtime.pendingConversation;
      if (!pending || pending.sceneId !== sceneId) {
        return;
      }
      runtime.pendingConversation = undefined;
      clearTimeout(pending.timer);
      // Part 5: for a household Sim the follow-through becomes a row that waits for a moment
      const intentions = this.rows();
      if (intentions && this.ctx.simStateCache.getSim(simId)?.is_household === true) {
        const added = intentions.addDeliberateRow(simId, { source: 'conversation', desire: pending.desire });
        if (added) {
          log.info(`[Cognition] sim ${simId}: scene ${sceneId} closed; the conversation action is row ${added.id}`);
          pending.resolve({ acted: false, deferred: true });
          return;
        }
      }
      log.info(`[Cognition] sim ${simId}: scene ${sceneId} closed; acting on the conversation now`);
      void this.actOnReleasedConversation(simId, pending);
    });
  }

  private async actOnReleasedConversation(simId: string, pending: PendingConversation): Promise<void> {
    try {
      pending.resolve(await this.actOnConversation(simId, { ...pending.desire, sceneId: undefined }));
    } catch (error: unknown) {
      log.warn(`[Cognition] sim ${simId} released conversation action failed`, error);
      pending.resolve({ acted: false });
    }
  }

  // The chosen intent goes out — or does not. The guards that keep a busy or redundant
  // pick from dispatching live here so the tick and a conversation's follow-through share
  // them. Returns true when an action was dispatched.
  private dispatchChosenIntent(params: {
    simId: string;
    entry: SimStateEntry;
    runtime: SimRuntime;
    intent: CognitionIntent | undefined;
    source: 'cognition' | 'conversation';
    motivation?: string;
    suggestOnly?: boolean;
  }): boolean {
    const { simId, entry, runtime, intent, source } = params;
    if (!intent || intent.kind !== 'action' || !intent.action) {
      this.stats.continues += 1;
      this.toCooldown(simId);
      return false;
    }

    const runningNow = entry.activity?.running ?? '';
    const busy =
      (runningNow !== '' && !isIdleAnimation(runningNow)) ||
      (entry.activity?.queue ?? []).some((queued) => !isIdleAnimation(queued));

    // G-9: autonomy-echo guard. The mod reports the whitelist verb the sim is ALREADY
    // doing (reverse index, fallbacks included); dispatching that same verb would only
    // interrupt the fast brain's own rescue to restart it. Counted as continue.
    const runningKey = entry.activity?.running_action_key;
    const runningTuning = entry.activity?.running ?? '';
    if (
      (runningKey && runningKey === intent.action) ||
      (intent.pie && runningTuning && runningTuning === intent.action)
    ) {
      this.stats.continues += 1;
      log.info(
        `[Cognition] sim ${simId} is already doing '${runningKey ?? runningTuning}' (autonomy); '${intent.action}' counted as continue`,
      );
      if (runtime.activeRowId) {
        // Collision 8: an echo satisfies the row (the beat is taken, a one-shot row is done)
        this.autonomy.intentions?.onStoodDown(runtime.activeRowId, { echo: true });
        runtime.activeRowId = undefined;
      }
      this.toCooldown(simId);
      return false;
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
        return false;
      }
    }

    if (params.suggestOnly || this.ctx.settings.cognitionAutonomyLevel === 'suggest') {
      this.stats.suggestions += 1;
      log.info(
        `[Cognition][suggest] sim ${simId} would ${intent.action}` +
          (intent.target_sim_id ? ` with ${intent.target_sim_id}` : '') +
          (intent.motivation ? ` — ${intent.motivation}` : ''),
      );
      this.toCooldown(simId);
      return false;
    }

    try {
      const requestId = this.autonomy.actionDispatcher.dispatch({
        sim_id: simId,
        action: intent.action,
        target_sim_id: intent.target_sim_id,
        target_object_id: intent.target_object_id,
        zone_id: intent.zone_id,
        motivation: params.motivation ?? intent.motivation ?? intent.thought,
        // The mod's default priority for both sources. Until 2026-09-22 a conversation's
        // follow-through went out high-priority with preempt, on the reasoning that an
        // action score of 7+ means changing course now; live, that cancelled the voiced
        // reply it came from and the player's own clicks. It now queues like any push.
        source,
        pie: intent.pie,
        row_id: runtime.activeRowId,
      });
      runtime.phase = 'PENDING_OUTCOME';
      runtime.pendingRequestId = requestId;
      runtime.pendingAction = intent.action;
      runtime.lastDispatch = { action: intent.action, at: Date.now() };
      // G-10: the intent and its remaining automatic retries ride the pending state
      runtime.pendingIntent = { intent, entry, retriesLeft: Math.min(3, Math.max(0, intent.retries ?? 1)) };
      this.stats.dispatches += 1;
      this.armPendingTimeout(simId, runtime, entry, intent);
      const rowId = runtime.activeRowId;
      if (rowId) {
        this.autonomy.intentions?.markInFlight(rowId, requestId, intent.target_object_id);
        runtime.activeRowId = undefined;
      }
      log.info(`[Cognition] sim ${simId} -> ${intent.action} (${requestId}, ${source})`);
      if (rowId) {
        // Part 7: the row's own line, said as the click goes out (pie, action and deliberate
        // rows all dispatch here)
        const row = this.autonomy.intentions?.rowsFor(simId).find((candidate) => candidate.id === rowId);
        if (row?.say) {
          this.voiceWhy(entry, row);
        }
      }
      return true;
    } catch (error) {
      // Dispatcher refused (already in flight — a race with a player push): back off
      log.warn(`[Cognition] dispatch refused for sim ${simId}`, error);
      this.toCooldown(simId);
      return false;
    }
  }

  // The why, voiced (part 7, the design's D4): a fired row's `say` as a "(to self)" line
  // through the existing scene_line path (balloon, mouth, memories row), stored as the Sim's
  // monologue. No model call: the line was written by a seed or the night call.
  private voiceWhy(entry: SimStateEntry, row: IntentionRow) {
    const say = row.say?.trim();
    const name = entry.sim_name?.trim();
    if (!say || !name || !this.ctx.settings.intentionVoiceWhy) {
      return;
    }
    // Older test stubs carry no TTS
    const ai = this.ctx.ai as Partial<Pick<ApiContext['ai'], 'playTtsLines'>> | undefined;
    if (typeof ai?.playTtsLines !== 'function') {
      return;
    }
    try {
      if (!canSpeak(this.ctx, { sim_id: entry.sim_id })) {
        return;
      }
      const speaker = `${name} (to self)`;
      const finalText = `${speaker}: ${say}`;
      this.ctx.memoryRepository.createMemory({
        memory: {
          content: finalText,
          location_id: entry.location?.zone_id ?? 0,
          event_type: 'monologue',
          action: row.why,
        },
        participants: [{ id: entry.sim_id }],
        index: { owner: entry.sim_id },
      });
      markScenePaced(finalText);
      this.ctx.ai.playTtsLines([{ speaker, text: say, simId: entry.sim_id }], undefined, {
        paced: true,
        pacedText: finalText,
      });
      log.info(`[Rows] ${name.split(/\s+/)[0]} says: "${say}"`);
    } catch (error) {
      log.warn(`[Rows] could not voice ${row.id} for sim ${entry.sim_id}`, error);
    }
  }

  // A directed scene's Reflection stage found this sim wanting a change (action score at
  // or over threshold). Mid-scene is not the moment to dispatch — the desire is armed and
  // the next eligible tick stages the Action Scene from a fresh snapshot.
  armDesireFromScene(
    simId: string,
    desire: { score: number; reason?: string; thought?: string; targetSimId?: string },
  ) {
    if (!simId || desire.score < this.ctx.settings.cognitionActionScoreThreshold) {
      return;
    }
    const runtime = this.runtime(simId);
    // Part 5: a household Sim's desire becomes a row that waits for a moment (collision 1:
    // before the first report, or for an NPC, today's armed path)
    const intentions = this.rows();
    const known = this.ctx.simStateCache.getSim(simId);
    if (intentions && known?.is_household === true) {
      const added = intentions.addDeliberateRow(simId, { source: 'scene', desire });
      if (added) {
        return;
      }
    }
    // Part 7: an NPC never gets rows, and with the legacy tick off nothing would act on it
    if (intentions && known?.is_household === false && !this.legacyTick()) {
      log.info(
        `[Cognition] sim ${simId} (not household) desire ${desire.score} dropped: the legacy tick is off and NPCs have no rows`,
      );
      return;
    }
    runtime.armedDesire = { ...desire, at: Date.now() };
    log.info(
      `[Cognition] sim ${simId} armed action desire ${desire.score}${desire.reason ? ` (${desire.reason})` : ''}`,
    );
  }

  // --- firing a row (autonomy part 5) -------------------------------------------------------

  // A whitelist verb this report can serve: a provider object the mod listed, a lot verb
  // (pay_bills while bills are due), or a social (the mod finds the Sim)
  private usableVerbs(entry: SimStateEntry, report: SimStateReport): (key: string) => boolean {
    const offered = offeredActions(entry, report.lot?.action_keys);
    return (key) => offered.objectActions.has(key) || offered.lotActions.has(key) || SOCIAL_ACTIONS.has(key);
  }

  // The intent a pie or action row dispatches: the mod resolves the target ('find') unless
  // the row names a Sim; retries 0 so maybeRetryTransient never re-dispatches under a request
  // id the row never knew (collision 4)
  private rowIntent(
    row: IntentionRow,
    intentions: IntentionService,
    usable: (key: string) => boolean,
  ): CognitionIntent | undefined {
    if (row.what.kind === 'action') {
      const action = intentions.actionFor(row, usable);
      if (!action) {
        return undefined;
      }
      return {
        kind: 'action',
        action,
        target_sim_id: row.target?.sim_id,
        motivation: row.why,
        retries: 0,
      };
    }
    if (row.what.kind === 'pie') {
      const [first] = row.what.candidates;
      if (!first) {
        return undefined;
      }
      return {
        kind: 'action',
        action: first,
        target_sim_id: row.target?.sim_id,
        motivation: row.why,
        retries: 0,
        pie: {
          target_kind: 'find',
          target_id: row.target?.sim_id,
          item: first,
          candidates: [...row.what.candidates],
          label: row.what.label,
        },
      };
    }
    return undefined;
  }

  // Fire one row: the `row` gate for a click (a deliberate row gates itself on its own
  // lane), then the dispatch (action / pie), the existing deliberation with the row as the
  // armed desire (scene), or the existing conversation follow-through (conversation).
  // Every path that does not dispatch ends in toCooldown, which reports the row stood down.
  private async fireRow(entry: SimStateEntry, report: SimStateReport, row: IntentionRow): Promise<void> {
    const simId = entry.sim_id;
    const runtime = this.runtime(simId);
    const intentions = this.autonomy.intentions;
    if (!intentions) {
      return;
    }
    runtime.activeRowId = row.id;
    if (row.what.kind === 'deliberate') {
      intentions.markFired(row.id, '');
      const { desire } = row.what;
      if (row.source === 'conversation' && desire.transcript !== undefined && desire.speaker !== undefined) {
        await this.actOnConversation(simId, {
          score: desire.score,
          reason: desire.reason,
          thought: desire.thought,
          speaker: desire.speaker,
          transcript: desire.transcript,
          speakerKind: desire.speakerKind,
          targetSimId: desire.targetSimId,
          sceneId: undefined,
        });
      } else {
        runtime.armedDesire = {
          score: Math.max(desire.score, this.ctx.settings.cognitionActionScoreThreshold),
          reason: desire.reason,
          thought: desire.thought,
          at: Date.now(),
          targetSimId: desire.targetSimId,
        };
        runtime.rowArmed = true;
        try {
          await this.deliberate(entry, report);
        } finally {
          runtime.rowArmed = false;
        }
      }
      if (runtime.activeRowId === row.id) {
        intentions.onStoodDown(row.id, { reason: 'no dispatch' });
        runtime.activeRowId = undefined;
      }
      return;
    }
    const intent = this.rowIntent(row, intentions, this.usableVerbs(entry, report));
    if (!intent) {
      intentions.onStoodDown(row.id, { reason: 'nothing to click' });
      runtime.activeRowId = undefined;
      return;
    }
    runtime.gating = true;
    try {
      const gate = await this.gateFor(simId, 'row', row.target?.sim_id);
      if (this.inFlight(simId)) {
        intentions.onStoodDown(row.id, { gate: true });
        runtime.activeRowId = undefined;
        return;
      }
      if (!gate.open) {
        // The moment, not the row, said no: the row stays waiting at no cost
        intentions.onStoodDown(row.id, { gate: true });
        runtime.activeRowId = undefined;
        this.refuseAtGate(simId, 'row', gate);
        return;
      }
    } finally {
      runtime.gating = false;
    }
    intentions.markFired(row.id, `-> ${intent.action}${intent.pie ? ' (pie)' : ''}`);
    this.dispatchChosenIntent({ simId, entry, runtime, intent, source: 'cognition' });
  }

  // The debug route: fire a row now, past the pace and the preconditions (the gate still
  // applies). Returns what happened in a word.
  async fireRowNow(simId: string, rowId: string): Promise<{ ok: boolean; error?: string; row?: IntentionRow }> {
    const intentions = this.rows();
    if (!intentions) {
      return { ok: false, error: 'intention rows are off or not part of this build' };
    }
    const entry = this.ctx.simStateCache.getSim(simId);
    const report = this.ctx.simStateCache.getReport();
    if (!entry || !report) {
      return { ok: false, error: `no state report for sim ${simId}` };
    }
    const row = intentions.rowsFor(simId).find((candidate) => candidate.id === rowId);
    if (!row) {
      return { ok: false, error: `sim ${simId} has no row ${rowId}` };
    }
    if (row.status !== 'waiting' && row.status !== 'asleep') {
      return { ok: false, error: `row ${rowId} is ${row.status}` };
    }
    const runtime = this.runtime(simId);
    if (runtime.gating || runtime.phase === 'DELIBERATING' || runtime.phase === 'PENDING_OUTCOME') {
      return { ok: false, error: `sim ${simId} is ${runtime.phase}` };
    }
    row.status = 'waiting';
    row.sleep = undefined;
    await this.fireRow(entry, report, row);
    return { ok: true, row: intentions.rowsFor(simId).find((candidate) => candidate.id === rowId) };
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
    // go_out destinations from the report; validateIntent resolves option.destination
    venues?: VenueEntry[];
    // The pie vocabulary this scene offers (autonomy part 2); undefined = the whitelist
    rows?: VocabularyRow[];
  }): Promise<CognitionIntent | undefined> {
    const {
      entryView,
      lotActionKeys,
      situationPrompt,
      simLabel,
      thought,
      actionReason,
      exchanges,
      hiddenActions,
      venues,
      rows,
    } = params;
    const pie = rows !== undefined;
    if (pie && !this.pieOverrideWarned) {
      const override = this.ctx.settings.stagePromptOverrides[StageId.BASAL_GANGLIA_OPTIONS];
      if (typeof override === 'string' && override.trim().length > 0) {
        this.pieOverrideWarned = true;
        log.warn(
          '[Cognition] a user prompt override exists for basal_ganglia_options while the pie vocabulary is on; it replaces the row-id JSON shape',
        );
      }
    }
    try {
      const optionsShot = await runStage(this.ctx.generationQueue, 'action options', () =>
        this.ctx.ai.runOneShot(
          `Action Options: ${simLabel}`,
          pie ? ACTION_OPTIONS_PIE_SYSTEM_PROMPT : ACTION_OPTIONS_SYSTEM_PROMPT,
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
      const valid: { intent: CognitionIntent; label: string; key: string; tag: string }[] = [];
      parsedOptions.options.forEach((option) => {
        const validated = validateIntent(
          {
            kind: 'action',
            action: option.action,
            target_sim_id: option.target_sim_id,
            target_object_id: option.target_object_id,
            destination: option.destination,
            row: option.row,
            option: option.option,
          },
          entryView,
          lotActionKeys,
          venues,
          rows,
        );
        if (!validated.ok || validated.intent.kind !== 'action' || !validated.intent.action) {
          if (!validated.ok) {
            log.debug(`[Cognition] ${simLabel} action scene dropped an option: ${validated.reason}`);
          }
          return;
        }
        // The hidden set is whitelist keys; a pie row carries a tuning key the mod built
        if (!validated.intent.pie && hiddenActions?.has(validated.intent.action)) {
          log.debug(`[Cognition] ${simLabel} action scene dropped hidden option '${validated.intent.action}'`);
          return;
        }
        // zone_id and the option in the key: two go_out options with different destinations,
        // or two channels of one stereo row, both survive
        const key = `${validated.intent.action}|${validated.intent.target_sim_id ?? ''}|${validated.intent.target_object_id ?? ''}|${validated.intent.zone_id ?? ''}|${validated.intent.pie?.option ?? ''}`;
        if (!valid.some((existing) => existing.key === key)) {
          const row = validated.intent.row
            ? rows?.find((candidate) => candidate.id === validated.intent.row)
            : undefined;
          const tag = validated.intent.pie
            ? `${validated.intent.pie.label ?? validated.intent.action} -> ${row?.target ?? validated.intent.pie.target_kind}`
            : validated.intent.action;
          valid.push({ intent: validated.intent, label: option.label ?? tag, key, tag });
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

      const menu = valid.map((option, index) => `${index + 1}. [${option.tag}] ${option.label}`).join('\n');

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

      // Part 7: the review stage runs only with the legacy tick (the row already decided)
      if (this.legacyTick()) {
        const reviewShot = await runStage(this.ctx.generationQueue, 'action review', () =>
          this.ctx.ai.runOneShot(
            `Action Review: ${simLabel}`,
            ACTION_REVIEW_SYSTEM_PROMPT,
            `${situationPrompt}\n\nOptions:\n${menu}\n\n${simLabel} chose: ${pickedIndex + 1} — [${valid[pickedIndex].tag}] ${valid[pickedIndex].label}${
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

  private withoutSuppressedActions(
    entry: SimStateEntry,
    suppressed: Set<string>,
    brokenObjectIds?: Set<string>,
  ): SimStateEntry {
    if (suppressed.size === 0 && !brokenObjectIds?.size) {
      return entry;
    }
    return {
      ...entry,
      objects: (entry.objects ?? []).map((object) => ({
        ...object,
        // A broken provider keeps its place in the room with no verb (part 3)
        action_keys: brokenObjectIds?.has(object.object_id)
          ? []
          : (object.action_keys ?? []).filter((key) => !suppressed.has(key)),
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
    // A routine moment is thought, not remembered. Gated before the trace below: a
    // pending trace with no memory to attach to would ride along on the next row.
    if (importance !== undefined && importance < thoughtMemoryFloor) {
      log.debug(`[Cognition] sim ${entry.sim_id} thought scored ${importance}; not stored`);
      return;
    }
    // Dev mode reads this back on the thought memory: the deliberation (and review) that
    // decided what the sim does next, prompt and all. Isolated from the write below —
    // this is debug bookkeeping and must never cost the sim its thought.
    try {
      this.ctx.ext.trace?.recordPending([intent.thought], { pipeline: 'cognition', exchanges });
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
      // A reply to the player (chat window, Twitch) recalls WITH the line it answered
      const lines = retrieved.map((result) => memoryRecallText(result.memory));
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
      // The row that fired it goes back to waiting (part 5)
      this.autonomy.intentions?.onTimeout(runtime.pendingRequestId);
      // Release the dispatcher's in-flight entry too — otherwise a lost dispatch (mod
      // websocket down) blocks every future dispatch for this sim until the 10-min TTL
      this.autonomy.actionDispatcher.release?.(runtime.pendingRequestId);
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
        if (runtime.phase !== 'COOLDOWN' || this.autonomy.actionDispatcher.getInFlight?.(simId)) {
          return;
        }
        const requestId = this.autonomy.actionDispatcher.dispatch({
          sim_id: simId,
          action,
          target_sim_id: pending.intent.target_sim_id,
          target_object_id: pending.intent.target_object_id,
          zone_id: pending.intent.zone_id,
          motivation: pending.intent.motivation ?? pending.intent.thought,
          source: 'cognition',
          pie: pending.intent.pie,
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
    // A row that was firing and never dispatched stood down (part 5); a desire it armed must
    // not linger for the legacy tick (collision 2)
    if (runtime.activeRowId) {
      this.autonomy.intentions?.onStoodDown(runtime.activeRowId);
      runtime.activeRowId = undefined;
    }
    if (runtime.rowArmed) {
      runtime.armedDesire = undefined;
    }
  }
}
