import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import { ApiContext } from 'main/sentient-sims/services/ApiContext';
import { DirectoryService } from 'main/sentient-sims/services/DirectoryService';
import { SettingsService } from 'main/sentient-sims/services/SettingsService';
import { ActionOutcomeRecord } from 'main/sentient-sims/db/ActionOutcomeRepository';
import { mockApiContext, mockEnvironment } from './util';

// F5: every graded outcome is written to the loaded save, so a bench run can audit the
// action loop after a restart instead of relying on someone having watched the log.
describe('action outcome persistence', () => {
  let ctx: ApiContext;
  let directoryService: DirectoryService;
  let settingsService: SettingsService;
  let sessionId: string;

  function record(overrides: Partial<ActionOutcomeRecord> = {}) {
    return ctx.outcomeVerdict.record({
      at: new Date().toISOString(),
      simId: '100',
      action: 'take_shower',
      outcome: 'success',
      verdict: 'confirmed',
      late: false,
      unowned: false,
      ...overrides,
    });
  }

  beforeEach(() => {
    ({ directoryService, settingsService } = mockEnvironment());
    ctx = mockApiContext({ directoryService, settingsService });
    fs.mkdirSync(ctx.directory.getSentientSimsFolder(), { recursive: true });
    sessionId = `outcome-${Math.random().toString(36).slice(2)}`;
    ctx.db.loadDatabase({ sessionId, saveId: '1' });
  });

  it('serves rows written before a restart', () => {
    // Nothing was registered in the game, so there is no push id and ran was never observed
    record({ action: 'take_shower', verdict: 'suspect', decidedAt: 'dispatch' });
    record({ action: 'tell_joke', verdict: 'confirmed', decidedAt: 'finished', pushId: '4242', ran: true });

    // A restart: a brand new context over the same save file
    const restarted = mockApiContext({ directoryService, settingsService });
    restarted.db.loadDatabase({ sessionId, saveId: '1' });

    const listed = restarted.outcomeVerdict.list();
    expect(listed.map((row) => row.action)).toEqual(['tell_joke', 'take_shower']);
    expect(listed[0].pushId).toBe('4242');
    expect(listed[0].ran).toBe(true);
    expect(listed[1].verdict).toBe('suspect');
    // ran is tri-state: never observed is not the same as observed-not-running
    expect(listed[1].ran).toBeUndefined();
  });

  it('filters by verdict and by sim, which is what the bench and the watches ask', () => {
    record({ simId: '100', verdict: 'suspect', action: 'take_shower' });
    record({ simId: '100', verdict: 'confirmed', action: 'grab_snack' });
    record({ simId: '200', verdict: 'suspect', action: 'sleep' });

    expect(ctx.outcomeVerdict.list({ verdict: 'suspect' }).map((row) => row.action)).toEqual(['sleep', 'take_shower']);
    expect(ctx.outcomeVerdict.list({ simId: '200' }).map((row) => row.action)).toEqual(['sleep']);
    expect(ctx.outcomeVerdict.list({ verdict: 'suspect', simId: '100' }).map((row) => row.action)).toEqual([
      'take_shower',
    ]);
  });

  it('round-trips the game clock and the grading context', () => {
    record({
      requestId: 'req-1',
      claim: 'merged_social',
      decidedAt: 'dispatch',
      simRunning: 'shower_TakeShower',
      gameClock: { absolute_day: 5, hour: 22, minute: 13 },
      dispatchAgeMs: 126,
      late: true,
      unowned: true,
      source: 'player_ask',
      memoryId: '20999',
    });

    const [row] = ctx.outcomeVerdict.list();
    expect(row.gameClock).toEqual({ absolute_day: 5, hour: 22, minute: 13 });
    expect(row.dispatchAgeMs).toBe(126);
    expect(row.late).toBe(true);
    expect(row.unowned).toBe(true);
    expect(row.source).toBe('player_ask');
    expect(row.simRunning).toBe('shower_TakeShower');
    expect(row.memoryId).toBe('20999');
  });

  it('keeps each save’s outcomes in its own database', () => {
    record({ action: 'take_shower' });

    const otherSession = `outcome-${Math.random().toString(36).slice(2)}`;
    ctx.db.loadDatabase({ sessionId: otherSession, saveId: '2' });

    expect(ctx.outcomeVerdict.list()).toEqual([]);
  });

  it('records nothing, and throws nothing, with no save loaded', () => {
    const noSave = mockApiContext({ directoryService, settingsService });

    expect(
      noSave.outcomeVerdict.record({
        at: new Date().toISOString(),
        simId: '1',
        outcome: 'success',
        verdict: 'confirmed',
        late: false,
        unowned: false,
      }),
    ).toBeUndefined();
    expect(noSave.outcomeVerdict.list()).toEqual([]);
  });

  it('bounds the table, because the save database is copied whole on every save', () => {
    record();
    ctx.actionOutcomeRepository.prune(1);
    expect(ctx.actionOutcomeRepository.count()).toBe(1);

    record({ action: 'grab_snack' });
    ctx.actionOutcomeRepository.prune(1);
    expect(ctx.actionOutcomeRepository.count()).toBe(1);
    expect(ctx.outcomeVerdict.list()[0].action).toBe('grab_snack');
  });
});
