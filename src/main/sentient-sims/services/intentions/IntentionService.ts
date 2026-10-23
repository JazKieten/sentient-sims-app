// The intention list (autonomy part 5, 2026-10-21; autonomy tier): one ordered row list per
// household Sim per game day, seeded from the state report (IntentionSeeds), fired by
// CognitionService's row lane (the FIRST waiting row whose preconditions hold, one beat per
// Sim per `intentionBeatMinutes` unless a need row), marked done by the mod's outcome and
// the game's goal events, and put to sleep by a structural cause until it clears. The
// model is never called from here.
import log from 'electron-log';
import type { ApiContext } from '../ApiContext';
import type { AutonomyServices } from '../../tiers/autonomy';
import type { SimStateEntry, SimStateReport } from '../../models/SimStateReport';
import type { InteractionOutcomeEvent } from '../../models/ActionIntent';
import type { CognitionGoalCompleted } from '../../models/ModLogWebsocketMessage';
import {
  DeliberateDesire,
  IntentionRow,
  RowClears,
  RowClockContext,
  clockMinutes,
  describeRow,
  isOneShotUntil,
  preconditionsHold,
  promptLine,
  untilReached,
} from '../../models/IntentionRow';
import { desireRow, mergeSeeds, orderRows, seedRows } from './IntentionSeeds';

type SimRows = {
  day: number;
  rows: IntentionRow[];
  lastBeat?: number;
  beatBefore?: number;
  shape?: string;
  paceLoggedAt?: number;
  saveTimer?: ReturnType<typeof setTimeout>;
};

export type PickOptions = {
  // Whitelist keys the runtime holds off (suppressedUntil / fixIneligibleUntil, collision 6)
  suppressed?: (key: string) => boolean;
  // Skip the pace and the preconditions (the debug fire route)
  force?: boolean;
  // An action row's verb the lot can serve in this report (a provider object the mod
  // listed, a lot verb, a social); a row none of whose verbs passes waits (live 2026-10-22:
  // play_piano fired on a lot with no piano and slept the row)
  usable?: (key: string) => boolean;
};

export type IntentionServiceDeps = Partial<Pick<AutonomyServices, 'intentionRepository' | 'modQuery'>>;

const SAVE_DEBOUNCE_MS = 2_000;
const CLAIM_DONE_MINUTES = 10;
const MAX_ATTEMPTS_A_DAY = 3;
const STRUCTURAL_SLEEP_MINUTES = 120;
const PACE_LOG_INTERVAL_MS = 60_000;

// Outcome causes that mean "the moment was wrong, the verb is fine" (CognitionService's
// TRANSIENT_OUTCOME_CAUSES, copied: the service is autonomy's and this list is the row's)
const TRANSIENT_CAUSES = new Set([
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
  'target_asleep',
  'displaced_by_another_interaction',
  'interrupted_while_running',
  'canceled_by_player',
  'player_directed_interaction_pending',
  'object_in_use',
  'starved_behind_running_interaction',
]);

// Causes that never clear today (age, trait, relationship gates: dropped at day end)
const NEVER_CAUSES = new Set([
  'incest_rules_block',
  'relationship_gate_blocks_romance',
  'trait_gated_affordance_variant',
  'actor_age_blocked',
  'target_age_blocked',
  'skill_level_too_low',
  'strangers_have_not_met',
  'relationship_too_low',
  'not_valid_species',
  'already_in_home_zone',
  'player_kept_them_home',
]);

function firstName(entry: SimStateEntry | undefined, simId: string): string {
  return (entry?.sim_name ?? '').trim().split(/\s+/)[0] || `sim ${simId}`;
}

export class IntentionService {
  private readonly ctx: ApiContext;

  private readonly deps: IntentionServiceDeps;

  private readonly sims = new Map<string, SimRows>();

  // Lot-level claims completed recently: claim -> absolute minute (decision 8)
  private readonly claimsDone = new Map<string, number>();

  constructor(ctx: ApiContext, deps: IntentionServiceDeps) {
    this.ctx = ctx;
    this.deps = deps;
    deps.modQuery?.onGoalCompleted((event) => {
      this.onGoalCompleted(event);
    });
  }

  // --- settings -----------------------------------------------------------------------------

  private get beatMinutes(): number {
    const raw = this.ctx.settings.intentionBeatMinutes;
    return Number.isFinite(raw) && raw > 0 ? raw : 120;
  }

