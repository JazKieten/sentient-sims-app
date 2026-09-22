import { afterEach, describe, expect, it, vi } from 'vitest';
import { CognitionService } from 'main/sentient-sims/services/CognitionService';
import { SimStateCache } from 'main/sentient-sims/services/SimStateCache';
import { ApiContext } from 'main/sentient-sims/services/ApiContext';
import { SimStateReport } from 'main/sentient-sims/models/SimStateReport';
import { ActionIntent } from 'main/sentient-sims/models/ActionIntent';

type JsonProvider = string | (() => string);

type CtxOptions = {
  autonomyLevel?: 'off' | 'suggest' | 'full';
  tickIntervalSeconds?: number;
  hourlyBudget?: number;
  actionScoreThreshold?: number;
  monologueText?: string;
  scoresJson?: JsonProvider;
  optionsJson?: JsonProvider;
  choiceJson?: JsonProvider;
  reviewJson?: JsonProvider;
  // Daily plan stub: what activePlan returns and whether the lazy planner should fire
  plan?: { goals: { label: string }[]; persona?: string; loadout?: string[] };
  needsLazyPlan?: boolean;
};

function resolveJson(provider: JsonProvider | undefined): string | undefined {
  return typeof provider === 'function' ? provider() : provider;
}

// Defaults drive the standard happy path: a restless sim (action 9) whose action scene
// offers the fridge snack and a chat, picks the snack.
const HIGH_SCORES = '{"memory": 4, "action": 9, "action_reason": "I want a snack."}';
const SNACK_AND_CHAT_OPTIONS = JSON.stringify({
  scene: 'You are peckish and Adrian is right there.',
  options: [
    { action: 'grab_snack', target_object_id: '900', label: 'Raid the fridge' },
    { action: 'chat', target_sim_id: '200', label: 'Talk to Adrian' },
  ],
});
const SNACK_ONLY_OPTIONS = JSON.stringify({
  scene: 'You are peckish.',
  options: [{ action: 'grab_snack', target_object_id: '900', label: 'Raid the fridge' }],
});
const PICK_FIRST = '{"choice": 1, "motivation": "grabbing a bite"}';

function buildCtx(options: CtxOptions = {}) {
  const cache = new SimStateCache();
  const dispatched: ActionIntent[] = [];
  const released: string[] = [];
  const oneShotCalls: string[] = [];
  const prompts: string[] = [];
  const storedMemories: unknown[] = [];
  const lazyPlanCalls: unknown[][] = [];

  const ctx = {
    settings: {
      cognitionEnabled: true,
      cognitionAutonomyLevel: options.autonomyLevel ?? 'full',
      cognitionTickIntervalSeconds: options.tickIntervalSeconds ?? 0,
      cognitionMaxConcurrent: 1,
      cognitionPerSimHourlyBudget: options.hourlyBudget ?? 100,
      cognitionActionScoreThreshold: options.actionScoreThreshold ?? 7,
    },
    simStateCache: cache,
    db: { isLoaded: () => true },
    generationQueue: {
      runCognition: <T>(task: () => Promise<T>) => task(),
    },
    ai: {
      // Labels carry the sim name so the dev-mode AI log can be read at a glance;
      // the harness dispatches on the stage prefix
      runOneShot: (label: string, _system: string, userPrompt: string) => {
        oneShotCalls.push(label);
        prompts.push(userPrompt);
        let text = '';
        if (label.startsWith('Cognition Monologue')) {
          text = options.monologueText ?? 'Just taking stock of the day.';
        } else if (label.startsWith('Cognition Scores')) {
          text = resolveJson(options.scoresJson) ?? HIGH_SCORES;
        } else if (label.startsWith('Action Options')) {
          text = resolveJson(options.optionsJson) ?? SNACK_AND_CHAT_OPTIONS;
        } else if (label.startsWith('Action Choice')) {
          text = resolveJson(options.choiceJson) ?? PICK_FIRST;
        } else if (label.startsWith('Action Review')) {
          // Default: unparseable — the review no-ops and the sim's own choice stands
          text = resolveJson(options.reviewJson) ?? 'keep';
        }
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
    semanticMemory: {
      recall: () => '',
    },
    dailyPlan: {
      activePlan: () => options.plan,
      needsLazyPlan: () => options.needsLazyPlan ?? false,
      generateLazy: (...args: unknown[]) => {
        lazyPlanCalls.push(args);
        return Promise.resolve();
      },
    },
  } as unknown as ApiContext;

  const cognition = new CognitionService(ctx);
  return { ctx, cache, cognition, dispatched, released, oneShotCalls, prompts, storedMemories, lazyPlanCalls };
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
        sims: [
          { sim_id: '200', tier: 'same_room', name: 'Adrian', distance: 3, age: 'ADULT', social: { has_met: true } },
        ],
        objects: [
          { object_id: '900', action_keys: ['grab_snack'], name: 'object_fridge', tier: 'same_room', distance: 4 },
        ],
        self: { mood: 'Fine', needs: { hunger: 50 }, age: 'ADULT' },
        activity: { queue: [], running: null, in_social: false },
      },
    ],
    ...overrides,
  };
}

async function settle() {
  // A deliberation is now a chain of up to five sequential mocked calls, each several
  // microtask hops deep — generous turns settle it without real timers
  for (let i = 0; i < 64; i += 1) {
    await Promise.resolve();
  }
}

