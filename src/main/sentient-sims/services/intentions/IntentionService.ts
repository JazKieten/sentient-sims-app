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
  IntentionEdits,
  IntentionRow,
  RowClears,
  RowClockContext,
  WakeOn,
  clockMinutes,
  describeRow,
  isOneShotUntil,
  preconditionsHold,
  promptLine,
  targetPresent,
  untilReached,
} from '../../models/IntentionRow';
import { desireRow, isImpulseRow, mergeSeeds, orderRows, seedRows, storyRow } from './IntentionSeeds';
import {
  NEVER_CAUSES,
  Initiation,
  RowStats,
  classifyOutcome,
  contextSnapshot,
  daySummaryLine,
  initiation,
  isDead,
  statsTag,
} from './RowMemory';
import type { PickRecord, VocabularyAnswer } from './RowMemoryService';
import type { VocabularySeenEntry } from '../../db/RowMemoryRepository';

// A Sim's day ended as this service saw it: the first sync with a new absolute_day
// (autonomy part 6: the night call edits the new day's list from the ending one)
export type DayRollover = {
  simId: string;
  endingDay: number;
  // The ending day's rows as they stood in memory (not a re-read)
  endingRows: IntentionRow[];
  newDay: number;
  // Keys the code retired at this rollover (renovation R1), before the night call reads them
  retired: string[];
};

