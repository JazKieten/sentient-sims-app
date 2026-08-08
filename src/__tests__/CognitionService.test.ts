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

  const ctx = {
    settings: {
      cognitionEnabled: true,
      cognitionAutonomyLevel: options.autonomyLevel ?? 'full',
      cognitionTickIntervalSeconds: options.tickIntervalSeconds ?? 0,
      cognitionMaxConcurrent: 1,
      cognitionPerSimHourlyBudget: options.hourlyBudget ?? 100,
      cognitionActionScoreThreshold: options.actionScoreThreshold ?? 7,
      memoryRetrievalEnabled: false,
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
  // A deliberation is now a chain of up to five sequential mocked calls, each several
  // microtask hops deep — generous turns settle it without real timers
  for (let i = 0; i < 64; i += 1) {
    // eslint-disable-next-line no-await-in-loop
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
      scoresJson: '{"memory": 2, "action": 2, "action_reason": "Happy as is."}',
    });
    cache.ingest(idleSimReport(1));
    await settle();

    expect(oneShotCalls.map((label) => label.split(':')[0])).toEqual(['Cognition Monologue', 'Cognition Scores']);
    expect(dispatched).toHaveLength(0);
    expect(cognition.getStats().continues).toBe(1);
    // The thought is still the sim's inner life — stored regardless of the score
    expect(storedMemories).toHaveLength(1);
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
    stranger.sims![0].sims = [{ sim_id: '200', tier: 'same_room', name: 'Stranger', distance: 2, social: { has_met: false } }];
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
        // The SocialContext bit is transient conversation tone — it must not render
        social: { has_met: true, friendship: 62, romance: 18, bits: ['relbit_SocialContext_Awkwardness_Casual'] },
      },
      { sim_id: '300', tier: 'same_room', name: 'Kira', distance: 4, social: { has_met: false } },
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
      optionsJson: JSON.stringify({ options: [{ action: 'brush_teeth', target_object_id: '901', label: 'Freshen up' }] }),
    });
    const report = idleSimReport(1);
    report.sims[0].objects!.push({ object_id: '901', action_keys: ['brush_teeth'], name: 'object_sink', tier: 'same_room', distance: 2 });
    cache.ingest(report);
    await settle();
    expect(dispatched).toHaveLength(1);

    cognition.onOutcome({ sim_id: '100', outcome: 'success', request_id: 'req-1', action: 'brush_teeth' });

    const second = idleSimReport(2);
    second.sims[0].objects!.push({ object_id: '901', action_keys: ['brush_teeth'], name: 'object_sink', tier: 'same_room', distance: 2 });
    cache.ingest(second);
    await settle();
    expect(dispatched).toHaveLength(1);
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
    report.sims![0].objects![0].action_keys = ['grab_snack', 'cook_meal'];
    cache.ingest(report);
    await settle();
    expect(dispatched).toHaveLength(1);
    cognition.onOutcome({ sim_id: '100', outcome: 'success', request_id: 'req-1', action: 'cook_meal' });

    currentOptions = JSON.stringify({ options: [{ action: 'grab_snack', label: 'A snack' }] });
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
    const { cache, dispatched, oneShotCalls } = buildCtx();
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

  it('a high action score interrupts a busy sim (the score IS the justification)', async () => {
    const { cache, dispatched } = buildCtx({
      optionsJson: JSON.stringify({ options: [{ action: 'take_shower', label: 'Rinse off' }] }),
    });
    const report = idleSimReport(1);
    report.sims![0].objects![0].action_keys = ['take_shower'];
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
});