describe('CognitionService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs monologue -> scores -> action scene and dispatches the chosen option', async () => {
    const { cache, dispatched, oneShotCalls, storedMemories } = buildCtx();
    cache.ingest(idleSimReport(1));
    await settle();

    expect(oneShotCalls.map((label) => label.split(':')[0])).toEqual([
      'Cognition Monologue',
      'Cognition Scores',
      'Action Options',
      'Action Choice',
      'Action Review',
    ]);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      sim_id: '100',
      action: 'grab_snack',
      target_object_id: '900',
      motivation: 'grabbing a bite',
      source: 'cognition',
    });
    // The tick monologue became the sim's private memory
    expect(storedMemories).toHaveLength(1);
  });

  it('a low action score means no action scene: the fast brain keeps the wheel', async () => {
    const { cache, cognition, dispatched, oneShotCalls, storedMemories } = buildCtx({
      scoresJson: '{"memory": 6, "action": 2, "action_reason": "Happy as is."}',
    });
    cache.ingest(idleSimReport(1));
    await settle();

    expect(oneShotCalls.map((label) => label.split(':')[0])).toEqual(['Cognition Monologue', 'Cognition Scores']);
    expect(dispatched).toHaveLength(0);
    expect(cognition.getStats().continues).toBe(1);
    // A memorable moment is still the sim's inner life — stored even with nothing to do
    expect(storedMemories).toHaveLength(1);
  });

  // The sim thinks on every tick; only the moments worth keeping are written down.
  // Filing every routine monologue buried the Memories window and fed the sim its own
  // small talk back on the next recall.
  it('a forgettable tick thinks but stores nothing', async () => {
    const { cache, cognition, oneShotCalls, storedMemories } = buildCtx({
      scoresJson: '{"memory": 2, "action": 2, "action_reason": "Happy as is."}',
    });
    cache.ingest(idleSimReport(1));
    await settle();

    expect(oneShotCalls.map((label) => label.split(':')[0])).toEqual(['Cognition Monologue', 'Cognition Scores']);
    expect(cognition.getStats().continues).toBe(1);
    expect(storedMemories).toHaveLength(0);
  });

  it('a scene-armed desire skips monologue and scores and stages the action scene directly', async () => {
    const { cache, cognition, dispatched, oneShotCalls } = buildCtx();
    cognition.armDesireFromScene('100', { score: 9, reason: 'I want to eat something', thought: 'Hungry.' });
    cache.ingest(idleSimReport(1));
    await settle();

    expect(oneShotCalls.map((label) => label.split(':')[0])).toEqual([
      'Action Options',
      'Action Choice',
      'Action Review',
    ]);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].action).toBe('grab_snack');
  });

  it('ignores scene scores below the threshold', async () => {
    const { cache, cognition, oneShotCalls } = buildCtx({
      scoresJson: '{"memory": 2, "action": 1}',
    });
    cognition.armDesireFromScene('100', { score: 5, reason: 'mild itch' });
    cache.ingest(idleSimReport(1));
    await settle();

    // Not armed — the tick ran its normal monologue/scores beat instead
    expect(oneShotCalls.map((label) => label.split(':')[0])).toEqual(['Cognition Monologue', 'Cognition Scores']);
  });

  it('never re-pushes while an intent is in flight, and outcome closes the state', async () => {
    const { cache, cognition, dispatched } = buildCtx();
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
    const { cache, cognition, dispatched, released } = buildCtx({ optionsJson: SNACK_ONLY_OPTIONS });
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

    // The timed-out action is suppressed like a failure: the options menu loses its only
    // valid entry, so the scene stands down instead of looping
    cache.ingest(idleSimReport(2));
    await settle();
    expect(dispatched).toHaveLength(1);
    expect(cognition.getStats().invalidIntents).toBe(1);
  });

  it('retries once on a transient close, never on ineligible (G-10)', async () => {
    vi.useFakeTimers();
    const { cache, cognition, dispatched } = buildCtx({ optionsJson: SNACK_ONLY_OPTIONS });
    cache.ingest(idleSimReport(1));
    await settle();
    expect(dispatched).toHaveLength(1);

    // Bumped from the queue: transient — one automatic retry after the delay
    cognition.onOutcome({
      sim_id: '100',
      outcome: 'canceled',
      request_id: 'req-1',
      action: 'grab_snack',
      cause: 'bumped_from_queue',
    });
    expect(cognition.getPhase('100')).toBe('COOLDOWN');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(dispatched).toHaveLength(2);
    expect(dispatched[1].action).toBe('grab_snack');
    expect(cognition.getPhase('100')).toBe('PENDING_OUTCOME');

    // Default retries is 1: a second transient close is a clean outcome, no re-dispatch
    cognition.onOutcome({
      sim_id: '100',
      outcome: 'canceled',
      request_id: 'req-2',
      action: 'grab_snack',
      cause: 'bumped_from_queue',
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(dispatched).toHaveLength(2);
    vi.useRealTimers();
  });

  it('never retries an ineligible close (G-10)', async () => {
    vi.useFakeTimers();
    const { cache, cognition, dispatched } = buildCtx({ optionsJson: SNACK_ONLY_OPTIONS });
    cache.ingest(idleSimReport(1));
    await settle();
    expect(dispatched).toHaveLength(1);
    cognition.onOutcome({
      sim_id: '100',
      outcome: 'ineligible',
      request_id: 'req-1',
      action: 'grab_snack',
      cause: 'no_provider_on_lot',
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(dispatched).toHaveLength(1);
    vi.useRealTimers();
  });

  // F5: a success nothing confirmed must not act like a success. Before this, the phantom
  // closed the sim's pending state as a clean win, which also lifted any suppression the
  // verb was sitting under — so the next tick could re-pick the action that never happened.
  it('treats a suspect success as unresolved, not as a win', async () => {
    vi.useFakeTimers();
    const { cache, cognition, dispatched } = buildCtx({ optionsJson: SNACK_ONLY_OPTIONS });
    cache.ingest(idleSimReport(1));
    await settle();
    expect(dispatched).toHaveLength(1);

    cognition.onOutcome({
      sim_id: '100',
      outcome: 'success',
      request_id: 'req-1',
      action: 'grab_snack',
      verdict: 'suspect',
      decided_at: 'dispatch',
    });

    expect(cognition.getPhase('100')).toBe('COOLDOWN');
    expect(cognition.getStats().suspectOutcomes).toBe(1);

    // The verb sits out the benign window instead of being immediately re-picked
    cache.ingest(idleSimReport(2));
    await settle();
    expect(dispatched).toHaveLength(1);
    vi.useRealTimers();
  });

  it('still closes a confirmed success as a win', async () => {
    vi.useFakeTimers();
    const { cache, cognition, dispatched } = buildCtx({ optionsJson: SNACK_ONLY_OPTIONS });
    cache.ingest(idleSimReport(1));
    await settle();

    cognition.onOutcome({
      sim_id: '100',
      outcome: 'success',
      request_id: 'req-1',
      action: 'grab_snack',
      verdict: 'confirmed',
      decided_at: 'finished',
      ran: true,
    });

    expect(cognition.getStats().suspectOutcomes).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    cache.ingest(idleSimReport(2));
    await settle();
    expect(dispatched).toHaveLength(2);
    vi.useRealTimers();
  });

  it('does not lift a timeout suppression for a late success nothing confirmed', async () => {
    vi.useFakeTimers();
    const { cache, cognition, dispatched } = buildCtx({ optionsJson: SNACK_ONLY_OPTIONS });
    cache.ingest(idleSimReport(1));
    await settle();
    expect(dispatched).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(95_000);
    expect(cognition.getPhase('100')).toBe('COOLDOWN');

    // Same shape as the guitar case that earned the lift (a long action answering late),
    // except this one never ran — so the suppression stays and the verb is not re-offered
    cognition.onOutcome({
      sim_id: '100',
      outcome: 'success',
      request_id: 'req-1',
      action: 'grab_snack',
      verdict: 'suspect',
      decided_at: 'finished',
      ran: false,
      late: true,
    });

    cache.ingest(idleSimReport(2));
    await settle();
    expect(dispatched).toHaveLength(1);
    expect(cognition.getStats().suspectOutcomes).toBe(1);
    vi.useRealTimers();
  });

  it('lifts the timeout suppression when the action reports success late', async () => {
    vi.useFakeTimers();
    const { cache, cognition, dispatched } = buildCtx({ optionsJson: SNACK_ONLY_OPTIONS });
    cache.ingest(idleSimReport(1));
    await settle();
    expect(dispatched).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(95_000);
    expect(cognition.getPhase('100')).toBe('COOLDOWN');

    // A long action answers late: the mod left it running and reports success. The
    // release had already suppressed the verb assuming silence — the world answered,
    // so the verb must come back (live 2026-08-10: a Sim mid-song was told 'play
    // guitar' was NOT possible while her only goal was to practise an instrument)
    cognition.onOutcome({ sim_id: '100', outcome: 'success', request_id: 'req-1', action: 'grab_snack' });

    cache.ingest(idleSimReport(2));
    await settle();
    expect(dispatched).toHaveLength(2);
    expect(cognition.getStats().invalidIntents).toBe(0);
  });

  it('suggest mode logs the would-be intent without dispatching', async () => {
    const { cache, cognition, dispatched, storedMemories } = buildCtx({ autonomyLevel: 'suggest' });
    cache.ingest(idleSimReport(1));
    await settle();

    expect(dispatched).toHaveLength(0);
    expect(cognition.getStats().suggestions).toBe(1);
    expect(storedMemories).toHaveLength(1);
  });

  it('degrades unparseable action options to continue', async () => {
    const { cache, cognition, dispatched } = buildCtx({ optionsJson: 'the model rambled with no JSON' });
    cache.ingest(idleSimReport(1));
    await settle();

    expect(dispatched).toHaveLength(0);
    expect(cognition.getStats().invalidIntents).toBe(1);
    expect(cognition.getStats().continues).toBe(1);
  });

  it('does nothing while the game is paused', async () => {
    const { cache, cognition } = buildCtx();
    cache.ingest(idleSimReport(1, { paused: true }));
    await settle();
    expect(cognition.getStats().deliberations).toBe(0);
  });

  it('skips sims in a social or WickedWhims scene', async () => {
    const { cache, cognition } = buildCtx();
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
    const { cache, cognition, dispatched } = buildCtx({ hourlyBudget: 1 });
    cache.ingest(idleSimReport(1));
    await settle();
    expect(dispatched).toHaveLength(1);

    cognition.onOutcome({ sim_id: '100', outcome: 'success', request_id: 'req-1' });
    cache.ingest(idleSimReport(2));
    await settle();
    // Budget of 1/hour spent — no second deliberation
    expect(cognition.getStats().deliberations).toBe(1);
  });

  it('coerces social options on strangers to chat', async () => {
    const { cache, dispatched } = buildCtx({
      optionsJson: JSON.stringify({
        scene: 'A stranger nearby.',
        options: [{ action: 'get_to_know', target_sim_id: '200', label: 'Get to know them' }],
      }),
    });
    const stranger = idleSimReport(1);
    stranger.sims![0].sims = [
      { sim_id: '200', tier: 'same_room', name: 'Stranger', distance: 2, social: { has_met: false } },
    ];
    cache.ingest(stranger);
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].action).toBe('chat');
  });

  it('coerces an unknown verb aimed at a present sim to chat', async () => {
    const { cache, dispatched } = buildCtx({
      optionsJson: JSON.stringify({
        scene: 'Company at last.',
        options: [{ action: 'talk', target_sim_id: '200', label: 'Talk to Andy' }],
      }),
    });
    const report = idleSimReport(1);
    report.sims![0].sims = [{ sim_id: '200', tier: 'same_room', name: 'Andy', distance: 2, social: { has_met: true } }];
    cache.ingest(report);
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].action).toBe('chat');
    expect(dispatched[0].target_sim_id).toBe('200');
  });

  it('normalizes prose action keys in options to the whitelist vocabulary', async () => {
    const { cache, dispatched } = buildCtx({
      optionsJson: JSON.stringify({ options: [{ action: 'Grab Snack', label: 'A snack' }] }),
    });
    cache.ingest(idleSimReport(1));
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].action).toBe('grab_snack');
    expect(dispatched[0].target_object_id).toBe('900');
  });

  it('replaces a hallucinated object id with the offered provider', async () => {
    const { cache, dispatched } = buildCtx({
      optionsJson: JSON.stringify({
        options: [{ action: 'grab_snack', target_object_id: '424242', label: 'A snack' }],
      }),
    });
    cache.ingest(idleSimReport(1));
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].target_object_id).toBe('900');
  });

  it('accepts context-gated lot verbs offered by the report and strips prose targets', async () => {
    const { cache, dispatched } = buildCtx({
      optionsJson: JSON.stringify({
        options: [{ action: 'pay bills', target_object_id: 'Mailbox', label: 'Pay the bills' }],
      }),
    });
    const report = idleSimReport(1);
    report.lot!.bills = { due: true, amount: 287 };
    report.lot!.action_keys = ['pay_bills'];
    cache.ingest(report);
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].action).toBe('pay_bills');
    expect(dispatched[0].target_object_id).toBeUndefined();
  });

  it('drops lot-verb options when the report does not offer them', async () => {
    const { cache, cognition, dispatched } = buildCtx({
      optionsJson: JSON.stringify({ options: [{ action: 'pay_bills', label: 'Pay the bills' }] }),
    });
    cache.ingest(idleSimReport(1));
    await settle();

    expect(dispatched).toHaveLength(0);
    expect(cognition.getStats().invalidIntents).toBe(1);
  });

  it('suppresses an action from the vocabulary after it closes unsuccessfully', async () => {
    const { cache, cognition, dispatched } = buildCtx({ optionsJson: SNACK_ONLY_OPTIONS });
    cache.ingest(idleSimReport(1));
    await settle();
    expect(dispatched).toHaveLength(1);

    // The world refused it (canceled, e.g. a game test failed). The action must leave
    // this sim's offered vocabulary — the options menu loses its only valid entry.
    cognition.onOutcome({ sim_id: '100', outcome: 'canceled', request_id: 'req-1', action: 'grab_snack' });

    cache.ingest(idleSimReport(2));
    await settle();
    expect(dispatched).toHaveLength(1);
    expect(cognition.getStats().invalidIntents).toBe(1);
    expect(cognition.getStats().continues).toBe(1);
  });

  it('re-offers a benignly-canceled action after the short window', async () => {
    // A cancel is churn (guest on the toilet, autonomy bump), not proof — observed live:
    // one canceled use_toilet locked the ONLY bladder fix out for the full 10 minutes
    vi.useFakeTimers();
    const { cache, cognition, dispatched } = buildCtx({ optionsJson: SNACK_ONLY_OPTIONS });
    cache.ingest(idleSimReport(1));
    await settle();
    expect(dispatched).toHaveLength(1);
    cognition.onOutcome({ sim_id: '100', outcome: 'canceled', request_id: 'req-1', action: 'grab_snack' });

    // Inside the benign window: still suppressed
    cache.ingest(idleSimReport(2));
    await settle();
    expect(dispatched).toHaveLength(1);

    // Past the benign window (90s), far inside the failure window (10 min): offered again
    await vi.advanceTimersByTimeAsync(95_000);
    cache.ingest(idleSimReport(3));
    await settle();
    expect(dispatched).toHaveLength(2);
  });

  it('lets the critical-need rule bypass suppression', async () => {
    // An accident-in-progress warrants retrying even a just-failed fix: a suppressed
    // use_toilet at bladder -90 must never mean peeing on the floor
    const { cache, cognition, dispatched } = buildCtx({ optionsJson: SNACK_ONLY_OPTIONS });
    const first = idleSimReport(1);
    first.sims![0].objects = [
      { object_id: '901', action_keys: ['use_toilet'], name: 'object_toilet', tier: 'same_room', distance: 2 },
    ];
    first.sims![0].self!.needs = { bladder: -40 };
    cache.ingest(first);
    await settle();
    // Fail use_toilet outright: it enters the 10-minute suppression window
    cognition.onOutcome({ sim_id: '100', outcome: 'failure', request_id: 'req-none', action: 'use_toilet' });

    const critical = idleSimReport(2);
    critical.sims![0].objects = first.sims![0].objects;
    critical.sims![0].self!.needs = { bladder: -90 };
    cache.ingest(critical);
    await settle();

    const toiletDispatches = dispatched.filter((intent) => intent.action === 'use_toilet');
    expect(toiletDispatches).toHaveLength(1);
  });

  it('backs off the critical-need rule after preflight declares the fix unusable', async () => {
    // The rule lane bypasses ordinary suppression by design, but an 'ineligible' close
    // means the game itself refused the fix object (broken toilet) — without a backoff
    // the rule re-fired every 5s state report at bladder -100, writing an identical
    // failure memory per attempt (observed live 2026-08-07)
    const { cache, cognition, dispatched } = buildCtx({ optionsJson: SNACK_ONLY_OPTIONS });
    const first = idleSimReport(1);
    first.sims![0].objects = [
      { object_id: '901', action_keys: ['use_toilet'], name: 'object_toilet', tier: 'same_room', distance: 2 },
    ];
    first.sims![0].self!.needs = { bladder: -90 };
    cache.ingest(first);
    await settle();
    expect(dispatched.filter((intent) => intent.action === 'use_toilet')).toHaveLength(1);

    cognition.onOutcome({ sim_id: '100', outcome: 'ineligible', request_id: 'req-1', action: 'use_toilet' });

    const second = idleSimReport(2);
    second.sims![0].objects = first.sims![0].objects;
    second.sims![0].self!.needs = { bladder: -100 };
    cache.ingest(second);
    await settle();
    expect(dispatched.filter((intent) => intent.action === 'use_toilet')).toHaveLength(1);
  });

  it('renders relationship context and the social vocabulary in the monologue prompt', async () => {
    const { cache, prompts } = buildCtx({ scoresJson: '{"memory": 2, "action": 1}' });
    const report = idleSimReport(1);
    report.sims![0].sims = [
      {
        sim_id: '200',
        tier: 'same_room',
        name: 'Adrian',
        distance: 3,
        age: 'ADULT',
        // The SocialContext bit is transient conversation tone — it must not render
        social: { has_met: true, friendship: 62, romance: 18, bits: ['relbit_SocialContext_Awkwardness_Casual'] },
      },
      { sim_id: '300', tier: 'same_room', name: 'Kira', distance: 4, age: 'ADULT', social: { has_met: false } },
    ];
    cache.ingest(report);
    await settle();

    const prompt = prompts[0];
    // The lore layer: labels, not raw track values
    expect(prompt).toContain('Adrian (sim_id 200, a good friend, a romantic spark)');
    expect(prompt).toContain('Kira (sim_id 300, a stranger — chat to break the ice)');
    // The social vocabulary is offered, annotated by register
    expect(prompt).toContain('OFFERED social actions');
    expect(prompt).toContain('romantic only: flirt, kiss');
    expect(prompt).toContain('mean: insult');
  });

  it('hides age-blocked SOCIALS, not just age-blocked objects', async () => {
    // The object/lot channels are narrowed through entryView, but the social list is
    // rendered from the static SOCIAL_ACTIONS set — so it needs the hidden keys handed
    // to it explicitly. Live 2026-08-10: a CHILD was offered 'deep conversation', the
    // exact verb the game refuses her ("Actor's age is Age.CHILD, must be one of...").
    const { cache, prompts } = buildCtx({ scoresJson: '{"memory": 2, "action": 1}' });
    const report = idleSimReport(1);
    report.sims![0].self!.age = 'CHILD';
    report.sims![0].self!.age_blocked = ['deep_conversation', 'tell_joke', 'read_book'];
    cache.ingest(report);
    await settle();

    const prompt = prompts[0];
    expect(prompt).toContain('OFFERED social actions');
    expect(prompt).not.toContain('deep conversation');
    expect(prompt).not.toContain('tell joke');
    // The verbs their age DOES allow survive — this is a filter, not a gag
    expect(prompt).toContain('chat');
    expect(prompt).toContain('ask about day');
    // And a hidden key is ABSENT from the whole prompt, never named as forbidden
    expect(prompt).not.toContain('NOT possible');
  });

  it('never offers romance across an age line, in either direction', async () => {
    // Live 2026-08-10: age rode every report and was read by nothing, so a CHILD's
    // prompt offered 'flirt' at whoever happened to be in the room
    const child = buildCtx({ scoresJson: '{"memory": 2, "action": 1}' });
    const childReport = idleSimReport(1);
    childReport.sims![0].self!.age = 'CHILD';
    child.cache.ingest(childReport);
    await settle();
    expect(child.prompts[0]).toContain('OFFERED social actions');
    expect(child.prompts[0]).not.toContain('romantic only');
    // Everything else survives — this is a romance gate, not a social blackout
    expect(child.prompts[0]).toContain('mean: insult');

    // ...and the other direction: an adult whose only company is a child
    const adult = buildCtx({ scoresJson: '{"memory": 2, "action": 1}' });
    const adultReport = idleSimReport(1);
    adultReport.sims![0].sims[0].age = 'CHILD';
    adult.cache.ingest(adultReport);
    await settle();
    expect(adult.prompts[0]).toContain('OFFERED social actions');
    expect(adult.prompts[0]).not.toContain('romantic only');
  });

  it('gates teen-plus socials on the TARGET age: hidden, labeled, or aimed right', async () => {
    // Live 2026-08-11 t64: 'deep_conversation' was selected and dispatched at a CHILD;
    // only the game's execution gate caught it. The offering side must catch it first.
    // Child is the only company -> the verb is absent, and the target is named a child.
    const solo = buildCtx({ scoresJson: '{"memory": 2, "action": 1}' });
    const soloReport = idleSimReport(1);
    soloReport.sims![0].sims[0].age = 'CHILD';
    solo.cache.ingest(soloReport);
    await settle();
    expect(solo.prompts[0]).toContain('OFFERED social actions');
    expect(solo.prompts[0]).not.toContain('deep conversation');
    expect(solo.prompts[0]).toContain('a child — keep talk age-appropriate');

    // Mixed-age room -> offered, but labeled so the model aims it at the teen+ target
    const mixed = buildCtx({ scoresJson: '{"memory": 2, "action": 1}' });
    const mixedReport = idleSimReport(1);
    mixedReport.sims![0].sims.push({
      sim_id: '300',
      tier: 'same_room',
      name: 'Kid',
      distance: 2,
      age: 'CHILD',
      social: { has_met: true },
    });
    mixed.cache.ingest(mixedReport);
    await settle();
    expect(mixed.prompts[0]).toContain('teens and up only: deep conversation');
  });

  it('coerces a teen-plus social dispatched at a child target down to chat', async () => {
    // Belt-and-braces behind the prompt filter: a stage that names the verb anyway
    // must never reach the game with a child target
    const { cache, dispatched } = buildCtx({
      optionsJson: JSON.stringify({
        scene: 'A quiet moment.',
        options: [{ action: 'deep_conversation', target_sim_id: '200', label: 'Really talk' }],
      }),
    });
    const report = idleSimReport(1);
    report.sims![0].sims[0].age = 'CHILD';
    cache.ingest(report);
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ action: 'chat', target_sim_id: '200' });
  });

  it('cuts go_out from the vocabulary when the sim is too tired', async () => {
    const { cache, dispatched } = buildCtx({
      optionsJson: JSON.stringify({ options: [{ action: 'go_out', label: 'Hit the town' }] }),
    });
    const report = idleSimReport(1);
    report.lot!.action_keys = ['go_out'];
    report.sims![0].self!.needs = { social: -100, energy: -50 };
    cache.ingest(report);
    await settle();

    // go_out was filtered before option validation -> no valid options -> stand down
    expect(dispatched).toHaveLength(0);
  });

  it('suppresses a one-shot verb after success too (done is done)', async () => {
    const { cache, cognition, dispatched } = buildCtx({
      optionsJson: JSON.stringify({ options: [{ action: 'hire_repair_service', label: 'Call a repair service' }] }),
    });
    const report = idleSimReport(1);
    report.lot!.action_keys = ['hire_repair_service'];
    cache.ingest(report);
    await settle();
    expect(dispatched).toHaveLength(1);

    cognition.onOutcome({ sim_id: '100', outcome: 'success', request_id: 'req-1', action: 'hire_repair_service' });

    const second = idleSimReport(2);
    second.lot!.action_keys = ['hire_repair_service'];
    cache.ingest(second);
    await settle();
    expect(dispatched).toHaveLength(1);
  });

  it('suppresses brush_teeth after success (the hygiene itch it barely moves persists)', async () => {
    // Observed live 2026-08-07: low hygiene kept the monologue wanting "to feel fresh",
    // and without success-suppression she brushed 5x in 7 minutes, burning an Action
    // Scene per re-pick before the dispatch guard caught each one
    const { cache, cognition, dispatched } = buildCtx({
      optionsJson: JSON.stringify({
        options: [{ action: 'brush_teeth', target_object_id: '901', label: 'Freshen up' }],
      }),
    });
    const report = idleSimReport(1);
    report.sims![0].objects.push({
      object_id: '901',
      action_keys: ['brush_teeth'],
      name: 'object_sink',
      tier: 'same_room',
      distance: 2,
    });
    cache.ingest(report);
    await settle();
    expect(dispatched).toHaveLength(1);

    cognition.onOutcome({ sim_id: '100', outcome: 'success', request_id: 'req-1', action: 'brush_teeth' });

    const second = idleSimReport(2);
    second.sims![0].objects.push({
      object_id: '901',
      action_keys: ['brush_teeth'],
      name: 'object_sink',
      tier: 'same_room',
      distance: 2,
    });
    cache.ingest(second);
    await settle();
    expect(dispatched).toHaveLength(1);
  });

  it('carries a chosen go_out destination through to the dispatcher as zone_id', async () => {
    const { cache, dispatched } = buildCtx({
      optionsJson: JSON.stringify({
        scene: 'The evening stretches ahead.',
        options: [{ action: 'go_out', destination: 'Willow Creek Archive', label: 'Head to the library' }],
      }),
    });
    const report = idleSimReport(1);
    report.lot!.action_keys = ['go_out'];
    report.venues = [
      { zone_id: '42', name: 'Willow Creek Archive', venue: 'library', world: 'Willow Creek', same_world: false },
      { zone_id: '77', name: 'Rattlesnake Juice', venue: 'bar', world: 'Oasis Springs', same_world: true },
    ];
    cache.ingest(report);
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ action: 'go_out', zone_id: '42' });
    expect(dispatched[0].target_object_id).toBeUndefined();
  });

  it('renders the go_out destinations line only when go_out is offered', async () => {
    const { cache, prompts } = buildCtx();
    const report = idleSimReport(1);
    report.lot!.action_keys = ['go_out'];
    report.venues = [
      { zone_id: '77', name: 'Rattlesnake Juice', venue: 'bar', world: 'Oasis Springs', same_world: true },
    ];
    cache.ingest(report);
    await settle();
    expect(
      prompts.some(
        (prompt) => prompt.includes('go_out destinations') && prompt.includes('Rattlesnake Juice (bar, Oasis Springs)'),
      ),
    ).toBe(true);

    // Without go_out in the lot keys the venue list stays out of the prompt
    const { cache: cache2, prompts: prompts2 } = buildCtx();
    const second = idleSimReport(1);
    second.venues = [
      { zone_id: '77', name: 'Rattlesnake Juice', venue: 'bar', world: 'Oasis Springs', same_world: true },
    ];
    cache2.ingest(second);
    await settle();
    expect(prompts2.some((prompt) => prompt.includes('go_out destinations'))).toBe(false);
  });

  it('re-offers go_out after its shortened 5-minute success cool-off', async () => {
    // Ordinary one-shots sit out the full 10 minutes; go_out's outing already occupies
    // the sim, so its window is half that — home from a trip, a second outing is fair
    vi.useFakeTimers();
    const { cache, cognition, dispatched } = buildCtx({
      optionsJson: JSON.stringify({ options: [{ action: 'go_out', label: 'Hit the town' }] }),
    });
    const first = idleSimReport(1);
    first.lot!.action_keys = ['go_out'];
    cache.ingest(first);
    await settle();
    expect(dispatched).toHaveLength(1);

    cognition.onOutcome({ sim_id: '100', outcome: 'success', request_id: 'req-1', action: 'go_out' });

    // 4 minutes: still suppressed
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    const second = idleSimReport(2);
    second.lot!.action_keys = ['go_out'];
    cache.ingest(second);
    await settle();
    expect(dispatched).toHaveLength(1);

    // Past 5 minutes: offered again (a 10-minute window would still be suppressing)
    await vi.advanceTimersByTimeAsync(90_000);
    const third = idleSimReport(3);
    third.lot!.action_keys = ['go_out'];
    cache.ingest(third);
    await settle();
    expect(dispatched).toHaveLength(2);
  });

  it('accepts squashed action keys when the action is offered', async () => {
    const { cache, dispatched } = buildCtx({
      optionsJson: JSON.stringify({ options: [{ action: 'grabsnack', label: 'A snack' }] }),
    });
    cache.ingest(idleSimReport(1));
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].action).toBe('grab_snack');
  });

  it('names a failed action as impossible in the next monologue prompt', async () => {
    const { cache, cognition, oneShotCalls, prompts } = buildCtx();
    cache.ingest(idleSimReport(1));
    await settle();
    cognition.onOutcome({ sim_id: '100', outcome: 'failure', request_id: 'req-1', action: 'grab_snack' });

    cache.ingest(idleSimReport(2));
    await settle();

    const monologueIndexes = oneShotCalls
      .map((label, index) => ({ label, index }))
      .filter((entry) => entry.label.startsWith('Cognition Monologue'))
      .map((entry) => entry.index);
    expect(prompts[monologueIndexes[0]]).not.toContain('NOT possible right now');
    expect(prompts[monologueIndexes[1]]).toContain('NOT possible right now, do not choose: grab snack');
  });

  it('does not re-dispatch the action a busy sim is already executing', async () => {
    // Proxy pushes (cook_meal) close as success instantly while the real chain keeps
    // running, so PENDING_OUTCOME can't catch the repeat
    const { cache, cognition, dispatched } = buildCtx({ optionsJson: SNACK_ONLY_OPTIONS });
    cache.ingest(idleSimReport(1));
    await settle();
    expect(dispatched).toHaveLength(1);
    cognition.onOutcome({ sim_id: '100', outcome: 'success', request_id: 'req-1', action: 'grab_snack' });

    // Still busy on the spawned chain, low hunger keeps her deliberation-eligible, and
    // the action scene picks grab_snack again
    const busyReport = idleSimReport(2);
    busyReport.sims![0].activity!.running = 'Food_Eat_Active';
    busyReport.sims![0].self!.needs = { hunger: 5 };
    cache.ingest(busyReport);
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(cognition.getStats().continues).toBe(1);
  });

  it('blocks a same-need action while busy on the last dispatch', async () => {
    // Food-on-food observed live: mid-cook, the pick was grab_snack — different key,
    // same need, and the Critical push can cancel the cooking already underway
    let currentOptions = JSON.stringify({ options: [{ action: 'cook_meal', label: 'Cook dinner' }] });
    const { cache, cognition, dispatched } = buildCtx({ optionsJson: () => currentOptions });
    const report = idleSimReport(1);
    report.sims![0].objects[0].action_keys = ['grab_snack', 'cook_meal'];
    cache.ingest(report);
    await settle();
    expect(dispatched).toHaveLength(1);
    cognition.onOutcome({ sim_id: '100', outcome: 'success', request_id: 'req-1', action: 'cook_meal' });

    currentOptions = JSON.stringify({ options: [{ action: 'grab_snack', label: 'A snack' }] });
    const busyReport = idleSimReport(2);
    busyReport.sims![0].objects[0].action_keys = ['grab_snack', 'cook_meal'];
    busyReport.sims![0].activity!.running = 'counter_MakeFood_Staging_Basic';
    busyReport.sims![0].self!.needs = { hunger: 5 };
    cache.ingest(busyReport);
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(cognition.getStats().continues).toBe(1);
  });

  it('rule-dispatches the fix for a critical need without consulting the model', async () => {
    // Observed live: bladder -99 while the model kept picking grab_snack at hunger 94
    const { cache, dispatched, oneShotCalls } = buildCtx();
    const report = idleSimReport(1);
    report.sims![0].objects[0].action_keys = ['use_toilet', 'grab_snack'];
    report.sims![0].self!.needs = { bladder: -99, hunger: 94 };
    report.sims![0].activity!.running = 'seating_Sit';
    cache.ingest(report);
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].action).toBe('use_toilet');
    expect(oneShotCalls).toHaveLength(0);
  });

  it('a high action score interrupts a busy sim (the score IS the justification)', async () => {
    const { cache, dispatched } = buildCtx({
      optionsJson: JSON.stringify({ options: [{ action: 'take_shower', label: 'Rinse off' }] }),
    });
    const report = idleSimReport(1);
    report.sims![0].objects[0].action_keys = ['take_shower'];
    report.sims![0].activity!.running = 'TV_Watch';
    report.sims![0].self!.needs = { hygiene: -60, fun: 5 };
    cache.ingest(report);
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].action).toBe('take_shower');
  });

  it('a content busy sim scores low and is left alone', async () => {
    const { cache, cognition, dispatched, oneShotCalls } = buildCtx({
      scoresJson: '{"memory": 2, "action": 2, "action_reason": "This show is great."}',
    });
    const report = idleSimReport(1);
    report.sims![0].activity!.running = 'TV_Watch';
    report.sims![0].self!.needs = { fun: 5 };
    cache.ingest(report);
    await settle();

    expect(dispatched).toHaveLength(0);
    expect(cognition.getStats().continues).toBe(1);
    expect(oneShotCalls.some((label) => label.startsWith('Action'))).toBe(false);
  });

  it('action review can override the pick to another option', async () => {
    const { cache, dispatched } = buildCtx({
      choiceJson: '{"choice": 1, "motivation": "snack time"}',
      reviewJson: '{"choice": 2}',
    });
    cache.ingest(idleSimReport(1));
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].action).toBe('chat');
    expect(dispatched[0].target_sim_id).toBe('200');
  });

  it('action review can stand the scene down with choice 0', async () => {
    const { cache, cognition, dispatched } = buildCtx({ reviewJson: '{"choice": 0}' });
    cache.ingest(idleSimReport(1));
    await settle();

    expect(dispatched).toHaveLength(0);
    expect(cognition.getStats().continues).toBe(1);
  });

  it('a hung model call cannot deadlock the cognition lane', async () => {
    vi.useFakeTimers();
    // Observed live: a provider request that never resolved left the runtime in
    // DELIBERATING forever, and maxConcurrent 1 silenced every future tick
    const hang = new Promise<never>(() => {});
    const { cache, cognition, ctx } = buildCtx({});
    (ctx as unknown as { ai: { runOneShot: () => Promise<never> } }).ai.runOneShot = () => hang;
    cache.ingest(idleSimReport(1));
    await vi.advanceTimersByTimeAsync(50_000);

    expect(cognition.getPhase('100')).toBe('COOLDOWN');

    // The lane is free again: a fresh report deliberates (an unparseable scores reply
    // simply scores low and continues)
    (ctx as unknown as { ai: { runOneShot: () => Promise<unknown> } }).ai.runOneShot = () =>
      Promise.resolve({ text: 'no json here', exchange: {} });
    cache.ingest(idleSimReport(2));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(cognition.getStats().deliberations).toBe(2);
  });

  it('holds cognition entirely while the database is not loaded', async () => {
    const { ctx, cache, cognition } = buildCtx();
    (ctx as unknown as { db: { isLoaded: () => boolean } }).db.isLoaded = () => false;
    cache.ingest(idleSimReport(1));
    await settle();
    expect(cognition.getStats().deliberations).toBe(0);
  });

  it('sends an idle off-lot sim home rule-based, without deliberating', async () => {
    const { cache, dispatched, oneShotCalls } = buildCtx();
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
    const { cache, dispatched } = buildCtx();
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

  it('sends a critically exhausted sim home from a venue as a rule', async () => {
    // Observed live: Energy -79 at the bar, no bed or food there, model kept trying
    // the broken TV while she drifted toward passout
    const { cache, dispatched, oneShotCalls } = buildCtx();
    const report = idleSimReport(1);
    report.lot!.is_home = false;
    report.sims![0].self!.needs = { energy: -90, social: -100, hunger: 20 };
    cache.ingest(report);
    await settle();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].action).toBe('go_home');
    expect(oneShotCalls).toHaveLength(0);
  });

  it('a sim having a bad time out asks to go home once it has gone on long enough', async () => {
    // Live 2026-09-19: two sims stood Uncomfortable in a museum indefinitely and nothing
    // ever proposed leaving. Low scores keep the model out of it, so the only dispatch
    // that can appear is the rule's.
    vi.useFakeTimers();
    const { cache, dispatched } = buildCtx({ scoresJson: '{"memory": 2, "action": 1}' });
    const miserableAtTheMuseum = (seq: number) => {
      const report = idleSimReport(seq);
      report.lot!.is_home = false;
      report.sims![0].self!.mood = 'Uncomfortable';
      return report;
    };

    cache.ingest(miserableAtTheMuseum(1));
    await settle();
    // The first report only starts the clock: a sim who just got somewhere and does not
    // like it is not yet asking to leave
    expect(dispatched.filter((intent) => intent.action === 'go_home')).toHaveLength(0);

    vi.setSystemTime(Date.now() + 6 * 60_000);
    cache.ingest(miserableAtTheMuseum(2));
    await settle();

    const goneHome = dispatched.filter((intent) => intent.action === 'go_home');
    expect(goneHome).toHaveLength(1);
    expect(goneHome[0].motivation).toContain('uncomfortable');
  });

  it('a bad mood that lifts resets the clock', async () => {
    vi.useFakeTimers();
    const { cache, dispatched } = buildCtx({ scoresJson: '{"memory": 2, "action": 1}' });
    const atTheMuseum = (seq: number, mood: string) => {
      const report = idleSimReport(seq);
      report.lot!.is_home = false;
      report.sims![0].self!.mood = mood;
      return report;
    };

    cache.ingest(atTheMuseum(1, 'Uncomfortable'));
    await settle();
    vi.setSystemTime(Date.now() + 4 * 60_000);
    cache.ingest(atTheMuseum(2, 'Happy'));
    await settle();
    vi.setSystemTime(Date.now() + 4 * 60_000);
    cache.ingest(atTheMuseum(3, 'Uncomfortable'));
    await settle();

    expect(dispatched.filter((intent) => intent.action === 'go_home')).toHaveLength(0);
  });

  it('never asks to leave the lot they live on', async () => {
    vi.useFakeTimers();
    const { cache, dispatched } = buildCtx({ scoresJson: '{"memory": 2, "action": 1}' });
    const miserableAtHome = (seq: number) => {
      const report = idleSimReport(seq);
      report.lot!.is_home = true;
      report.sims![0].self!.mood = 'Uncomfortable';
      return report;
    };

    cache.ingest(miserableAtHome(1));
    await settle();
    vi.setSystemTime(Date.now() + 6 * 60_000);
    cache.ingest(miserableAtHome(2));
    await settle();

    expect(dispatched.filter((intent) => intent.action === 'go_home')).toHaveLength(0);
  });

  it('an on-lot NPC never ticks its own inner life', async () => {
    const { cache, cognition, oneShotCalls } = buildCtx();
    const report = idleSimReport(1);
    report.sims![0].is_household = false;
    report.sims![0].self!.needs = { hunger: -99, fun: -80 };
    cache.ingest(report);
    await settle();

    // Neither deliberation nor the critical-need rule lane: NPC needs belong to the game
    expect(cognition.getStats().deliberations).toBe(0);
    expect(oneShotCalls).toHaveLength(0);
  });

  it('an on-lot NPC with a scene-armed desire runs its action scene', async () => {
    const { cache, cognition, dispatched, oneShotCalls } = buildCtx();
    cognition.armDesireFromScene('100', { score: 9, reason: 'I want a snack', thought: 'Peckish.' });
    const report = idleSimReport(1);
    report.sims![0].is_household = false;
    cache.ingest(report);
    await settle();

    expect(oneShotCalls.map((label) => label.split(':')[0])).toEqual([
      'Action Options',
      'Action Choice',
      'Action Review',
    ]);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].sim_id).toBe('100');
    expect(dispatched[0].action).toBe('grab_snack');
  });

  it('walks an idle off-lot sim into a venue instead of sending them home', async () => {
    // Travel spawns sims on the street outside the venue lot; observed live: she stood
    // outside the bar thinking wistful thoughts while three sims drank inside
    const { cache, dispatched, oneShotCalls } = buildCtx();
    const report = idleSimReport(1);
    report.lot!.is_home = false;
    report.sims![0].self!.on_active_lot = false;
    cache.ingest(report);
    await settle();

    // Rule-based enter_lot, never go_home — and off-lot sims never deliberate either
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].action).toBe('enter_lot');
    expect(oneShotCalls).toHaveLength(0);
  });

  it('daily loadout hard-filters off-loadout keys: absent from OFFERED and from NOT-possible', async () => {
    const { cache, dispatched, prompts } = buildCtx({
      plan: {
        goals: [{ label: 'Chat with 3 sims' }],
        persona: 'Today I want to be the friend who actually listens.',
        loadout: ['dance', 'gossip', 'deep_conversation'],
      },
      // The director names an off-loadout key anyway — belt-and-braces must drop it
      optionsJson: JSON.stringify({
        options: [
          { action: 'watch_tv', target_object_id: '901', label: 'Zone out' },
          { action: 'grab_snack', target_object_id: '900', label: 'Raid the fridge' },
        ],
      }),
    });
    const report = idleSimReport(1);
    report.lot!.clock!.absolute_day = 12;
    report.sims![0].objects.push({
      object_id: '901',
      action_keys: ['watch_tv'],
      name: 'object_tv',
      tier: 'same_room',
      distance: 3,
    });
    cache.ingest(report);
    await settle();

    const monologuePrompt = prompts[0];
    // The plan block renders persona + goals; the loadout itself is never named
    expect(monologuePrompt).toContain('<TODAYS_PLAN>');
    expect(monologuePrompt).toContain('friend who actually listens');
    expect(monologuePrompt).toContain("Today's goals: Chat with 3 sims.");
    expect(monologuePrompt).not.toContain('loadout');
    // watch_tv is off-loadout: gone from the offered vocabulary AND not listed as
    // impossible (absent means absent)
    expect(monologuePrompt).not.toContain('watch tv');
    // Off-loadout socials vanish from the social line; prepped ones and chat stay
    expect(monologuePrompt).toContain('gossip');
    expect(monologuePrompt).not.toContain('tell joke');
    // Always-available keys survive any loadout
    expect(monologuePrompt).toContain('grab snack');

    // The watch_tv option died in validation; the always-available snack dispatched
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].action).toBe('grab_snack');
  });

  it('fires the lazy planner once when a household sim has no plan for today', async () => {
    const { cache, dispatched, lazyPlanCalls, prompts } = buildCtx({ needsLazyPlan: true });
    const report = idleSimReport(1);
    report.lot!.clock!.absolute_day = 12;
    cache.ingest(report);
    await settle();

    expect(lazyPlanCalls).toHaveLength(1);
    // The planless tick proceeds unfiltered — no TODAYS_PLAN block, dispatch as normal
    expect(prompts[0]).not.toContain('<TODAYS_PLAN>');
    expect(dispatched).toHaveLength(1);
  });

  it('an old mod (no absolute_day) leaves the plan machinery inert', async () => {
    const { cache, dispatched, lazyPlanCalls, prompts } = buildCtx({
      plan: { goals: [{ label: 'ghost goal' }], persona: 'ghost', loadout: ['dance', 'gossip', 'flirt'] },
      needsLazyPlan: true,
    });
    cache.ingest(idleSimReport(1)); // default clock has no absolute_day
    await settle();

    expect(lazyPlanCalls).toHaveLength(0);
    expect(prompts[0]).not.toContain('<TODAYS_PLAN>');
    expect(dispatched).toHaveLength(1);
  });

  it('an infant with nothing offered never deliberates (J8)', async () => {
    // Jaz's 09-04 handoff, cause 8: five paid round trips per infant tick, ending in
    // "no valid options". The mod's age gate blocks every verb for an infant; with an
    // empty vocabulary the tick is skipped before the monologue.
    const { cache, oneShotCalls, dispatched } = buildCtx();
    const socials = [
      'chat',
      'ask_about_day',
      'ask_about_career',
      'get_to_know',
      'deep_conversation',
      'compliment_outfit',
      'tell_joke',
      'tell_funny_story',
      'gossip',
      'hug',
      'flirt',
      'kiss',
      'insult',
      'apologize',
    ];
    cache.ingest(
      idleSimReport(1, {
        sims: [
          {
            sim_id: '100',
            sim_name: 'Ehren',
            location: { zone_id: 1 },
            sims: [{ sim_id: '200', tier: 'same_room', name: 'Adrian', distance: 3, age: 'ADULT' }],
            objects: [],
            self: { mood: 'Fine', needs: { hunger: 50 }, age: 'INFANT', age_blocked: socials },
            activity: { queue: [], running: null, in_social: false },
          },
        ],
      }),
    );
    await settle();
    expect(oneShotCalls).toEqual([]);
    expect(dispatched).toHaveLength(0);

    // A toddler who can still 'dance' thinks as before
    cache.ingest(
      idleSimReport(2, {
        sims: [
          {
            sim_id: '101',
            sim_name: 'Tot',
            location: { zone_id: 1 },
            sims: [],
            objects: [
              { object_id: '901', action_keys: ['dance'], name: 'object_stereo', tier: 'same_room', distance: 2 },
            ],
            self: { mood: 'Fine', needs: { hunger: 50 }, age: 'TODDLER', age_blocked: socials },
            activity: { queue: [], running: null, in_social: false },
          },
        ],
      }),
    );
    await settle();
    expect(oneShotCalls[0]).toMatch(/^Cognition Monologue/);
  });
});

