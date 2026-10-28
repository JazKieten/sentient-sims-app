import * as fs from 'fs';
import { describe, expect, it } from 'vitest';
import { RowMemoryRepository } from 'main/sentient-sims/db/RowMemoryRepository';
import { mockApiContext } from './util';
import { ApiContext } from 'main/sentient-sims/services/ApiContext';
import { IntentionService } from 'main/sentient-sims/services/intentions/IntentionService';
import { RowMemoryService } from 'main/sentient-sims/services/intentions/RowMemoryService';
import {
  RowStats,
  classifyOutcome,
  contextSnapshot,
  emptyStats,
  isDead,
  namesSim,
  shouldRetire,
  statsTag,
} from 'main/sentient-sims/services/intentions/RowMemory';
import { buildNightText } from 'main/sentient-sims/services/intentions/NightCall';
import { seedRows } from 'main/sentient-sims/services/intentions/IntentionSeeds';
import type {
  FireLogEntry,
  FireOutcome,
  InteractionLogEntry,
  VocabularySeenEntry,
} from 'main/sentient-sims/db/RowMemoryRepository';
import { IntentionRow } from 'main/sentient-sims/models/IntentionRow';
import { SimStateEntry, SimStateReport } from 'main/sentient-sims/models/SimStateReport';
import { SimStateCache } from 'main/sentient-sims/services/SimStateCache';
import type { DayRollover } from 'main/sentient-sims/services/intentions/IntentionService';

// Renovation R1: row memory. Counters per row key across days (code counts, a gate refusal
// costs nothing), the decision log with the state before the pick, the code-owned retire
// (D4) at the rollover before the night call, the retired seed held off until it clears,
// say once, the night text's inline counts, the household log and the menus seen.

function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('expected a value');
  }
  return value;
}

class FakeRepository {
  stats = new Map<string, RowStats>();

  fires: FireLogEntry[] = [];

  interactions: InteractionLogEntry[] = [];

  vocabulary: VocabularySeenEntry[] = [];

  pruned: { interactions?: number; vocabulary?: number } = {};

  isLoaded() {
    return true;
  }

  statsFor(simId: string) {
    return [...this.stats.values()].filter((stats) => stats.simId === simId).map((stats) => ({ ...stats }));
  }

  allStats() {
    return [...this.stats.values()];
  }

  saveStats(stats: RowStats) {
    this.stats.set(`${stats.simId}|${stats.seedKey}`, { ...stats });
  }

  insertFire(fire: FireLogEntry) {
    this.fires.push({ ...fire, id: this.fires.length + 1 });
    return this.fires.length;
  }

  fireOutcome(requestId: string, outcome: FireOutcome) {
    const fire = [...this.fires].reverse().find((candidate) => candidate.requestId === requestId);
    if (fire) {
      Object.assign(fire, outcome);
    }
    return !!fire;
  }

  firesFor(simId: string, day?: number) {
    return this.fires.filter((fire) => fire.simId === simId && (day === undefined || fire.day === day));
  }

  insertInteractions(entries: InteractionLogEntry[]) {
    this.interactions.push(...entries);
  }

  countInteractions() {
    return {};
  }

  pruneInteractions(beforeDay: number) {
    this.pruned.interactions = beforeDay;
  }

  upsertVocabulary(entries: VocabularySeenEntry[]) {
    this.vocabulary.push(...entries);
  }

  vocabularyFor(simId: string, day: number, zone?: string) {
    return this.vocabulary.filter(
      (seen) => seen.simId === simId && seen.day === day && (zone === undefined || seen.zone === zone),
    );
  }

  pruneVocabulary(beforeDay: number) {
    this.pruned.vocabulary = beforeDay;
  }
}

