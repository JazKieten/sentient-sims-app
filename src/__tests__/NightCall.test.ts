import { describe, expect, it } from 'vitest';
import { ApiContext } from 'main/sentient-sims/services/ApiContext';
import { SimStateCache } from 'main/sentient-sims/services/SimStateCache';
import { IntentionService } from 'main/sentient-sims/services/intentions/IntentionService';
import { NightCallService } from 'main/sentient-sims/services/intentions/NightCallService';
import { buildNightText, verdictOf } from 'main/sentient-sims/services/intentions/NightCall';
import type { IntentionRow } from 'main/sentient-sims/models/IntentionRow';
import type { SimStateEntry, SimStateReport } from 'main/sentient-sims/models/SimStateReport';
import type { PlumTurnOptions, PlumTurnResult } from 'main/sentient-sims/services/PlumService';

// Autonomy part 6 (2026-10-22): the night call's text and the queue that runs one Plum turn
// of kind `night` per household Sim at the day rollover.

function row(partial: Partial<IntentionRow> & Pick<IntentionRow, 'id' | 'source' | 'why'>): IntentionRow {
  return {
    seedKey: partial.id,
    what: { kind: 'action', actions: ['chat'] },
    preconditions: [],
    until: { kind: 'once' },
    status: 'waiting',
    attempts: 0,
    history: [],
    ...partial,
  };
}

function entry(simId: string, name: string, extra: Partial<SimStateEntry> = {}): SimStateEntry {
  return {
    sim_id: simId,
    sim_name: name,
    sims: [],
    objects: [],
    self: {
      needs: { hunger: 40 },
      age: 'YOUNGADULT',
      traits: ['Cheerful', 'Bookworm'],
      careers: [{ career: 'Writer', level: 3 }],
      mood: 'Happy',
    },
    is_household: true,
    ...extra,
  };
}

function report(day: number, hour: number, sims: SimStateEntry[]): SimStateReport {
  return {
    type: 'state_report',
    seq: 1,
    lot: { zone_id: 1, clock: { hour, minute: 0, absolute_day: day, day: 2 }, funds: 1500 },
    sims,
  };
}

describe('verdictOf', () => {
  it('names what became of each row', () => {
    expect(
      verdictOf(
        row({ id: 'i1', source: 'want', why: 'x', status: 'done', history: [{ at: 1, outcome: 'goal_completed' }] }),
      ),
    ).toBe('done: the game completed it');
    expect(
      verdictOf(row({ id: 'i2', source: 'want', why: 'x', status: 'done', history: [{ at: 1, outcome: 'success' }] })),
    ).toBe('done (success)');
    expect(
      verdictOf(
        row({
          id: 'i3',
          source: 'want',
          why: 'x',
          status: 'asleep',
          attempts: 3,
          sleep: { cause: '3 attempts today', clears: { kind: 'day_end' } },
          history: [1, 2, 3].map((at) => ({ at, outcome: 'canceled', cause: 'target_left' })),
        }),
      ),
    ).toBe('asleep: 3 attempts today, 3 attempts (canceled target_left x3)');
    expect(
      verdictOf(
        row({
          id: 'i4',
          source: 'want',
          why: 'x',
          target: { sim_id: '200', name: 'Alex' },
          preconditions: [{ kind: 'target_present', sim_id: '200' }],
        }),
      ),
    ).toBe('never fired (waited for Alex to be here)');
    expect(verdictOf(row({ id: 'i5', source: 'want', why: 'x', status: 'dropped' }))).toBe('dropped');
  });
});