  private get needFloor(): number {
    const raw = this.ctx.settings.intentionNeedFloor;
    return Number.isFinite(raw) ? raw : -60;
  }

  // --- state --------------------------------------------------------------------------------

  private dbLoaded(): boolean {
    try {
      return this.ctx.db.isLoaded();
    } catch {
      return false;
    }
  }

  private stateFor(simId: string, day: number): SimRows {
    let state = this.sims.get(simId);
    if (state && state.day === day) {
      return state;
    }
    if (state?.saveTimer) {
      clearTimeout(state.saveTimer);
      this.persist(simId, state);
    }
    let rows: IntentionRow[] = [];
    if (this.dbLoaded()) {
      try {
        rows = this.deps.intentionRepository?.getRows(simId, day) ?? [];
      } catch (error) {
        log.debug(`[Rows] load failed for sim ${simId}: ${String(error)}`);
      }
    }
    // An in-flight row from a previous app run has no pending to answer it
    rows = rows.map((item) =>
      item.status === 'in_flight' ? { ...item, status: 'waiting', requestId: undefined } : item,
    );
    state = { day, rows, shape: rows.map((item) => item.seedKey).join(',') };
    this.sims.set(simId, state);
    return state;
  }

  private markDirty(simId: string, state: SimRows) {
    if (state.saveTimer) {
      return;
    }
    state.saveTimer = setTimeout(() => {
      state.saveTimer = undefined;
      this.persist(simId, state);
    }, SAVE_DEBOUNCE_MS);
    state.saveTimer.unref();
  }

  private persist(simId: string, state: SimRows) {
    if (!this.dbLoaded()) {
      return;
    }
    try {
      this.deps.intentionRepository?.saveRows(simId, state.day, state.rows);
    } catch (error) {
      log.debug(`[Rows] save failed for sim ${simId}: ${String(error)}`);
    }
  }

  flush() {
    this.sims.forEach((state, simId) => {
      if (state.saveTimer) {
        clearTimeout(state.saveTimer);
        state.saveTimer = undefined;
      }
      this.persist(simId, state);
    });
  }

  // Rows are per save: a new database means a new cache
  onDatabaseLoaded() {
    this.sims.forEach((state) => {
      if (state.saveTimer) {
        clearTimeout(state.saveTimer);
      }
    });
    this.sims.clear();
    this.claimsDone.clear();
  }

  // The mod's websocket closed: every in-flight row's outcome is lost
  onModDisconnected() {
    this.sims.forEach((state, simId) => {
      let changed = false;
      for (const item of state.rows) {
        if (item.status === 'in_flight') {
          item.status = 'waiting';
          item.requestId = undefined;
          changed = true;
        }
      }
      if (changed) {
        // The push never ran: the beat goes back too
        state.lastBeat = state.beatBefore;
        this.markDirty(simId, state);
      }
    });
  }

  private context(entry: SimStateEntry, report: SimStateReport): RowClockContext | undefined {
    const nowMinutes = clockMinutes(report);
    if (nowMinutes === undefined) {
      return undefined;
    }
    return { nowMinutes, absoluteDay: report.lot?.clock?.absolute_day, entry, report };
  }

  // --- sync: seeds, merge, expiry, sleep clearing -------------------------------------------

  sync(entry: SimStateEntry, report: SimStateReport) {
    const simId = entry.sim_id;
    const ctx = this.context(entry, report);
    if (!simId || !ctx || ctx.absoluteDay === undefined) {
      return;
    }
    const state = this.stateFor(simId, ctx.absoluteDay);
    const seeded = seedRows(entry, report, { needFloor: this.needFloor });
    const merged = mergeSeeds(state.rows, seeded);
    const rowsById = new Map(merged.map((item) => [item.id, item]));
    merged.forEach((item) => {
      if (item.status === 'waiting' && item.until.kind !== 'once' && untilReached(item, ctx)) {
        // A goal the game marked done before we ever fired it, a bill paid by hand, a need
        // that recovered on its own, a window that closed
        item.status = item.source === 'scene' || item.source === 'conversation' ? 'expired' : 'done';
        if (item.until.kind === 'game_time' && (item.source === 'scene' || item.source === 'conversation')) {
          log.info(`[Rows] ${firstName(entry, simId)} ${item.id} expired: ${item.why}`);
        }
      }
      if (item.status === 'asleep' && item.sleep && this.sleepClears(item.sleep.clears, ctx)) {
        log.info(`[Rows] ${firstName(entry, simId)} ${item.id} woke: ${item.sleep.cause} cleared`);
        item.status = 'waiting';
        item.sleep = undefined;
      }
    });
    const shape = merged.map((item) => item.seedKey).join(',');
    const changed = shape !== state.shape || merged !== state.rows;
    state.rows = merged;
    if (shape !== state.shape) {
      state.shape = shape;
      const listed = merged
        .filter((item) => item.status !== 'done' && item.status !== 'expired')
        .map((item, index) => `${index + 1}. ${describeRow(item)}`);
      log.info(`[Rows] ${firstName(entry, simId)} list: ${listed.join(' ') || '(empty)'}`);
    }
    if (changed) {
      this.markDirty(simId, state);
    }
    void rowsById;
  }