type SimRows = {
  day: number;
  rows: IntentionRow[];
  lastBeat?: number;
  beatBefore?: number;
  shape?: string;
  paceLoggedAt?: number;
  saveTimer?: ReturnType<typeof setTimeout>;
  // The last pick that returned a row: the eligible set and the state before it (R1)
  lastPick?: PickRecord & { rowId: string };
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

export type IntentionServiceDeps = Partial<
  Pick<AutonomyServices, 'intentionRepository' | 'modQuery' | 'rowMemory' | 'budgetGate'>
>;

const SAVE_DEBOUNCE_MS = 2_000;
const CLAIM_DONE_MINUTES = 10;
const MAX_ATTEMPTS_A_DAY = 3;
// Renovation R2: a row whose initiation set fails is checked at most once per game hour and
// expires after MAX_ABSENT such checks in a row
const ABSENT_CHECK_MINUTES = 60;
export const MAX_ABSENT = 3;
// After a database load or a mod reconnect no row fires for this long: the save loads paused
// and the first reports arrive before the pause does (10-22)
export const ROWS_SETTLE_MS = 15_000;
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

// NEVER_CAUSES (age, trait, relationship gates: dropped at day end) live in RowMemory since R1

function firstName(entry: SimStateEntry | undefined, simId: string): string {
  return (entry?.sim_name ?? '').trim().split(/\s+/)[0] || `sim ${simId}`;
}

// A row the list still carries: not finished, not struck
function isLive(item: IntentionRow): boolean {
  return item.status !== 'done' && item.status !== 'expired' && item.status !== 'dropped';
}

// A story row is one beat: done on its first success, whatever its until says
function doneOnSuccess(item: IntentionRow): boolean {
  return isOneShotUntil(item.until) || item.source === 'story';
}

export class IntentionService {
  private readonly ctx: ApiContext;

  private readonly deps: IntentionServiceDeps;

  private readonly sims = new Map<string, SimRows>();

  // Lot-level claims completed recently: claim -> absolute minute (decision 8)
  private readonly claimsDone = new Map<string, number>();

  private readonly rolloverListeners: ((rollover: DayRollover) => void)[] = [];

  // How many edit_intentions calls landed per Sim (the night call reads it around its turn)
  private readonly editCounts = new Map<string, number>();

  // R3: row id -> when the budget gate last said so in the log (ms)
  private readonly budgetLoggedAt = new Map<string, number>();

  // R2: armed by a database load or a mod reconnect; the first pick after it holds every row
  // for ROWS_SETTLE_MS (settleUntil, ms)
  private settleArmed = false;

  private settleUntil: number | undefined;

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

  onDayRollover(listener: (rollover: DayRollover) => void) {
    this.rolloverListeners.push(listener);
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
    if (state && day > state.day) {
      const retired = this.closeDay(simId, state, day);
      const rollover: DayRollover = { simId, endingDay: state.day, endingRows: state.rows, newDay: day, retired };
      this.rolloverListeners.forEach((listener) => {
        try {
          listener(rollover);
        } catch (error) {
          log.warn(`[Rows] a day rollover listener failed for sim ${simId}`, error);
        }
      });
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

  // The day's end in code, before the night call hears the rollover (renovation R1): the keys
  // that meet D4 retire, the logs are pruned, and one readout line says what the day came to
  private closeDay(simId: string, state: SimRows, newDay: number): string[] {
    const memory = this.deps.rowMemory;
    if (!memory) {
      return [];
    }
    try {
      const zone = this.ctx.simStateCache.getReport()?.lot?.zone_id;
      const retired = memory.retirePass(simId, state.rows, state.day, zone === undefined ? undefined : String(zone));
      memory.prune(newDay);
      log.info(
        daySummaryLine(this.simName(simId), state.day, memory.daySummary(simId, state.day, state.rows, retired)),
      );
      return retired;
    } catch (error) {
      log.warn(`[Rows] closing day ${state.day} failed for sim ${simId}`, error);
      return [];
    }
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
    this.settleArmed = true;
    this.settleUntil = undefined;
  }

  // The mod's websocket closed: every in-flight row's outcome is lost
  onModDisconnected() {
    this.settleArmed = true;
    this.settleUntil = undefined;
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
    const zone = report.lot?.zone_id;
    let seeded = seedRows(entry, report, { needFloor: this.needFloor });
    if (this.deps.rowMemory) {
      seeded = this.deps.rowMemory.retiredFilter(
        simId,
        seeded,
        ctx.absoluteDay,
        zone === undefined ? undefined : String(zone),
      );
    }
    const statusBefore = new Map(state.rows.map((item) => [item.id, item.status]));
    const merged = mergeSeeds(state.rows, seeded);
    const rowsById = new Map(merged.map((item) => [item.id, item]));
    merged.forEach((item) => {
      if (item.status === 'waiting' && item.until.kind !== 'once' && untilReached(item, ctx)) {
        // A goal the game marked done before we ever fired it, a bill paid by hand, a need
        // that recovered on its own, a window that closed
        item.status = isImpulseRow(item) ? 'expired' : 'done';
        if (item.until.kind === 'game_time' && isImpulseRow(item)) {
          log.info(`[Rows] ${firstName(entry, simId)} ${item.id} expired: ${item.why}`);
        }
      }
      const woke = item.status === 'asleep' && item.sleep ? this.sleepClears(simId, item, ctx) : undefined;
      if (woke && item.sleep) {
        log.info(`[Rows] ${firstName(entry, simId)} ${item.id} woke: ${item.sleep.cause} cleared (${woke})`);
        item.status = 'waiting';
        item.sleep = undefined;
      }
      if (item.status === 'expired' && statusBefore.has(item.id) && statusBefore.get(item.id) !== 'expired') {
        this.deps.rowMemory?.expired(simId, item);
      }
    });
    const shape = merged.map((item) => item.seedKey).join(',');
    const changed = shape !== state.shape || merged !== state.rows;
    state.rows = merged;
    if (shape !== state.shape) {
      state.shape = shape;
      log.info(`[Rows] ${firstName(entry, simId)} list: ${IntentionService.listLine(merged)}`);
    }
    if (changed) {
      this.markDirty(simId, state);
    }
    void rowsById;
  }

  private static listLine(rows: IntentionRow[]): string {
    const listed = rows.filter(isLive).map((item, index) => `${index + 1}. ${describeRow(item)}`);
    return listed.join(' ') || '(empty)';
  }

  // What woke a sleeping row, or undefined. A structural sleep waits for an EVENT since R2 (the
  // zone changed, the target arrived, a candidate showed on today's menus, the item ran for
  // someone in the household), never a 2-hour timer; a row slept before R2 keeps its `until`.
  private sleepClears(simId: string, item: IntentionRow, ctx: RowClockContext): string | undefined {
    const clears = item.sleep?.clears;
    if (!clears) {
      return undefined;
    }
    switch (clears.kind) {
      case 'funds_at_least': {
        const funds = ctx.report.lot?.funds;
        return typeof funds === 'number' && funds >= clears.amount ? `funds §${funds}` : undefined;
      }
      case 'zone_change': {
        const zone = ctx.report.lot?.zone_id;
        if (clears.zone_id !== undefined && String(zone) !== clears.zone_id) {
          return `zone changed to ${String(zone)}`;
        }
        if (clears.until !== undefined && ctx.nowMinutes >= clears.until) {
          return 'the old 2-hour re-check';
        }
        return this.wakeEvent(simId, item, clears.wake_on ?? [], ctx);
      }
      case 'object_fixed':
        return (ctx.report.lot?.conditions ?? []).some(
          (condition) =>
            condition.object_id === clears.object_id && condition.conditions.some((tag) => tag !== 'dirty'),
        )
          ? undefined
          : 'the object was fixed';
      case 'day_end':
      case 'never':
      default:
        return undefined;
    }
  }

  private wakeEvent(simId: string, item: IntentionRow, wakeOn: WakeOn[], ctx: RowClockContext): string | undefined {
    if (wakeOn.includes('target_present') && item.target && targetPresent(ctx.entry, item.target.sim_id)) {
      return `${item.target.name ?? 'the target'} arrived`;
    }
    if (item.what.kind !== 'pie' || ctx.absoluteDay === undefined) {
      return undefined;
    }
    const zone = ctx.report.lot?.zone_id === undefined ? undefined : String(ctx.report.lot.zone_id);
    const candidates = [...item.what.candidates, ...(item.what.fallback ? [item.what.fallback] : [])];
    const memory = this.deps.rowMemory;
    if (wakeOn.includes('candidate_seen') && memory && zone !== undefined) {
      const view = memory.vocabularyView(simId, ctx.absoluteDay, zone);
      const seen = candidates.find((candidate) =>
        [...view.targets.values()].some((menu) => menu.keys.has(candidate) || menu.supers.has(candidate)),
      );
      if (seen) {
        return `${seen} is on a menu now`;
      }
    }
    if (wakeOn.includes('ran_by_anyone') && memory) {
      const ran = memory.ranToday(zone, ctx.absoluteDay, candidates);
      if (ran) {
        return `${ran} ran for the household`;
      }
    }
    return undefined;
  }

  // R2: whether the row may START now (its initiation set, judged against the day's menus)
  private initiationFor(simId: string, item: IntentionRow, ctx: RowClockContext): Initiation {
    const memory = this.deps.rowMemory;
    const zone = ctx.report.lot?.zone_id;
    if (!memory || zone === undefined || ctx.absoluteDay === undefined) {
      return initiation(item, { targets: new Map(), checked: new Set() });
    }
    return initiation(item, memory.vocabularyView(simId, ctx.absoluteDay, String(zone)));
  }

  // A row I keeps refusing: counted once per row per day in row_stats, checked at most once a
  // game hour, expired after MAX_ABSENT checks in a row. Returns true when it expired now.
  private absent(simId: string, item: IntentionRow, verdict: Exclude<Initiation, { ok: true }>, now: number) {
    this.deps.rowMemory?.skip(simId, item, verdict.cause);
    const last = item.absent;
    if (last && last.cause === verdict.cause && now - last.lastAt < ABSENT_CHECK_MINUTES) {
      return false;
    }
    item.absent = { count: (last?.count ?? 0) + 1, lastAt: now, cause: verdict.cause };
    if (item.absent.count < MAX_ABSENT) {
      return false;
    }
    item.status = 'expired';
    item.history.push({ at: Date.now(), outcome: 'expired', cause: verdict.cause });
    this.deps.rowMemory?.expired(simId, item);
    log.info(
      `[Rows] ${this.simName(simId)} ${item.id} expired: ${verdict.why} (${item.absent.count} checks an hour apart)`,
    );
    return true;
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
    if (!options.force && this.settling()) {
      return undefined;
    }
    const rowsById = new Map(state.rows.map((item) => [item.id, item]));
    const claimsHeld = this.claimsHeld(simId, ctx.nowMinutes);
    let chosen: IntentionRow | undefined;
    let expired = false;
    // R1: every row that could have fired now, in list order (the decision log's candidate set)
    const eligible: IntentionRow[] = [];
    for (const item of state.rows) {
      if (item.status !== 'waiting' || item.what.kind === 'note') {
        continue;
      }
      if (!options.force && !this.eligible(item, ctx, rowsById, claimsHeld, options)) {
        continue;
      }
      if (!options.force) {
        // R2: a row that cannot start costs nothing (no beat, no attempt) and says why
        const verdict = this.initiationFor(simId, item, ctx);
        if (!verdict.ok) {
          expired = this.absent(simId, item, verdict, ctx.nowMinutes) || expired;
          continue;
        }
        item.absent = undefined;
        // R3: a deliberate row starts a model call only if it can finish in its window
        if (!this.affordable(simId, item, ctx.nowMinutes)) {
          continue;
        }
      }
      if (!chosen) {
        if (!options.force && item.source !== 'need' && state.lastBeat !== undefined) {
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
        chosen = item;
      }
      eligible.push(item);
    }
    if (expired) {
      this.markDirty(simId, state);
    }
    if (chosen) {
      state.lastPick = {
        rowId: chosen.id,
        eligible: eligible.map((item) => ({ id: item.id, source: item.source, kind: item.what.kind })),
        context: contextSnapshot(entry, report),
      };
    }
    return chosen;
  }

  // R3, SOFAI's rule: never start a call that cannot finish in the time left. A refused row is
  // skipped at no cost (the next row may fire) and expires at its window's end as before.
  private affordable(simId: string, item: IntentionRow, nowMinutes: number): boolean {
    const verdict = this.deps.budgetGate?.allows(item, nowMinutes);
    if (!verdict || verdict.ok) {
      return true;
    }
    const now = Date.now();
    const loggedAt = this.budgetLoggedAt.get(item.id) ?? 0;
    if (now - loggedAt > 60 * 60 * 1000) {
      this.budgetLoggedAt.set(item.id, now);
      if (!item.history.some((entry) => entry.cause === 'budget')) {
        item.history.push({ at: now, outcome: 'held', cause: 'budget' });
      }
      log.info(
        `[Rows] ${this.simName(simId)} budget gate: ${item.id} needs ~${Math.round(verdict.needSeconds)} s, ` +
          `its window has ${Math.round(verdict.haveSeconds)} s at this speed`,
      );
    }
    return false;
  }

  // R2: the settle hold after a load or a reconnect (the first pick starts it)
  private settling(): boolean {
    const now = Date.now();
    if (this.settleArmed) {
      this.settleArmed = false;
      this.settleUntil = now + ROWS_SETTLE_MS;
      log.info(`[Rows] settling: no row fires for ${ROWS_SETTLE_MS / 1000} s after a load or a reconnect`);
    }
    return this.settleUntil !== undefined && now < this.settleUntil;
  }

  // Preconditions, claims, held-off keys and an action row's served verbs (pick's filters)
  private eligible(
    item: IntentionRow,
    ctx: RowClockContext,
    rowsById: Map<string, IntentionRow>,
    claimsHeld: Set<string>,
    options: PickOptions,
  ): boolean {
    if (!preconditionsHold(item, ctx, rowsById).ok) {
      return false;
    }
    if (item.claim && claimsHeld.has(item.claim)) {
      return false;
    }
    if (options.suppressed && this.keysOf(item).some((key) => options.suppressed?.(key))) {
      return false;
    }
    if (item.what.kind === 'action' && options.usable && !item.what.actions.some(options.usable)) {
      return false;
    }
    return true;
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
    const pick = state.lastPick?.rowId === item.id ? state.lastPick : undefined;
    const entry = this.ctx.simStateCache.getSim(simId);
    this.deps.rowMemory?.startFire(
      simId,
      item,
      pick ??
        (entry
          ? {
              eligible: [{ id: item.id, source: item.source, kind: item.what.kind }],
              context: contextSnapshot(entry, this.ctx.simStateCache.getReport()),
            }
          : undefined),
    );
    state.lastPick = undefined;
    const beat =
      item.source === 'need'
        ? 'need, no beat'
        : `beat ${state.lastBeat !== undefined ? 'taken' : '?'}/${this.beatMinutes} min`;
    log.info(`[Rows] ${this.simName(simId)} fired ${describeRow(item)} ${detail} (${beat})`);
    this.markDirty(simId, state);
  }

  // `chosen` is what went out (the pie label or the verb), for the decision log
  markInFlight(rowId: string, requestId: string, targetObjectId?: string, chosen?: string) {
    const found = this.find(rowId);
    if (!found) {
      return;
    }
    this.deps.rowMemory?.commitFire(found.item, { requestId, chosen });
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
    if (options.gate) {
      this.deps.rowMemory?.dropFire(item.id);
    } else if (options.echo) {
      this.deps.rowMemory?.echo(simId, item);
    } else {
      this.deps.rowMemory?.commitFire(item, { outcome: 'stood_down', cause: options.reason ?? 'stood_down' });
    }
    if (options.echo) {
      item.history.push({ at: Date.now(), outcome: 'echo' });
      item.status = doneOnSuccess(item) ? 'done' : 'waiting';
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
    this.deps.rowMemory?.timeout(simId, item, item.requestId);
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
    this.deps.rowMemory?.outcome(simId, item, event.request_id, {
      outcome: event.outcome,
      cause: event.cause,
      reason: event.reason,
      ran: event.ran ?? undefined,
      finishing: event.finishing,
    });
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
      if (doneOnSuccess(item)) {
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
    // R3: a story row's click refused on its first target tries the fallback target once
    if (item.what.kind === 'pie' && item.what.fallbackTarget) {
      const counter = classifyOutcome(event.outcome, event.cause, event.reason).counter;
      const noProvider = /no object on the lot provides|no_provider/.test(reason);
      if (counter === 'refusedLive' || counter === 'noTarget' || noProvider) {
        const next = item.what.fallbackTarget;
        item.what = { ...item.what, target: next, fallbackTarget: undefined };
        if (next.kind === 'sim' && next.id) {
          item.target = { sim_id: next.id, name: next.name };
        }
        item.status = 'waiting';
        log.info(`[Rows] ${name} ${item.id} trying the fallback target ${next.name ?? next.id ?? next.kind}`);
        this.markDirty(simId, state);
        return;
      }
    }
    const structural =
      event.outcome === 'ineligible' ||
      (!!event.cause && !TRANSIENT_CAUSES.has(event.cause) && event.outcome !== 'canceled');
    if (structural) {
      item.status = 'asleep';
      item.sleep = { cause: event.cause ?? event.reason ?? event.outcome, clears: this.clearsFor(simId, event, item) };
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

  private clearsFor(simId: string, event: InteractionOutcomeEvent, item: IntentionRow): RowClears {
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
    // R2: events wake it, not a timer. The target's arrival only counts if they were away.
    const wakeOn: WakeOn[] = [];
    const entry = this.ctx.simStateCache.getSim(simId);
    if (item.target && !(entry && targetPresent(entry, item.target.sim_id))) {
      wakeOn.push('target_present');
    }
    if (item.what.kind === 'pie') {
      wakeOn.push('candidate_seen', 'ran_by_anyone');
    }
    return { kind: 'zone_change', zone_id: zone === undefined ? undefined : String(zone), wake_on: wakeOn };
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

  // --- the night call's edits (autonomy part 6) ---------------------------------------------

  // Drop, reword, re-rank and add story rows on today's list. Throws when the Sim has no list
  // today or a row id is unknown, before anything changes (the tool reports the error).
  applyEdits(simId: string, edits: IntentionEdits): { changed: string } {
    const state = this.sims.get(simId);
    const name = this.simName(simId);
    if (!state) {
      throw new Error(`no list for ${name} today; the first report of the day seeds it`);
    }
    const byId = new Map(state.rows.map((item) => [item.id, item]));
    const unknown = [...edits.drop, ...edits.rewrite.map((edit) => edit.row_id)].filter((id) => !byId.has(id));
    if (unknown.length > 0) {
      const live = state.rows.filter(isLive).map((item) => item.id);
      throw new Error(`no row ${unknown.join(', ')} on ${name}'s list today (rows: ${live.join(', ') || 'none'})`);
    }
    const needDrops = edits.drop.filter((id) => byId.get(id)?.source === 'need');
    if (needDrops.length > 0) {
      throw new Error(
        `${needDrops.join(', ')} ${needDrops.length > 1 ? 'are need rows' : 'is a need row'}; needs are never dropped`,
      );
    }
    const now = Date.now();
    edits.drop.forEach((id) => {
      const item = byId.get(id);
      if (item && item.status !== 'in_flight') {
        item.status = 'dropped';
        item.history.push({ at: now, outcome: 'dropped', cause: 'night call' });
      }
    });
    // R1: a dead or retired key is never reworded (ACE: deltas, not rewrites); the rest of the
    // call still applies, since a throw would lose every other edit of a detached turn
    const refused: string[] = [];
    let rewrote = 0;
    edits.rewrite.forEach((edit) => {
      const item = byId.get(edit.row_id);
      if (!item) {
        return;
      }
      const stats = this.deps.rowMemory?.get(simId, item.seedKey);
      if (stats && (isDead(stats) || stats.retiredDay !== undefined)) {
        refused.push(`${item.id} ${statsTag(stats)}`);
        return;
      }
      rewrote += 1;
      if (edit.why || edit.say) {
        this.deps.rowMemory?.rewrote(simId, item);
      }
      if (edit.why) {
        item.why = edit.why;
      }
      if (edit.say) {
        item.say = edit.say;
      }
      if (edit.rank !== undefined) {
        item.rank = edit.rank;
      }
    });
    // R3: why each dead or failed key died, in the night call's words, kept for R4
    (edits.diagnoses ?? []).forEach((diagnosis) => {
      state.rows
        .filter((item) => item.seedKey === diagnosis.key)
        .forEach((item) => {
          item.diagnosis = diagnosis.text;
        });
      this.deps.rowMemory?.diagnose(simId, diagnosis.key, diagnosis.text);
      log.info(`[Night] ${name} diagnosis [${diagnosis.key}]: ${diagnosis.text}`);
    });
    const threshold = this.ctx.settings.cognitionActionScoreThreshold;
    const added = edits.add.map((edit) => storyRow(edit, state.day, threshold));
    const clicks = added.filter((item) => item.what.kind === 'pie').length;
    state.rows.push(...added);
    orderRows(state.rows);
    state.shape = state.rows.map((item) => item.seedKey).join(',');
    this.editCounts.set(simId, (this.editCounts.get(simId) ?? 0) + 1);
    const refusedText =
      refused.length > 0 ? `; refused to reword ${refused.join('; ')} (dead: drop it or leave it)` : '';
    const diagnosed = edits.diagnoses?.length ?? 0;
    const changed =
      `${name}'s list: dropped ${edits.drop.length}, rewrote ${rewrote}, ` +
      `added ${added.length} story row${added.length === 1 ? '' : 's'} (${clicks} with a click), ` +
      `${diagnosed} diagnos${diagnosed === 1 ? 'is' : 'es'}${refusedText}`;
    log.info(
      `[Rows] ${name} night: dropped ${edits.drop.length}, rewrote ${rewrote}, added ${added.length} story rows ` +
        `(${clicks} with a click), ${diagnosed} diagnoses${refusedText}`,
    );
    log.info(`[Rows] ${name} list: ${IntentionService.listLine(state.rows)}`);
    this.markDirty(simId, state);
    return { changed };
  }

  // Whether the Sim has a list for this day (empty or not): edits need one
  hasList(simId: string, day: number): boolean {
    return this.sims.get(simId)?.day === day;
  }

  editsApplied(simId: string): number {
    return this.editCounts.get(simId) ?? 0;
  }

  // A day's stored list (the debug night call reads yesterday's)
  rowsForDay(simId: string, day: number): IntentionRow[] {
    const state = this.sims.get(simId);
    if (state && state.day === day) {
      return [...state.rows];
    }
    if (!this.dbLoaded()) {
      return [];
    }
    try {
      return this.deps.intentionRepository?.getRows(simId, day) ?? [];
    } catch (error) {
      log.debug(`[Rows] load failed for sim ${simId} day ${day}: ${String(error)}`);
      return [];
    }
  }

  // --- row memory (renovation R1) -----------------------------------------------------------

  // Every key's counters for the Sim (the night text, the stats route)
  statsFor(simId: string): RowStats[] {
    return this.deps.rowMemory?.statsFor(simId) ?? [];
  }

  // Say once: a row's line is voiced only if its key has not been said today
  canSay(simId: string, row: IntentionRow): boolean {
    return this.deps.rowMemory?.canSay(simId, row) ?? true;
  }

  markSaid(simId: string, row: IntentionRow) {
    this.deps.rowMemory?.markSaid(simId, row);
  }

  // What the Sim's menus offered on a day, every zone (the night call's clickable lists, R3)
  vocabularySeen(simId: string, day: number): VocabularySeenEntry[] {
    return this.deps.rowMemory?.vocabularySeen(simId, day) ?? [];
  }

  // Every vocabulary answer the app gets is what the Sim's menus offered (R3 reads it at night)
  recordVocabulary(simId: string, answer: VocabularyAnswer, report: SimStateReport | undefined) {
    try {
      this.deps.rowMemory?.recordVocabulary(simId, answer, report);
    } catch (error) {
      log.debug(`[Rows] vocabulary not kept for sim ${simId}: ${String(error)}`);
    }
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
    const live = state.rows.filter(isLive);
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