// 2026-09-21: a sleeping sim thought "just want to keep sleeping" four times in five
// minutes. The gate compared the running interaction to the word 'sleep'; the mod sends
// the tuning name (`sleep_Passive`), so it never matched, and low energy kept the sim
// eligible all night.
describe('a sleeping sim does not tick', () => {
  const asleepInBed = {
    sim_id: '100',
    sim_name: 'Ehren',
    location: { zone_id: 1 },
    sims: [],
    objects: [
      { object_id: '900', action_keys: ['grab_snack'], name: 'object_fridge', tier: 'same_room' as const, distance: 4 },
    ],
  };

  it('never deliberates on the running interaction name the mod actually sends', async () => {
    const { cache, cognition, oneShotCalls } = buildCtx();
    cache.ingest(
      idleSimReport(1, {
        sims: [
          {
            ...asleepInBed,
            self: { mood: 'Fine', needs: { energy: -60 }, age: 'ADULT' },
            activity: { queue: ['sleep_Passive'], running: 'sleep_Passive', in_social: false, running_action_key: 'sleep' },
          },
        ],
      }),
    );
    await settle();
    expect(oneShotCalls).toEqual([]);
    expect(cognition.getStats().deliberations).toBe(0);
  });

  it("trusts the game's own sleeping flag even with no interaction reported", async () => {
    const { cache, oneShotCalls } = buildCtx();
    cache.ingest(
      idleSimReport(1, {
        sims: [
          {
            ...asleepInBed,
            self: { mood: 'Fine', needs: { energy: -60 }, age: 'ADULT', asleep: true },
            activity: { queue: [], running: null, in_social: false },
          },
        ],
      }),
    );
    await settle();
    expect(oneShotCalls).toEqual([]);
  });

  it('still lets a tired sim who is awake think about it', async () => {
    const { cache, oneShotCalls } = buildCtx();
    cache.ingest(
      idleSimReport(1, {
        sims: [
          {
            ...asleepInBed,
            self: { mood: 'Fine', needs: { energy: -60 }, age: 'ADULT' },
            activity: { queue: ['seating_Sit'], running: 'seating_Sit', in_social: false, running_action_key: 'sit' },
          },
        ],
      }),
    );
    await settle();
    expect(oneShotCalls[0]).toMatch(/^Cognition Monologue/);
  });
});