function build(repository = new FakeRepository()) {
  const cache = new SimStateCache();
  const ctx = {
    settings: { intentionBeatMinutes: 120, intentionNeedFloor: -60, cognitionActionScoreThreshold: 7 },
    db: { isLoaded: () => true },
    simStateCache: cache,
  } as unknown as ApiContext;
  const rowMemory = new RowMemoryService(ctx, { rowMemoryRepository: repository as never });
  const stored = new Map<string, IntentionRow[]>();
  const service = new IntentionService(ctx, {
    intentionRepository: {
      getRows: (simId: string, day: number) => stored.get(`${simId}|${day}`),
      saveRows: (simId: string, day: number, rows: IntentionRow[]) => {
        stored.set(`${simId}|${day}`, JSON.parse(JSON.stringify(rows)) as IntentionRow[]);
      },
    } as never,
    rowMemory,
  });
  return { service, rowMemory, repository, cache };
}

const GARDEN = {
  id: 'objective_Garden',
  source: 'aspiration' as const,
  label: 'Plant something',
  affordances: ['super_PottedPlants_Gardening_Plant_Cont', 'gardening_Plant'],
};

function entry(simId: string, self: Partial<NonNullable<SimStateEntry['self']>> = {}): SimStateEntry {
  return {
    sim_id: simId,
    sim_name: 'Seth Polanco',
    sims: [{ sim_id: '200', name: 'Arlene Zhang', tier: 'same_room', distance: 3 }],
    objects: [],
    self: { needs: { hunger: 50, fun: 10 }, mood: 'Happy', goal_pool: [GARDEN], ...self },
    activity: { running: 'sim_Idle', queue: [] },
    is_household: true,
  };
}

function report(sims: SimStateEntry[], day = 40, hour = 10, zone: number | string = 1): SimStateReport {
  return {
    type: 'state_report',
    seq: 1,
    lot: { zone_id: zone, clock: { hour, minute: 0, absolute_day: day, day: 2, speed: 'NORMAL' }, funds: 2000 },
    sims,
  };
}

// One fire of the garden row that the mod refuses with "none of N candidates is on the menu"
function failOnce(built: ReturnType<typeof build>, sim: SimStateEntry, rep: SimStateReport, requestId: string) {
  const { service } = built;
  const row = must(service.pick(sim, rep, {}));
  service.markFired(row.id, '');
  service.markInFlight(row.id, requestId, undefined, 'Plant');
  service.onOutcome({
    request_id: requestId,
    sim_id: sim.sim_id,
    outcome: 'canceled',
    decided_at: 'dispatch',
    reason: 'Plant something: none of 2 candidates is on the menu',
  });
  return row;
}

