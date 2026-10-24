// Row memory (autonomy renovation R1, 2026-10-24; autonomy tier): the counters each row KEY
// carries across days, the decision log of every fire, the household's interactions the mod
// forwards, and the pie items each target offered. Code counts, code retires; no model is
// called from here. Every database touch is guarded: no save loaded means nothing is kept,
// never a throw into the row lane.
import log from 'electron-log';
import type { ApiContext } from '../ApiContext';
import type { SimStateReport } from '../../models/SimStateReport';
import type { IntentionRow } from '../../models/IntentionRow';
import type { CognitionInteractionLogRecord } from '../../models/ModLogWebsocketMessage';
import type { FireLogEntry, RowMemoryRepository, VocabularySeenEntry } from '../../db/RowMemoryRepository';
import {
  CAUSE_TIMEOUT,
  DaySummary,
  DecisionContext,
  RETIRE_CLEAR_DAYS,
  RowStats,
  StatsCounter,
  classifyOutcome,
  emptyStats,
  isJudgedRow,
  shouldRetire,
  statsTag,
} from './RowMemory';

export const INTERACTION_LOG_DAYS = 7;
export const VOCABULARY_DAYS = 3;
// Propensity of the deterministic picker (decision D2: logged now, randomness only with L2)
export const PICKER_PROPENSITY = 1;

export type RowMemoryDeps = { rowMemoryRepository?: RowMemoryRepository };

// The pick that preceded a fire: the eligible rows in order and the state before it
export type PickRecord = {
  eligible: { id: string; source: string; kind: string }[];
  context: DecisionContext;
};

type PendingFire = { simId: string; seedKey: string; judged: boolean; entry: FireLogEntry };

// A vocabulary answer as the mod sends it (ss_cognition_query kind vocabulary)
export type VocabularyAnswer = {
  rows?: {
    target?: string;
    target_id?: string;
    target_kind?: string;
    label?: string;
    key?: string;
    greyed?: boolean;
    reason?: string | null;
  }[];
};

export type OutcomeFacts = {
  outcome: string;
  cause?: string;
  reason?: string;
  ran?: boolean;
  finishing?: string;
};

function vocabularyTarget(kind: string | undefined, targetId: string | undefined, label: string | undefined): string {
  switch (kind) {
    case 'self':
      return 'self';
    case 'sim':
      return `sim:${targetId ?? label ?? '?'}`;
    case 'phone':
      return 'phone';
    default:
      return label ?? targetId ?? kind ?? '?';
  }
}

export class RowMemoryService {
  private readonly ctx: ApiContext;

  private readonly deps: RowMemoryDeps;

  // sim id -> seed key -> stats (loaded lazily per Sim, written through)
  private readonly stats = new Map<string, Map<string, RowStats>>();

  // row id -> a fire the lane took that has not passed the gate yet (decision A)
  private readonly pending = new Map<string, PendingFire>();

  // `${simId}|${day}|${zone}` -> the item keys a menu offered (not greyed) that day
  private readonly vocabularyKeys = new Map<string, Set<string>>();

  private prunedDay: number | undefined;

  constructor(ctx: ApiContext, deps: RowMemoryDeps) {
    this.ctx = ctx;
    this.deps = deps;
  }

  // --- plumbing -----------------------------------------------------------------------------

  private repo(): RowMemoryRepository | undefined {
    const repository = this.deps.rowMemoryRepository;
    try {
      return repository?.isLoaded() ? repository : undefined;
    } catch {
      return undefined;
    }
  }

  private guard<T>(what: string, fn: (repository: RowMemoryRepository) => T): T | undefined {
    const repository = this.repo();
    if (!repository) {
      return undefined;
    }
    try {
      return fn(repository);
    } catch (error) {
      log.debug(`[RowMemory] ${what} failed: ${String(error)}`);
      return undefined;
    }
  }

  private report(): SimStateReport | undefined {
    return this.ctx.simStateCache.getReport();
  }

  private today(): number | undefined {
    return this.report()?.lot?.clock?.absolute_day;
  }

  private simName(simId: string): string {
    return (this.ctx.simStateCache.getSim(simId)?.sim_name ?? '').trim().split(/\s+/)[0] || `sim ${simId}`;
  }

  private cacheFor(simId: string): Map<string, RowStats> {
    let cache = this.stats.get(simId);
    if (!cache) {
      cache = new Map();
      (this.guard('load stats', (repository) => repository.statsFor(simId)) ?? []).forEach((stats) => {
        cache?.set(stats.seedKey, stats);
      });
      this.stats.set(simId, cache);
    }
    return cache;
  }

