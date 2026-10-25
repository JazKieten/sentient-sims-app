import * as fs from 'fs';
import { describe, expect, it } from 'vitest';
import { mockApiContext } from './util';
import { ApiContext } from 'main/sentient-sims/services/ApiContext';
import { ProcedureRepository } from 'main/sentient-sims/db/ProcedureRepository';
import { IntentionService } from 'main/sentient-sims/services/intentions/IntentionService';
import { ProcedureService } from 'main/sentient-sims/services/intentions/ProcedureService';
import { RowMemoryService } from 'main/sentient-sims/services/intentions/RowMemoryService';
import {
  Pitfall,
  Procedure,
  SHARED_SCOPE,
  applyToRow,
  bindClick,
  draftFrom,
  emptyProcedure,
  nightLessons,
  normalizeKey,
  procedureKeyOf,
  promotable,
  recordFailure,
  revise,
} from 'main/sentient-sims/services/intentions/Procedures';
import { storyRow } from 'main/sentient-sims/services/intentions/IntentionSeeds';
import { buildNightText } from 'main/sentient-sims/services/intentions/NightCall';
import { intentionEdits } from 'main/sentient-sims/services/plum/PlumAppTools';
import { IntentionRow } from 'main/sentient-sims/models/IntentionRow';
import { SimStateEntry, SimStateReport } from 'main/sentient-sims/models/SimStateReport';
import { SimStateCache } from 'main/sentient-sims/services/SimStateCache';

// Renovation R4: procedures (what clicked and ran for a key, drafted by code from the game's
// outcome, the winner first; revised in place by the night call when it fails) and pitfalls (the
// night call's diagnoses and its lessons). k = 1, exact keys, counters by code.

function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('expected a value');
  }
  return value;
}

const GARDEN = {
  id: 'objective_Garden',
  source: 'aspiration' as const,
  label: 'Plant something',
  affordances: ['super_PottedPlants_Gardening_Plant_Cont', 'gardening_Plant'],
};

function entry(simId: string, name = 'Seth Polanco', goals = [GARDEN]): SimStateEntry {
  return {
    sim_id: simId,
    sim_name: name,
    sims: [{ sim_id: '200', name: 'Arlene Zhang', tier: 'same_room', distance: 3 }],
    objects: [],
    self: { needs: { hunger: 50, fun: 10 }, mood: 'Happy', goal_pool: goals },
    activity: { running: 'sim_Idle', queue: [] },
    is_household: true,
  };
}

function report(sims: SimStateEntry[], day = 40, hour = 10): SimStateReport {
  return {
    type: 'state_report',
    seq: 1,
    lot: { zone_id: 1, clock: { hour, minute: 0, absolute_day: day, day: 2, speed: 'NORMAL' }, funds: 2000 },
    sims,
  };
}

class FakeProcedures {
  procedures = new Map<string, Procedure>();

  pitfalls = new Map<string, Pitfall>();

  isLoaded() {
    return true;
  }

  proceduresFor(scope: string) {
    return [...this.procedures.values()]
      .filter((procedure) => procedure.scope === scope)
      .map((procedure) => ({ ...procedure }));
  }

  proceduresByKey(key: string) {
    return [...this.procedures.values()].filter((procedure) => procedure.key === key).map((p) => ({ ...p }));
  }

  allProcedures() {
    return [...this.procedures.values()];
  }

  saveProcedure(procedure: Procedure) {
    this.procedures.set(`${procedure.scope}|${procedure.key}`, { ...procedure, items: [...procedure.items] });
  }

  pitfallsFor(scope: string) {
    return [...this.pitfalls.values()].filter((pitfall) => pitfall.scope === scope).map((p) => ({ ...p }));
  }

  allPitfalls() {
    return [...this.pitfalls.values()];
  }

  savePitfall(pitfall: Pitfall) {
    this.pitfalls.set(`${pitfall.scope}|${pitfall.about}`, { ...pitfall });
  }
}

