import log from 'electron-log';
import {
  CreateMemoryRequest,
  DeleteMemoryRequest,
  GetMemoryParticipantsRequest,
  GetMemoryRequest,
  GetParticipantsMemoriesRequest,
} from '../models/GetMemoryRequest';
import { Repository } from './Repository';
import { MemoryEntity, withDisplayContent } from './entities/MemoryEntity';
import { MemoryParticipantEntity } from './entities/MemoryParticipantEntity';
import { notifyMemoryDeleted, notifyMemoryEdited, notifyNewMemoryAdded } from '../util/notifyRenderer';
import { MemoryParticipantDTO } from './dto/MemoryParticipantDTO';
import { stripArtifacts, validateMemoryContent, NEAR_DUP_EVENT_TYPES, NEAR_DUP_JACCARD, trigramJaccard } from '../util/memoryHygiene';

export class MemoryRepository extends Repository {
  // The db layer can't depend on services, so annotation (importance/embedding into
  // memory_index) hooks in via this callback, wired up by ApiContext. Must never throw.
  private onMemoryUpserted?: (memory: MemoryEntity) => void;

  setOnMemoryUpserted(callback: (memory: MemoryEntity) => void) {
    this.onMemoryUpserted = callback;
  }

  getMemory(getMemoryRequest: GetMemoryRequest): MemoryEntity {
    const results = this.dbService
      .getDb()
      .prepare('SELECT * FROM memory WHERE id = ?')
      .all([getMemoryRequest.id]) as MemoryEntity[];
    if (results.length > 0) {
      return results[0];
    }

    throw Error(`Memory with id ${getMemoryRequest.id} not found.`);
  }

  getMemoryParticipants(getMemoryParticipantsRequest: GetMemoryParticipantsRequest): MemoryParticipantDTO[] {
    const memoryParticipants = this.dbService
      .getDb()
      .prepare('SELECT * FROM memory_participants WHERE memory_id = ?')
      .all([getMemoryParticipantsRequest.memory_id]) as MemoryParticipantEntity[];

    return memoryParticipants.map((memoryParticipant) => {
      return {
        id: memoryParticipant.id,
        participant_id: memoryParticipant.participant_id.toString(),
        memory_id: memoryParticipant.memory_id,
      };
    });
  }

  getParticipantsMemories(getParticipantsMemoriesRequest: GetParticipantsMemoriesRequest): MemoryEntity[] {
    const placeholders = getParticipantsMemoriesRequest.participant_ids.map(() => '?').join(', ');

    const query = `
      SELECT * FROM (
        SELECT DISTINCT memory.*
        FROM memory
        INNER JOIN memory_participants ON memory.id = memory_participants.memory_id
        WHERE memory_participants.participant_id IN (${placeholders})
        ORDER BY memory.timestamp DESC
        LIMIT 100
      ) AS subquery
      ORDER BY subquery.timestamp ASC;
    `;

    const bigIntParticipantIds = getParticipantsMemoriesRequest.participant_ids.map((participantIdString) =>
      BigInt(participantIdString),
    );

    return this.dbService.getDb().prepare(query).all(bigIntParticipantIds) as MemoryEntity[];
  }

  // This list feeds the in-game memories window, which can't render a null content
  // (see withDisplayContent) — every row it hands out gets a string content.
  getMemories(): MemoryEntity[] {
    const memories = this.dbService
      .getDb()
      .prepare(
        `
          SELECT * FROM (
            SELECT * FROM memory
            ORDER BY timestamp DESC
            LIMIT 100
          ) AS subquery
          ORDER BY subquery.timestamp ASC;
        `,
      )
      .all() as MemoryEntity[];

    return this.withNameTags(memories).map((memory) => withDisplayContent(memory));
  }