describe('buildNightText', () => {
  it("carries the Sim, yesterday's rows with verdicts, the memories, today's ids and the rules", () => {
    const sim = entry('100', 'Corinne Stiles');
    const text = buildNightText({
      simId: '100',
      simName: 'Corinne Stiles',
      entry: sim,
      report: report(41, 0, [sim, entry('200', 'Duane Miles')]),
      endingDay: 40,
      newDay: 41,
      endingRows: [
        row({
          id: 'i1',
          source: 'want',
          why: 'I should paint something',
          status: 'asleep',
          sleep: { cause: 'no_provider_on_lot', clears: { kind: 'never' } },
        }),
        row({
          id: 'i2',
          source: 'bills',
          why: 'the bills are due',
          status: 'done',
          history: [{ at: 1, outcome: 'success' }],
        }),
      ],
      todayRows: [
        row({ id: 'i7', source: 'need', why: 'hunger is low' }),
        row({ id: 'i8', source: 'want', why: 'The jams are on now!', say: 'The jams are on now!' }),
        row({ id: 'i9', source: 'want', why: 'stale', status: 'done' }),
      ],
      memories: [{ content: 'Corinne wrote a chapter on the computer.', event_type: 'interaction', location_id: 1 }],
      outcomes: [
        {
          at: 'x',
          simId: '100',
          action: 'write',
          interactionName: 'computer_PracticeWritingSkill',
          outcome: 'canceled',
          cause: 'incompatible_with_current_interaction',
          verdict: 'unresolved',
          gameClock: { absolute_day: 40, hour: 20, minute: 11 },
          late: false,
          unowned: false,
        } as never,
        {
          at: 'y',
          simId: '100',
          outcome: 'success',
          verdict: 'confirmed',
          gameClock: { absolute_day: 39 },
          late: false,
          unowned: false,
        } as never,
      ],
    });
    expect(text).toContain('<night_call sim="Corinne Stiles" sim_id="100" ending_day="40" new_day="41">');
    expect(text).toContain('traits: Cheerful, Bookworm');
    expect(text).toContain('work: Writer level 3');
    expect(text).toContain('Duane Miles');
    expect(text).toContain('i1 want: I should paint something');
    expect(text).toContain('=> asleep: no_provider_on_lot');
    expect(text).toContain('i2 bills: the bills are due');
    expect(text).toContain('=> done (success)');
    expect(text).toContain('- [interaction] Corinne wrote a chapter on the computer.');
    expect(text).toContain('- 20:11 computer_PracticeWritingSkill -> canceled (incompatible_with_current_interaction)');
    expect(text).toContain('i7 need: hunger is low');
    expect(text).toContain('a need row: never touch it');
    expect(text).toContain('says: "The jams are on now!"');
    expect(text).not.toContain('i9 ');
    expect(text).toContain('Story beats only');
    expect(text).toContain('edit_intentions once with sim_id "100"');
    // Outcomes of other days stay out
    expect(text.match(/-> success/g)).toBeNull();
  });
});

type FakePlum = {
  turns: { text: string; options: PlumTurnOptions }[];
  isRunning: boolean;
  unavailable?: string;
  finish?: () => void;
};

function build(options: { plumEnabled?: boolean; nightCallEnabled?: boolean } = {}) {
  const cache = new SimStateCache();
  const plum: FakePlum = { turns: [], isRunning: false };
  const ctx = {
    settings: {
      intentionBeatMinutes: 120,
      intentionNeedFloor: -60,
      intentionRowsEnabled: true,
      intentionNightCallEnabled: options.nightCallEnabled ?? true,
      cognitionActionScoreThreshold: 7,
      plumEnabled: options.plumEnabled ?? true,
    },
    db: { isLoaded: () => true },
    simStateCache: cache,
    memoryRepository: { getOwnDayMemories: () => [] },
    plum: {
      get isRunning() {
        return plum.isRunning;
      },
      brainUnavailable: () => plum.unavailable,
      runTurn: (text: string, turnOptions: PlumTurnOptions) => {
        plum.turns.push({ text, options: turnOptions });
        plum.isRunning = true;
        return new Promise<PlumTurnResult>((resolve) => {
          plum.finish = () => {
            plum.isRunning = false;
            resolve({});
          };
        });
      },
    },
  } as unknown as ApiContext;
  const stored = new Map<string, IntentionRow[]>();
  const intentions = new IntentionService(ctx, {
    intentionRepository: {
      getRows: (simId: string, day: number) => stored.get(`${simId}|${day}`),
      saveRows: (simId: string, day: number, rows: IntentionRow[]) => {
        stored.set(`${simId}|${day}`, rows);
      },
    } as never,
  });
  const nightCall = new NightCallService(ctx, { intentions });
  // A report goes through the rows, then the night call ticks (CognitionService's order)
  const feed = (rep: SimStateReport) => {
    cache.ingest(rep);
    (rep.sims ?? []).forEach((sim) => {
      intentions.sync(sim, rep);
    });
    nightCall.tick(rep);
  };
  return { ctx, cache, plum, intentions, nightCall, feed };
}