function build() {
  const cache = new SimStateCache();
  const ctx = {
    settings: { intentionBeatMinutes: 120, intentionNeedFloor: -60, cognitionActionScoreThreshold: 7 },
    db: { isLoaded: () => true },
    simStateCache: cache,
  } as unknown as ApiContext;
  const fake = new FakeProcedures();
  const repository = {
    isLoaded: () => true,
    procedures: (scope: string) => fake.proceduresFor(scope),
    proceduresByKey: (key: string) => fake.proceduresByKey(key),
    allProcedures: () => fake.allProcedures(),
    saveProcedure: (procedure: Procedure) => {
      fake.saveProcedure(procedure);
    },
    pitfalls: (scope: string) => fake.pitfallsFor(scope),
    allPitfalls: () => fake.allPitfalls(),
    savePitfall: (pitfall: Pitfall) => {
      fake.savePitfall(pitfall);
    },
  };
  const rowMemory = new RowMemoryService(ctx, {});
  const procedures = new ProcedureService(ctx, { procedureRepository: repository as never, rowMemory });
  const stored = new Map<string, IntentionRow[]>();
  const service = new IntentionService(ctx, {
    intentionRepository: {
      getRows: (simId: string, day: number) => stored.get(`${simId}|${day}`),
      saveRows: (simId: string, day: number, rows: IntentionRow[]) => {
        stored.set(`${simId}|${day}`, JSON.parse(JSON.stringify(rows)) as IntentionRow[]);
      },
    } as never,
    rowMemory,
    procedures,
  });
  return { service, procedures, fake, cache };
}

// One click of the Sim's first row, answered by the mod
function clickOnce(
  built: ReturnType<typeof build>,
  sim: SimStateEntry,
  rep: SimStateReport,
  requestId: string,
  answer: {
    outcome: string;
    reason?: string;
    cause?: string;
    interaction_name?: string;
    label?: string;
    ran?: boolean;
  },
) {
  const row = must(built.service.pick(sim, rep, { force: true }));
  built.service.markFired(row.id, '');
  built.service.markInFlight(row.id, requestId, undefined, 'x');
  built.service.onOutcome({
    request_id: requestId,
    sim_id: sim.sim_id,
    decided_at: 'running',
    ...answer,
  } as never);
  return row;
}

