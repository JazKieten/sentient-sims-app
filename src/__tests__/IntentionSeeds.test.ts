import { describe, expect, it } from 'vitest';
import { SimStateEntry, SimStateReport } from 'main/sentient-sims/models/SimStateReport';
import {
  desireRow,
  mergeSeeds,
  seedRows,
  shiftStartMinutes,
} from 'main/sentient-sims/services/intentions/IntentionSeeds';
import { clockMinutes, describeRow, preconditionsHold, untilReached } from 'main/sentient-sims/models/IntentionRow';

// Autonomy part 5: the seeds of a Sim's intention list, in priority order, and the merge
// that keeps a row's status across reports.

const SETTINGS = { needFloor: -60 };

function report(lot: Partial<SimStateReport['lot']> = {}): SimStateReport {
  return {
    type: 'state_report',
    seq: 1,
    lot: { zone_id: 1, clock: { hour: 10, minute: 0, absolute_day: 40, day: 2 }, funds: 2000, ...lot },
    sims: [],
  };
}

function entry(
  self: Partial<NonNullable<SimStateEntry['self']>> = {},
  extra: Partial<SimStateEntry> = {},
): SimStateEntry {
  return {
    sim_id: '100',
    sim_name: 'Jonah Calloway',
    sims: [{ sim_id: '200', name: 'Alex Calloway', tier: 'same_room', distance: 2 }],
    objects: [],
    self: { needs: { hunger: 50 }, ...self },
    ...extra,
  };
}

describe('seedRows', () => {
  it('orders needs, bills, work, drama, then the goal pool by source', () => {
    const rows = seedRows(
      entry({
        needs: { hunger: -70, fun: 10 },
        careers: [{ career: 'Culinary', next_shift: '14:00:00.000 day:2 week:1', at_work: false }],
        drama: [{ node: 'visitor_NeighborDropIn', uid: '77', in_minutes: 180, role: 'receiver', other_name: 'Nancy' }],
        goal_pool: [
          {
            id: 'want_ChatWith',
            source: 'want',
            label: 'Want: Chat With',
            affordances: ['mixer_social_Chat'],
            target_sim_id: '200',
            target_name: 'Alex Calloway',
          },
          {
            id: 'objective_Asp_1',
            source: 'aspiration',
            label: 'Aspiration: Chat x3',
            affordances: ['mixer_social_Chat', 'mixer_social_TellJoke'],
          },
          {
            id: 'objective_Promo',
            source: 'promotion',
            label: 'Promotion requirement: Cooking to 3',
            action_keys: ['cook_meal'],
          },
        ],
      }),
      report({ bills: { due: true, amount: 800 } }),
      SETTINGS,
    );
    expect(rows.map((row) => row.seedKey)).toEqual([
      'need:hunger',
      'bills',
      'work:Culinary',
      'drama:77',
      'objective_Asp_1',
      'objective_Promo',
      'want_ChatWith',
    ]);
    expect(rows.map((row) => row.what.kind)).toEqual(['action', 'action', 'note', 'note', 'pie', 'action', 'pie']);
  });

  it('a bills row needs the funds and clears with the bills flag', () => {
    const [bills] = seedRows(entry(), report({ bills: { due: true, amount: 800 }, funds: 300 }), SETTINGS);
    expect(bills.seedKey).toBe('bills');
    expect(bills.claim).toBe('bills');
    expect(bills.preconditions).toEqual([{ kind: 'funds_at_least', amount: 800 }]);
    const ctx = {
      nowMinutes: 40 * 1440 + 600,
      absoluteDay: 40,
      entry: entry(),
      report: report({ bills: { due: true, amount: 800 }, funds: 300 }),
    };
    expect(preconditionsHold(bills, ctx)).toEqual({ ok: false, waiting: '§800 (have §300)' });
    expect(untilReached(bills, ctx)).toBe(false);
    const paid = { ...ctx, report: report({ bills: { due: false }, funds: 1200 }) };
    expect(preconditionsHold(bills, paid)).toEqual({ ok: true });
    expect(untilReached(bills, paid)).toBe(true);
  });

  it('a want with affordances is a pie row aimed at its target; an actor want falls back to its verb; neither is unreachable', () => {
    const rows = seedRows(
      entry({
        goal_pool: [
          {
            id: 'want_FlirtWith',
            source: 'want',
            label: 'Want: Flirt',
            affordances: ['mixer_social_Flirt'],
            target_sim_id: '200',
            target_name: 'Alex Calloway',
            text: 'I should flirt with Alex.',
            action_keys: ['flirt'],
          },
          {
            id: 'want_Motives_Hygiene',
            source: 'want',
            label: 'Want: Motives Hygiene',
            action_keys: ['take_shower', 'brush_teeth'],
          },
          { id: 'fear_Fire', source: 'want', label: 'Worry: Fire' },
        ],
      }),
      report(),
      SETTINGS,
    );
    const [flirt, shower, fear] = rows;
    expect(flirt.what).toEqual({
      kind: 'pie',
      candidates: ['mixer_social_Flirt'],
      label: 'I should flirt with Alex.',
      fallback: 'flirt',
    });
    expect(flirt.target).toEqual({ sim_id: '200', name: 'Alex Calloway' });
    expect(flirt.preconditions).toEqual([{ kind: 'target_present', sim_id: '200' }]);
    expect(flirt.why).toBe('I should flirt with Alex.');
    expect(flirt.until).toEqual({ kind: 'want_absent' });
    expect(shower.what).toEqual({ kind: 'action', actions: ['take_shower', 'brush_teeth'] });
    expect(fear.status).toBe('unreachable');
    expect(describeRow(flirt)).toContain(
      'want: I should flirt with Alex. with Alex Calloway -> pie mixer_social_Flirt',
    );
  });

  it('a need under the floor is a row while awake, none when asleep', () => {
    const awake = seedRows(entry({ needs: { hunger: -65, bladder: -10 } }), report(), SETTINGS);
    expect(awake.map((row) => row.seedKey)).toEqual(['need:hunger']);
    expect(awake[0].preconditions).toEqual([{ kind: 'awake' }, { kind: 'need_below', need: 'hunger', value: -60 }]);
    expect(awake[0].until).toEqual({ kind: 'need_above', need: 'hunger', value: -40 });
    expect(seedRows(entry({ needs: { hunger: -65 }, asleep: true }), report(), SETTINGS)).toEqual([]);
  });

  it('a drama node is a note with its window', () => {
    const [note] = seedRows(
      entry({
        drama: [{ node: 'phoneCall_Invite', uid: '9', in_minutes: 120, role: 'sender', other_name: 'Nancy Landgraab' }],
      }),
      report(),
      SETTINGS,
    );
    const at = 40 * 1440 + 12 * 60;
    expect(note.what).toEqual({ kind: 'note', holds: ['go_out', 'travel_to_zone'] });
    expect(note.preconditions).toEqual([{ kind: 'game_time', from: at - 60, to: at + 60 }]);
    expect(note.until).toEqual({ kind: 'game_time', at: at + 60 });
    expect(note.why).toBe('phoneCall Invite with Nancy Landgraab at 12:00 (you planned)');
  });

  it('the work note is live from an hour before the shift to two hours after, never at work', () => {
    const shiftReport = report();
    expect(shiftStartMinutes('14:00:00.000 day:2 week:1', shiftReport)).toBe(40 * 1440 + 14 * 60);
    // Tomorrow's weekday
    expect(shiftStartMinutes('09:00:00.000 day:3 week:1', shiftReport)).toBe(41 * 1440 + 9 * 60);
    const [work] = seedRows(
      entry({ careers: [{ career: 'Culinary', next_shift: '14:00:00.000 day:2 week:1', at_work: false }] }),
      shiftReport,
      SETTINGS,
    );
    expect(work.seedKey).toBe('work:Culinary');
    expect(work.preconditions).toEqual([
      { kind: 'game_time', from: 40 * 1440 + 13 * 60, to: 40 * 1440 + 16 * 60 },
      { kind: 'not_at_work' },
    ]);
    const late = { nowMinutes: 40 * 1440 + 14 * 60 + 30, absoluteDay: 40, entry: entry(), report: shiftReport };
    expect(preconditionsHold(work, late)).toEqual({ ok: true });
    const atWork = { ...late, entry: entry({ careers: [{ career: 'Culinary', at_work: true }] }) };
    expect(preconditionsHold(work, atWork)).toEqual({ ok: false, waiting: 'the shift to end' });
    expect(
      seedRows(
        entry({ careers: [{ career: 'Culinary', next_shift: '14:00:00.000 day:2 week:1', at_work: true }] }),
        shiftReport,
        SETTINGS,
      ),
    ).toEqual([]);
  });

  it('clockMinutes is absolute', () => {
    expect(clockMinutes(report())).toBe(40 * 1440 + 600);
    expect(clockMinutes({ type: 'state_report', seq: 1, lot: { clock: { hour: 3 } } })).toBeUndefined();
  });
});