  get(simId: string, seedKey: string): RowStats | undefined {
    return this.cacheFor(simId).get(seedKey);
  }

  private touch(simId: string, row: Pick<IntentionRow, 'seedKey' | 'why'>): RowStats {
    const cache = this.cacheFor(simId);
    let stats = cache.get(row.seedKey);
    if (!stats) {
      stats = emptyStats(simId, row.seedKey);
      cache.set(row.seedKey, stats);
    }
    const day = this.today();
    if (day !== undefined) {
      stats.firstDay = stats.firstDay ?? day;
      stats.lastDay = day;
    }
    if (row.why) {
      stats.why = row.why;
    }
    return stats;
  }

  private save(stats: RowStats) {
    this.guard('save stats', (repository) => {
      repository.saveStats(stats);
    });
  }

  private bump(simId: string, row: Pick<IntentionRow, 'seedKey' | 'why'>, counter: StatsCounter) {
    const stats = this.touch(simId, row);
    stats[counter] += 1;
    this.save(stats);
    return stats;
  }

  // --- fires --------------------------------------------------------------------------------

  // The lane took a row: held until it passes the gate (a gate refusal costs nothing)
  startFire(simId: string, row: IntentionRow, pick: PickRecord | undefined) {
    const clock = this.report()?.lot?.clock;
    this.pending.set(row.id, {
      simId,
      seedKey: row.seedKey,
      judged: isJudgedRow(row),
      entry: {
        at: new Date().toISOString(),
        day: clock?.absolute_day,
        minute: typeof clock?.hour === 'number' ? clock.hour * 60 + (clock.minute ?? 0) : undefined,
        simId,
        rowId: row.id,
        seedKey: row.seedKey,
        source: row.source,
        whatKind: row.what.kind,
        eligible: pick?.eligible ?? [{ id: row.id, source: row.source, kind: row.what.kind }],
        propensity: PICKER_PROPENSITY,
        context: pick?.context,
      },
    });
  }

  dropFire(rowId: string) {
    this.pending.delete(rowId);
  }

  // The fire passed the gate: counted, and its decision logged. `requestId` = it went out.
  commitFire(row: IntentionRow, facts: { requestId?: string; chosen?: string; outcome?: string; cause?: string }) {
    const pending = this.pending.get(row.id);
    if (!pending) {
      return;
    }
    this.pending.delete(row.id);
    const stats = this.touch(pending.simId, row);
    stats.fires += 1;
    stats.firesSinceRan += 1;
    if (facts.requestId) {
      stats.clicked += 1;
    }
    if (facts.cause) {
      stats.lastCause = facts.cause;
      stats.lastStructural = false;
    }
    this.save(stats);
    const entry: FireLogEntry = {
      ...pending.entry,
      requestId: facts.requestId,
      chosen: facts.chosen,
      outcome: facts.outcome,
      cause: facts.cause,
    };
    this.guard('log fire', (repository) => repository.insertFire(entry));
  }

  // An echo: the Sim was already doing it, which satisfies the row
  echo(simId: string, row: IntentionRow) {
    this.commitFire(row, { outcome: 'echo' });
    this.ran(simId, row);
  }

  private ran(simId: string, row: IntentionRow) {
    const stats = this.touch(simId, row);
    stats.ran += 1;
    stats.firesSinceRan = 0;
    stats.lastCause = undefined;
    stats.lastStructural = false;
    this.save(stats);
  }

  // The mod's outcome for a row's push
  outcome(simId: string, row: IntentionRow, requestId: string | undefined, facts: OutcomeFacts) {
    const classified = classifyOutcome(facts.outcome, facts.cause, facts.reason);
    if (classified.counter === 'ran') {
      this.ran(simId, row);
    } else {
      const stats = this.touch(simId, row);
      stats[classified.counter] += 1;
      stats.lastCause = classified.cause;
      stats.lastStructural = classified.structural;
      this.save(stats);
    }
    if (requestId) {
      this.guard('fire outcome', (repository) =>
        repository.fireOutcome(requestId, {
          outcome: facts.outcome,
          ran: facts.ran ?? facts.outcome === 'success',
          finishing: facts.finishing,
          cause: classified.cause,
          reason: facts.reason?.slice(0, 240),
        }),
      );
    }
  }

  // No outcome came back in the pending window (decision E: a timeout is a cancel)
  timeout(simId: string, row: IntentionRow, requestId: string | undefined) {
    const stats = this.touch(simId, row);
    stats.canceled += 1;
    stats.lastCause = CAUSE_TIMEOUT;
    stats.lastStructural = false;
    this.save(stats);
    if (requestId) {
      this.guard('fire timeout', (repository) =>
        repository.fireOutcome(requestId, { outcome: 'timeout', cause: CAUSE_TIMEOUT }),
      );
    }
  }

