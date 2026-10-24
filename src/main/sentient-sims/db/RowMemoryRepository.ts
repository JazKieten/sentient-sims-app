import { Repository } from './Repository';
import type { DecisionContext, RowStats } from '../services/intentions/RowMemory';

// Row memory (autonomy renovation R1, migration 027): row_stats, row_fire_log,
// interaction_log and vocabulary_seen for the loaded save. Plain SQL; the service above it
// keeps the stats in memory and writes through.

type RowStatsEntity = {
  sim_id: string;
  seed_key: string;
  fires: number;
  clicked: number;
  ran: number;
  canceled: number;
  refused: number;
  not_on_menu: number;
  no_target: number;
  expired: number;
  nights_kept: number;
  rewrites: number;
  fires_since_ran: number;
  last_cause: string | null;
  last_structural: number;
  first_day: number | null;
  last_day: number | null;
  said_day: number | null;
  retired_day: number | null;
  retired_cause: string | null;
  retired_zone: string | null;
  why: string | null;
};

function toStats(row: RowStatsEntity): RowStats {
  return {
    simId: row.sim_id,
    seedKey: row.seed_key,
    fires: row.fires,
    clicked: row.clicked,
    ran: row.ran,
    canceled: row.canceled,
    refused: row.refused,
    notOnMenu: row.not_on_menu,
    noTarget: row.no_target,
    expired: row.expired,
    nightsKept: row.nights_kept,
    rewrites: row.rewrites,
    firesSinceRan: row.fires_since_ran,
    lastCause: row.last_cause ?? undefined,
    lastStructural: row.last_structural === 1,
    firstDay: row.first_day ?? undefined,
    lastDay: row.last_day ?? undefined,
    saidDay: row.said_day ?? undefined,
    retiredDay: row.retired_day ?? undefined,
    retiredCause: row.retired_cause ?? undefined,
    retiredZone: row.retired_zone ?? undefined,
    why: row.why ?? undefined,
  };
}

export type FireLogEntry = {
  id?: number;
  at: string;
  day?: number;
  minute?: number;
  simId: string;
  rowId: string;
  seedKey: string;
  source?: string;
  whatKind?: string;
  eligible: { id: string; source: string; kind: string }[];
  chosen?: string;
  propensity: number;
  context?: DecisionContext;
  requestId?: string;
  outcome?: string;
  ran?: boolean;
  finishing?: string;
  cause?: string;
  reason?: string;
};