  // V-4: owner (memory_index) + participant names for the renderer's "Milo (thought):"
  // tags. One batched pass per list; a missing index/participant just leaves the tag off.
  withNameTags(memories: MemoryEntity[]): MemoryEntity[] {
    const ids = memories.map((memory) => memory.id).filter((id): id is number => typeof id === 'number');
    if (ids.length === 0) {
      return memories;
    }
    try {
      const placeholders = ids.map(() => '?').join(', ');
      const owners = this.dbService
        .getDb()
        .prepare(`SELECT memory_id, owner_participant_id FROM memory_index WHERE memory_id IN (${placeholders})`)
        .safeIntegers()
        .all(ids) as { memory_id: bigint | number; owner_participant_id: bigint | number | null }[];
      const ownerByMemory = new Map<number, string>();
      owners.forEach((row) => {
        if (row.owner_participant_id !== null && row.owner_participant_id !== undefined) {
          ownerByMemory.set(Number(row.memory_id), String(row.owner_participant_id));
        }
      });
      const links = this.dbService
        .getDb()
        .prepare(
          `SELECT mp.memory_id AS memory_id, mp.participant_id AS participant_id, p.name AS name
           FROM memory_participants mp
           LEFT JOIN participant p ON p.id = mp.participant_id
           WHERE mp.memory_id IN (${placeholders})
           ORDER BY mp.id ASC`,
        )
        .safeIntegers()
        .all(ids) as { memory_id: bigint | number; participant_id: bigint | number; name: string | null }[];
      const namesByMemory = new Map<number, string[]>();
      const nameById = new Map<string, string>();
      links.forEach((row) => {
        const memoryId = Number(row.memory_id);
        const participantId = String(row.participant_id);
        if (row.name) {
          nameById.set(participantId, row.name);
          const list = namesByMemory.get(memoryId) ?? [];
          if (!list.includes(row.name)) {
            list.push(row.name);
          }
          namesByMemory.set(memoryId, list);
        }
      });
      return memories.map((memory) => {
        if (memory.id === undefined) {
          return memory;
        }
        const owner = ownerByMemory.get(memory.id);
        return {
          ...memory,
          owner_participant_id: owner,
          owner_name: owner ? nameById.get(owner) : undefined,
          participant_names: namesByMemory.get(memory.id),
        };
      });
    } catch (error) {
      log.debug(`memory name tags skipped: ${String(error)}`);
      return memories;
    }
  }

  // The raw, non-reflection memories of a single scene, oldest first. A scene is identified by
  // its location and start time (no schema support needed): this is the "conversational cache"
  // that resets each time the player travels to a new location. Timestamps are SQLite
  // CURRENT_TIMESTAMP strings (UTC, second precision), so `since` must be in the same format.
  // Inner life (thought/monologue rows) is excluded: this transcript replays into SHARED
  // prompts (every actor's "Previously in this scene"), and one sim's private head must
  // never reach another sim's performance. Private rows travel only through owner-scoped
  // retrieval (memory_index.owner_participant_id).
  getSceneMemories(locationId: number, since: string): MemoryEntity[] {
    return this.dbService
      .getDb()
      .prepare(
        `
          SELECT * FROM memory
          WHERE location_id = ? AND timestamp >= ?
            AND (event_type IS NULL OR event_type NOT IN ('reflection', 'thought', 'monologue'))
          ORDER BY timestamp ASC, id ASC;
        `,
      )
      .all([locationId, since]) as MemoryEntity[];
  }

  // Distinct participant ids that took part in a scene, used to link a scene reflection back to
  // everyone who was present.
  getSceneParticipantIds(locationId: number, since: string): string[] {
    const rows = this.dbService
      .getDb()
      .prepare(
        `
          SELECT DISTINCT memory_participants.participant_id AS participant_id
          FROM memory_participants
          INNER JOIN memory ON memory.id = memory_participants.memory_id
          WHERE memory.location_id = ? AND memory.timestamp >= ?
            AND (memory.event_type IS NULL OR memory.event_type != 'reflection');
        `,
      )
      .safeIntegers()
      .all([locationId, since]) as { participant_id: bigint }[];

    return rows.map((row) => row.participant_id.toString());
  }

  getRecentReflections(limit: number): MemoryEntity[] {
    return this.dbService
      .getDb()
      .prepare(
        `
          SELECT * FROM memory
          WHERE event_type = 'reflection'
          ORDER BY timestamp DESC, id DESC
          LIMIT ?;
        `,
      )
      .all([limit]) as MemoryEntity[];
  }

  getRecentReflectionsForLocation(locationId: number, limit: number): MemoryEntity[] {
    return this.dbService
      .getDb()
      .prepare(
        `
          SELECT * FROM memory
          WHERE event_type = 'reflection' AND location_id = ?
          ORDER BY timestamp DESC, id DESC
          LIMIT ?;
        `,
      )
      .all([locationId, limit]) as MemoryEntity[];
  }

