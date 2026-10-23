import { describe, expect, it } from 'vitest';
import { ApiContext } from 'main/sentient-sims/services/ApiContext';
import { IntentionService } from 'main/sentient-sims/services/intentions/IntentionService';
import { IntentionRow } from 'main/sentient-sims/models/IntentionRow';
import { SimStateEntry, SimStateReport } from 'main/sentient-sims/models/SimStateReport';
import { SimStateCache } from 'main/sentient-sims/services/SimStateCache';
import type { CognitionGoalCompleted } from 'main/sentient-sims/models/ModLogWebsocketMessage';

// Autonomy part 5: the list per Sim per day (pick order, the pace, claims, the outcome
// transitions, the game's goal events, persistence, the mod's disconnect).

type Stored = Map<string, IntentionRow[]>;

function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('expected a value');
  }
  return value;
}

function build(options: { beatMinutes?: number; needFloor?: number; stored?: Stored; dbLoaded?: boolean } = {}) {
  const stored: Stored = options.stored ?? new Map<string, IntentionRow[]>();
  const goalListeners: ((event: CognitionGoalCompleted) => void)[] = [];
  const cache = new SimStateCache();
  const ctx = {
    settings: {
      intentionBeatMinutes: options.beatMinutes ?? 120,
      intentionNeedFloor: options.needFloor ?? -60,
    },
    db: { isLoaded: () => options.dbLoaded ?? true },
    simStateCache: cache,
  } as unknown as ApiContext;
  const repository = {
    getRows: (simId: string, day: number) => stored.get(`${simId}|${day}`),
    saveRows: (simId: string, day: number, rows: IntentionRow[]) => {
      stored.set(`${simId}|${day}`, JSON.parse(JSON.stringify(rows)) as IntentionRow[]);
    },
  };
  const modQuery = {
    onGoalCompleted: (listener: (event: CognitionGoalCompleted) => void) => {
      goalListeners.push(listener);
    },
  };
  const service = new IntentionService(ctx, {
    intentionRepository: repository as never,
    modQuery: modQuery as never,
  });
  return {
    service,
    stored,
    cache,
    goalCompleted: (event: CognitionGoalCompleted) => {
      goalListeners.forEach((l) => {
        l(event);
      });
    },
  };
}

function entry(
  simId: string,
  self: Partial<NonNullable<SimStateEntry['self']>> = {},
  name = 'Jonah Calloway',
): SimStateEntry {
  return {
    sim_id: simId,
    sim_name: name,
    sims: [{ sim_id: '200', name: 'Alex Calloway', tier: 'same_room', distance: 2 }],
    objects: [],
    self: { needs: { hunger: 50 }, ...self },
    is_household: true,
  };
}

function report(entries: SimStateEntry[], lot: Partial<SimStateReport['lot']> = {}, minute = 0): SimStateReport {
  return {
    type: 'state_report',
    seq: 1,
    lot: { zone_id: 1, clock: { hour: 10, minute, absolute_day: 40, day: 2 }, funds: 2000, ...lot },
    sims: entries,
  };
}

const WANT_POOL = [
  {
    id: 'want_ChatWith',
    source: 'want' as const,
    label: 'Want: Chat With',
    affordances: ['mixer_social_Chat'],
    target_sim_id: '200',
    target_name: 'Alex Calloway',
  },
  {
    id: 'objective_Asp_1',
    source: 'aspiration' as const,
    label: 'Aspiration: Joke x3',
    affordances: ['mixer_social_TellJoke'],
  },
];