type FireLogEntity = {
  id: number;
  at: string;
  day: number | null;
  minute: number | null;
  sim_id: string;
  row_id: string;
  seed_key: string;
  source: string | null;
  what_kind: string | null;
  eligible: string | null;
  chosen: string | null;
  propensity: number | null;
  context: string | null;
  request_id: string | null;
  outcome: string | null;
  ran: number | null;
  finishing: string | null;
  cause: string | null;
  reason: string | null;
};

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) {
    return fallback;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function toFire(row: FireLogEntity): FireLogEntry {
  return {
    id: row.id,
    at: row.at,
    day: row.day ?? undefined,
    minute: row.minute ?? undefined,
    simId: row.sim_id,
    rowId: row.row_id,
    seedKey: row.seed_key,
    source: row.source ?? undefined,
    whatKind: row.what_kind ?? undefined,
    eligible: parseJson(row.eligible, []),
    chosen: row.chosen ?? undefined,
    propensity: row.propensity ?? 1,
    context: parseJson<DecisionContext | undefined>(row.context, undefined),
    requestId: row.request_id ?? undefined,
    outcome: row.outcome ?? undefined,
    ran: row.ran === null ? undefined : row.ran === 1,
    finishing: row.finishing ?? undefined,
    cause: row.cause ?? undefined,
    reason: row.reason ?? undefined,
  };
}

export type FireOutcome = { outcome: string; ran?: boolean; finishing?: string; cause?: string; reason?: string };

// One household interaction as the mod forwarded it (interactions/ss_household_log.py)
export type InteractionLogEntry = {
  at: string;
  simId: string;
  interactionId?: string;
  name?: string;
  superName?: string;
  isSuper?: boolean;
  targetKind?: string;
  targetId?: string;
  ran?: boolean;
  canceled?: boolean;
  userCanceled?: boolean;
  finishing?: string;
  origin?: string;
  day?: number;
  minute?: number;
  zone?: string;
};

export type VocabularySeenEntry = {
  simId: string;
  // 'self' | 'sim:<id>' | an object's tuning class name | 'phone'
  target: string;
  kind: string;
  label: string;
  key: string;
  greyed?: string;
  zone: string;
  day: number;
  minute?: number;
};

function bool(value: boolean | undefined): number | null {
  return value === undefined ? null : Number(value);
}

export class RowMemoryRepository extends Repository {
  isLoaded(): boolean {
    return this.dbService.isLoaded();
  }

  // --- row_stats ----------------------------------------------------------------------------

  statsFor(simId: string): RowStats[] {
    const rows = this.dbService
      .getDb()
      .prepare('SELECT * FROM row_stats WHERE sim_id = ?')
      .all([simId]) as RowStatsEntity[];
    return rows.map(toStats);
  }

  allStats(): RowStats[] {
    const rows = this.dbService.getDb().prepare('SELECT * FROM row_stats').all() as RowStatsEntity[];
    return rows.map(toStats);
  }

  saveStats(stats: RowStats) {
    this.dbService
      .getDb()
      .prepare(
        `INSERT OR REPLACE INTO row_stats(sim_id, seed_key, fires, clicked, ran, canceled, refused, not_on_menu,
           no_target, expired, nights_kept, rewrites, fires_since_ran, last_cause, last_structural, first_day,
           last_day, said_day, retired_day, retired_cause, retired_zone, why)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run([
        stats.simId,
        stats.seedKey,
        stats.fires,
        stats.clicked,
        stats.ran,
        stats.canceled,
        stats.refused,
        stats.notOnMenu,
        stats.noTarget,
        stats.expired,
        stats.nightsKept,
        stats.rewrites,
        stats.firesSinceRan,
        stats.lastCause ?? null,
        Number(stats.lastStructural),
        stats.firstDay ?? null,
        stats.lastDay ?? null,
        stats.saidDay ?? null,
        stats.retiredDay ?? null,
        stats.retiredCause ?? null,
        stats.retiredZone ?? null,
        stats.why ?? null,
      ]);
  }

  // --- row_fire_log -------------------------------------------------------------------------

  insertFire(entry: FireLogEntry): number {
    const result = this.dbService
      .getDb()
      .prepare(
        `INSERT INTO row_fire_log(at, day, minute, sim_id, row_id, seed_key, source, what_kind, eligible, chosen,
           propensity, context, request_id, outcome, ran, finishing, cause, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run([
        entry.at,
        entry.day ?? null,
        entry.minute ?? null,
        entry.simId,
        entry.rowId,
        entry.seedKey,
        entry.source ?? null,
        entry.whatKind ?? null,
        JSON.stringify(entry.eligible),
        entry.chosen ?? null,
        entry.propensity,
        entry.context ? JSON.stringify(entry.context) : null,
        entry.requestId ?? null,
        entry.outcome ?? null,
        bool(entry.ran),
        entry.finishing ?? null,
        entry.cause ?? null,
        entry.reason ?? null,
      ]);
    return Number(result.lastInsertRowid);
  }

  // The outcome of the newest fire that carried this request id
  fireOutcome(requestId: string, outcome: FireOutcome): boolean {
    const result = this.dbService
      .getDb()
      .prepare(
        `UPDATE row_fire_log SET outcome = ?, ran = ?, finishing = ?, cause = ?, reason = ?
         WHERE id = (SELECT id FROM row_fire_log WHERE request_id = ? ORDER BY id DESC LIMIT 1)`,
      )
      .run([
        outcome.outcome,
        bool(outcome.ran),
        outcome.finishing ?? null,
        outcome.cause ?? null,
        outcome.reason ?? null,
        requestId,
      ]);
    return result.changes > 0;
  }

  firesFor(simId: string, day?: number, limit = 200): FireLogEntry[] {
    const rows =
      day === undefined
        ? (this.dbService
            .getDb()
            .prepare('SELECT * FROM row_fire_log WHERE sim_id = ? ORDER BY id DESC LIMIT ?')
            .all([simId, limit]) as FireLogEntity[])
        : (this.dbService
            .getDb()
            .prepare('SELECT * FROM row_fire_log WHERE sim_id = ? AND day = ? ORDER BY id DESC LIMIT ?')
            .all([simId, day, limit]) as FireLogEntity[]);
    return rows.map(toFire);
  }

  // --- interaction_log ----------------------------------------------------------------------

  insertInteractions(entries: InteractionLogEntry[]) {
    const db = this.dbService.getDb();
    const statement = db.prepare(
      `INSERT INTO interaction_log(at, sim_id, interaction_id, name, super_name, is_super, target_kind, target_id,
         ran, canceled, user_canceled, finishing, origin, day, minute, zone)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.transaction((rows: InteractionLogEntry[]) => {
      rows.forEach((entry) => {
        statement.run([
          entry.at,
          entry.simId,
          entry.interactionId ?? null,
          entry.name ?? null,
          entry.superName ?? null,
          bool(entry.isSuper),
          entry.targetKind ?? null,
          entry.targetId ?? null,
          bool(entry.ran),
          bool(entry.canceled),
          bool(entry.userCanceled),
          entry.finishing ?? null,
          entry.origin ?? null,
          entry.day ?? null,
          entry.minute ?? null,
          entry.zone ?? null,
        ]);
      });
    })(entries);
  }

  countInteractions(simId?: string, day?: number): Record<string, number> {
    const clauses: string[] = [];
    const parameters: (string | number)[] = [];
    if (simId) {
      clauses.push('sim_id = ?');
      parameters.push(simId);
    }
    if (day !== undefined) {
      clauses.push('day = ?');
      parameters.push(day);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.dbService
      .getDb()
      .prepare(`SELECT origin, COUNT(*) AS total FROM interaction_log ${where} GROUP BY origin`)
      .all(parameters) as { origin: string | null; total: number }[];
    const out: Record<string, number> = {};
    rows.forEach((row) => {
      out[row.origin ?? 'unknown'] = row.total;
    });
    return out;
  }

  pruneInteractions(beforeDay: number) {
    this.dbService.getDb().prepare('DELETE FROM interaction_log WHERE day < ?').run([beforeDay]);
  }

  // --- vocabulary_seen ----------------------------------------------------------------------

  upsertVocabulary(entries: VocabularySeenEntry[]) {
    const db = this.dbService.getDb();
    const statement = db.prepare(
      `INSERT OR REPLACE INTO vocabulary_seen(sim_id, target, kind, label, key, greyed, zone, day, minute)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.transaction((rows: VocabularySeenEntry[]) => {
      rows.forEach((entry) => {
        statement.run([
          entry.simId,
          entry.target,
          entry.kind,
          entry.label,
          entry.key,
          entry.greyed ?? null,
          entry.zone,
          entry.day,
          entry.minute ?? null,
        ]);
      });
    })(entries);
  }

  vocabularyFor(simId: string, day: number, zone?: string): VocabularySeenEntry[] {
    const rows = (
      zone === undefined
        ? this.dbService.getDb().prepare('SELECT * FROM vocabulary_seen WHERE sim_id = ? AND day = ?').all([simId, day])
        : this.dbService
            .getDb()
            .prepare('SELECT * FROM vocabulary_seen WHERE sim_id = ? AND day = ? AND zone = ?')
            .all([simId, day, zone])
    ) as {
      sim_id: string;
      target: string;
      kind: string;
      label: string;
      key: string;
      greyed: string | null;
      zone: string;
      day: number;
      minute: number | null;
    }[];
    return rows.map((row) => ({
      simId: row.sim_id,
      target: row.target,
      kind: row.kind,
      label: row.label,
      key: row.key,
      greyed: row.greyed ?? undefined,
      zone: row.zone,
      day: row.day,
      minute: row.minute ?? undefined,
    }));
  }

  pruneVocabulary(beforeDay: number) {
    this.dbService.getDb().prepare('DELETE FROM vocabulary_seen WHERE day < ?').run([beforeDay]);
  }
}
