import { Repository } from './Repository';
import type {
  Pitfall,
  PitfallStatus,
  Procedure,
  ProcedureFailure,
  ProcedureStatus,
  ProcedureTargetKind,
} from '../services/intentions/Procedures';

// Procedures and pitfalls (autonomy renovation R4, migration 029) for the loaded save. Plain
// SQL; ProcedureService above it decides what to write.

type ProcedureEntity = {
  id: number;
  scope: string;
  key: string;
  zone: string | null;
  target_kind: string | null;
  target_name: string | null;
  items: string;
  why: string | null;
  uses: number;
  ran: number;
  failed: number;
  fires_since_ran: number;
  last_cause: string | null;
  last_structural: number;
  last_failure: string | null;
  status: string;
  source: string;
  first_day: number | null;
  last_day: number | null;
  revisions: number;
  revised_day: number | null;
};

type PitfallEntity = {
  id: number;
  scope: string;
  about: string;
  text: string;
  evidence: string | null;
  seen: number;
  status: string;
  source: string;
  zone: string | null;
  first_day: number | null;
  last_day: number | null;
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

function toProcedure(row: ProcedureEntity): Procedure {
  return {
    id: row.id,
    scope: row.scope,
    key: row.key,
    zone: row.zone ?? undefined,
    targetKind: (row.target_kind ?? 'find') as ProcedureTargetKind,
    targetName: row.target_name ?? undefined,
    items: parseJson<string[]>(row.items, []),
    why: row.why ?? undefined,
    uses: row.uses,
    ran: row.ran,
    failed: row.failed,
    firesSinceRan: row.fires_since_ran,
    lastCause: row.last_cause ?? undefined,
    lastStructural: row.last_structural === 1,
    lastFailure: parseJson<ProcedureFailure | undefined>(row.last_failure, undefined),
    status: row.status as ProcedureStatus,
    source: row.source === 'night' ? 'night' : 'code',
    firstDay: row.first_day ?? undefined,
    lastDay: row.last_day ?? undefined,
    revisions: row.revisions,
    revisedDay: row.revised_day ?? undefined,
  };
}

function toPitfall(row: PitfallEntity): Pitfall {
  return {
    id: row.id,
    scope: row.scope,
    about: row.about,
    text: row.text,
    evidence: parseJson<number[]>(row.evidence, []),
    seen: row.seen,
    status: row.status as PitfallStatus,
    source: row.source === 'night' ? 'night' : 'diagnosis',
    zone: row.zone ?? undefined,
    firstDay: row.first_day ?? undefined,
    lastDay: row.last_day ?? undefined,
  };
}

export class ProcedureRepository extends Repository {
  isLoaded(): boolean {
    return this.dbService.isLoaded();
  }

  // --- procedures ---------------------------------------------------------------------------

  procedures(scope: string): Procedure[] {
    const rows = this.dbService
      .getDb()
      .prepare('SELECT * FROM procedures WHERE scope = ?')
      .all([scope]) as ProcedureEntity[];
    return rows.map(toProcedure);
  }

  proceduresByKey(key: string): Procedure[] {
    const rows = this.dbService
      .getDb()
      .prepare('SELECT * FROM procedures WHERE key = ?')
      .all([key]) as ProcedureEntity[];
    return rows.map(toProcedure);
  }

  allProcedures(): Procedure[] {
    const rows = this.dbService.getDb().prepare('SELECT * FROM procedures').all() as ProcedureEntity[];
    return rows.map(toProcedure);
  }

  saveProcedure(procedure: Procedure) {
    this.dbService
      .getDb()
      .prepare(
        `INSERT INTO procedures(scope, key, zone, target_kind, target_name, items, why, uses, ran, failed,
           fires_since_ran, last_cause, last_structural, last_failure, status, source, first_day, last_day,
           revisions, revised_day)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, key) DO UPDATE SET zone = excluded.zone, target_kind = excluded.target_kind,
           target_name = excluded.target_name, items = excluded.items, why = excluded.why, uses = excluded.uses,
           ran = excluded.ran, failed = excluded.failed, fires_since_ran = excluded.fires_since_ran,
           last_cause = excluded.last_cause, last_structural = excluded.last_structural,
           last_failure = excluded.last_failure, status = excluded.status, source = excluded.source,
           first_day = excluded.first_day, last_day = excluded.last_day, revisions = excluded.revisions,
           revised_day = excluded.revised_day`,
      )
      .run([
        procedure.scope,
        procedure.key,
        procedure.zone ?? null,
        procedure.targetKind,
        procedure.targetName ?? null,
        JSON.stringify(procedure.items),
        procedure.why ?? null,
        procedure.uses,
        procedure.ran,
        procedure.failed,
        procedure.firesSinceRan,
        procedure.lastCause ?? null,
        Number(procedure.lastStructural),
        procedure.lastFailure ? JSON.stringify(procedure.lastFailure) : null,
        procedure.status,
        procedure.source,
        procedure.firstDay ?? null,
        procedure.lastDay ?? null,
        procedure.revisions,
        procedure.revisedDay ?? null,
      ]);
  }

  // --- pitfalls -----------------------------------------------------------------------------

  pitfalls(scope: string): Pitfall[] {
    const rows = this.dbService
      .getDb()
      .prepare('SELECT * FROM pitfalls WHERE scope = ?')
      .all([scope]) as PitfallEntity[];
    return rows.map(toPitfall);
  }

  allPitfalls(): Pitfall[] {
    const rows = this.dbService.getDb().prepare('SELECT * FROM pitfalls').all() as PitfallEntity[];
    return rows.map(toPitfall);
  }

  savePitfall(pitfall: Pitfall) {
    this.dbService
      .getDb()
      .prepare(
        `INSERT INTO pitfalls(scope, about, text, evidence, seen, status, source, zone, first_day, last_day)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, about) DO UPDATE SET text = excluded.text, evidence = excluded.evidence,
           seen = excluded.seen, status = excluded.status, source = excluded.source, zone = excluded.zone,
           first_day = excluded.first_day, last_day = excluded.last_day`,
      )
      .run([
        pitfall.scope,
        pitfall.about,
        pitfall.text,
        JSON.stringify(pitfall.evidence),
        pitfall.seen,
        pitfall.status,
        pitfall.source,
        pitfall.zone ?? null,
        pitfall.firstDay ?? null,
        pitfall.lastDay ?? null,
      ]);
  }
}