  private sleepClears(clears: RowClears, ctx: RowClockContext): boolean {
    switch (clears.kind) {
      case 'funds_at_least': {
        const funds = ctx.report.lot?.funds;
        return typeof funds === 'number' && funds >= clears.amount;
      }
      case 'zone_change': {
        const zone = ctx.report.lot?.zone_id;
        return (clears.zone_id !== undefined && String(zone) !== clears.zone_id) || ctx.nowMinutes >= clears.until;
      }
      case 'object_fixed':
        return !(ctx.report.lot?.conditions ?? []).some(
          (condition) =>
            condition.object_id === clears.object_id && condition.conditions.some((tag) => tag !== 'dirty'),
        );
      case 'day_end':
      case 'never':
      default:
        return false;
    }
  }

  // --- pick ---------------------------------------------------------------------------------

  // The first waiting row whose preconditions hold, whose claim is free and whose keys the
  // runtime is not holding off, inside the pace (need rows skip it). Note rows never pick.
  pick(entry: SimStateEntry, report: SimStateReport, options: PickOptions = {}): IntentionRow | undefined {
    const simId = entry.sim_id;
    const ctx = this.context(entry, report);
    if (!simId || !ctx || ctx.absoluteDay === undefined) {
      return undefined;
    }
    const state = this.stateFor(simId, ctx.absoluteDay);
    const rowsById = new Map(state.rows.map((item) => [item.id, item]));
    const claimsHeld = this.claimsHeld(simId, ctx.nowMinutes);
    for (const item of state.rows) {
      if (item.status !== 'waiting' || item.what.kind === 'note') {
        continue;
      }
      if (!options.force) {
        const held = preconditionsHold(item, ctx, rowsById);
        if (!held.ok) {
          continue;
        }
        if (item.claim && claimsHeld.has(item.claim)) {
          continue;
        }
        if (options.suppressed && this.keysOf(item).some((key) => options.suppressed?.(key))) {
          continue;
        }
        if (item.what.kind === 'action' && options.usable && !item.what.actions.some(options.usable)) {
          continue;
        }
        if (item.source !== 'need' && state.lastBeat !== undefined) {
          const next = state.lastBeat + this.beatMinutes;
          if (ctx.nowMinutes < next) {
            const now = Date.now();
            if (!state.paceLoggedAt || now - state.paceLoggedAt > PACE_LOG_INTERVAL_MS) {
              state.paceLoggedAt = now;
              log.info(
                `[Rows] ${firstName(entry, simId)} pace: ${item.id} waits for the next beat in ${next - ctx.nowMinutes} min`,
              );
            }
            return undefined;
          }
        }
      }
      return item;
    }
    return undefined;
  }

  private keysOf(item: IntentionRow): string[] {
    if (item.what.kind === 'action') {
      return item.what.actions;
    }
    if (item.what.kind === 'pie') {
      return [...item.what.candidates, ...(item.what.fallback ? [item.what.fallback] : [])];
    }
    return [];
  }

  // Lot-level claims another household Sim holds in flight, or anyone completed recently
  private claimsHeld(simId: string, nowMinutes: number): Set<string> {
    const held = new Set<string>();
    this.sims.forEach((state, otherId) => {
      if (otherId === simId) {
        return;
      }
      state.rows.forEach((item) => {
        if (item.claim && item.status === 'in_flight') {
          held.add(item.claim);
        }
      });
    });
    this.claimsDone.forEach((at, claim) => {
      if (nowMinutes - at < CLAIM_DONE_MINUTES) {
        held.add(claim);
      }
    });
    return held;
  }