describe('Procedures (pure)', () => {
  it('keys: a story row by its own key, a goal row by its seed key at the zone, needs never', () => {
    const goal = { ...storyRow({ why: 'w', say: 's', click: { target_kind: 'self', items: ['A'] } }, 40, 7) };
    expect(procedureKeyOf(goal, '1')).toBeUndefined();
    const keyed = storyRow(
      { why: 'w', say: 's', key: ' make up ', click: { target_kind: 'self', items: ['A'] } },
      40,
      7,
    );
    expect(keyed.procedureKey).toBe('make_up');
    expect(procedureKeyOf(keyed, '1')).toBe('make_up');
    const aspiration = { ...keyed, source: 'aspiration' as const, seedKey: 'objective_Garden' };
    expect(procedureKeyOf(aspiration, '7')).toBe('objective_Garden@7');
    expect(procedureKeyOf({ ...keyed, source: 'need' as const }, '1')).toBeUndefined();
    expect(normalizeKey('[objective_Asp_Nature_A1_1@123]')).toBe('objective_Asp_Nature_A1_1@123');
  });

  it('a draft puts the item that ran first and generalizes a Sim target to the variable', () => {
    const row = storyRow(
      {
        why: 'Make up with Arlene',
        say: 'Sorry.',
        key: 'make_up',
        click: { target_kind: 'sim', target_id: '200', items: ['Apologize', 'Hug', 'Chat'] },
      },
      40,
      7,
    );
    const draft = draftFrom(undefined, { scope: '100', key: 'make_up', zone: '1', row, clicked: 'Hug', day: 40 });
    expect(draft).toMatchObject({ items: ['Hug', 'Apologize', 'Chat'], targetKind: 'sim', ran: 1, uses: 1 });
    expect(draft.targetName).toBeUndefined();
    expect(bindClick(draft, { target_sim_id: '300', target_name: 'Cristal' })).toEqual({
      target_kind: 'sim',
      target_id: '300',
      target_name: 'Cristal',
      items: ['Hug', 'Apologize', 'Chat'],
    });
    expect(bindClick(draft, {})).toBeUndefined();
  });

  it('a structural failure asks for a fix; three since it ran retire it; a revision is a fresh streak', () => {
    let procedure: Procedure = { ...emptyProcedure('100', 'k'), items: ['A'], ran: 1 };
    procedure = recordFailure(procedure, { day: 40, cause: 'target_left', structural: false });
    expect(procedure.status).toBe('active');
    procedure = recordFailure(procedure, { day: 40, cause: 'not_on_menu', structural: true });
    expect(procedure.status).toBe('needs_fix');
    const revised = revise(procedure, { key: 'k', target_kind: 'kind', target_id: 'planter', items: ['Plant'] }, 41);
    expect(revised).toMatchObject({ status: 'active', source: 'night', revisions: 1, firesSinceRan: 0 });
    expect(revised.targetName).toBe('planter');
    procedure = recordFailure(procedure, { day: 41, cause: 'not_on_menu', structural: true });
    expect(procedure.status).toBe('retired');
  });

  it('a seeded row clicks its procedure first, once (idempotent)', () => {
    const row = storyRow({ why: 'w', say: 's', click: { target_kind: 'self', items: ['B', 'C'] } }, 40, 7);
    const procedure = { ...emptyProcedure('100', 'k'), items: ['C', 'Z'], targetKind: 'self' as const };
    const what = must(applyToRow(row, procedure));
    expect(what.kind === 'pie' && what.candidates).toEqual(['C', 'Z', 'B']);
    expect(applyToRow({ ...row, what }, procedure)).toBeUndefined();
  });

  it('promotes when two Sims ran the same first item for one key', () => {
    const own = (scope: string, first: string): Procedure => ({
      ...emptyProcedure(scope, 'k'),
      items: [first],
      ran: 1,
      targetKind: 'self',
    });
    expect(promotable([own('1', 'A')], own('1', 'A'))).toBe(false);
    expect(promotable([own('1', 'A'), own('2', 'B')], own('1', 'A'))).toBe(false);
    expect(promotable([own('1', 'A'), own('2', 'a')], own('1', 'A'))).toBe(true);
  });

  it('the night blocks: worked, failed, fresh pitfalls; shared ones only for this zone', () => {
    const lessons = nightLessons({
      own: [
        { ...emptyProcedure('1', 'calm_down'), items: ['Take a Bath'], targetKind: 'self', ran: 2, lastDay: 40 },
        { ...emptyProcedure('1', 'garden@1'), items: ['Plant'], status: 'needs_fix', failed: 2, lastDay: 40 },
      ],
      ownPitfalls: [
        {
          scope: '1',
          about: 'old',
          text: 'Long ago.',
          evidence: [],
          seen: 1,
          status: 'active',
          source: 'night',
          lastDay: 20,
        },
        {
          scope: '1',
          about: 'k',
          text: 'No planter.',
          evidence: [],
          seen: 2,
          status: 'active',
          source: 'diagnosis',
          lastDay: 40,
        },
        {
          scope: '1',
          about: 'gone',
          text: 'Fixed now.',
          evidence: [],
          seen: 1,
          status: 'stale',
          source: 'night',
          lastDay: 40,
        },
      ],
      shared: [{ ...emptyProcedure(SHARED_SCOPE, 'pay'), items: ['Pay Bills'], targetKind: 'phone', zone: '2' }],
      sharedPitfalls: [
        {
          scope: '*',
          about: 'toilet',
          text: 'The toilet breaks.',
          evidence: [],
          seen: 1,
          status: 'active',
          source: 'night',
          zone: '1',
          lastDay: 40,
        },
      ],
      day: 41,
      zone: '1',
    });
    expect(lessons.worked).toEqual(['- [calm_down] ran=2 failed=0 :: self: Take a Bath']);
    expect(lessons.failed[0]).toContain('- [garden@1] ran=0 failed=2 :: was the nearest provider: Plant');
    expect(lessons.pitfalls).toEqual(['- [k] No planter. (seen 2x)']);
    expect(lessons.shared).toEqual(['- [toilet] The toilet breaks.']);
  });
});

