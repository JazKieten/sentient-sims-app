import { describe, expect, it } from 'vitest';
import { ApiContext } from 'main/sentient-sims/services/ApiContext';
import { intentionEdits } from 'main/sentient-sims/services/plum/PlumAppTools';
import { IntentionService } from 'main/sentient-sims/services/intentions/IntentionService';
import { BudgetGate, LATENCY_SEED_MS } from 'main/sentient-sims/services/intentions/BudgetGate';
import { storyRow } from 'main/sentient-sims/services/intentions/IntentionSeeds';
import { buildNightText, clickableLines } from 'main/sentient-sims/services/intentions/NightCall';
import { emptyView, initiation, labelParts } from 'main/sentient-sims/services/intentions/RowMemory';
import type { VocabularySeenEntry } from 'main/sentient-sims/db/RowMemoryRepository';
import { IntentionRow } from 'main/sentient-sims/models/IntentionRow';
import { SimStateEntry, SimStateReport } from 'main/sentient-sims/models/SimStateReport';
import { SimStateCache } from 'main/sentient-sims/services/SimStateCache';

// Renovation R3: the night call writes story rows as ready-to-click pie rows picked from the
// menus the Sim saw yesterday (no fire-time model call), says why each dead row died in the same
// call, and the day's remaining model calls wait behind SOFAI's budget gate.

function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('expected a value');
  }
  return value;
}

function report(sims: SimStateEntry[] = [], hour = 10, minute = 0): SimStateReport {
  return {
    type: 'state_report',
    seq: 1,
    lot: { zone_id: 1, clock: { hour, minute, absolute_day: 40 } },
    sims,
  };
}

function entry(simId: string, name: string, extra: Partial<SimStateEntry> = {}): SimStateEntry {
  return { sim_id: simId, sim_name: name, sims: [], objects: [], self: {}, is_household: true, ...extra };
}

function toolCtx(): ApiContext {
  const cache = new SimStateCache();
  cache.ingest(report([entry('100', 'Corinne Hart'), entry('200', 'Duane Miles')]));
  return {
    simStateCache: cache,
    participantRepository: {
      getAllParticipants: () => {
        throw new Error('no database');
      },
    },
  } as unknown as ApiContext;
}

const seen = (target: string, label: string, kind = 'object', greyed?: string): VocabularySeenEntry => ({
  simId: '100',
  target,
  kind,
  label,
  key: `k_${label}`,
  greyed,
  zone: '1',
  day: 39,
});

describe('edit_intentions: a story row with a click, and the diagnoses', () => {
  it('resolves the click target: self, a Sim, the phone, else an object kind', () => {
    const edits = intentionEdits(toolCtx(), {
      drop: [],
      rewrite: [],
      add: [
        {
          why: 'Stargaze',
          say: 'Stars.',
          target: null,
          click: { target: 'self', items: ['Stargaze'], fallback_target: null },
        },
        {
          why: 'Make up with Duane',
          say: 'Sorry.',
          target: null,
          click: { target: 'Duane', items: ['Apologize', 'Hug'], fallback_target: null },
        },
        {
          why: 'Call Mom',
          say: 'Hi!',
          target: null,
          click: { target: 'phone', items: ['Call'], fallback_target: null },
        },
        {
          why: 'Cook dinner',
          say: 'Dinner!',
          target: null,
          click: { target: 'object_fridgeDS_02', items: ['Cook'], fallback_target: 'self' },
        },
      ],
      diagnoses: [{ key: '[objective_Garden]', text: 'No planter on this lot.' }],
    });
    expect(edits.add.map((add) => add.click?.target_kind)).toEqual(['self', 'sim', 'phone', 'kind']);
    expect(edits.add[1].click).toMatchObject({
      target_id: '200',
      target_name: 'Duane Miles',
      items: ['Apologize', 'Hug'],
    });
    expect(edits.add[3].click).toMatchObject({ target_id: 'object_fridgeDS_02', fallback: { target_kind: 'self' } });
    expect(edits.diagnoses).toEqual([{ key: 'objective_Garden', text: 'No planter on this lot.' }]);
  });

  it('refuses a click with no items, too many, or no target', () => {
    const add = (click: unknown) => () =>
      intentionEdits(toolCtx(), { drop: [], rewrite: [], add: [{ why: 'w', say: 's', target: null, click }] });
    expect(add({ target: 'self', items: [], fallback_target: null })).toThrow(/1 to 3 items/);
    expect(add({ target: 'self', items: ['a', 'b', 'c', 'd'], fallback_target: null })).toThrow(/1 to 3 items/);
    expect(add({ target: '', items: ['a'], fallback_target: null })).toThrow(/needs `target`/);
  });
});

