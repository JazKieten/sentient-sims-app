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
  TargetMenu,
  VocabularyView,
  classifyOutcome,
  labelParts,
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
    // The super the item stages when it differs from the key (R2)
    super?: string;
  }[];
  // Per target; a sample's provider targets name the candidates they judged (R2)
  targets?: { target?: string | null; kind?: string; candidates_checked?: string[]; social?: string[] }[];
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

function addToView(view: VocabularyView, entry: VocabularySeenEntry) {
  let menu: TargetMenu | undefined = view.targets.get(entry.target);
  if (!menu) {
    menu = { keys: new Set(), supers: new Set(), greyed: new Map(), labels: new Set() };
    view.targets.set(entry.target, menu);
  }
  const { label } = labelParts(entry.label);
  if (entry.greyed) {
    menu.greyed.set(entry.key, entry.greyed);
    menu.greyed.set(label, entry.greyed);
    if (entry.superKey) {
      menu.greyed.set(entry.superKey, entry.greyed);
    }
    return;
  }
  menu.keys.add(entry.key);
  (menu.labels ??= new Set()).add(label);
  if (entry.superKey) {
    menu.supers.add(entry.superKey);
  }
}

export class RowMemoryService {
  private readonly ctx: ApiContext;

  private readonly deps: RowMemoryDeps;

  // sim id -> seed key -> stats (loaded lazily per Sim, written through)
  private readonly stats = new Map<string, Map<string, RowStats>>();

  // row id -> a fire the lane took that has not passed the gate yet (decision A)
  private readonly pending = new Map<string, PendingFire>();

  // `${simId}|${day}|${zone}` -> what each target's menu offered that day (R2's prior)
  private readonly views = new Map<string, VocabularyView>();

  // `${zone}|${day}` -> interaction names (and supers) that RAN for the household today
  private readonly ranNames = new Map<string, Set<string>>();

  // Rows whose initiation-set skip was counted today (`${rowId}|${day}`), and the day's skips
  private readonly skipped = new Set<string>();

  private readonly daySkips = new Map<string, { notOnMenu: number; noTarget: number }>();

