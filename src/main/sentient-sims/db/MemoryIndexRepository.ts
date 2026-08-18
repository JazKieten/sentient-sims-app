import { Repository } from './Repository';
import { MemoryEntity, MemoryRow, toMemoryEntity } from './entities/MemoryEntity';
import { MemoryIndexEntity, MemoryWithIndex } from './entities/MemoryIndexEntity';

// memory_index row as read with safeIntegers() (INTEGER columns arrive as bigint).
type MemoryIndexRow = {
  memory_id: bigint;
  importance?: bigint | null;
  embedding?: Buffer | null;
  embedding_model?: string | null;
  owner_participant_id?: bigint | null;
};

type MemoryWithIndexRow = MemoryRow & Omit<MemoryIndexRow, 'memory_id'>;

function toMemoryWithIndex(row: MemoryWithIndexRow): MemoryWithIndex {
  const { importance, ...rest } = row;
  return {
    ...toMemoryEntity(rest),
    importance: importance === null || importance === undefined ? importance : Number(importance),
  };
}

export class MemoryIndexRepository extends Repository {
  getIndex(memoryId: string): MemoryIndexEntity | undefined {
    const row = this.dbService
      .getDb()
      .prepare('SELECT * FROM memory_index WHERE memory_id = ?')
      .safeIntegers()
      .get([BigInt(memoryId)]) as MemoryIndexRow | undefined;

    if (!row) {
      return undefined;
    }

    return {
      memory_id: row.memory_id.toString(),
      importance: row.importance === null || row.importance === undefined ? row.importance : Number(row.importance),
      embedding: row.embedding,
      embedding_model: row.embedding_model,
      owner_participant_id: row.owner_participant_id,
    };
  }

  // Annotation is fire-and-forget, so by the time it lands the memory may have been
  // deleted (or the db reloaded). The WHERE EXISTS guard makes a stale upsert a
  // silent no-op instead of a FOREIGN KEY error. An undefined owner keeps whatever
  // owner the row already has — the annotator overwrites ratings, never privacy.
  upsertIndex(index: MemoryIndexEntity) {
    const owner = index.owner_participant_id === undefined ? null : index.owner_participant_id;
    return this.dbService
      .getDb()
      .prepare(
        `INSERT OR REPLACE INTO memory_index(memory_id, importance, embedding, embedding_model, owner_participant_id)
         SELECT ?, ?, ?, ?, COALESCE(?, (SELECT owner_participant_id FROM memory_index WHERE memory_id = ?))
         WHERE EXISTS (SELECT 1 FROM memory WHERE id = ?)`,
      )
      .run([
        BigInt(index.memory_id),
        index.importance ?? null,
        index.embedding ?? null,
        index.embedding_model ?? null,
        owner,
        BigInt(index.memory_id),
        BigInt(index.memory_id),
      ]);
  }

  // Recent memories involving any of the given participants, joined with their retrieval
  // metadata (LEFT JOIN: rows the annotator hasn't reached yet still show up, with null
  // importance/embedding). Newest-first window that MemoryRetrievalService scores in process.
  // ownerScope gates private rows: a memory with a non-null owner only surfaces when that
  // owner is in scope (a sim retrieving for itself, or a scene the owner is part of).
  // Omitted scope means shared rows only — privacy fails closed.
  getRetrievalCandidates(participantIds: string[], limit: number, ownerScope: string[] = []): MemoryWithIndex[] {
    if (participantIds.length === 0) {
      return [];
    }

    const placeholders = participantIds.map(() => '?').join(', ');
    const ownerPlaceholders = ownerScope.map(() => '?').join(', ');
    const ownerFilter = ownerScope.length
      ? `AND (memory_index.owner_participant_id IS NULL OR memory_index.owner_participant_id IN (${ownerPlaceholders}))`
      : 'AND memory_index.owner_participant_id IS NULL';
    const query = `
      SELECT DISTINCT memory.*, memory_index.importance, memory_index.embedding, memory_index.embedding_model,
        memory_index.owner_participant_id
      FROM memory
      INNER JOIN memory_participants ON memory.id = memory_participants.memory_id
      LEFT JOIN memory_index ON memory_index.memory_id = memory.id
      WHERE memory_participants.participant_id IN (${placeholders})
        ${ownerFilter}
      ORDER BY memory.timestamp DESC, memory.id DESC
      LIMIT ?;
    `;

    const bigIntParticipantIds = participantIds.map((participantIdString) => BigInt(participantIdString));
    const bigIntOwnerScope = ownerScope.map((ownerId) => BigInt(ownerId));

    const rows = this.dbService
      .getDb()
      .prepare(query)
      .safeIntegers()
      .all([...bigIntParticipantIds, ...bigIntOwnerScope, limit]) as MemoryWithIndexRow[];
    return rows.map(toMemoryWithIndex);
  }

  // Memories with no index row yet (or indexed before an embedder was available),
  // oldest first — the backfill work queue.
  getUnindexedMemories(limit: number): MemoryEntity[] {
    const rows = this.dbService
      .getDb()
      .prepare(
        `
          SELECT memory.* FROM memory
          LEFT JOIN memory_index ON memory_index.memory_id = memory.id
          WHERE (memory_index.memory_id IS NULL OR memory_index.embedding IS NULL)
            AND (memory.event_type IS NULL OR memory.event_type != 'outcome')
          ORDER BY memory.timestamp ASC, memory.id ASC
          LIMIT ?;
        `,
      )
      .safeIntegers()
      .all([limit]) as MemoryRow[];
    return rows.map(toMemoryEntity);
  }
}
