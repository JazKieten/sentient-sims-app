import { Repository } from './Repository';
import { MemoryTracePipeline, MemoryTraceReview, StoredMemoryTrace, StoredTraceExchange } from '../models/MemoryTrace';

type MemoryTraceRow = {
  memory_id: string;
  pipeline: string;
  director_direction: string | null;
  review: string | null;
  exchanges: string;
};

/**
 * The persisted pipeline trace of each memory (Phase 3.0 F4). Stages that went through the
 * logged provider seam are stored as references into ai_exchange, so each prompt lives once
 * in the save; MemoryTraceService resolves them back into full exchanges on read.
 */
export class MemoryTraceRepository extends Repository {
  isLoaded(): boolean {
    return this.dbService.isLoaded();
  }

  upsert(memoryId: string, trace: StoredMemoryTrace) {
    return this.dbService
      .getDb()
      .prepare(
        `INSERT OR REPLACE INTO memory_trace(memory_id, pipeline, director_direction, review, exchanges)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run([
        memoryId,
        trace.pipeline,
        trace.directorDirection ?? null,
        trace.review ? JSON.stringify(trace.review) : null,
        JSON.stringify(trace.exchanges),
      ]);
  }

  get(memoryId: string): StoredMemoryTrace | undefined {
    const row = this.dbService.getDb().prepare('SELECT * FROM memory_trace WHERE memory_id = ?').get([memoryId]) as
      | MemoryTraceRow
      | undefined;
    if (!row) {
      return undefined;
    }
    return {
      pipeline: row.pipeline as MemoryTracePipeline,
      exchanges: JSON.parse(row.exchanges) as StoredTraceExchange[],
      directorDirection: row.director_direction ?? undefined,
      review: row.review ? (JSON.parse(row.review) as MemoryTraceReview) : undefined,
    };
  }
}