  // `${simId}|${seedKey}` -> the night call's last diagnosis of why that key died (R3, for R4)
  private readonly diagnoses = new Map<string, string>();

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
      const view = this.vocabularyView(simId, day, zone);
      const seen = seed.what.candidates.find((candidate) =>
        [...view.targets.values()].some((menu) => menu.keys.has(candidate) || menu.supers.has(candidate)),
      );
      if (seen) {
        return `${seen} was on a menu today`;
      }
    }
    return undefined;
  }

  // --- the initiation set's bookkeeping (R2) --------------------------------------------------

  // A row skipped because I failed: counted once per row per day (never per report)
  skip(simId: string, row: IntentionRow, cause: 'not_on_menu' | 'greyed' | 'no_target') {
    const day = this.today();
    const key = `${row.id}|${day ?? '?'}`;
    if (this.skipped.has(key)) {
      return;
    }
    this.skipped.add(key);
    const stats = this.touch(simId, row);
    if (cause === 'no_target') {
      stats.noTarget += 1;
    } else {
      stats.notOnMenu += 1;
    }
    this.save(stats);
    const counts = this.daySkips.get(`${simId}|${day ?? '?'}`) ?? { notOnMenu: 0, noTarget: 0 };
    if (cause === 'no_target') {
      counts.noTarget += 1;
    } else {
      counts.notOnMenu += 1;
    }
    this.daySkips.set(`${simId}|${day ?? '?'}`, counts);
  }

  // Whether one of these names ran for the household today in this zone (a wake event)
  ranToday(zone: string | undefined, day: number, names: string[]): string | undefined {
    const ran = this.ranNames.get(`${zone ?? '?'}|${day}`);
    return ran ? names.find((name) => ran.has(name)) : undefined;
  }

  // The readout line's counts for one Sim's day, from that day's fire log and ending rows
  daySummary(simId: string, day: number, endingRows: IntentionRow[], retired: string[]): DaySummary {
    const fires = this.guard('day fires', (repository) => repository.firesFor(simId, day, 1000)) ?? [];
    return {
      fired: fires.length,
      clicked: fires.filter((fire) => fire.requestId).length,
      ran: fires.filter((fire) => fire.outcome === 'success' || fire.outcome === 'echo').length,
      notOnMenu: this.daySkips.get(`${simId}|${day}`)?.notOnMenu ?? 0,
      refusedLive: fires.filter((fire) => fire.cause === 'not_on_menu').length,
      noTarget:
        (this.daySkips.get(`${simId}|${day}`)?.noTarget ?? 0) +
        fires.filter((fire) => fire.cause === 'no_target' || fire.cause === 'nobody_nearby').length,
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
    [...this.views.keys()].forEach((key) => {
      if (Number(key.split('|')[1]) < day - VOCABULARY_DAYS + 1) {
        this.views.delete(key);
      }
    });
    [...this.ranNames.keys()].forEach((key) => {
      if (Number(key.split('|')[1]) < day) {
        this.ranNames.delete(key);
      }
    });
    [...this.daySkips.keys()].forEach((key) => {
      if (Number(key.split('|')[1]) < day - 1) {
        this.daySkips.delete(key);
      }
    });
    [...this.skipped].forEach((key) => {
      if (Number(key.split('|')[1]) < day) {
        this.skipped.delete(key);
      }
    });
  }

  // --- the household's interactions (the mod's ss_household_log) ----------------------------

  onInteractionLog(records: CognitionInteractionLogRecord[]) {
    if (!Array.isArray(records) || records.length === 0) {
      return;
    }
    const at = new Date().toISOString();
    records.forEach((record) => {
      if (!record.ran || record.day === undefined || record.day === null) {
        return;
      }
      const key = `${record.zone_id ?? '?'}|${record.day}`;
      const ran = this.ranNames.get(key) ?? new Set<string>();
      if (record.name) {
        ran.add(record.name);
      }
      if (record.super_name) {
        ran.add(record.super_name);
      }
      this.ranNames.set(key, ran);
    });
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
    const view = this.vocabularyView(simId, day, zone);
    answer.rows.forEach((row) => {
      if (!row.key || !row.label) {
        return;
      }
      const entry: VocabularySeenEntry = {
        simId,
        target: vocabularyTarget(row.target_kind, row.target_id, row.target),
        kind: row.target_kind ?? 'object',
        label: row.label,
        key: row.key,
        superKey: row.super,
        greyed: row.greyed ? (row.reason ?? 'greyed') : undefined,
        zone,
        day,
        minute,
      };
      entries.push(entry);
      addToView(view, entry);
    });
    (answer.targets ?? []).forEach((target) => {
      (target.candidates_checked ?? []).forEach((candidate) => view.checked.add(candidate));
    });
    if (entries.length > 0) {
      this.guard('vocabulary', (repository) => {
        repository.upsertVocabulary(entries);
      });
    }
  }

  // What each target's menu offered the Sim today in this zone (the stored rows, plus the
  // candidates a provider sample judged this app run)
  vocabularyView(simId: string, day: number, zone: string): VocabularyView {
    const key = `${simId}|${day}|${zone}`;
    let view = this.views.get(key);
    if (!view) {
      const built: VocabularyView = { targets: new Map(), checked: new Set() };
      (this.guard('vocabulary view', (repository) => repository.vocabularyFor(simId, day, zone)) ?? []).forEach(
        (entry) => {
          addToView(built, entry);
        },
      );
      view = built;
      this.views.set(key, view);
    }
    return view;
  }

  // The night call's reading of why a key died (R3; kept in memory, R4 gives it a table)
  diagnose(simId: string, seedKey: string, text: string) {
    this.diagnoses.set(`${simId}|${seedKey}`, text);
  }

  diagnosisFor(simId: string, seedKey: string): string | undefined {
    return this.diagnoses.get(`${simId}|${seedKey}`);
  }

  // Every item a menu offered the Sim on a day, every zone (the night text's clickable lists)
  vocabularySeen(simId: string, day: number): VocabularySeenEntry[] {
    return this.guard('vocabulary seen', (repository) => repository.vocabularyFor(simId, day)) ?? [];
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
    this.views.clear();
    this.ranNames.clear();
    this.skipped.clear();
    this.daySkips.clear();
    this.prunedDay = undefined;
  }
}