describe('RowMemory helpers', () => {
  it('classifies the click refusals the 10-22 playtest saw', () => {
    expect(classifyOutcome('canceled', undefined, 'x: none of 27 candidates is on the menu')).toEqual({
      counter: 'refusedLive',
      cause: 'not_on_menu',
      structural: true,
    });
    expect(classifyOutcome('failure', undefined, "action 'tell_joke' requires target_sim_id").counter).toBe('noTarget');
    expect(classifyOutcome('canceled', undefined, 'nobody nearby to "chat" with').structural).toBe(false);
    expect(classifyOutcome('ineligible', 'no_provider_on_lot').structural).toBe(true);
    expect(classifyOutcome('canceled', 'target_left')).toEqual({
      counter: 'canceled',
      cause: 'target_left',
      structural: false,
    });
    expect(classifyOutcome('failure', 'relationship_too_low').structural).toBe(true);
    expect(classifyOutcome('success').counter).toBe('ran');
  });

  it('dead is 3 fires since the last run; retire needs a structural last cause too', () => {
    const stats = { ...emptyStats('1', 'k'), fires: 7, firesSinceRan: 3, lastCause: 'target_left' };
    expect(isDead(stats)).toBe(true);
    expect(shouldRetire(stats)).toBe(false);
    expect(shouldRetire({ ...stats, lastStructural: true })).toBe(true);
    expect(shouldRetire({ ...stats, lastStructural: true, retiredDay: 3 })).toBe(false);
    expect(isDead({ ...stats, firesSinceRan: 2 })).toBe(false);
  });

  it('renders counters ACE-style', () => {
    const stats = {
      ...emptyStats('1', 'goal:x'),
      fires: 7,
      ran: 0,
      notOnMenu: 7,
      rewrites: 1,
      lastCause: 'not_on_menu',
    };
    expect(statsTag(stats)).toBe('[goal:x] fired=7 ran=0 not_on_menu=7 rewrites=1 last=not_on_menu');
  });

  it('the decision context is the state before the pick', () => {
    const snapshot = contextSnapshot(entry('100'), report([entry('100')]));
    expect(snapshot).toMatchObject({
      day: 40,
      hour: 10,
      speed: 'NORMAL',
      zone: '1',
      funds: 2000,
      mood: 'Happy',
      running: 'sim_Idle',
      sims: [{ sim_id: '200', distance: 3, tier: 'same_room' }],
    });
    expect(snapshot.needs).toEqual({ hunger: 50, fun: 10 });
  });

  it('a want line that names the Sim is the game talking, not the Sim', () => {
    expect(namesSim('Duane is starting to see sheep.', 'Duane Miles')).toBe(true);
    expect(namesSim('The jams are on now!', 'Duane Miles')).toBe(false);
    const want = { id: 'want_Sheep', source: 'want' as const, label: 'w', text: 'Duane is starting to see sheep.' };
    const jams = { id: 'want_Jams', source: 'want' as const, label: 'w', text: 'The jams are on now!' };
    const duane = { ...entry('300'), sim_name: 'Duane Miles', self: { goal_pool: [want, jams] } };
    const rows = seedRows(duane, report([duane]), { needFloor: -60 });
    expect(rows.find((row) => row.seedKey === 'want_Sheep')?.say).toBeUndefined();
    expect(rows.find((row) => row.seedKey === 'want_Jams')?.say).toBe('The jams are on now!');
  });
});