  // The verbs the Sim's live note rows hold (work and drama windows): go_out / travel
  heldKeys(simId: string, report: SimStateReport | undefined): Set<string> {
    const held = new Set<string>();
    const entry = this.ctx.simStateCache.getSim(simId);
    const state = this.sims.get(simId);
    if (!state || !report || !entry) {
      return held;
    }
    const ctx = this.context(entry, report);
    if (!ctx) {
      return held;
    }
    state.rows.forEach((item) => {
      if (
        item.what.kind === 'note' &&
        item.status === 'waiting' &&
        item.what.holds &&
        preconditionsHold(item, ctx).ok
      ) {
        item.what.holds.forEach((key) => held.add(key));
      }
    });
    return held;
  }

  // The current action key an action row should try (attempts walk the recipe list)
  // The verb an action row dispatches: the first the lot can serve now, else the list
  // rotated by the attempts so far
  actionFor(item: IntentionRow, usable?: (key: string) => boolean): string | undefined {
    if (item.what.kind !== 'action') {
      return undefined;
    }
    const { actions } = item.what;
    const served = usable ? actions.find(usable) : undefined;
    return served ?? actions[Math.min(item.attempts, actions.length - 1)];
  }

  // --- transitions --------------------------------------------------------------------------

  private find(rowId: string): { simId: string; state: SimRows; item: IntentionRow } | undefined {
    for (const [simId, state] of this.sims) {
      const item = state.rows.find((candidate) => candidate.id === rowId);
      if (item) {
        return { simId, state, item };
      }
    }
    return undefined;
  }

  private findByRequest(
    requestId: string | undefined,
  ): { simId: string; state: SimRows; item: IntentionRow } | undefined {
    if (!requestId) {
      return undefined;
    }
    for (const [simId, state] of this.sims) {
      const item = state.rows.find((candidate) => candidate.requestId === requestId);
      if (item) {
        return { simId, state, item };
      }
    }
    return undefined;
  }

  private nowMinutes(): number | undefined {
    return clockMinutes(this.ctx.simStateCache.getReport());
  }

  private simName(simId: string): string {
    return firstName(this.ctx.simStateCache.getSim(simId), simId);
  }

  // The lane took this row: the beat is spent now (refunded if the dispatch never goes out)
  markFired(rowId: string, detail: string) {
    const found = this.find(rowId);
    if (!found) {
      return;
    }
    const { simId, state, item } = found;
    const now = this.nowMinutes();
    state.beatBefore = state.lastBeat;
    if (item.source !== 'need' && now !== undefined) {
      state.lastBeat = now;
    }
    item.firedAt = Date.now();
    const beat =
      item.source === 'need'
        ? 'need, no beat'
        : `beat ${state.lastBeat !== undefined ? 'taken' : '?'}/${this.beatMinutes} min`;
    log.info(`[Rows] ${this.simName(simId)} fired ${describeRow(item)} ${detail} (${beat})`);
    this.markDirty(simId, state);
  }

  markInFlight(rowId: string, requestId: string, targetObjectId?: string) {
    const found = this.find(rowId);
    if (!found) {
      return;
    }
    found.item.status = 'in_flight';
    found.item.requestId = requestId;
    found.item.targetObjectId = targetObjectId;
    this.markDirty(found.simId, found.state);
  }

  // A dispatch that never went out. An autonomy echo (the Sim is already doing it) counts as
  // satisfied (collision 8); a closed gate costs nothing (the moment, not the row, said no);
  // anything else is an attempt and the beat goes back.
  onStoodDown(rowId: string, options: { echo?: boolean; gate?: boolean; reason?: string } = {}) {
    const found = this.find(rowId);
    if (!found) {
      return;
    }
    const { simId, state, item } = found;
    if (item.status === 'in_flight') {
      return;
    }
    if (options.echo) {
      item.history.push({ at: Date.now(), outcome: 'echo' });
      item.status = isOneShotUntil(item.until) ? 'done' : 'waiting';
      log.info(`[Rows] ${this.simName(simId)} ${item.id} already doing it${item.status === 'done' ? '; done' : ''}`);
    } else {
      state.lastBeat = state.beatBefore;
      if (!options.gate) {
        item.attempts += 1;
        item.history.push({ at: Date.now(), outcome: 'stood_down', cause: options.reason });
        this.sleepIfExhausted(simId, item);
      }
    }
    this.markDirty(simId, state);
  }