describe('ProcedureService with the intention list', () => {
  it('a goal row that ran drafts its procedure, the clicked label first; tomorrow clicks it first', () => {
    const built = build();
    const seth = entry('100');
    const rep = report([seth]);
    built.cache.ingest(rep);
    built.service.sync(seth, rep);
    clickOnce(built, seth, rep, 'req-1', {
      outcome: 'success',
      ran: true,
      label: 'Plant something',
      interaction_name: 'Plant Seeds',
    });
    const procedure = must(built.procedures.procedureFor('100', 'objective_Garden@1'));
    expect(procedure).toMatchObject({ source: 'code', ran: 1, status: 'active', targetKind: 'find' });
    expect(procedure.items[0]).toBe('Plant Seeds');
    // The next day's seed of the same goal clicks the label that ran first
    const tomorrow = report([seth], 41);
    built.cache.ingest(tomorrow);
    built.service.sync(seth, tomorrow);
    const row = must(built.service.rowsFor('100').find((item) => item.seedKey === 'objective_Garden'));
    expect(row.what.kind === 'pie' && row.what.candidates[0]).toBe('Plant Seeds');
  });

  it('a structural refusal under a known key asks the night for a fix', () => {
    const built = build();
    const seth = entry('100');
    const rep = report([seth]);
    built.cache.ingest(rep);
    built.service.sync(seth, rep);
    clickOnce(built, seth, rep, 'req-1', {
      outcome: 'success',
      ran: true,
      label: 'Plant something',
      interaction_name: 'Plant Seeds',
    });
    const tomorrow = report([seth], 41);
    built.cache.ingest(tomorrow);
    built.service.sync(seth, tomorrow);
    clickOnce(built, seth, tomorrow, 'req-2', {
      outcome: 'canceled',
      reason: 'Plant something: none of 3 candidates is on the menu',
    });
    expect(built.procedures.procedureFor('100', 'objective_Garden@1')).toMatchObject({
      status: 'needs_fix',
      failed: 1,
      lastCause: 'not_on_menu',
    });
    const lessons = built.procedures.nightLessons('100', 42);
    expect(lessons.failed[0]).toContain('[objective_Garden@1]');
  });

  it('the night call revises it in place, writes pitfalls, and a keyed row takes its click', () => {
    const built = build();
    const seth = entry('100');
    const rep = report([seth]);
    built.cache.ingest(rep);
    built.service.sync(seth, rep);
    clickOnce(built, seth, rep, 'req-1', {
      outcome: 'success',
      ran: true,
      label: 'Plant something',
      interaction_name: 'Plant Seeds',
    });
    built.procedures.recordFailureNow('100', 'objective_Garden@1');
    const result = built.service.applyEdits('100', {
      drop: [],
      rewrite: [],
      add: [{ why: 'Garden again', say: 'Back to the dirt.', key: 'objective_Garden@1' }],
      diagnoses: [{ key: 'objective_Garden', text: 'The planter was sold.' }],
      revise_procedure: [
        { key: 'objective_Garden@1', target_kind: 'kind', target_id: 'planterBox', items: ['Plant'] },
        { key: 'nope', target_kind: 'self', items: ['X'] },
      ],
      add_pitfall: [{ about: 'planterBox', text: 'The only planter is outside.', shared: true }],
    });
    expect(result.changed).toContain('1 procedure revised, 1 pitfall, 1 click from a procedure');
    expect(result.changed).toContain("not revised: [nope] is not one of Seth's procedures");
    expect(built.procedures.procedureFor('100', 'objective_Garden@1')).toMatchObject({
      status: 'active',
      source: 'night',
      targetKind: 'kind',
      targetName: 'planterBox',
      items: ['Plant'],
    });
    const added = must(built.service.rowsFor('100').find((item) => item.source === 'story'));
    expect(added.what).toMatchObject({
      kind: 'pie',
      candidates: ['Plant'],
      target: { kind: 'kind', id: 'planterBox' },
    });
    expect(added.procedureKey).toBe('objective_Garden@1');
    expect(built.procedures.diagnosisFor('100', 'objective_Garden')).toBe('The planter was sold.');
    expect(built.fake.pitfalls.get('*|planterBox')).toMatchObject({ zone: '1', source: 'night' });
    // The shared block is frozen for the day: the first night text of day 41 fixes it
    const lessons = built.procedures.nightLessons('100', 41);
    expect(lessons.shared).toEqual(['- [planterBox] The only planter is outside.']);
    expect(lessons.pitfalls).toEqual(['- [objective_Garden] The planter was sold.']);
  });

  it('a pitfall about a key goes stale once that key runs', () => {
    const built = build();
    const seth = entry('100');
    const rep = report([seth]);
    built.cache.ingest(rep);
    built.service.sync(seth, rep);
    built.procedures.diagnose('100', 'objective_Garden', 'No planter.');
    clickOnce(built, seth, rep, 'req-1', {
      outcome: 'success',
      ran: true,
      label: 'Plant something',
      interaction_name: 'Plant Seeds',
    });
    expect(built.fake.pitfalls.get('100|objective_Garden')?.status).toBe('stale');
  });

  it('two Sims that ran the same click share it', () => {
    const built = build();
    const seth = entry('100');
    const arlene = entry('200', 'Arlene Zhang');
    const rep = report([seth, arlene]);
    built.cache.ingest(rep);
    built.service.sync(seth, rep);
    built.service.sync(arlene, rep);
    clickOnce(built, seth, rep, 'req-1', {
      outcome: 'success',
      ran: true,
      label: 'Plant something',
      interaction_name: 'Plant Seeds',
    });
    clickOnce(built, arlene, rep, 'req-2', {
      outcome: 'success',
      ran: true,
      label: 'Plant something',
      interaction_name: 'Plant Seeds',
    });
    expect(built.procedures.procedureFor(SHARED_SCOPE, 'objective_Garden@1')).toMatchObject({
      items: ['Plant Seeds', 'super_PottedPlants_Gardening_Plant_Cont', 'gardening_Plant'],
    });
  });
});

