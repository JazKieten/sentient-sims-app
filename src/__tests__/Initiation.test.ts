import { describe, expect, it } from 'vitest';
import { ApiContext } from 'main/sentient-sims/services/ApiContext';
import { IntentionService, MAX_ABSENT } from 'main/sentient-sims/services/intentions/IntentionService';
import { RowMemoryService } from 'main/sentient-sims/services/intentions/RowMemoryService';
import { VocabularySampler } from 'main/sentient-sims/services/intentions/VocabularySampler';
import { RowStats, VocabularyView, emptyView, initiation } from 'main/sentient-sims/services/intentions/RowMemory';
import { seedRows } from 'main/sentient-sims/services/intentions/IntentionSeeds';
import type { VocabularySeenEntry } from 'main/sentient-sims/db/RowMemoryRepository';
import { IntentionRow } from 'main/sentient-sims/models/IntentionRow';
import { SimStateEntry, SimStateReport } from 'main/sentient-sims/models/SimStateReport';
import { SimStateCache } from 'main/sentient-sims/services/SimStateCache';

// Renovation R2: a row is an option and fires only when its initiation set holds, judged
// against the menus the Sim met today (an unsampled target is unknown, never empty); a row
// that cannot start costs nothing and expires after MAX_ABSENT hourly checks; sleeps wake on
// events; a targetless social action row never seeds; the sampler fills the day's menus.

function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('expected a value');
  }
  return value;
}

class FakeRepository {
  stats = new Map<string, RowStats>();

  vocabulary: VocabularySeenEntry[] = [];

  isLoaded() {
    return true;
  }

  statsFor(simId: string) {
    return [...this.stats.values()].filter((stats) => stats.simId === simId);
  }

  saveStats(stats: RowStats) {
    this.stats.set(`${stats.simId}|${stats.seedKey}`, { ...stats });
  }

  insertFire() {
    return 1;
  }

  fireOutcome() {
    return true;
  }

  firesFor() {
    return [];
  }

  insertInteractions() {
    // kept in memory by the service's ran-today set
  }

  pruneInteractions() {
    // nothing stored here
  }

  upsertVocabulary(entries: VocabularySeenEntry[]) {
    this.vocabulary.push(...entries);
  }

  vocabularyFor(simId: string, day: number, zone?: string) {
    return this.vocabulary.filter(
      (seen) => seen.simId === simId && seen.day === day && (zone === undefined || seen.zone === zone),
    );
  }

  pruneVocabulary() {
    // nothing stored here
  }
}

function build() {
  const repository = new FakeRepository();
  const cache = new SimStateCache();
  const ctx = {
    settings: { intentionBeatMinutes: 120, intentionNeedFloor: -60, cognitionActionScoreThreshold: 7 },
    db: { isLoaded: () => true },
    simStateCache: cache,
  } as unknown as ApiContext;
  const rowMemory = new RowMemoryService(ctx, { rowMemoryRepository: repository as never });
  const service = new IntentionService(ctx, {
    intentionRepository: { getRows: () => undefined, saveRows: () => undefined } as never,
    rowMemory,
  });
  return { service, rowMemory, repository, cache };
}

const GARDEN = {
  id: 'objective_Garden',
  source: 'aspiration' as const,
  label: 'Plant something',
  affordances: ['super_Plant', 'super_Water'],
};

function entry(simId = '100', self: Partial<NonNullable<SimStateEntry['self']>> = {}, extra = {}): SimStateEntry {
  return {
    sim_id: simId,
    sim_name: 'Seth Polanco',
    sims: [{ sim_id: '200', name: 'Arlene Zhang', tier: 'same_room', distance: 3 }],
    objects: [],
    self: { needs: { hunger: 50 }, goal_pool: [GARDEN], ...self },
    is_household: true,
    ...extra,
  };
}

function report(sims: SimStateEntry[], hour = 10, day = 40): SimStateReport {
  return { type: 'state_report', seq: 1, lot: { zone_id: 1, clock: { hour, minute: 0, absolute_day: day } }, sims };
}