  private sleepIfExhausted(simId: string, item: IntentionRow) {
    if (item.attempts >= MAX_ATTEMPTS_A_DAY && item.status === 'waiting') {
      item.status = 'asleep';
      item.sleep = { cause: `${item.attempts} attempts today`, clears: { kind: 'day_end' } };
      log.info(`[Rows] ${this.simName(simId)} ${item.id} asleep(${item.sleep.cause})`);
    }
  }

  // The pending window expired with no outcome: back to waiting, one attempt spent
  onTimeout(requestId: string | undefined) {
    const found = this.findByRequest(requestId);
    if (!found || found.item.status !== 'in_flight') {
      return;
    }
    const { simId, state, item } = found;
    item.status = 'waiting';
    item.requestId = undefined;
    item.attempts += 1;
    item.history.push({ at: Date.now(), outcome: 'timeout' });
    log.info(`[Rows] ${this.simName(simId)} ${item.id} timed out; waiting (attempt ${item.attempts})`);
    this.sleepIfExhausted(simId, item);
    this.markDirty(simId, state);
  }

  // The mod's outcome for a row's push (decisions 9 and 10)
  onOutcome(event: InteractionOutcomeEvent) {
    const found = this.findByRequest(event.request_id);
    if (!found) {
      return;
    }
    const { simId, state, item } = found;
    if (item.status !== 'in_flight') {
      return;
    }
    const name = this.simName(simId);
    item.requestId = undefined;
    item.history.push({ at: Date.now(), outcome: event.outcome, cause: event.cause });
    if (event.outcome !== 'success' && event.decided_at === 'dispatch') {
      // The mod refused before anything touched the queue: nothing ran, the beat goes back
      state.lastBeat = state.beatBefore;
    }
    const now = this.nowMinutes();
    if (event.outcome === 'success') {
      if (item.claim && now !== undefined) {
        this.claimsDone.set(item.claim, now);
      }
      if (isOneShotUntil(item.until)) {
        item.status = 'done';
        log.info(`[Rows] ${name} ${item.id} done: ${item.why}`);
      } else {
        item.status = 'waiting';
        log.info(
          `[Rows] ${name} ${item.id} succeeded once; ${item.until.kind === 'want_absent' ? 'the want' : 'the goal'} decides when it is done`,
        );
      }
      this.markDirty(simId, state);
      return;
    }
    const reason = `${event.cause ?? ''} ${event.reason ?? ''}`.toLowerCase();
    const picker = /picker/.test(reason);
    if (picker && item.what.kind === 'pie' && item.what.fallback) {
      item.what = { kind: 'action', actions: [item.what.fallback] };
      item.status = 'waiting';
      log.info(`[Rows] ${name} ${item.id} opened a picker; now ${describeRow(item)}`);
      this.markDirty(simId, state);
      return;
    }
    const structural =
      event.outcome === 'ineligible' ||
      (!!event.cause && !TRANSIENT_CAUSES.has(event.cause) && event.outcome !== 'canceled');
    if (structural) {
      item.status = 'asleep';
      item.sleep = { cause: event.cause ?? event.reason ?? event.outcome, clears: this.clearsFor(event, item, now) };
      log.info(`[Rows] ${name} ${item.id} asleep(${item.sleep.cause}) until ${item.sleep.clears.kind}`);
      this.markDirty(simId, state);
      return;
    }
    item.status = 'waiting';
    item.attempts += 1;
    log.info(
      `[Rows] ${name} ${item.id} ${event.outcome}${event.cause ? ` (${event.cause})` : ''}; waiting (attempt ${item.attempts})`,
    );
    this.sleepIfExhausted(simId, item);
    this.markDirty(simId, state);
  }