describe('mergeSeeds', () => {
  it('keeps status and history, appends new keys, expires a rerolled want and completes a vanished objective', () => {
    const first = seedRows(
      entry({
        goal_pool: [
          { id: 'objective_Asp_1', source: 'aspiration', label: 'A', affordances: ['x'] },
          { id: 'want_One', source: 'want', label: 'W1', action_keys: ['chat'] },
        ],
      }),
      report({ bills: { due: true, amount: 100 } }),
      SETTINGS,
    );
    first[0].status = 'done';
    first[0].history.push({ at: 1, outcome: 'success' });
    first[1].attempts = 2;
    const second = seedRows(
      entry({ goal_pool: [{ id: 'want_Two', source: 'want', label: 'W2', action_keys: ['chat'] }] }),
      report({ bills: { due: false } }),
      SETTINGS,
    );
    const merged = mergeSeeds(first, second);
    expect(merged.map((row) => [row.seedKey, row.status])).toEqual([
      ['bills', 'done'],
      ['objective_Asp_1', 'done'],
      ['want_One', 'expired'],
      ['want_Two', 'waiting'],
    ]);
    expect(merged[0].history).toHaveLength(1);
    expect(merged[1].attempts).toBe(2);
    // Sticky: the bills row is not reseeded while the mod still says due (collision 7)
    const again = mergeSeeds(merged, seedRows(entry(), report({ bills: { due: true, amount: 100 } }), SETTINGS));
    expect(again.filter((row) => row.seedKey === 'bills')).toHaveLength(1);
    expect(again[0].status).toBe('done');
  });

  it('scene and conversation rows are never touched by the seeds', () => {
    const scene = desireRow(
      'scene',
      { score: 8, reason: 'wants to make up with Alex', targetSimId: '200' },
      1000,
      'Alex',
    );
    const talk = desireRow('conversation', { score: 9, speaker: 'Scott', transcript: 'Scott: go paint' }, 1000);
    expect(scene.what.kind).toBe('deliberate');
    expect(scene.preconditions).toEqual([{ kind: 'target_present', sim_id: '200' }]);
    expect(scene.until).toEqual({ kind: 'game_time', at: 1120 });
    expect(talk.why).toBe('follow through on the talk with Scott');
    const merged = mergeSeeds([scene, talk], []);
    expect(merged).toEqual([scene, talk]);
  });
});
