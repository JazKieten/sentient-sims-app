import { afterEach, describe, expect, it, vi } from 'vitest';
import { CognitionService } from 'main/sentient-sims/services/CognitionService';
import { SimStateCache } from 'main/sentient-sims/services/SimStateCache';
import { ApiContext } from 'main/sentient-sims/services/ApiContext';
import { SimStateReport } from 'main/sentient-sims/models/SimStateReport';
import { ActionIntent } from 'main/sentient-sims/models/ActionIntent';

type CtxOptions = {
  autonomyLevel?: 'off' | 'suggest' | 'full';
  pipeline?: 'off' | 'review';
  tickIntervalSeconds?: number;
  hourlyBudget?: number;
  intentJson?: string | (() => string);
  reviewJson?: string;
};

function buildCtx(options: CtxOptions = {}) {
  const cache = new SimStateCache();
  const dispatched: ActionIntent[] = [];
  const released: string[] = [];
  const oneShotCalls: string[] = [];
  const prompts: string[] = [];
  const storedMemories: unknown[] = [];

  const ctx = {
    settings: {
      cognitionEnabled: true,
      cognitionAutonomyLevel: options.autonomyLevel ?? 'full',
      cognitionPipeline: options.pipeline ?? 'off',
      cognitionTickIntervalSeconds: options.tickIntervalSeconds ?? 0,
      cognitionMaxConcurrent: 1,
      cognitionPerSimHourlyBudget: options.hourlyBudget ?? 100,
      memoryRetrievalEnabled: false,
    },
    simStateCache: cache,
    db: { isLoaded: () => true },
    generationQueue: {
      runCognition: <T>(task: () => Promise<T>) => task(),
    },
    ai: {
      runOneShot: (label: string, _system: string, userPrompt: string) => {
        oneShotCalls.push(label);
        prompts.push(userPrompt);
        const isReview = label === 'Cognition Review';
        const intentJson = typeof options.intentJson === 'function' ? options.intentJson() : options.intentJson;
        const text = isReview ? (options.reviewJson ?? intentJson ?? '{}') : (intentJson ?? '{}');
        return Promise.resolve({ text, exchange: {} });
      },
    },
    actionDispatcher: {
      dispatch: (intent: ActionIntent) => {
        dispatched.push(intent);
        return `req-${dispatched.length}`;
      },
      release: (requestId: string | undefined) => {
        if (requestId) {
          released.push(requestId);
        }
      },
    },
    memoryRepository: {
      createMemory: (request: unknown) => {
        storedMemories.push(request);
        return { id: storedMemories.length };
      },
    },
    memoryRetrieval: {
      retrieve: () => Promise.resolve([]),
    },
  } as unknown as ApiContext;

  const cognition = new CognitionService(ctx);
  return { ctx, cache, cognition, dispatched, released, oneShotCalls, prompts, storedMemories };
}

function idleSimReport(seq: number, overrides: Partial<SimStateReport> = {}): SimStateReport {
  return {
    type: 'state_report',
    seq,
    lot: { zone_id: 1, clock: { hour: 10, paused: false } },
    sims: [
      {
        sim_id: '100',
        sim_name: 'Elliot',
        location: { zone_id: 1 },
        sims: [{ sim_id: '200', tier: 'same_room', name: 'Adrian', distance: 3, social: { has_met: true } }],
        objects: [{ object_id: '900', action_keys: ['grab_snack'], name: 'object_fridge', tier: 'same_room', distance: 4 }],
        self: { mood: 'Fine', needs: { hunger: 50 } },
        activity: { queue: [], running: null, in_social: false },
      },
    ],
    ...overrides,
  };
}