describe('a story row with a click is a pie row', () => {
  it('carries the items, the target and the fallback, and a Sim target must be present', () => {
    const row = storyRow(
      {
        why: 'Make up with Duane',
        say: 'Sorry about yesterday.',
        click: {
          target_kind: 'sim',
          target_id: '200',
          target_name: 'Duane Miles',
          items: ['Apologize'],
          fallback: { target_kind: 'kind', target_id: 'object_fridge' },
        },
      },
      40,
      7,
    );
    expect(row.what).toEqual({
      kind: 'pie',
      candidates: ['Apologize'],
      label: 'Make up with Duane',
      target: { kind: 'sim', id: '200', name: 'Duane Miles' },
      fallbackTarget: { kind: 'kind', id: 'object_fridge', name: undefined },
    });
    expect(row.target).toEqual({ sim_id: '200', name: 'Duane Miles' });
    expect(row.preconditions).toContainEqual({ kind: 'target_present', sim_id: '200' });
    // Without a click it stays deliberate
    expect(storyRow({ why: 'w', say: 's' }, 40, 7).what.kind).toBe('deliberate');
  });

  it('is judged by label on the menus seen', () => {
    const row = storyRow(
      { why: 'Cook', say: 's', click: { target_kind: 'kind', target_id: 'fridge', items: ['Cook'] } },
      40,
      7,
    );
    const view = emptyView();
    view.targets.set('object_fridge', {
      keys: new Set(['k']),
      supers: new Set(),
      greyed: new Map(),
      labels: new Set(['cook']),
    });
    expect(initiation(row, view).ok).toBe(true);
    expect(labelParts('Cook [fridge_Cook] (picker)')).toEqual({ label: 'cook', key: 'fridge_Cook' });
  });
});

describe('the night text lists what the Sim could click yesterday', () => {
  it('per target, ungreyed, no <choice> rows, Sims by name, and the rules ask for clicks and diagnoses', () => {
    const vocabulary = [
      seen('self', 'Stargaze', 'self'),
      seen('sim:200', 'Ask about Day', 'sim'),
      seen('sim:200', 'Insult', 'sim', 'too far'),
      seen('object_fridgeDS_02', 'Cook'),
      seen('object_stereo', 'Listen To <choice>'),
      seen('phone', 'Call', 'phone'),
    ];
    const input = {
      simId: '100',
      simName: 'Corinne Hart',
      report: report([entry('200', 'Duane Miles')]),
      endingDay: 39,
      newDay: 40,
      endingRows: [],
      todayRows: [],
      memories: [],
      outcomes: [],
      vocabulary,
    };
    expect(clickableLines(input)).toEqual([
      '- self: Stargaze',
      '- Duane Miles: Ask about Day',
      '- object_fridgeDS_02: Cook',
      '- phone: Call',
    ]);
    const text = buildNightText(input);
    expect(text).toContain('What Corinne could click yesterday');
    expect(text).toContain('Give each story row a `click`');
    expect(text).toContain('one `diagnoses` line by its [key]');
    expect(buildNightText({ ...input, vocabulary: [] })).toContain('no menus were seen yesterday');
  });
});

describe('applyEdits and the fallback target', () => {
  function service() {
    const cache = new SimStateCache();
    const ctx = {
      settings: { intentionBeatMinutes: 120, intentionNeedFloor: -60, cognitionActionScoreThreshold: 7 },
      db: { isLoaded: () => true },
      simStateCache: cache,
    } as unknown as ApiContext;
    const diagnosed: string[] = [];
    const procedures = {
      diagnose: (simId: string, key: string, text: string) => diagnosed.push(`${key}: ${text}`),
      onOutcome: () => undefined,
      applyToRow: () => false,
      bindStoryClick: () => undefined,
    };
    const rowMemory = {
      get: () => undefined,
      retiredFilter: (_simId: string, seeds: IntentionRow[]) => seeds,
      vocabularyView: () => emptyView(),
      skip: () => undefined,
      startFire: () => undefined,
      commitFire: () => undefined,
      outcome: () => undefined,
      rewrote: () => undefined,
      expired: () => undefined,
    };
    const intentions = new IntentionService(ctx, {
      intentionRepository: { getRows: () => undefined, saveRows: () => undefined } as never,
      rowMemory: rowMemory as never,
      procedures: procedures as never,
    });
    const corinne = entry('100', 'Corinne Hart', {
      self: { goal_pool: [{ id: 'objective_Garden', source: 'aspiration', label: 'Plant', affordances: ['x'] }] },
    });
    const rep = report([corinne]);
    cache.ingest(rep);
    intentions.sync(corinne, rep);
    return { intentions, diagnosed, corinne, rep };
  }

  it('keeps the diagnoses on the row with that key and counts the click rows', () => {
    const { intentions, diagnosed } = service();
    const result = intentions.applyEdits('100', {
      drop: [],
      rewrite: [],
      add: [{ why: 'Cook', say: 'Dinner!', click: { target_kind: 'kind', target_id: 'fridge', items: ['Cook'] } }],
      diagnoses: [{ key: 'objective_Garden', text: 'No planter here.' }],
    });
    expect(result.changed).toContain('(1 with a click), 1 diagnosis');
    expect(intentions.rowsFor('100').find((row) => row.seedKey === 'objective_Garden')?.diagnosis).toBe(
      'No planter here.',
    );
    expect(diagnosed).toEqual(['objective_Garden: No planter here.']);
  });

  it('a click refused on its first target tries the fallback target once', () => {
    const { intentions } = service();
    intentions.applyEdits('100', {
      drop: [],
      rewrite: [],
      add: [
        {
          why: 'Cook',
          say: 'Dinner!',
          click: { target_kind: 'kind', target_id: 'fridge', items: ['Cook'], fallback: { target_kind: 'self' } },
        },
      ],
    });
    const story = must(intentions.rowsFor('100').find((row) => row.source === 'story'));
    story.status = 'in_flight';
    story.requestId = 'req-1';
    intentions.onOutcome({
      request_id: 'req-1',
      sim_id: '100',
      outcome: 'ineligible',
      reason: 'no object on the lot provides "fridge"',
    });
    const after = must(intentions.rowsFor('100').find((row) => row.id === story.id));
    expect(after.status).toBe('waiting');
    expect(after.what).toMatchObject({ kind: 'pie', target: { kind: 'self' } });
    expect(after.what.kind === 'pie' ? after.what.fallbackTarget : 'x').toBeUndefined();
  });
});

