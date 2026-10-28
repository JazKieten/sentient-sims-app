import { Repository } from './Repository';
import type { Experience, ExperienceKind, ExperienceSource } from '../services/intentions/Experience';

// Experiences (autonomy renovation R5a, migration 030) for the loaded save. Plain SQL; insert
// is idempotent by (holder, source, source_id), so a night that runs twice adds nothing.

type ExperienceEntity = {
  id: number;
  holder: string;
  day: number;
  minute: number | null;
  kind: string;
  participants: string | null;
  verb: string | null;
  verb_family: string | null;
  target: string | null;
  zone: string | null;
  outcome: string | null;
  finishing: string | null;
  importance: number;
  last_access: number | null;
  source: string;
  source_id: string;
  scene_id: string | null;
  text: string | null;
};

function parseIds(text: string | null): string[] {
  if (!text) {
    return [];
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function toExperience(row: ExperienceEntity): Experience {
  return {
    id: row.id,
    holder: row.holder,
    day: row.day,
    minute: row.minute ?? undefined,
    kind: row.kind as ExperienceKind,
    participants: parseIds(row.participants),
    verb: row.verb ?? undefined,
    verbFamily: row.verb_family ?? undefined,
    target: row.target ?? undefined,
    zone: row.zone ?? undefined,
    outcome: row.outcome ?? undefined,
    finishing: row.finishing ?? undefined,
    importance: row.importance,
    lastAccess: row.last_access ?? undefined,
    source: row.source as ExperienceSource,
    sourceId: row.source_id,
    sceneId: row.scene_id ?? undefined,
    text: row.text ?? undefined,
  };
}

export class ExperienceRepository extends Repository {
  isLoaded(): boolean {
    return this.dbService.isLoaded();
  }

  // New rows only (a row already kept for this source id is left as it is); returns how many
  insertMany(experiences: Experience[]): number {
    const db = this.dbService.getDb();
    const statement = db.prepare(
      `INSERT OR IGNORE INTO experience(holder, day, minute, kind, participants, verb, verb_family, target, zone,
         outcome, finishing, importance, last_access, source, source_id, scene_id, text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let added = 0;
    db.transaction((rows: Experience[]) => {
      rows.forEach((experience) => {
        added += statement.run([
          experience.holder,
          experience.day,
          experience.minute ?? null,
          experience.kind,
          JSON.stringify(experience.participants),
          experience.verb ?? null,
          experience.verbFamily ?? null,
          experience.target ?? null,
          experience.zone ?? null,
          experience.outcome ?? null,
          experience.finishing ?? null,
          experience.importance,
          experience.lastAccess ?? null,
          experience.source,
          experience.sourceId,
          experience.sceneId ?? null,
          experience.text ?? null,
        ]).changes;
      });
    })(experiences);
    return added;
  }

  forHolder(holder: string, fromDay: number): Experience[] {
    const rows = this.dbService
      .getDb()
      .prepare('SELECT * FROM experience WHERE holder = ? AND day >= ? ORDER BY day ASC, minute ASC, id ASC')
      .all([holder, fromDay]) as ExperienceEntity[];
    return rows.map(toExperience);
  }

  markAccessed(ids: number[], at: number) {
    const db = this.dbService.getDb();
    const statement = db.prepare('UPDATE experience SET last_access = ? WHERE id = ?');
    db.transaction((list: number[]) => {
      list.forEach((id) => {
        statement.run([at, id]);
      });
    })(ids);
  }

  prune(beforeDay: number) {
    this.dbService.getDb().prepare('DELETE FROM experience WHERE day < ?').run([beforeDay]);
  }
}