async function settle() {
  // Deliberation is a chain of awaits; a few microtask turns settles it
  for (let i = 0; i < 8; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

const ACTION_INTENT = JSON.stringify({
  kind: 'action',
  action: 'grab_snack',
  thought: 'I could eat.',
  motivation: 'grabbing a bite',
});

describe('CognitionService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('deliberates an idle sim and dispatches the validated intent', async () => {
    const { cache, dispatched, storedMemories } = buildCtx({ intentJson: ACTION_INTENT });
    cache.ingest(idleSimReport(1));
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      sim_id: '100',
      action: 'grab_snack',
      target_object_id: '900',
      motivation: 'grabbing a bite',
      source: 'cognition',
    });
    // The thought became a memory
    expect(storedMemories).toHaveLength(1);
  });

  it('never re-pushes while an intent is in flight, and outcome closes the state', async () => {
    const { cache, cognition, dispatched } = buildCtx({ intentJson: ACTION_INTENT });
    cache.ingest(idleSimReport(1));
    await settle();
    expect(dispatched).toHaveLength(1);
    expect(cognition.getPhase('100')).toBe('PENDING_OUTCOME');

    // Reports keep arriving while the sim routes: no second dispatch
    cache.ingest(idleSimReport(2));
    cache.ingest(idleSimReport(3));
    await settle();
    expect(dispatched).toHaveLength(1);

    cognition.onOutcome({ sim_id: '100', outcome: 'success', request_id: 'req-1', action: 'grab_snack' });
    expect(cognition.getPhase('100')).toBe('COOLDOWN');

    // Cooldown of 0s: the next report deliberates again
    cache.ingest(idleSimReport(4));
    await settle();
    expect(dispatched).toHaveLength(2);
  });

  it('releases a stuck intent via the distance-aware timeout', async () => {
    vi.useFakeTimers();
    const { cache, cognition, dispatched, released } = buildCtx({ intentJson: ACTION_INTENT });
    cache.ingest(idleSimReport(1));
    await settle();
    expect(dispatched).toHaveLength(1);
    expect(cognition.getPhase('100')).toBe('PENDING_OUTCOME');

    // Base allowance is 90s; the fridge is 4m away so the timeout is ~90s
    await vi.advanceTimersByTimeAsync(95_000);
    expect(cognition.getPhase('100')).toBe('COOLDOWN');
    expect(cognition.getStats().timeouts).toBe(1);
    // The dispatcher's in-flight entry dies with the state machine's view — a lost
    // dispatch must not block the sim until the dispatcher TTL
    expect(released).toEqual(['req-1']);
  });

  it('suggest mode logs the would-be intent without dispatching', async () => {
    const { cache, cognition, dispatched, storedMemories } = buildCtx({
      intentJson: ACTION_INTENT,
      autonomyLevel: 'suggest',
    });
    cache.ingest(idleSimReport(1));
    await settle();

    expect(dispatched).toHaveLength(0);
    expect(cognition.getStats().suggestions).toBe(1);
    expect(storedMemories).toHaveLength(1);
  });

  it('degrades an invalid intent to continue', async () => {
    const { cache, cognition, dispatched } = buildCtx({ intentJson: 'the model rambled with no JSON' });
    cache.ingest(idleSimReport(1));
    await settle();

    expect(dispatched).toHaveLength(0);
    expect(cognition.getStats().invalidIntents).toBe(1);
    expect(cognition.getStats().continues).toBe(1);
  });

  it('does nothing while the game is paused', async () => {
    const { cache, cognition } = buildCtx({ intentJson: ACTION_INTENT });
    cache.ingest(idleSimReport(1, { paused: true }));
    await settle();
    expect(cognition.getStats().deliberations).toBe(0);
  });

  it('skips sims in a social or WickedWhims scene', async () => {
    const { cache, cognition } = buildCtx({ intentJson: ACTION_INTENT });
    const socialReport = idleSimReport(1);
    socialReport.sims![0].activity!.in_social = true;
    cache.ingest(socialReport);

    const wwReport = idleSimReport(2);
    wwReport.sims![0].self!.in_ww_scene = true;
    cache.ingest(wwReport);
    await settle();

    expect(cognition.getStats().deliberations).toBe(0);
  });

  it('enforces the per-sim hourly budget', async () => {
    const { cache, cognition, dispatched } = buildCtx({ intentJson: ACTION_INTENT, hourlyBudget: 1 });
    cache.ingest(idleSimReport(1));
    await settle();
    expect(dispatched).toHaveLength(1);

    cognition.onOutcome({ sim_id: '100', outcome: 'success', request_id: 'req-1' });
    cache.ingest(idleSimReport(2));
    await settle();
    // Budget of 1/hour spent — no second deliberation
    expect(cognition.getStats().deliberations).toBe(1);
  });

  it('coerces socials on strangers to chat', async () => {
    const intent = JSON.stringify({ kind: 'action', action: 'get_to_know', target_sim_id: '200', thought: 'who?' });
    const { cache, dispatched } = buildCtx({ intentJson: intent });
    const stranger = idleSimReport(1);
    stranger.sims![0].sims = [{ sim_id: '200', tier: 'same_room', name: 'Stranger', distance: 2, social: { has_met: false } }];
    cache.ingest(stranger);
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].action).toBe('chat');
  });

  it('normalizes prose action keys to the whitelist vocabulary', async () => {
    // Observed live on the first playtest tick: the model emitted "Grab Snack"
    const intent = JSON.stringify({ kind: 'action', action: 'Grab Snack', thought: 'hungry' });
    const { cache, dispatched } = buildCtx({ intentJson: intent });
    cache.ingest(idleSimReport(1));
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].action).toBe('grab_snack');
    expect(dispatched[0].target_object_id).toBe('900');
  });

  it('replaces a hallucinated object id with the offered provider', async () => {
    const intent = JSON.stringify({
      kind: 'action',
      action: 'grab_snack',
      target_object_id: '424242', // not in the snapshot
      thought: 'hungry',
    });
    const { cache, dispatched } = buildCtx({ intentJson: intent });
    cache.ingest(idleSimReport(1));
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].target_object_id).toBe('900');
  });

  it('accepts context-gated lot verbs offered by the report', async () => {
    // pay_bills has no snapshot provider object — the mod resolves mailbox/phone itself.
    // The model-supplied prose target ("Mailbox", observed live) must be stripped.
    const intent = JSON.stringify({
      kind: 'action',
      action: 'pay bills',
      target_object_id: 'Mailbox',
      thought: 'bills are due',
    });
    const { cache, dispatched } = buildCtx({ intentJson: intent });
    const report = idleSimReport(1);
    report.lot!.bills = { due: true, amount: 287 };
    report.lot!.action_keys = ['pay_bills'];
    cache.ingest(report);
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].action).toBe('pay_bills');
    expect(dispatched[0].target_object_id).toBeUndefined();
  });

  it('rejects lot verbs when the report does not offer them', async () => {
    const intent = JSON.stringify({ kind: 'action', action: 'pay_bills', thought: 'bills?' });
    const { cache, cognition, dispatched } = buildCtx({ intentJson: intent });
    cache.ingest(idleSimReport(1));
    await settle();

    expect(dispatched).toHaveLength(0);
    expect(cognition.getStats().invalidIntents).toBe(1);
  });

  it('suppresses an action from the vocabulary after it closes unsuccessfully', async () => {
    const { cache, cognition, dispatched } = buildCtx({ intentJson: ACTION_INTENT });
    cache.ingest(idleSimReport(1));
    await settle();
    expect(dispatched).toHaveLength(1);

    // The world refused it (canceled, e.g. a game test failed). The action must leave
    // this sim's offered vocabulary — observed live: a bill-free mailbox re-offered
    // pay_bills every tick and the sim retried it forever.
    cognition.onOutcome({ sim_id: '100', outcome: 'canceled', request_id: 'req-1', action: 'grab_snack' });

    cache.ingest(idleSimReport(2));
    await settle();
    // The model picked grab_snack again, but its provider was filtered out -> inert continue
    expect(dispatched).toHaveLength(1);
    expect(cognition.getStats().invalidIntents).toBe(1);
    expect(cognition.getStats().continues).toBe(1);
  });

  it('accepts squashed action keys when the action is offered', async () => {
    // Observed live: the model emitted "paybills" with no separator
    const intent = JSON.stringify({ kind: 'action', action: 'grabsnack', thought: 'hungry' });
    const { cache, dispatched } = buildCtx({ intentJson: intent });
    cache.ingest(idleSimReport(1));
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].action).toBe('grab_snack');
  });

  it('names a rejected action as impossible in the next prompt', async () => {
    // A fixated model (memories full of bills) re-picks an unofferable action every tick
    // unless the prompt pushes back — observed live: 3 straight pay_bills rejections
    const { cache, cognition, prompts } = buildCtx({
      intentJson: JSON.stringify({ kind: 'action', action: 'pay_bills', thought: 'bills!' }),
    });
    cache.ingest(idleSimReport(1));
    await settle();
    expect(cognition.getStats().invalidIntents).toBe(1);
    expect(prompts[0]).not.toContain('NOT possible right now');

    cache.ingest(idleSimReport(2));
    await settle();
    expect(prompts[1]).toContain('NOT possible right now, do not choose: pay bills');
  });

  it('does not re-dispatch the action a busy sim is already executing', async () => {
    // Proxy pushes (cook_meal) close as success instantly while the real chain keeps
    // running, so PENDING_OUTCOME can't catch the repeat — observed live: a second
    // cook_meal queued while the first meal was still on the stove
    const { cache, cognition, dispatched } = buildCtx({ intentJson: ACTION_INTENT });
    cache.ingest(idleSimReport(1));
    await settle();
    expect(dispatched).toHaveLength(1);
    cognition.onOutcome({ sim_id: '100', outcome: 'success', request_id: 'req-1', action: 'grab_snack' });

    // Still busy on the spawned chain, low hunger keeps her deliberation-eligible, and
    // the model picks grab_snack again
    const busyReport = idleSimReport(2);
    busyReport.sims![0].activity!.running = 'Food_Eat_Active';
    busyReport.sims![0].self!.needs = { hunger: 5 };
    cache.ingest(busyReport);
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(cognition.getStats().continues).toBe(1);
  });

  it('blocks a same-need action while busy on the last dispatch', async () => {
    // Food-on-food observed live: mid-cook, the model picked grab_snack — different key,
    // same need, and the Critical push can cancel the cooking already underway
    const cookIntent = JSON.stringify({ kind: 'action', action: 'cook_meal', thought: 'dinner' });
    const snackIntent = JSON.stringify({ kind: 'action', action: 'grab_snack', thought: 'hungry' });
    let current = cookIntent;
    const { cache, cognition, dispatched } = buildCtx({ intentJson: () => current });
    const report = idleSimReport(1);
    report.sims![0].objects![0].action_keys = ['grab_snack', 'cook_meal'];
    cache.ingest(report);
    await settle();
    expect(dispatched).toHaveLength(1);
    cognition.onOutcome({ sim_id: '100', outcome: 'success', request_id: 'req-1', action: 'cook_meal' });

    current = snackIntent;
    const busyReport = idleSimReport(2);
    busyReport.sims![0].objects![0].action_keys = ['grab_snack', 'cook_meal'];
    busyReport.sims![0].activity!.running = 'counter_MakeFood_Staging_Basic';
    busyReport.sims![0].self!.needs = { hunger: 5 };
    cache.ingest(busyReport);
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(cognition.getStats().continues).toBe(1);
  });

  it('rule-dispatches the fix for a critical need without consulting the model', async () => {
    // Observed live: bladder -99 while the model kept picking grab_snack at hunger 94
    const { cache, dispatched, oneShotCalls } = buildCtx({ intentJson: ACTION_INTENT });
    const report = idleSimReport(1);
    report.sims![0].objects![0].action_keys = ['use_toilet', 'grab_snack'];
    report.sims![0].self!.needs = { bladder: -99, hunger: 94 };
    report.sims![0].activity!.running = 'seating_Sit';
    cache.ingest(report);
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].action).toBe('use_toilet');
    expect(oneShotCalls).toHaveLength(0);
  });

  it('does not interrupt a busy sim for a non-urgent need', async () => {
    // Observed live: a take_shower at hygiene 31 canceled the only TV time of the day
    const shower = JSON.stringify({ kind: 'action', action: 'take_shower', thought: 'I smell bad.' });
    const { cache, cognition, dispatched, storedMemories } = buildCtx({ intentJson: shower });
    const report = idleSimReport(1);
    report.sims![0].objects![0].action_keys = ['take_shower'];
    report.sims![0].activity!.running = 'TV_Watch';
    report.sims![0].self!.needs = { hygiene: 31, fun: 5 };
    cache.ingest(report);
    await settle();

    expect(dispatched).toHaveLength(0);
    expect(cognition.getStats().continues).toBe(1);
    // A blocked action's justification must NOT become a memory — "I smell bad" at
    // fine hygiene poisoned retrieval as her supposed inner state (observed live)
    expect(storedMemories).toHaveLength(0);
  });

  it('interrupts a busy sim for an urgent need', async () => {
    const toilet = JSON.stringify({ kind: 'action', action: 'use_toilet', thought: 'now!' });
    const { cache, dispatched } = buildCtx({ intentJson: toilet });
    const report = idleSimReport(1);
    report.sims![0].objects![0].action_keys = ['use_toilet'];
    report.sims![0].activity!.running = 'TV_Watch';
    report.sims![0].self!.needs = { bladder: -60 };
    cache.ingest(report);
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].action).toBe('use_toilet');
  });

  it('holds cognition entirely while the database is not loaded', async () => {
    const { ctx, cache, cognition } = buildCtx({ intentJson: ACTION_INTENT });
    (ctx as unknown as { db: { isLoaded: () => boolean } }).db.isLoaded = () => false;
    cache.ingest(idleSimReport(1));
    await settle();
    expect(cognition.getStats().deliberations).toBe(0);
  });

  it('restores the model intent when the review pick is guard-blocked', async () => {
    // Observed live: model watch_tv (Fun -100), review flipped to grab_snack while food
    // was already cooking — the guard killed the review pick and the good intent was
    // lost to continue. Code guards outrank the reviewer.
    const snack = JSON.stringify({ kind: 'action', action: 'grab_snack', thought: 'a bite' });
    const tv = JSON.stringify({ kind: 'action', action: 'watch_tv', thought: 'some fun' });
    let current = snack;
    const { cache, cognition, dispatched } = buildCtx({
      intentJson: () => current,
      reviewJson: snack,
      pipeline: 'review',
    });
    const first = idleSimReport(1);
    first.sims![0].objects![0].action_keys = ['grab_snack', 'watch_tv'];
    cache.ingest(first);
    await settle();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].action).toBe('grab_snack');
    cognition.onOutcome({ sim_id: '100', outcome: 'success', request_id: 'req-1', action: 'grab_snack' });

    current = tv;
    const busyReport = idleSimReport(2);
    busyReport.sims![0].objects![0].action_keys = ['grab_snack', 'watch_tv'];
    busyReport.sims![0].activity!.running = 'generic_consume_food';
    // fun deeply low so the restored watch_tv also clears the busy-interrupt bar
    busyReport.sims![0].self!.needs = { hunger: 5, fun: -80 };
    cache.ingest(busyReport);
    await settle();

    expect(dispatched).toHaveLength(2);
    expect(dispatched[1].action).toBe('watch_tv');
  });

  it('review dial runs a second pass that can adjust the intent', async () => {
    const reviewed = JSON.stringify({
      kind: 'action',
      action: 'grab_snack',
      target_object_id: '900',
      thought: 'Food first.',
    });
    const { cache, dispatched, oneShotCalls } = buildCtx({
      intentJson: JSON.stringify({ kind: 'action', action: 'chat', target_sim_id: '200', thought: 'chatty' }),
      reviewJson: reviewed,
      pipeline: 'review',
    });
    cache.ingest(idleSimReport(1));
    await settle();

    expect(oneShotCalls).toEqual(['Cognition', 'Cognition Review']);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].action).toBe('grab_snack');
  });

  it('sends an idle off-lot sim home rule-based, without deliberating', async () => {
    const { cache, dispatched, oneShotCalls } = buildCtx({ intentJson: ACTION_INTENT });
    const report = idleSimReport(1);
    report.lot!.is_home = true;
    report.sims![0].self!.on_active_lot = false;
    cache.ingest(report);
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].action).toBe('go_home');
    // No LLM involved — the rule fires before deliberation
    expect(oneShotCalls).toHaveLength(0);
  });

  it('sends home an off-lot sim stuck in an idle animation', async () => {
    // idle_Energy at 1am in the street counts as idle, not busy (observed live)
    const { cache, dispatched } = buildCtx({ intentJson: ACTION_INTENT });
    const report = idleSimReport(1);
    report.lot!.is_home = true;
    report.sims![0].self!.on_active_lot = false;
    report.sims![0].activity!.running = 'idle_Energy';
    report.sims![0].activity!.queue = ['idle_Energy'];
    cache.ingest(report);
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].action).toBe('go_home');
  });

  it('never sends sims home from a lot that is not their home', async () => {
    const { cache, dispatched, oneShotCalls } = buildCtx({ intentJson: ACTION_INTENT });
    const report = idleSimReport(1);
    report.lot!.is_home = false;
    report.sims![0].self!.on_active_lot = false;
    cache.ingest(report);
    await settle();

    // Not sent home, and off-lot sims never deliberate either
    expect(dispatched).toHaveLength(0);
    expect(oneShotCalls).toHaveLength(0);
  });

  it('speak intents normalize into a chat dispatch with the topic as motivation', async () => {
    const intent = JSON.stringify({
      kind: 'speak',
      speak: { target_sim_id: '200', topic: 'ask Adrian about the gig' },
      thought: 'I should check in.',
    });
    const { cache, dispatched } = buildCtx({ intentJson: intent });
    cache.ingest(idleSimReport(1));
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      action: 'chat',
      target_sim_id: '200',
      motivation: 'ask Adrian about the gig',
    });
  });
});