  expired(simId: string, row: IntentionRow) {
    this.bump(simId, row, 'expired');
  }

  rewrote(simId: string, row: IntentionRow) {
    this.bump(simId, row, 'rewrites');
  }

  // --- say once -----------------------------------------------------------------------------

  canSay(simId: string, row: IntentionRow): boolean {
    const day = this.today();
    return day === undefined || this.get(simId, row.seedKey)?.saidDay !== day;
  }

  markSaid(simId: string, row: IntentionRow) {
    const day = this.today();
    if (day === undefined) {
      return;
    }
    const stats = this.touch(simId, row);
    stats.saidDay = day;
    this.save(stats);
  }

  // --- the rollover -------------------------------------------------------------------------

  // Before the night call: every judged key of the ending day that meets D4 is retired here,
  // with the zone it died in. Returns the keys retired now.
  retirePass(simId: string, endingRows: IntentionRow[], endingDay: number, zone: string | undefined): string[] {
    const retired: string[] = [];
    const seen = new Set<string>();
    endingRows.forEach((row) => {
      if (!isJudgedRow(row) || seen.has(row.seedKey)) {
        return;
      }
      seen.add(row.seedKey);
      const stats = this.get(simId, row.seedKey);
      if (row.status !== 'done' && row.status !== 'dropped' && row.status !== 'expired' && stats) {
        stats.nightsKept += 1;
      }
      if (!stats) {
        return;
      }
      if (shouldRetire(stats)) {
        stats.retiredDay = endingDay;
        stats.retiredCause = stats.lastCause;
        stats.retiredZone = zone;
        retired.push(row.seedKey);
        log.info(`[Rows] ${this.simName(simId)} retired ${statsTag(stats)} (zone ${zone ?? '?'})`);
      }
      this.save(stats);
    });
    return retired;
  }

  retiredKeys(simId: string): RowStats[] {
    return [...this.cacheFor(simId).values()].filter((stats) => stats.retiredDay !== undefined);
  }

  // The seeds of retired keys that have not cleared are left out of today's list. A key
  // clears on a zone change, on a candidate of a key retired for not_on_menu showing on a
  // menu today (not greyed), or RETIRE_CLEAR_DAYS after it retired; then it seeds once more
  // and must earn its keep (its streak starts at 0).
  retiredFilter(simId: string, seeds: IntentionRow[], day: number, zone: string | undefined): IntentionRow[] {
    const cache = this.cacheFor(simId);
    return seeds.filter((seed) => {
      const stats = cache.get(seed.seedKey);
      if (!stats || stats.retiredDay === undefined) {
        return true;
      }
      const why = this.clearReason(simId, seed, stats, day, zone);
      if (!why) {
        return false;
      }
      stats.retiredDay = undefined;
      stats.retiredCause = undefined;
      stats.retiredZone = undefined;
      stats.firesSinceRan = 0;
      stats.lastStructural = false;
      this.save(stats);
      log.info(`[Rows] ${this.simName(simId)} ${seed.seedKey} back: ${why}`);
      return true;
    });
  }

  private clearReason(
    simId: string,
    seed: IntentionRow,
    stats: RowStats,
    day: number,
    zone: string | undefined,
  ): string | undefined {
    if (zone !== undefined && stats.retiredZone !== undefined && zone !== stats.retiredZone) {
      return `zone changed (${stats.retiredZone} -> ${zone})`;
    }
    if (stats.retiredDay !== undefined && day >= stats.retiredDay + RETIRE_CLEAR_DAYS) {
      return `${day - stats.retiredDay} days since it retired`;
    }
    if (stats.retiredCause === 'not_on_menu' && seed.what.kind === 'pie' && zone !== undefined) {
      const keys = this.vocabularyKeysFor(simId, day, zone);
      const seen = seed.what.candidates.find((candidate) => keys.has(candidate));
      if (seen) {
        return `${seen} was on a menu today`;
      }
    }
    return undefined;
  }

  // The readout line's counts for one Sim's day, from that day's fire log and ending rows
  daySummary(simId: string, day: number, endingRows: IntentionRow[], retired: string[]): DaySummary {
    const fires = this.guard('day fires', (repository) => repository.firesFor(simId, day, 1000)) ?? [];
    return {
      fired: fires.length,
      clicked: fires.filter((fire) => fire.requestId).length,
      ran: fires.filter((fire) => fire.outcome === 'success' || fire.outcome === 'echo').length,
      notOnMenu: fires.filter((fire) => fire.cause === 'not_on_menu').length,
      noTarget: fires.filter((fire) => fire.cause === 'no_target' || fire.cause === 'nobody_nearby').length,
      expired: endingRows.filter((row) => row.status === 'expired').length,
      retired,
    };
  }