describe('the night text and the tool (R4)', () => {
  it('opens with the shared block and shows the Sim lessons and the new rules', () => {
    const text = buildNightText({
      simId: '100',
      simName: 'Seth Polanco',
      endingDay: 40,
      newDay: 41,
      endingRows: [],
      todayRows: [],
      memories: [],
      outcomes: [],
      lessons: {
        shared: ['- [toilet] The toilet breaks.'],
        worked: ['- [calm_down] ran=2 failed=0 :: self: Take a Bath'],
        failed: ['- [garden@1] ran=0 failed=2 :: was planter: Plant :: failed day 40'],
        pitfalls: ['- [k] No planter.'],
      },
    });
    expect(text.startsWith('<shared_lessons>\n')).toBe(true);
    expect(text).toContain('What has worked for Seth (procedures: reuse one by its [key]):');
    expect(text).toContain('Procedures that failed (revise in place with revise_procedure, or leave them):');
    expect(text).toContain('Lessons Seth has learned (pitfalls):');
    expect(text).toContain('`revise_procedure`');
    const bare = buildNightText({
      simId: '100',
      simName: 'Seth Polanco',
      endingDay: 40,
      newDay: 41,
      endingRows: [],
      todayRows: [],
      memories: [],
      outcomes: [],
    });
    expect(bare.startsWith('<night_call')).toBe(true);
  });

  it('parses key, revise_procedure and add_pitfall', () => {
    const cache = new SimStateCache();
    cache.ingest(report([entry('100'), entry('200', 'Arlene Zhang')]));
    const ctx = {
      simStateCache: cache,
      participantRepository: {
        getAllParticipants: () => {
          throw new Error('no database');
        },
      },
    } as unknown as ApiContext;
    const edits = intentionEdits(ctx, {
      drop: [],
      rewrite: [],
      add: [{ why: 'w', say: 's', target: 'Arlene', from_hour: null, to_hour: null, click: null, key: '[make_up]' }],
      diagnoses: [],
      revise_procedure: [
        { key: '[make_up]', target: '{target}', items: ['Apologize'], why: null },
        { key: 'cook', target: 'object_fridge', items: ['Cook'], why: 'Dinner' },
      ],
      add_pitfall: [{ about: 'Arlene', text: 'She leaves at five.', shared: false }],
    });
    expect(edits.add[0].key).toBe('make_up');
    expect(edits.revise_procedure).toEqual([
      { target_kind: 'sim', key: 'make_up', items: ['Apologize'] },
      {
        target_kind: 'kind',
        target_id: 'object_fridge',
        target_name: 'object_fridge',
        key: 'cook',
        items: ['Cook'],
        why: 'Dinner',
      },
    ]);
    expect(edits.add_pitfall).toEqual([{ about: 'Arlene', text: 'She leaves at five.', shared: false }]);
    expect(() =>
      intentionEdits(ctx, {
        drop: [],
        rewrite: [],
        add: [],
        revise_procedure: [{ key: 'k', target: 'self', items: [] }],
      }),
    ).toThrow('needs 1 to 3 items');
  });
});

