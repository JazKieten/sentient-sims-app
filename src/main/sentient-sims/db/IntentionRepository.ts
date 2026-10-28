import { Repository } from './Repository';
import type { IntentionRow } from '../models/IntentionRow';

// Intention rows persist in their OWN table (decision 2): the daily_plan row's existence is
// what needsLazyPlan keys on, so a Sim with rows but no plan must never get a plan row.
type IntentionRowsEntity = { sim_id: string; absolute_day: number; rows: string | null };

export class IntentionRepository extends Repository {
  getRows(simId: string, absoluteDay: number): IntentionRow[] | undefined {
    const entity = this.dbService
      .getDb()
      .prepare('SELECT * FROM intention_rows WHERE sim_id = ? AND absolute_day = ?')
      .get([simId, absoluteDay]) as IntentionRowsEntity | undefined;
    if (!entity?.rows) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(entity.rows) as unknown;
      return Array.isArray(parsed) ? (parsed as IntentionRow[]) : undefined;
    } catch {
      return undefined;
    }
  }

  saveRows(simId: string, absoluteDay: number, rows: IntentionRow[]) {
    return this.dbService
      .getDb()
      .prepare(
        `INSERT OR REPLACE INTO intention_rows(sim_id, absolute_day, rows, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
      )
      .run([simId, absoluteDay, JSON.stringify(rows)]);
  }
}