  private clearsFor(event: InteractionOutcomeEvent, item: IntentionRow, now: number | undefined): RowClears {
    const text = `${event.cause ?? ''} ${event.reason ?? ''}`.toLowerCase();
    if (/funds|afford|money|simoleon/.test(text)) {
      const amount = item.preconditions.find((condition) => condition.kind === 'funds_at_least');
      return { kind: 'funds_at_least', amount: amount?.kind === 'funds_at_least' ? amount.amount : 1 };
    }
    if (event.cause === 'object_broken' && item.targetObjectId) {
      return { kind: 'object_fixed', object_id: item.targetObjectId };
    }
    if (event.cause && NEVER_CAUSES.has(event.cause)) {
      return { kind: 'never' };
    }
    const zone = this.ctx.simStateCache.getReport()?.lot?.zone_id;
    return {
      kind: 'zone_change',
      zone_id: zone === undefined ? undefined : String(zone),
      until: (now ?? 0) + STRUCTURAL_SLEEP_MINUTES,
    };
  }

  // The game marked a goal done (mod: interactions/ss_goal_events.py). A whim names its row;
  // an aspiration nudge is answered by the next report's goal pool.
  onGoalCompleted(event: CognitionGoalCompleted) {
    const state = this.sims.get(event.sim_id);
    if (!state) {
      return;
    }
    if (event.whim) {
      const item = state.rows.find((candidate) => candidate.seedKey === event.whim && candidate.status !== 'done');
      if (item) {
        item.status = 'done';
        item.history.push({ at: Date.now(), outcome: 'goal_completed' });
        log.info(`[Rows] ${this.simName(event.sim_id)} ${item.id} done: the game completed ${event.whim}`);
        this.markDirty(event.sim_id, state);
        return;
      }
    }
    log.debug(
      `[Rows] ${this.simName(event.sim_id)} ${event.source} goal completed${event.whim ? ` (${event.whim})` : ''}`,
    );
  }

  // --- the deliberate rows ------------------------------------------------------------------

  addDeliberateRow(
    simId: string,
    params: { source: 'scene' | 'conversation'; desire: DeliberateDesire },
  ): IntentionRow | undefined {
    const report = this.ctx.simStateCache.getReport();
    const entry = this.ctx.simStateCache.getSim(simId);
    const now = clockMinutes(report);
    const day = report?.lot?.clock?.absolute_day;
    if (!report || now === undefined || day === undefined) {
      return undefined;
    }
    const state = this.stateFor(simId, day);
    const targetName = params.desire.targetSimId
      ? (entry?.sims ?? []).find((perceived) => perceived.sim_id === params.desire.targetSimId)?.name
      : undefined;
    // Latest wins per source: a newer scene or a newer line replaces the row still waiting
    state.rows = state.rows.filter((item) => !(item.source === params.source && item.status === 'waiting'));
    const item = desireRow(params.source, params.desire, now, targetName);
    state.rows.push(item);
    orderRows(state.rows);
    state.shape = state.rows.map((candidate) => candidate.seedKey).join(',');
    log.info(`[Rows] ${firstName(entry, simId)} added ${describeRow(item)}`);
    this.markDirty(simId, state);
    return item;
  }

  // --- views --------------------------------------------------------------------------------

  hasInFlight(simId: string): boolean {
    return (this.sims.get(simId)?.rows ?? []).some((item) => item.status === 'in_flight');
  }

  rowsFor(simId: string): IntentionRow[] {
    return [...(this.sims.get(simId)?.rows ?? [])];
  }

  all(): Record<string, { day: number; lastBeat?: number; rows: IntentionRow[] }> {
    const out: Record<string, { day: number; lastBeat?: number; rows: IntentionRow[] }> = {};
    this.sims.forEach((state, simId) => {
      out[simId] = { day: state.day, lastBeat: state.lastBeat, rows: [...state.rows] };
    });
    return out;
  }

  // "Your intentions today, in order: 1. ... (waiting for X) 2. ... (on hold: no money)"
  promptLines(simId: string): string[] {
    const state = this.sims.get(simId);
    if (!state) {
      return [];
    }
    const live = state.rows.filter((item) => item.status !== 'done' && item.status !== 'expired');
    if (live.length === 0) {
      return [];
    }
    const report = this.ctx.simStateCache.getReport();
    const entry = this.ctx.simStateCache.getSim(simId);
    const ctx = entry && report ? this.context(entry, report) : undefined;
    const rowsById = new Map(state.rows.map((item) => [item.id, item]));
    const lines = live.slice(0, 8).map((item, index) => `${index + 1}. ${promptLine(item, ctx, rowsById)}`);
    return [`Your intentions today, in order: ${lines.join(' ')}`];
  }
}