describe('the budget gate', () => {
  const deliberate = (until: number): IntentionRow => ({
    id: 'i1',
    seedKey: 'scene:1',
    source: 'scene',
    what: { kind: 'deliberate', desire: { score: 8 } },
    why: 'act on it',
    preconditions: [],
    until: { kind: 'game_time', at: until },
    status: 'waiting',
    attempts: 0,
    history: [],
  });

  it('is seeded at 60 s, then the p90 of recent model calls', () => {
    const gate = new BudgetGate();
    expect(gate.p90Ms()).toBe(LATENCY_SEED_MS);
    [5_000, 6_000, 7_000, 8_000, 40_000, 500].forEach((ms) => {
      gate.recordLatency(ms);
    });
    expect(gate.p90Ms()).toBe(40_000);
  });

  it('learns the pace from the reports and shuts a call that cannot finish in the window', () => {
    const gate = new BudgetGate();
    const now = 40 * 1440 + 600;
    expect(gate.allows(deliberate(now + 30), now).ok).toBe(true); // pace unknown: open
    // Speed 3: a game minute every 0.2 real seconds
    gate.observe(report([], 10, 0), 0);
    gate.observe(report([], 10, 50), 10_000);
    expect(gate.pace).toBeCloseTo(0.2);
    // 30 game minutes = 6 real seconds, against a 60 s seed: shut
    expect(gate.allows(deliberate(now + 30), now)).toMatchObject({ ok: false, needSeconds: 60 });
    // A pie row never waits on it
    expect(gate.allows({ ...deliberate(now + 30), what: { kind: 'pie', candidates: ['x'], label: 'x' } }, now).ok).toBe(
      true,
    );
    // Speed 1: a game minute a real second; 120 minutes is plenty
    const slow = new BudgetGate();
    slow.observe(report([], 10, 0), 0);
    slow.observe(report([], 10, 10), 10_000);
    expect(slow.allows(deliberate(now + 120), now).ok).toBe(true);
  });

  it('pick skips a deliberate row the gate shuts and the next row fires', () => {
    const cache = new SimStateCache();
    const ctx = {
      settings: { intentionBeatMinutes: 120, intentionNeedFloor: -60, cognitionActionScoreThreshold: 7 },
      db: { isLoaded: () => true },
      simStateCache: cache,
    } as unknown as ApiContext;
    const gate = new BudgetGate();
    gate.observe(report([], 9, 0), 0);
    gate.observe(report([], 9, 50), 10_000);
    const intentions = new IntentionService(ctx, {
      intentionRepository: { getRows: () => undefined, saveRows: () => undefined } as never,
      budgetGate: gate,
    });
    const corinne = entry('100', 'Corinne Hart', {
      self: { goal_pool: [{ id: 'objective_Garden', source: 'aspiration', label: 'Plant', affordances: ['x'] }] },
    });
    const rep = report([corinne]);
    cache.ingest(rep);
    intentions.sync(corinne, rep);
    must(intentions.addDeliberateRow('100', { source: 'scene', desire: { score: 8, reason: 'make up' } }));
    const picked = must(intentions.pick(corinne, rep));
    expect(picked.seedKey).toBe('objective_Garden');
    const scene = must(intentions.rowsFor('100').find((row) => row.source === 'scene'));
    expect(scene.history).toEqual([expect.objectContaining({ cause: 'budget' })]);
  });
});