function pieRow(partial: Partial<IntentionRow> = {}): IntentionRow {
  return {
    id: 'i1',
    seedKey: 'k',
    source: 'aspiration',
    what: { kind: 'pie', candidates: ['super_Plant', 'super_Water'], label: 'Plant' },
    why: 'Plant something',
    preconditions: [],
    until: { kind: 'goal_absent' },
    status: 'waiting',
    attempts: 0,
    history: [],
    ...partial,
  };
}

function view(
  menus: Record<string, { keys?: string[]; supers?: string[]; greyed?: string[] }>,
  checked: string[] = [],
) {
  const built: VocabularyView = emptyView();
  Object.entries(menus).forEach(([target, menu]) => {
    built.targets.set(target, {
      keys: new Set(menu.keys ?? []),
      supers: new Set(menu.supers ?? []),
      greyed: new Map((menu.greyed ?? []).map((key) => [key, 'greyed'])),
    });
  });
  checked.forEach((candidate) => built.checked.add(candidate));
  return built;
}

describe('the initiation set', () => {
  it('nothing sampled today is unknown: the row may start', () => {
    expect(initiation(pieRow(), emptyView()).ok).toBe(true);
  });

  it('a row with no target: on any menu by key or super starts; checked and absent does not', () => {
    expect(initiation(pieRow(), view({ self: { keys: ['super_Water'] } })).ok).toBe(true);
    expect(initiation(pieRow(), view({ object_planter: { supers: ['super_Plant'] } })).ok).toBe(true);
    expect(initiation(pieRow(), view({ self: { keys: ['x'] } })).ok).toBe(true); // never checked: unknown
    expect(initiation(pieRow(), view({ self: { keys: ['x'] } }, ['super_Plant', 'super_Water']))).toMatchObject({
      ok: false,
      cause: 'not_on_menu',
    });
    expect(initiation(pieRow(), view({ self: { greyed: ['super_Plant'] } }, ['super_Water']))).toMatchObject({
      ok: false,
      cause: 'greyed',
    });
  });

  it("a row with a target is judged on that Sim's menu, unknown when nobody sampled them", () => {
    const row = pieRow({ target: { sim_id: '200', name: 'Arlene' } });
    expect(initiation(row, view({ self: { keys: ['x'] } })).ok).toBe(true);
    expect(initiation(row, view({ 'sim:200': { keys: ['super_Plant'] } })).ok).toBe(true);
    expect(initiation(row, view({ 'sim:200': { keys: ['other'] } }))).toMatchObject({
      ok: false,
      cause: 'not_on_menu',
    });
  });

  it('a social action row with no one to do it with has no initiation set', () => {
    const row = pieRow({ what: { kind: 'action', actions: ['tell_joke'] } });
    expect(initiation(row, emptyView())).toMatchObject({ ok: false, cause: 'no_target' });
    expect(initiation({ ...row, target: { sim_id: '200' } }, emptyView()).ok).toBe(true);
    expect(initiation({ ...row, what: { kind: 'action', actions: ['browse_web'] } }, emptyView()).ok).toBe(true);
  });

  it('the seeds never write a targetless social action row', () => {
    const want = { id: 'want_Joke', source: 'want' as const, label: 'Tell a joke', action_keys: ['tell_joke'] };
    const bound = { ...want, id: 'want_JokeArlene', target_sim_id: '200', target_name: 'Arlene' };
    const rows = seedRows(entry('100', { goal_pool: [want, bound] }), report([]), { needFloor: -60 });
    expect(rows.map((row) => row.seedKey)).toEqual(['want_JokeArlene']);
    expect(rows[0].target?.sim_id).toBe('200');
  });
});