describe('ProcedureRepository on a real save database (migration 029)', () => {
  it('round-trips procedures and pitfalls, upserting by scope and key', () => {
    const ctx = mockApiContext();
    fs.mkdirSync(ctx.directory.getSentientSimsFolder(), { recursive: true });
    ctx.db.loadDatabase({ sessionId: 'procedures-roundtrip', saveId: '1' });
    const repository = new ProcedureRepository(ctx.db);
    const procedure: Procedure = {
      ...emptyProcedure('100', 'make_up'),
      items: ['Apologize'],
      targetKind: 'sim',
      ran: 1,
      lastFailure: { day: 40, cause: 'target_left' },
    };
    repository.saveProcedure(procedure);
    repository.saveProcedure({ ...procedure, ran: 2, status: 'needs_fix' });
    const [stored] = repository.procedures('100');
    expect(stored).toMatchObject({ key: 'make_up', items: ['Apologize'], ran: 2, status: 'needs_fix' });
    expect(stored.lastFailure).toEqual({ day: 40, cause: 'target_left' });
    expect(repository.proceduresByKey('make_up')).toHaveLength(1);
    const pitfall: Pitfall = {
      scope: '*',
      about: 'toilet',
      text: 'It breaks.',
      evidence: [3, 4],
      seen: 1,
      status: 'active',
      source: 'night',
      zone: '1',
      lastDay: 40,
    };
    repository.savePitfall(pitfall);
    repository.savePitfall({ ...pitfall, seen: 2, text: 'It breaks every morning.' });
    expect(repository.pitfalls('*')).toEqual([expect.objectContaining({ seen: 2, text: 'It breaks every morning.' })]);
    expect(repository.allPitfalls()[0].evidence).toEqual([3, 4]);
  });
});
