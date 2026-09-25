import * as fs from 'fs';
import { describe, expect, it } from 'vitest';
import { migrate } from 'main/sentient-sims/db/migrations';
import { mockApiContext } from './util';

function loadedDb(sessionId: string) {
  const ctx = mockApiContext();
  fs.mkdirSync(ctx.directory.getSentientSimsFolder(), { recursive: true });
  ctx.db.loadDatabase({ sessionId, saveId: '1' });
  return ctx.db.getDb();
}

function migrationNames(db: ReturnType<typeof loadedDb>): string[] {
  return (db.prepare('SELECT name FROM migrations ORDER BY id').all() as { name: string }[]).map((row) => row.name);
}

describe('migrate', () => {
  // A save's DB goes back and forth between app builds (the stream app, then the core
  // app, or a newer app then an older one). A migration row this build has never heard
  // of must not stop it opening the DB.
  it('ignores applied migrations newer than it knows', () => {
    const db = loadedDb('migrations-newer-row');
    db.prepare('INSERT INTO migrations (name) VALUES (?)').run('999-from-a-newer-build');
    const before = migrationNames(db);

    expect(() => {
      migrate(db);
    }).not.toThrow();

    expect(migrationNames(db)).toEqual(before);
    expect(migrationNames(db)).toContain('999-from-a-newer-build');
  });

  it('is a no-op the second time', () => {
    const db = loadedDb('migrations-twice');
    const before = migrationNames(db);

    migrate(db);
    migrate(db);

    expect(migrationNames(db)).toEqual(before);
  });
});