async function settle() {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

describe('NightCallService', () => {
  const corinne = entry('100', 'Corinne Stiles');
  const duane = entry('200', 'Duane Miles');

  it('a rollover queues each Sim; one night turn runs at a time, the next after it ends', async () => {
    const { plum, feed, nightCall } = build();
    feed(report(40, 22, [corinne, duane]));
    expect(plum.turns).toEqual([]);
    feed(report(41, 0, [corinne, duane]));
    expect(plum.turns).toHaveLength(1);
    expect(plum.turns[0].options).toEqual({ night: true });
    expect(plum.turns[0].text).toContain('sim="Corinne Stiles"');
    expect(nightCall.pending.map((item) => item.simId)).toEqual(['200']);
    // Duane waits while Corinne's turn runs
    feed(report(41, 1, [corinne, duane]));
    expect(plum.turns).toHaveLength(1);
    plum.finish?.();
    await settle();
    feed(report(41, 1, [corinne, duane]));
    expect(plum.turns).toHaveLength(2);
    expect(plum.turns[1].text).toContain('sim="Duane Miles"');
  });

  it('an edit during the turn counts as edited', async () => {
    const { plum, feed, intentions, nightCall } = build();
    feed(report(40, 22, [corinne]));
    feed(report(41, 0, [corinne]));
    expect(nightCall.runningSim).toBe('100');
    intentions.applyEdits('100', {
      drop: [],
      rewrite: [],
      add: [{ why: 'Write a chapter', say: 'Words first, coffee second.' }],
    });
    plum.finish?.();
    await settle();
    expect(nightCall.runningSim).toBeUndefined();
    expect(intentions.rowsFor('100').some((item) => item.source === 'story')).toBe(true);
  });

  it('a Sim still queued six sim-hours into the day is dropped', () => {
    const { plum, feed, nightCall } = build();
    plum.unavailable = 'the Claude Code session is not running';
    feed(report(40, 22, [corinne]));
    feed(report(41, 0, [corinne]));
    expect(plum.turns).toEqual([]);
    expect(nightCall.pending).toHaveLength(1);
    feed(report(41, 7, [corinne]));
    expect(nightCall.pending).toEqual([]);
    plum.unavailable = undefined;
    feed(report(41, 8, [corinne]));
    expect(plum.turns).toEqual([]);
  });

  it('Plum off runs none; the setting off queues none', () => {
    const off = build({ plumEnabled: false });
    off.feed(report(40, 22, [corinne]));
    off.feed(report(41, 0, [corinne]));
    expect(off.plum.turns).toEqual([]);
    const disabled = build({ nightCallEnabled: false });
    disabled.feed(report(40, 22, [corinne]));
    disabled.feed(report(41, 0, [corinne]));
    expect(disabled.nightCall.pending).toEqual([]);
    expect(disabled.plum.turns).toEqual([]);
  });

  it('runNow works with no rollover, using today as the day when there is no yesterday', () => {
    const { plum, feed, nightCall } = build();
    feed(report(41, 9, [corinne]));
    const result = nightCall.runNow('100');
    expect(result).toEqual({ ok: true, started: 'night call for Corinne Stiles (day 41 -> 41)' });
    expect(plum.turns).toHaveLength(1);
    expect(plum.turns[0].options).toEqual({ night: true });
    expect(nightCall.runNow('100')).toMatchObject({ ok: false });
    expect(nightCall.runNow('999')).toMatchObject({ ok: false, error: 'no state report for sim 999' });
  });

  it("runNow reads yesterday's stored rows when there are some", () => {
    const { plum, feed, intentions, nightCall } = build();
    feed(report(40, 20, [corinne]));
    intentions.applyEdits('100', {
      drop: [],
      rewrite: [],
      add: [{ why: 'Yesterday I meant to call Mom', say: 'I should call Mom.' }],
    });
    intentions.flush();
    // The rollover queued a call; let it be the debug route's instead
    plum.unavailable = 'busy';
    feed(report(41, 9, [corinne]));
    plum.unavailable = undefined;
    const result = nightCall.runNow('100');
    expect(result.started).toContain('(day 40 -> 41)');
    expect(plum.turns.at(-1)?.text).toContain('Yesterday I meant to call Mom');
  });
});