describe("the row lane with the day's menus", () => {
  function seenOnly(built: ReturnType<typeof build>, keys: string[], checked: string[], rep: SimStateReport) {
    built.rowMemory.recordVocabulary(
      '100',
      {
        rows: keys.map((key) => ({ target_kind: 'self', key, label: key })),
        targets: [{ kind: 'provider', candidates_checked: checked }],
      },
      rep,
    );
  }

  it('a row that cannot start is skipped at no cost and expires after MAX_ABSENT hourly checks', () => {
    const built = build();
    const seth = entry();
    let rep = report([seth]);
    built.cache.ingest(rep);
    built.service.sync(seth, rep);
    seenOnly(built, ['other'], ['super_Plant', 'super_Water'], rep);
    expect(built.service.pick(seth, rep)).toBeUndefined();
    expect(built.service.pick(seth, rep)).toBeUndefined();
    const row = built.service.rowsFor('100')[0];
    expect(row).toMatchObject({ status: 'waiting', attempts: 0, absent: { count: 1, cause: 'not_on_menu' } });
    // Counted once a day in row_stats, however many reports skipped it
    expect(built.rowMemory.get('100', 'objective_Garden')).toMatchObject({ notOnMenu: 1, fires: 0 });
    for (let check = 2; check <= MAX_ABSENT; check += 1) {
      rep = report([seth], 10 + check);
      built.cache.ingest(rep);
      built.service.sync(seth, rep);
      expect(built.service.pick(seth, rep)).toBeUndefined();
    }
    expect(built.service.rowsFor('100')[0].status).toBe('expired');
    expect(built.rowMemory.get('100', 'objective_Garden')?.expired).toBe(1);
  });

  it('a candidate on the menu lets it start and clears the absent count', () => {
    const built = build();
    const seth = entry();
    const rep = report([seth]);
    built.cache.ingest(rep);
    built.service.sync(seth, rep);
    seenOnly(built, ['other'], ['super_Plant', 'super_Water'], rep);
    built.service.pick(seth, rep);
    seenOnly(built, ['super_Water'], [], rep);
    const picked = must(built.service.pick(seth, rep));
    expect(picked.absent).toBeUndefined();
  });

  it('a reconnect holds every row for the settle time; a fresh service does not', () => {
    const built = build();
    const seth = entry();
    const rep = report([seth]);
    built.cache.ingest(rep);
    built.service.sync(seth, rep);
    expect(built.service.pick(seth, rep)).toBeDefined();
    built.service.onModDisconnected();
    expect(built.service.pick(seth, rep)).toBeUndefined();
    expect(built.service.pick(seth, rep, { force: true })).toBeDefined();
  });

  it('a structural sleep waits for an event, not two hours', () => {
    const built = build();
    const seth = entry();
    let rep = report([seth]);
    built.cache.ingest(rep);
    built.service.sync(seth, rep);
    const row = must(built.service.pick(seth, rep));
    built.service.markFired(row.id, '');
    built.service.markInFlight(row.id, 'req-1');
    built.service.onOutcome({ request_id: 'req-1', sim_id: '100', outcome: 'failure', cause: 'object_in_bad_state' });
    const slept = built.service.rowsFor('100')[0];
    expect(slept.status).toBe('asleep');
    expect(slept.sleep?.clears).toEqual({
      kind: 'zone_change',
      zone_id: '1',
      wake_on: ['candidate_seen', 'ran_by_anyone'],
    });
    // Three game hours later nothing changed: still asleep (the old timer woke it at two)
    rep = report([seth], 13);
    built.cache.ingest(rep);
    built.service.sync(seth, rep);
    expect(built.service.rowsFor('100')[0].status).toBe('asleep');
    // The household ran one of its candidates: it wakes
    built.rowMemory.onInteractionLog([{ sim_id: '200', name: 'super_Water', ran: true, day: 40, zone_id: '1' }]);
    built.service.sync(seth, rep);
    expect(built.service.rowsFor('100')[0].status).toBe('waiting');
  });

  it('a sleep on a row whose target was away wakes when they arrive', () => {
    const built = build();
    const alone = entry(
      '100',
      { goal_pool: [{ ...GARDEN, target_sim_id: '300', target_name: 'Duane' }] },
      { sims: [] },
    );
    let rep = report([alone]);
    built.cache.ingest(rep);
    built.service.sync(alone, rep);
    const row = built.service.rowsFor('100')[0];
    row.status = 'in_flight';
    row.requestId = 'req-x';
    built.service.onOutcome({ request_id: 'req-x', sim_id: '100', outcome: 'failure', cause: 'object_in_bad_state' });
    expect(built.service.rowsFor('100')[0].sleep?.clears).toMatchObject({
      wake_on: ['target_present', 'candidate_seen', 'ran_by_anyone'],
    });
    const company = entry(
      '100',
      { goal_pool: [{ ...GARDEN, target_sim_id: '300', target_name: 'Duane' }] },
      {
        sims: [{ sim_id: '300', name: 'Duane Miles', tier: 'same_room', distance: 2 }],
      },
    );
    rep = report([company]);
    built.cache.ingest(rep);
    built.service.sync(company, rep);
    expect(built.service.rowsFor('100')[0].status).toBe('waiting');
  });
});