describe('IntentionService', () => {
  it('picks the first waiting row whose preconditions hold, in list order', () => {
    const { service, cache } = build();
    const jonah = entry('100', { goal_pool: WANT_POOL });
    const rep = report([jonah], { bills: { due: true, amount: 5000 }, funds: 100 });
    cache.ingest(rep);
    service.sync(jonah, rep);
    const rows = service.rowsFor('100');
    expect(rows.map((row) => row.seedKey)).toEqual(['bills', 'objective_Asp_1', 'want_ChatWith']);
    // Bills first in the list but without the funds: the aspiration row is picked
    expect(service.pick(jonah, rep)?.seedKey).toBe('objective_Asp_1');
    const paid = report([jonah], { bills: { due: true, amount: 5000 }, funds: 6000 });
    expect(service.pick(jonah, paid)?.seedKey).toBe('bills');
  });

  it('the pace: a second pick inside the beat is refused, a need row passes', () => {
    const { service, cache } = build({ beatMinutes: 120 });
    const jonah = entry('100', { goal_pool: WANT_POOL });
    let rep = report([jonah]);
    cache.ingest(rep);
    service.sync(jonah, rep);
    const first = service.pick(jonah, rep);
    expect(first?.seedKey).toBe('objective_Asp_1');
    service.markFired(must(first).id, '-> mixer_social_TellJoke');
    service.markInFlight(must(first).id, 'req-1');
    service.onOutcome({ request_id: 'req-1', sim_id: '100', outcome: 'success' });
    expect(service.rowsFor('100')[0].status).toBe('waiting'); // goal_absent decides
    // 30 sim-minutes later: paced
    rep = report([jonah], {}, 30);
    cache.ingest(rep);
    service.sync(jonah, rep);
    expect(service.pick(jonah, rep)).toBeUndefined();
    // A need row skips the pace
    const hungry = entry('100', { goal_pool: WANT_POOL, needs: { hunger: -70 } });
    const hungryReport = report([hungry], {}, 30);
    service.sync(hungry, hungryReport);
    expect(service.pick(hungry, hungryReport)?.seedKey).toBe('need:hunger');
    // Two hours later the want fires
    const later = { ...rep, lot: { ...rep.lot, clock: { hour: 12, minute: 1, absolute_day: 40, day: 2 } } };
    expect(service.pick(jonah, later)?.seedKey).toBe('objective_Asp_1');
  });

  it('claims: two Sims, one bills row fires', () => {
    const { service, cache } = build();
    const jonah = entry('100');
    const alex = entry('300', {}, 'Alex Calloway');
    const rep = report([jonah, alex], { bills: { due: true, amount: 100 } });
    cache.ingest(rep);
    service.sync(jonah, rep);
    service.sync(alex, rep);
    const picked = service.pick(jonah, rep);
    expect(picked?.claim).toBe('bills');
    service.markFired(must(picked).id, '');
    service.markInFlight(must(picked).id, 'req-bills');
    expect(service.pick(alex, rep)).toBeUndefined();
    service.onOutcome({ request_id: 'req-bills', sim_id: '100', outcome: 'success' });
    expect(service.rowsFor('100')[0].status).toBe('done');
    // Completed within 10 sim-minutes: still held for Alex
    expect(service.pick(alex, rep)).toBeUndefined();
  });

  it('outcome transitions: transient cancels count attempts, three sleep the row, ineligible money sleeps until funds', () => {
    const { service, cache } = build();
    const jonah = entry('100', { goal_pool: WANT_POOL });
    const rep = report([jonah], { bills: { due: true, amount: 500 }, funds: 100 });
    cache.ingest(rep);
    service.sync(jonah, rep);
    const asp = service.rowsFor('100')[1];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      service.markFired(asp.id, '');
      service.markInFlight(asp.id, `req-${attempt}`);
      service.onOutcome({ request_id: `req-${attempt}`, sim_id: '100', outcome: 'canceled', cause: 'target_left' });
      const after = service.rowsFor('100')[1];
      expect(after.attempts).toBe(attempt);
      expect(after.status).toBe(attempt < 3 ? 'waiting' : 'asleep');
    }
    expect(service.rowsFor('100')[1].sleep?.clears).toEqual({ kind: 'day_end' });
    // The bills row: ineligible for money sleeps until the funds are there
    const bills = service.rowsFor('100')[0];
    service.markFired(bills.id, '');
    service.markInFlight(bills.id, 'req-b');
    service.onOutcome({
      request_id: 'req-b',
      sim_id: '100',
      outcome: 'ineligible',
      reason: "Jonah's household cannot afford it (not enough funds)",
    });
    expect(service.rowsFor('100')[0].status).toBe('asleep');
    expect(service.rowsFor('100')[0].sleep?.clears).toEqual({ kind: 'funds_at_least', amount: 500 });
    const rich = report([jonah], { bills: { due: true, amount: 500 }, funds: 900 });
    cache.ingest(rich);
    service.sync(jonah, rich);
    expect(service.rowsFor('100')[0].status).toBe('waiting');
  });

  it('a picker refusal swaps a pie row to its action fallback; no provider sleeps it until the zone changes', () => {
    const { service, cache } = build();
    const pool = [
      {
        id: 'want_Cook',
        source: 'want' as const,
        label: 'Want: Cook',
        affordances: ['fridge_Cook'],
        action_keys: ['cook_meal'],
      },
      { id: 'want_Paint', source: 'want' as const, label: 'Want: Paint', affordances: ['easel_Paint'] },
    ];
    const jonah = entry('100', { goal_pool: pool });
    const rep = report([jonah]);
    cache.ingest(rep);
    service.sync(jonah, rep);
    const [cook, paint] = service.rowsFor('100');
    service.markFired(cook.id, '');
    service.markInFlight(cook.id, 'req-c');
    service.onOutcome({
      request_id: 'req-c',
      sim_id: '100',
      outcome: 'ineligible',
      reason: '"Cook" opens a picker dialog',
    });
    expect(service.rowsFor('100')[0].what).toEqual({ kind: 'action', actions: ['cook_meal'] });
    expect(service.rowsFor('100')[0].status).toBe('waiting');
    service.markFired(paint.id, '');
    service.markInFlight(paint.id, 'req-p');
    service.onOutcome({
      request_id: 'req-p',
      sim_id: '100',
      outcome: 'ineligible',
      cause: 'no_provider_on_lot',
      reason: 'no object on the lot provides "Want: Paint"',
    });
    const asleep = service.rowsFor('100')[1];
    expect(asleep.status).toBe('asleep');
    expect(asleep.sleep?.clears).toMatchObject({ kind: 'zone_change', zone_id: '1' });
    const elsewhere = report([jonah], { zone_id: 2 });
    cache.ingest(elsewhere);
    service.sync(jonah, elsewhere);
    expect(service.rowsFor('100')[1].status).toBe('waiting');
  });

  it("the game's goal_completed marks the want's row done", () => {
    const { service, cache, goalCompleted } = build();
    const jonah = entry('100', { goal_pool: WANT_POOL });
    const rep = report([jonah]);
    cache.ingest(rep);
    service.sync(jonah, rep);
    goalCompleted({ kind: 'goal_completed', sim_id: '100', whim: 'want_ChatWith', source: 'whim' });
    const want = service.rowsFor('100').find((row) => row.seedKey === 'want_ChatWith');
    expect(want?.status).toBe('done');
    expect(want?.history[0].outcome).toBe('goal_completed');
  });

  it('a vanished want expires and a vanished objective is done on the next report', () => {
    const { service, cache } = build();
    const jonah = entry('100', { goal_pool: WANT_POOL });
    const rep = report([jonah]);
    cache.ingest(rep);
    service.sync(jonah, rep);
    const bare = entry('100', { goal_pool: [] });
    service.sync(bare, report([bare]));
    expect(service.rowsFor('100').map((row) => [row.seedKey, row.status])).toEqual([
      ['objective_Asp_1', 'done'],
      ['want_ChatWith', 'expired'],
    ]);
  });

  it('persists after a change and reloads the day with in-flight rows reset', () => {
    const stored: Stored = new Map();
    const first = build({ stored });
    const jonah = entry('100', { goal_pool: WANT_POOL });
    const rep = report([jonah]);
    first.cache.ingest(rep);
    first.service.sync(jonah, rep);
    const row = must(first.service.pick(jonah, rep));
    first.service.markFired(row.id, '');
    first.service.markInFlight(row.id, 'req-1');
    first.service.flush();
    expect(stored.get('100|40')?.find((item) => item.id === row.id)?.status).toBe('in_flight');
    const second = build({ stored });
    second.cache.ingest(rep);
    second.service.sync(jonah, rep);
    const reloaded = second.service.rowsFor('100').find((item) => item.id === row.id);
    expect(reloaded?.status).toBe('waiting');
    expect(reloaded?.requestId).toBeUndefined();
  });

  it('a mod disconnect resets in-flight rows; a stood-down fire refunds the beat; an echo satisfies a one-shot row', () => {
    const { service, cache } = build();
    const jonah = entry('100', { goal_pool: WANT_POOL });
    const rep = report([jonah], { bills: { due: true, amount: 100 } });
    cache.ingest(rep);
    service.sync(jonah, rep);
    const bills = must(service.pick(jonah, rep));
    service.markFired(bills.id, '');
    service.markInFlight(bills.id, 'req-1');
    expect(service.hasInFlight('100')).toBe(true);
    service.onModDisconnected();
    expect(service.hasInFlight('100')).toBe(false);
    expect(service.rowsFor('100')[0].status).toBe('waiting');
    // Stood down at the gate: no attempt, the beat refunded, the row picked again at once
    const again = must(service.pick(jonah, rep));
    service.markFired(again.id, '');
    service.onStoodDown(again.id, { gate: true });
    expect(service.rowsFor('100')[0].attempts).toBe(0);
    expect(service.pick(jonah, rep)?.id).toBe(again.id);
    // An echo: the one-shot bills row is done
    service.markFired(again.id, '');
    service.onStoodDown(again.id, { echo: true });
    expect(service.rowsFor('100')[0].status).toBe('done');
  });

  it('prompt lines name the rows in order with what each waits for', () => {
    const { service, cache } = build();
    const jonah = entry('100', { goal_pool: WANT_POOL });
    const rep = report([jonah], { bills: { due: true, amount: 5000 }, funds: 100 });
    cache.ingest(rep);
    service.sync(jonah, rep);
    expect(service.promptLines('100')).toEqual([
      'Your intentions today, in order: 1. the bills are due (§5000) (waiting for §5000 (have §100)) 2. Aspiration: Joke x3 3. Want: Chat With with Alex Calloway',
    ]);
    const asleepRow = service.rowsFor('100')[1];
    service.markFired(asleepRow.id, '');
    service.markInFlight(asleepRow.id, 'r');
    service.onOutcome({ request_id: 'r', sim_id: '100', outcome: 'ineligible', cause: 'actor_age_blocked' });
    expect(service.promptLines('100')[0]).toContain('2. Aspiration: Joke x3 (on hold: actor_age_blocked)');
  });

  it('a deliberate row waits for its target and expires after two hours', () => {
    const { service, cache } = build();
    const jonah = entry('100');
    const rep = report([jonah]);
    cache.ingest(rep);
    service.sync(jonah, rep);
    const added = service.addDeliberateRow('100', {
      source: 'scene',
      desire: { score: 8, reason: 'make up with Alex', targetSimId: '200' },
    });
    expect(added?.what.kind).toBe('deliberate');
    expect(service.pick(jonah, rep)?.id).toBe(added?.id);
    const alone = { ...jonah, sims: [] };
    expect(service.pick(alone, rep)).toBeUndefined();
    const later = report([jonah], {}, 0);
    must(later.lot).clock = { hour: 13, minute: 0, absolute_day: 40, day: 2 };
    service.sync(jonah, later);
    expect(service.rowsFor('100').find((row) => row.id === added?.id)?.status).toBe('expired');
  });
  it('an action row waits until the lot serves one of its verbs, then dispatches that verb', () => {
    const { service, cache } = build();
    const pool = [
      {
        id: 'want_Music',
        source: 'want' as const,
        label: 'The jams are on now!',
        action_keys: ['play_piano', 'listen_to_music'],
        reachable: true,
      },
    ];
    const jonah = entry('100', { goal_pool: pool });
    const rep = report([jonah]);
    cache.ingest(rep);
    service.sync(jonah, rep);
    const music = service.rowsFor('100')[0];
    expect(music.what).toEqual({ kind: 'action', actions: ['play_piano', 'listen_to_music'] });
    // No piano, no stereo: the row waits at no cost
    expect(service.pick(jonah, rep, { usable: () => false })).toBeUndefined();
    expect(music.attempts).toBe(0);
    const stereo = (key: string) => key === 'listen_to_music';
    expect(service.pick(jonah, rep, { usable: stereo })?.id).toBe(music.id);
    expect(service.actionFor(music, stereo)).toBe('listen_to_music');
    expect(service.actionFor(music)).toBe('play_piano');
  });

  it('a refusal at dispatch gives the beat back; a refusal by the game keeps it', () => {
    const { service, cache } = build();
    const jonah = entry('100', { goal_pool: WANT_POOL });
    const rep = report([jonah]);
    cache.ingest(rep);
    service.sync(jonah, rep);
    const first = must(service.pick(jonah, rep));
    service.markFired(first.id, '');
    service.markInFlight(first.id, 'req-1');
    service.onOutcome({
      request_id: 'req-1',
      sim_id: '100',
      outcome: 'canceled',
      cause: 'target_left',
      decided_at: 'dispatch',
    });
    // Nothing ran: the same row (waiting, attempt 1) is picked again at once
    expect(service.pick(jonah, rep)?.id).toBe(first.id);
    service.markFired(first.id, '');
    service.markInFlight(first.id, 'req-2');
    service.onOutcome({
      request_id: 'req-2',
      sim_id: '100',
      outcome: 'canceled',
      cause: 'target_left',
      decided_at: 'finished',
    });
    expect(service.pick(jonah, rep)).toBeUndefined();
  });
});
