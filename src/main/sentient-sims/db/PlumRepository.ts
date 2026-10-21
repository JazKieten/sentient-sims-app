// Plum's memory across sessions, per save (migration 023): the rows the tab showed, by
// thread, and the notes Plum keeps for itself. Everything is JSON in a text column, so the
// row shape can grow without a migration.
import { Repository } from './Repository';

export type PlumStoredRow = {
  id: number;
  thread_id: string;
  role: string;
  content: Record<string, unknown>;
  created_at: string;
  game_day?: number;
};

export type PlumNote = {
  id: number;
  kind: string;
  text: string;
  sim_ids: string[];
  created_at: string;
  game_day?: number;
};

type MessageRow = {
  id: number;
  thread_id: string;
  role: string;
  content_json: string;
  created_at: string;
  game_day: number | null;
};

type NoteRow = {
  id: number;
  kind: string;
  text: string;
  sim_ids_json: string | null;
  created_at: string;
  game_day: number | null;
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

export class PlumRepository extends Repository {
  isLoaded(): boolean {
    return this.dbService.isLoaded();
  }

  appendMessage(threadId: string, role: string, content: Record<string, unknown>, gameDay?: number): number {
    const result = this.dbService
      .getDb()
      .prepare('INSERT INTO plum_message (thread_id, role, content_json, game_day) VALUES (?, ?, ?, ?)')
      .run([threadId, role, JSON.stringify(content), gameDay ?? null]);
    return Number(result.lastInsertRowid);
  }

  // The newest `limit` rows of a thread, oldest first
  recentRows(threadId: string, limit = 30): PlumStoredRow[] {
    const rows = this.dbService
      .getDb()
      .prepare(
        `SELECT * FROM (
           SELECT * FROM plum_message WHERE thread_id = ? ORDER BY id DESC LIMIT ?
         ) AS tail ORDER BY id ASC`,
      )
      .all([threadId, limit]) as MessageRow[];
    return rows.map((row) => ({
      id: row.id,
      thread_id: row.thread_id,
      role: row.role,
      content: parseJson<Record<string, unknown>>(row.content_json, {}),
      created_at: row.created_at,
      ...(row.game_day === null ? {} : { game_day: row.game_day }),
    }));
  }

  lastThreadId(): string | undefined {
    const row = this.dbService.getDb().prepare('SELECT thread_id FROM plum_message ORDER BY id DESC LIMIT 1').get() as
      | { thread_id: string }
      | undefined;
    return row?.thread_id;
  }

  addNote(kind: string, text: string, simIds: string[] = [], gameDay?: number): number {
    const result = this.dbService
      .getDb()
      .prepare('INSERT INTO plum_note (kind, text, sim_ids_json, game_day) VALUES (?, ?, ?, ?)')
      .run([kind, text, JSON.stringify(simIds), gameDay ?? null]);
    return Number(result.lastInsertRowid);
  }

  // The newest `limit` notes, oldest first
  notes(limit = 40): PlumNote[] {
    const rows = this.dbService
      .getDb()
      .prepare('SELECT * FROM (SELECT * FROM plum_note ORDER BY id DESC LIMIT ?) AS tail ORDER BY id ASC')
      .all([limit]) as NoteRow[];
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      text: row.text,
      sim_ids: parseJson<string[]>(row.sim_ids_json, []),
      created_at: row.created_at,
      ...(row.game_day === null ? {} : { game_day: row.game_day }),
    }));
  }

  deleteNote(id: number): boolean {
    const result = this.dbService.getDb().prepare('DELETE FROM plum_note WHERE id = ?').run([id]);
    return result.changes > 0;
  }

  // A note of which only the newest matters (the director's note, rewritten every tick):
  // every earlier note of that kind goes, and an empty text leaves none
  replaceNote(kind: string, text: string, simIds: string[] = [], gameDay?: number): number | undefined {
    const db = this.dbService.getDb();
    const swap = db.transaction((): number | undefined => {
      db.prepare('DELETE FROM plum_note WHERE kind = ?').run([kind]);
      return text ? this.addNote(kind, text, simIds, gameDay) : undefined;
    });
    return swap();
  }

  latestNote(kind: string): PlumNote | undefined {
    const row = this.dbService
      .getDb()
      .prepare('SELECT * FROM plum_note WHERE kind = ? ORDER BY id DESC LIMIT 1')
      .get([kind]) as NoteRow | undefined;
    if (!row) {
      return undefined;
    }
    return {
      id: row.id,
      kind: row.kind,
      text: row.text,
      sim_ids: parseJson<string[]>(row.sim_ids_json, []),
      created_at: row.created_at,
      ...(row.game_day === null ? {} : { game_day: row.game_day }),
    };
  }
}