  // Once per game day: interaction_log keeps INTERACTION_LOG_DAYS, vocabulary_seen VOCABULARY_DAYS
  prune(day: number) {
    if (this.prunedDay === day) {
      return;
    }
    this.prunedDay = day;
    this.guard('prune', (repository) => {
      repository.pruneInteractions(day - INTERACTION_LOG_DAYS + 1);
      repository.pruneVocabulary(day - VOCABULARY_DAYS + 1);
    });
    [...this.vocabularyKeys.keys()].forEach((key) => {
      const keyDay = Number(key.split('|')[1]);
      if (keyDay < day - VOCABULARY_DAYS + 1) {
        this.vocabularyKeys.delete(key);
      }
    });
  }

  // --- the household's interactions (the mod's ss_household_log) ----------------------------

  onInteractionLog(records: CognitionInteractionLogRecord[]) {
    if (!Array.isArray(records) || records.length === 0) {
      return;
    }
    const at = new Date().toISOString();
    this.guard('interaction log', (repository) => {
      repository.insertInteractions(
        records
          .filter((record) => Boolean(record.sim_id))
          .map((record) => ({
            at,
            simId: record.sim_id,
            interactionId: record.interaction_id ?? undefined,
            name: record.name ?? undefined,
            superName: record.super_name ?? undefined,
            isSuper: record.is_super ?? undefined,
            targetKind: record.target_kind ?? undefined,
            targetId: record.target_id ?? undefined,
            ran: record.ran ?? undefined,
            canceled: record.canceled ?? undefined,
            userCanceled: record.user_canceled ?? undefined,
            finishing: record.finishing ?? undefined,
            origin: record.origin ?? undefined,
            day: record.day ?? undefined,
            minute: record.minute ?? undefined,
            zone: record.zone_id ?? undefined,
          })),
      );
    });
  }

  // --- the vocabulary each target offered ---------------------------------------------------

  recordVocabulary(simId: string, answer: VocabularyAnswer, report: SimStateReport | undefined) {
    const clock = report?.lot?.clock;
    const day = clock?.absolute_day;
    const zoneRaw = report?.lot?.zone_id;
    if (day === undefined || zoneRaw === undefined || !Array.isArray(answer.rows)) {
      return;
    }
    const zone = String(zoneRaw);
    const minute = typeof clock?.hour === 'number' ? clock.hour * 60 + (clock.minute ?? 0) : undefined;
    const entries: VocabularySeenEntry[] = [];
    const keys = this.vocabularyKeysFor(simId, day, zone);
    answer.rows.forEach((row) => {
      if (!row.key || !row.label) {
        return;
      }
      entries.push({
        simId,
        target: vocabularyTarget(row.target_kind, row.target_id, row.target),
        kind: row.target_kind ?? 'object',
        label: row.label,
        key: row.key,
        greyed: row.greyed ? (row.reason ?? 'greyed') : undefined,
        zone,
        day,
        minute,
      });
      if (!row.greyed) {
        keys.add(row.key);
      }
    });
    if (entries.length > 0) {
      this.guard('vocabulary', (repository) => {
        repository.upsertVocabulary(entries);
      });
    }
  }

  private vocabularyKeysFor(simId: string, day: number, zone: string): Set<string> {
    const key = `${simId}|${day}|${zone}`;
    let keys = this.vocabularyKeys.get(key);
    if (!keys) {
      keys = new Set(
        (this.guard('vocabulary keys', (repository) => repository.vocabularyFor(simId, day, zone)) ?? [])
          .filter((entry) => !entry.greyed)
          .map((entry) => entry.key),
      );
      this.vocabularyKeys.set(key, keys);
    }
    return keys;
  }

  // --- views --------------------------------------------------------------------------------

  statsFor(simId: string): RowStats[] {
    return [...this.cacheFor(simId).values()];
  }

  allStats(): RowStats[] {
    return this.guard('all stats', (repository) => repository.allStats()) ?? [];
  }

  firesFor(simId: string, day?: number, limit = 50): FireLogEntry[] {
    return this.guard('fires', (repository) => repository.firesFor(simId, day, limit)) ?? [];
  }

  interactionCounts(simId?: string, day?: number): Record<string, number> {
    return this.guard('interaction counts', (repository) => repository.countInteractions(simId, day)) ?? {};
  }

  // Row memory is per save
  onDatabaseLoaded() {
    this.stats.clear();
    this.pending.clear();
    this.vocabularyKeys.clear();
    this.prunedDay = undefined;
  }
}