describe('RowMemoryService with the intention list', () => {
  it('a fire is logged with its eligible set, context and propensity, and its outcome fills in', () => {
    const built = build();
    const seth = entry('100');
    const rep = report([seth]);
    built.cache.ingest(rep);
    built.service.sync(seth, rep);
    failOnce(built, seth, rep, 'req-1');
    const [fire] = built.repository.fires;
    expect(fire).toMatchObject({
      simId: '100',
      seedKey: 'objective_Garden',
      chosen: 'Plant',
      propensity: 1,
      requestId: 'req-1',
      outcome: 'canceled',
      cause: 'not_on_menu',
      day: 40,
      minute: 600,
    });
    expect(fire.eligible).toEqual([{ id: fire.rowId, source: 'aspiration', kind: 'pie' }]);
    expect(fire.context?.needs).toEqual({ hunger: 50, fun: 10 });
    const stats = must(built.rowMemory.get('100', 'objective_Garden'));
    expect(stats).toMatchObject({ fires: 1, clicked: 1, refusedLive: 1, firesSinceRan: 1, lastStructural: true });
  });

  it('a gate refusal counts nothing and logs nothing', () => {
    const built = build();
    const seth = entry('100');
    const rep = report([seth]);
    built.cache.ingest(rep);
    built.service.sync(seth, rep);
    const row = must(built.service.pick(seth, rep));
    built.service.markFired(row.id, '');
    built.service.onStoodDown(row.id, { gate: true });
    expect(built.repository.fires).toHaveLength(0);
    expect(built.rowMemory.get('100', 'objective_Garden')).toBeUndefined();
    expect(built.service.rowsFor('100')[0].attempts).toBe(0);
  });

  it('a run resets the streak; a stand-down is a fire that keeps the last cause', () => {
    const built = build();
    const seth = entry('100');
    const rep = report([seth]);
    built.cache.ingest(rep);
    built.service.sync(seth, rep);
    failOnce(built, seth, rep, 'req-1');
    const row = built.service.rowsFor('100')[0];
    built.service.markFired(row.id, '');
    built.service.markInFlight(row.id, 'req-2');
    built.service.onOutcome({ request_id: 'req-2', sim_id: '100', outcome: 'success' });
    expect(built.rowMemory.get('100', 'objective_Garden')).toMatchObject({ fires: 2, ran: 1, firesSinceRan: 0 });
    built.service.markFired(row.id, '');
    built.service.onStoodDown(row.id, { reason: 'nothing to click' });
    // A stand-down is a fire, but never overwrites the last real outcome's cause (live 10-24)
    expect(built.rowMemory.get('100', 'objective_Garden')).toMatchObject({ fires: 3, lastCause: undefined });
    expect(built.repository.fires.at(-1)?.outcome).toBe('stood_down');
  });

  it('three no-candidate fires retire the key at the rollover, before the night call hears it', () => {
    const built = build();
    const seth = entry('100');
    const rep = report([seth]);
    built.cache.ingest(rep);
    built.service.sync(seth, rep);
    // The beat is spent on every fire: three fires two hours apart
    failOnce(built, seth, rep, 'req-1');
    for (const [hour, id] of [
      [13, 'req-2'],
      [16, 'req-3'],
    ] as const) {
      const later = report([seth], 40, hour);
      built.cache.ingest(later);
      built.service.sync(seth, later);
      failOnce(built, seth, later, id);
    }
    let heard: DayRollover | undefined;
    built.service.onDayRollover((rollover) => {
      heard = rollover;
      // The retire already happened when the listener runs
      expect(built.rowMemory.get('100', 'objective_Garden')?.retiredDay).toBe(40);
    });
    const next = report([seth], 41, 8);
    built.cache.ingest(next);
    built.service.sync(seth, next);
    expect(must(heard).retired).toEqual(['objective_Garden']);
    expect(built.rowMemory.get('100', 'objective_Garden')).toMatchObject({ retiredZone: '1', fires: 3 });
    // The retired key is not seeded on the new day
    expect(built.service.rowsFor('100').map((row) => row.seedKey)).not.toContain('objective_Garden');
    expect(built.repository.pruned).toEqual({ interactions: 35, vocabulary: 39 });
  });

  it('a retired key comes back on a zone change, a candidate on a menu, or after three days', () => {
    const built = build();
    const seth = entry('100');
    const retire = (zone: string) => {
      const stats = built.rowMemory.get('100', 'objective_Garden') ?? emptyStats('100', 'objective_Garden');
      Object.assign(stats, {
        fires: 3,
        firesSinceRan: 3,
        lastStructural: true,
        lastCause: 'not_on_menu',
        retiredDay: 40,
        retiredCause: 'not_on_menu',
        retiredZone: zone,
      });
      built.repository.saveStats(stats);
      built.rowMemory.onDatabaseLoaded();
    };
    retire('1');
    let rep = report([seth], 41, 8);
    built.cache.ingest(rep);
    built.service.sync(seth, rep);
    expect(built.service.rowsFor('100')).toHaveLength(0);
    // A candidate shows on a menu today (not greyed)
    built.service.recordVocabulary(
      '100',
      { rows: [{ target_kind: 'object', target: 'object_planter_01', key: 'gardening_Plant', label: 'Plant' }] },
      rep,
    );
    built.service.sync(seth, rep);
    expect(built.service.rowsFor('100').map((row) => row.seedKey)).toEqual(['objective_Garden']);
    expect(built.rowMemory.get('100', 'objective_Garden')).toMatchObject({ retiredDay: undefined, firesSinceRan: 0 });
    expect(built.repository.vocabulary[0]).toMatchObject({ target: 'object_planter_01', kind: 'object', zone: '1' });

    // Zone change
    const zoned = build();
    zoned.repository.saveStats({
      ...emptyStats('100', 'objective_Garden'),
      retiredDay: 40,
      retiredZone: '9',
      retiredCause: 'ineligible',
    });
    rep = report([seth], 41, 8, 1);
    zoned.cache.ingest(rep);
    zoned.service.sync(seth, rep);
    expect(zoned.service.rowsFor('100')).toHaveLength(1);

    // Three days
    const waited = build();
    waited.repository.saveStats({
      ...emptyStats('100', 'objective_Garden'),
      retiredDay: 40,
      retiredZone: '1',
      retiredCause: 'ineligible',
    });
    rep = report([seth], 42, 8);
    waited.cache.ingest(rep);
    waited.service.sync(seth, rep);
    expect(waited.service.rowsFor('100')).toHaveLength(0);
    rep = report([seth], 43, 8);
    waited.cache.ingest(rep);
    waited.service.sync(seth, rep);
    expect(waited.service.rowsFor('100')).toHaveLength(1);
  });

  it('a rewrite of a dead key is refused and the rest of the call applies', () => {
    const built = build();
    const seth = entry('100');
    const rep = report([seth]);
    built.cache.ingest(rep);
    built.service.sync(seth, rep);
    const row = built.service.rowsFor('100')[0];
    built.repository.saveStats({ ...emptyStats('100', 'objective_Garden'), fires: 7, firesSinceRan: 7 });
    built.rowMemory.onDatabaseLoaded();
    const result = built.service.applyEdits('100', {
      drop: [],
      rewrite: [{ row_id: row.id, why: 'I really want to garden' }],
      add: [{ why: 'Make up with Arlene', say: 'Sorry about yesterday.' }],
    });
    expect(result.changed).toContain('rewrote 0');
    expect(result.changed).toContain('refused to reword');
    expect(result.changed).toContain('[objective_Garden] fired=7');
    expect(built.service.rowsFor('100').find((item) => item.id === row.id)?.why).toBe('Plant something');
    expect(built.service.rowsFor('100').some((item) => item.source === 'story')).toBe(true);
  });

  it('a live key is reworded and the rewrite is counted', () => {
    const built = build();
    const seth = entry('100');
    const rep = report([seth]);
    built.cache.ingest(rep);
    built.service.sync(seth, rep);
    const row = built.service.rowsFor('100')[0];
    built.service.applyEdits('100', {
      drop: [],
      rewrite: [{ row_id: row.id, say: 'Time to get my hands dirty.' }],
      add: [],
    });
    expect(built.rowMemory.get('100', 'objective_Garden')?.rewrites).toBe(1);
  });

  it('says a key once a day', () => {
    const built = build();
    const seth = entry('100');
    const rep = report([seth]);
    built.cache.ingest(rep);
    built.service.sync(seth, rep);
    const row = built.service.rowsFor('100')[0];
    expect(built.service.canSay('100', row)).toBe(true);
    built.service.markSaid('100', row);
    expect(built.service.canSay('100', row)).toBe(false);
    const tomorrow = report([seth], 41);
    built.cache.ingest(tomorrow);
    expect(built.service.canSay('100', row)).toBe(true);
  });

  it('keeps the household log the mod forwards', () => {
    const built = build();
    built.rowMemory.onInteractionLog([
      { sim_id: '100', name: 'sim_Chat', origin: 'game', ran: true, day: 40, minute: 600, zone_id: '1' },
      { sim_id: '', name: 'dropped' },
    ]);
    expect(built.repository.interactions).toHaveLength(1);
    expect(built.repository.interactions[0]).toMatchObject({
      simId: '100',
      name: 'sim_Chat',
      origin: 'game',
      zone: '1',
    });
  });
});