describe('the vocabulary sampler', () => {
  function sampler() {
    const built = build();
    const queries: { kind: string; args: Record<string, unknown> }[] = [];
    let answer: (value: unknown) => void = () => undefined;
    const modQuery = {
      query: (kind: string, args: Record<string, unknown>) => {
        queries.push({ kind, args });
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
    };
    const instance = new VocabularySampler({
      modQuery: modQuery as never,
      intentions: built.service,
      rowMemory: built.rowMemory,
    });
    return {
      ...built,
      instance,
      queries,
      answer: (value: unknown) => {
        answer(value);
      },
    };
  }

  it('samples self, the awake household here and the providers of target-less pie rows, once a day', async () => {
    const built = sampler();
    const seth = entry();
    const arlene = entry('200', { goal_pool: [] }, { sim_name: 'Arlene Zhang', sims: [] });
    const duane = entry('300', { asleep: true, goal_pool: [] }, { sim_name: 'Duane Miles', sims: [] });
    const withDuane = { ...seth, sims: [...seth.sims, { sim_id: '300', tier: 'same_room' as const }] };
    const rep = report([withDuane, arlene, duane]);
    built.cache.ingest(rep);
    built.service.sync(withDuane, rep);
    built.instance.tick([withDuane], rep, 100_000);
    expect(built.queries).toHaveLength(1);
    expect(built.queries[0]).toEqual({
      kind: 'vocabulary',
      args: {
        sim_id: '100',
        sample: {
          targets: [
            { kind: 'self' },
            { kind: 'sim', sim_id: '200' },
            { kind: 'provider', candidates: ['super_Plant', 'super_Water'] },
          ],
        },
      },
    });
    // One in flight at a time
    built.instance.tick([withDuane], rep, 200_000);
    expect(built.queries).toHaveLength(1);
    built.answer({
      ok: true,
      result: { rows: [{ target_kind: 'self', key: 'super_Stargaze', label: 'Stargaze' }], targets: [], ms: 120 },
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(built.repository.vocabulary.map((seen) => seen.key)).toEqual(['super_Stargaze']);
    // Once a day: no second sample for Seth today
    built.instance.tick([withDuane], rep, 300_000);
    expect(built.queries).toHaveLength(1);
  });

  it('skips a Sim who is asleep and targets the day already covered', () => {
    const built = sampler();
    const seth = entry('100', { goal_pool: [] }, { sims: [] });
    const rep = report([seth]);
    built.cache.ingest(rep);
    built.service.sync(seth, rep);
    built.rowMemory.recordVocabulary('100', { rows: [{ target_kind: 'self', key: 'k', label: 'K' }] }, rep);
    built.instance.tick([seth], rep, 100_000);
    expect(built.queries).toHaveLength(0);
    const sleeper = entry('400', { asleep: true }, { sims: [] });
    built.instance.tick([sleeper], report([sleeper]), 200_000);
    expect(built.queries).toHaveLength(0);
  });
});