  getRecentReflectionsForParticipants(participantIds: string[], limit: number): MemoryEntity[] {
    if (participantIds.length === 0) {
      return [];
    }

    const placeholders = participantIds.map(() => '?').join(', ');
    const query = `
      SELECT DISTINCT memory.*
      FROM memory
      INNER JOIN memory_participants ON memory.id = memory_participants.memory_id
      WHERE memory.event_type = 'reflection' AND memory_participants.participant_id IN (${placeholders})
      ORDER BY memory.timestamp DESC, memory.id DESC
      LIMIT ?;
    `;

    const bigIntParticipantIds = participantIds.map((participantIdString) => BigInt(participantIdString));

    return this.dbService
      .getDb()
      .prepare(query)
      .all([...bigIntParticipantIds, limit]) as MemoryEntity[];
  }

  updateMemory(memory: MemoryEntity) {
    const result = this.dbService
      .getDb()
      .prepare(
        'UPDATE memory SET pre_action = ?, observation = ?, content = ?, timestamp = ?, location_id = ?, action = ?, event_type = ?, interaction_name = ? WHERE id = ?',
      )
      .run(
        memory.pre_action,
        memory.observation,
        memory.content,
        memory.timestamp,
        memory.location_id,
        memory.action,
        memory.event_type,
        memory.interaction_name,
        memory.id,
      );

    notifyMemoryEdited(memory);

    this.onMemoryUpserted?.(memory);

    return result;
  }

  updateMemoryParticipant(memoryParticipant: MemoryParticipantDTO) {
    return this.dbService
      .getDb()
      .prepare('INSERT OR REPLACE INTO memory_participants(id, participant_id, memory_id) VALUES(?, ?, ?)')
      .safeIntegers()
      .run([memoryParticipant.id, BigInt(memoryParticipant.participant_id), memoryParticipant.memory_id]);
  }

  private findRecentEcho(owner: string, content: string): { id: number; score: number } | undefined {
    try {
      const rows = this.dbService
        .getDb()
        .prepare(
          `SELECT m.id AS id, m.content AS content
           FROM memory m
           LEFT JOIN memory_index mi ON mi.memory_id = m.id
           LEFT JOIN memory_participants mp ON mp.memory_id = m.id
           WHERE m.event_type IN ('thought', 'monologue', 'reflection')
             AND m.timestamp >= datetime('now', '-30 minutes')
             AND (mi.owner_participant_id = ? OR mp.participant_id = ?)
           GROUP BY m.id
           ORDER BY m.id DESC LIMIT 8`,
        )
        .safeIntegers()
        .all([BigInt(owner), BigInt(owner)]) as { id: bigint | number; content: string | null }[];
      for (const row of rows) {
        if (!row.content) {
          continue;
        }
        const score = trigramJaccard(row.content, content);
        if (score >= NEAR_DUP_JACCARD) {
          return { id: Number(row.id), score };
        }
      }
    } catch (error) {
      log.debug(`near-duplicate check skipped: ${String(error)}`);
    }
    return undefined;
  }