describe('the night text reads the counts', () => {
  it('puts counts before a row, marks DEAD and lists retired keys', () => {
    const today: IntentionRow = {
      id: 'i1',
      seedKey: 'want_Chat',
      source: 'want',
      what: { kind: 'pie', candidates: ['mixer_social_Chat'], label: 'Chat' },
      why: 'Chat with Arlene',
      preconditions: [],
      until: { kind: 'want_absent' },
      status: 'waiting',
      attempts: 0,
      history: [],
    };
    const text = buildNightText({
      simId: '100',
      simName: 'Seth Polanco',
      endingDay: 40,
      newDay: 41,
      endingRows: [{ ...today, id: 'i0' }],
      todayRows: [today],
      memories: [],
      outcomes: [],
      stats: [
        { ...emptyStats('100', 'want_Chat'), fires: 4, firesSinceRan: 3, lastCause: 'target_left' },
        {
          ...emptyStats('100', 'objective_Garden'),
          fires: 7,
          notOnMenu: 7,
          firesSinceRan: 7,
          lastCause: 'not_on_menu',
          retiredDay: 40,
          retiredZone: '1',
          why: 'Plant something',
        },
      ],
    });
    expect(text).toContain('- [want_Chat] fired=4 ran=0 last=target_left DEAD :: i0 want: Chat with Arlene');
    expect(text).toContain('- [want_Chat] fired=4 ran=0 last=target_left DEAD :: i1 want: Chat with Arlene');
    expect(text).toContain('Dead here (retired by code');
    expect(text).toContain(
      '- [objective_Garden] fired=7 ran=0 not_on_menu=7 last=not_on_menu :: Plant something (retired day 40, zone 1)',
    );
    expect(text).toContain('A row marked DEAD fired 3 or more times without running');
  });
});

