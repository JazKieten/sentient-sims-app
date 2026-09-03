import { Repository } from './Repository';
import { OutcomeVerdict } from '../services/OutcomeVerdictService';

// One graded outcome, as stored. Everything the bench needs to audit the action loop
// after the fact: what was reported, where the verdict was made, and what the world
// looked like at the moment it was reported.
export type ActionOutcomeRecord = {
  id?: number;
  at: string;
  requestId?: string;
  simId: string;
  action?: string;
  interactionName?: string;
  outcome: string;
  verdict: OutcomeVerdict;
  decidedAt?: string;
  claim?: string;
  pushId?: string;
  ran?: boolean;
  finishing?: string;
  simRunning?: string;
  gameClock?: { absolute_day?: number; hour?: number; minute?: number };
  dispatchAgeMs?: number;
  late: boolean;
  unowned: boolean;
  source?: string;
  cause?: string;
  reason?: string;
  memoryId?: string;
};

type ActionOutcomeRow = {
  id: number;
  at: string;
  request_id: string | null;
  sim_id: string;
  action: string | null;
  interaction_name: string | null;
  outcome: string;
  verdict: string;
  decided_at: string | null;
  claim: string | null;
  push_id: string | null;
  ran: number | null;
  finishing: string | null;
  sim_running: string | null;
  game_clock: string | null;
  dispatch_age_ms: number | null;
  late: number;
  unowned: number;
  source: string | null;
  cause: string | null;
  reason: string | null;
  memory_id: string | null;
};

function toRecord(row: ActionOutcomeRow): ActionOutcomeRecord {
  return {
    id: row.id,
    at: row.at,
    requestId: row.request_id ?? undefined,
    simId: row.sim_id,
    action: row.action ?? undefined,
    interactionName: row.interaction_name ?? undefined,
    outcome: row.outcome,
    verdict: row.verdict as OutcomeVerdict,
    decidedAt: row.decided_at ?? undefined,
    claim: row.claim ?? undefined,
    pushId: row.push_id ?? undefined,
    ran: row.ran === null ? undefined : row.ran === 1,
    finishing: row.finishing ?? undefined,
    simRunning: row.sim_running ?? undefined,
    gameClock: row.game_clock ? (JSON.parse(row.game_clock) as ActionOutcomeRecord['gameClock']) : undefined,
    dispatchAgeMs: row.dispatch_age_ms ?? undefined,
    late: row.late === 1,
    unowned: row.unowned === 1,
    source: row.source ?? undefined,
    cause: row.cause ?? undefined,
    reason: row.reason ?? undefined,
    memoryId: row.memory_id ?? undefined,
  };
}

/**
 * Every outcome the mod reported, with the verdict the app graded it as (Phase 3.0 F5).
 * Lives in the loaded save's database so a bench run can audit the action loop after a
 * restart, and so "was a phantom success written during this probe?" is a query rather
 * than a memory of watching the log.
 *
 * The memory row remains the thing cognition reads; this table is the provenance behind it.
 */
export class ActionOutcomeRepository extends Repository {
  isLoaded(): boolean {
    return this.dbService.isLoaded();
  }

  insert(record: ActionOutcomeRecord): number {
    const result = this.dbService
      .getDb()
      .prepare(
        `INSERT INTO action_outcome(at, request_id, sim_id, action, interaction_name, outcome, verdict,
                                    decided_at, claim, push_id, ran, finishing, sim_running, game_clock,
                                    dispatch_age_ms, late, unowned, source, cause, reason, memory_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run([
        record.at,
        record.requestId ?? null,
        record.simId,
        record.action ?? null,
        record.interactionName ?? null,
        record.outcome,
        record.verdict,
        record.decidedAt ?? null,
        record.claim ?? null,
        record.pushId ?? null,
        record.ran === undefined ? null : Number(record.ran),
        record.finishing ?? null,
        record.simRunning ?? null,
        record.gameClock ? JSON.stringify(record.gameClock) : null,
        record.dispatchAgeMs ?? null,
        Number(record.late),
        Number(record.unowned),
        record.source ?? null,
        record.cause ?? null,
        record.reason ?? null,
        record.memoryId ?? null,
      ]);
    return Number(result.lastInsertRowid);
  }

  // Newest first. Both filters are optional; the bench reads by verdict, the Sims page by sim.
  list(options: { simId?: string; verdict?: OutcomeVerdict; limit?: number } = {}): ActionOutcomeRecord[] {
    const clauses: string[] = [];
    const parameters: (string | number)[] = [];
    if (options.simId) {
      clauses.push('sim_id = ?');
      parameters.push(options.simId);
    }
    if (options.verdict) {
      clauses.push('verdict = ?');
      parameters.push(options.verdict);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    parameters.push(options.limit ?? 100);
    const rows = this.dbService
      .getDb()
      .prepare(`SELECT * FROM action_outcome ${where} ORDER BY id DESC LIMIT ?`)
      .all(parameters) as ActionOutcomeRow[];
    return rows.map(toRecord);
  }

  count(): number {
    const row = this.dbService.getDb().prepare('SELECT COUNT(*) AS total FROM action_outcome').get() as {
      total: number;
    };
    return row.total;
  }

  // Same bound and the same reason as ai_exchange: the save database is copied whole on
  // every game save.
  prune(keep: number) {
    this.dbService
      .getDb()
      .prepare('DELETE FROM action_outcome WHERE id NOT IN (SELECT id FROM action_outcome ORDER BY id DESC LIMIT ?)')
      .run([keep]);
  }
}