  createMemory(createMemoryRequest: CreateMemoryRequest, options?: { notifyMod?: boolean }): MemoryEntity | undefined {
    // Refuse-to-persist gate: refusals, leaked prompt scaffolding, and no-text rows are
    // permanent retrieval poison once written (~8% of the playtest DB). Outcome rows
    // legitimately carry their text in observation, so content-less rows pass as long
    // as an observation exists.
    const incoming = createMemoryRequest.memory;
    if (incoming.content) {
      incoming.content = stripArtifacts(incoming.content);
    }
    if (incoming.content) {
      const validation = validateMemoryContent(incoming.content);
      if (!validation.ok) {
        log.warn(
          `Memory rejected (${validation.reason}) event_type=${incoming.event_type ?? 'unknown'} ` +
            `interaction=${incoming.interaction_name ?? ''}`,
        );
        return undefined;
      }
    } else if (!incoming.observation && !incoming.pre_action) {
      // Outcome rows carry their text in observation; pre-action fallback rows keep the
      // pre_action so the memories window can still render the beat. A row with no text
      // anywhere is pure junk.
      log.warn(
        `Memory rejected (no content, observation, or pre_action) event_type=${incoming.event_type ?? 'unknown'} ` +
          `interaction=${incoming.interaction_name ?? ''}`,
      );
      return undefined;
    }

    // A scene transcript can be POSTed back once per completing interaction (live, a hug
    // SI and the chat SI it rode on both completed and stored the same dialogue twice —
    // both then get embedded, retrieved, and fed to "Previously in this scene"). Exact
    // content duplicates at the same location within the paced-scene window are dropped.
    if (createMemoryRequest.memory.id === undefined && createMemoryRequest.memory.content) {
      const duplicate = this.dbService
        .getDb()
        .prepare(
          "SELECT id FROM memory WHERE content = ? AND location_id = ? AND timestamp >= datetime('now', '-5 minutes') ORDER BY id DESC LIMIT 1",
        )
        .get([createMemoryRequest.memory.content, createMemoryRequest.memory.location_id]) as
        | { id: number }
        | undefined;
      if (duplicate) {
        log.info(`Memory create skipped: identical recent content already stored as memory ${duplicate.id}`);
        return this.getMemory({ id: duplicate.id });
      }
    }

    // N-6: store-time echo suppression for a mind's own inner rows. Same owner (index
    // owner, else the sole participant), last 8 thought/monologue/reflection rows within
    // 30 minutes, trigram Jaccard >= 0.85 -> skip. Dialogue/outcome rows are untouched
    // (the private/shared split and the diaries depend on them landing).
    if (
      createMemoryRequest.memory.id === undefined &&
      createMemoryRequest.memory.content &&
      NEAR_DUP_EVENT_TYPES.has(createMemoryRequest.memory.event_type ?? '')
    ) {
      const owner =
        createMemoryRequest.index?.owner ??
        (createMemoryRequest.participants.length === 1 ? createMemoryRequest.participants[0].id : undefined);
      if (owner) {
        const echo = this.findRecentEcho(owner, createMemoryRequest.memory.content);
        if (echo) {
          log.info(
            `Memory create skipped: near-duplicate of memory ${echo.id} (jaccard ${echo.score.toFixed(2)}) for owner ${owner}`,
          );
          return this.getMemory({ id: echo.id });
        }
      }
    }

    const createMemoryTransaction = this.dbService.getDb().transaction(() => {
      const updateMemoryResult = this.dbService
        .getDb()
        .prepare(
          'INSERT OR REPLACE INTO memory(id, pre_action, observation, content, location_id, action, event_type, interaction_name) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run([
          createMemoryRequest.memory.id,
          createMemoryRequest.memory.pre_action,
          createMemoryRequest.memory.observation,
          createMemoryRequest.memory.content,
          createMemoryRequest.memory.location_id,
          createMemoryRequest.memory.action,
          createMemoryRequest.memory.event_type,
          createMemoryRequest.memory.interaction_name,
        ]);

      createMemoryRequest.participants.forEach((participant) => {
        this.updateMemoryParticipant({
          memory_id: Number(updateMemoryResult.lastInsertRowid),
          participant_id: participant.id,
        });
      });

      if (createMemoryRequest.index) {
        // Inside the transaction so a private row is never observable without its owner.
        // COALESCE keeps whatever the deferred annotator may already have written.
        const { owner, importance } = createMemoryRequest.index;
        this.dbService
          .getDb()
          .prepare(
            `INSERT INTO memory_index(memory_id, importance, owner_participant_id)
             VALUES(?, ?, ?)
             ON CONFLICT(memory_id) DO UPDATE SET
               importance = COALESCE(excluded.importance, importance),
               owner_participant_id = COALESCE(excluded.owner_participant_id, owner_participant_id)`,
          )
          .run([updateMemoryResult.lastInsertRowid, importance ?? null, owner ? BigInt(owner) : null]);
      }

      return updateMemoryResult.lastInsertRowid;
    });

    const createdMemoryId = createMemoryTransaction();

    const memory = this.withNameTags([this.getMemory({ id: Number(createdMemoryId) })])[0];

    notifyNewMemoryAdded(memory, options);

    log.info(`Memory added:\n${JSON.stringify(memory, null, 2)}`);

    this.onMemoryUpserted?.(memory);

    return memory;
  }

  deleteMemory(deleteMemoryRequest: DeleteMemoryRequest) {
    const result = this.dbService.getDb().prepare('DELETE FROM memory WHERE id = ?').run([deleteMemoryRequest.id]);

    notifyMemoryDeleted(deleteMemoryRequest);

    return result;
  }

  deleteAllMemories() {
    return this.dbService.getDb().prepare('DELETE FROM memory').run();
  }
}