describe('RowMemoryRepository on a real save database (migration 027)', () => {
  it('round-trips stats, a fire and its outcome, the household log and the menus seen', () => {
    const ctx = mockApiContext();
    fs.mkdirSync(ctx.directory.getSentientSimsFolder(), { recursive: true });
    ctx.db.loadDatabase({ sessionId: 'row-memory-roundtrip', saveId: '1' });
    const repository = new RowMemoryRepository(ctx.db);
    repository.saveStats({ ...emptyStats('100', 'objective_Garden'), fires: 3, lastStructural: true, retiredDay: 40 });
    expect(repository.statsFor('100')[0]).toMatchObject({ fires: 3, lastStructural: true, retiredDay: 40 });
    repository.insertFire({
      at: 'now',
      day: 40,
      minute: 600,
      simId: '100',
      rowId: 'i1',
      seedKey: 'objective_Garden',
      eligible: [{ id: 'i1', source: 'aspiration', kind: 'pie' }],
      propensity: 1,
      context: { day: 40, needs: { fun: 10 } },
      requestId: 'req-1',
    });
    expect(repository.fireOutcome('req-1', { outcome: 'canceled', cause: 'not_on_menu' })).toBe(true);
    const [fire] = repository.firesFor('100', 40);
    expect(fire).toMatchObject({ outcome: 'canceled', cause: 'not_on_menu', propensity: 1 });
    expect(fire.context?.needs).toEqual({ fun: 10 });
    repository.insertInteractions([{ at: 'now', simId: '100', name: 'sim_Chat', origin: 'game', day: 33 }]);
    repository.insertInteractions([{ at: 'now', simId: '100', name: 'sim_Chat', origin: 'ours', day: 40 }]);
    expect(repository.countInteractions('100')).toEqual({ game: 1, ours: 1 });
    repository.pruneInteractions(34);
    expect(repository.countInteractions('100')).toEqual({ ours: 1 });
    const seen = { simId: '100', target: 'self', kind: 'self', label: 'Stargaze', key: 'k', zone: '1', day: 40 };
    repository.upsertVocabulary([seen, { ...seen, minute: 5, superKey: 'super_Stargaze' }]);
    expect(repository.vocabularyFor('100', 40, '1')).toHaveLength(1);
    expect(repository.vocabularyFor('100', 40, '1')[0].superKey).toBe('super_Stargaze');
    repository.saveStats({ ...emptyStats('100', 'k2'), refusedLive: 2 });
    expect(repository.statsFor('100').find((stats) => stats.seedKey === 'k2')?.refusedLive).toBe(2);
    repository.pruneVocabulary(41);
    expect(repository.vocabularyFor('100', 40)).toHaveLength(0);
  });
});
