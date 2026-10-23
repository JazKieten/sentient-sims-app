import { describe, expect, it, vi } from 'vitest';
import { CognitionService } from 'main/sentient-sims/services/CognitionService';
import { autonomyOf, type AutonomyServices } from 'main/sentient-sims/tiers/autonomy';
import { SimStateCache } from 'main/sentient-sims/services/SimStateCache';
import { ApiContext } from 'main/sentient-sims/services/ApiContext';
import { SimStateEntry, SimStateReport } from 'main/sentient-sims/models/SimStateReport';
import { ActionIntent } from 'main/sentient-sims/models/ActionIntent';
import { deniedConversationActions } from 'main/sentient-sims/util/conversationActions';
import { mockApiContext } from './util';

// 2026-09-21: a reply to the player whose action score crosses the threshold acts
// (CognitionService.actOnConversation), dispatched as 'conversation', instead of arming a
// desire for the next tick.
// 2026-09-22: tamed after the stream. The action waits for the reply's scene to close, the
// vocabulary loses idle/self-care verbs the conversation never mentioned, the dispatch
// carries no priority/preempt, and the bar is its own (conversationActionScoreThreshold).

const OPTIONS = JSON.stringify({
  scene: 'Zoe came up and it stuck.',
  options: [
    { action: 'chat', target_sim_id: '200', label: 'Go talk to Zoe' },
    { action: 'grab_snack', target_object_id: '900', label: 'Raid the fridge' },
  ],
});
const PICK_FIRST = '{"choice": 1, "motivation": "Zoe is right there"}';
const PICK_SECOND = '{"choice": 2, "motivation": "Suddenly peckish"}';

type CtxOptions = {
  threshold?: number;
  conversationThreshold?: number;
  enabled?: boolean;
  autonomyLevel?: 'off' | 'suggest' | 'full';
  pick?: string;
  // Autonomy parts 1 and 4 (2026-10-21)
  fromViewers?: boolean;
  hourlyBudget?: number;
  moment?: { ok: boolean; result?: Record<string, unknown>; error?: string };
};

function buildCtx(options: CtxOptions = {}) {
  const cache = new SimStateCache();
  const dispatched: ActionIntent[] = [];
  const oneShotCalls: string[] = [];
  const prompts: string[] = [];
  const queries: { kind: string; args: Record<string, unknown> }[] = [];
  const ctx = {
    settings: {
      // The tick loop stays off: only actOnConversation deliberates here
      cognitionEnabled: false,
      cognitionAutonomyLevel: options.autonomyLevel ?? 'full',
      cognitionTickIntervalSeconds: 0,
      cognitionMaxConcurrent: 1,
      cognitionPerSimHourlyBudget: options.hourlyBudget ?? 100,
      cognitionActionScoreThreshold: options.threshold ?? 6,
      conversationActionScoreThreshold: options.conversationThreshold ?? 8,
      conversationActionsEnabled: options.enabled ?? true,
      conversationActionsFromViewers: options.fromViewers ?? false,
      cognitionGateEnabled: true,
      cognitionVocabulary: 'whitelist',
      // The review stage these cases count runs with the legacy tick only (part 7)
      cognitionLegacyTick: true,
    },
    simStateCache: cache,
    db: { isLoaded: () => true },
    ext: {},
    generationQueue: { runCognition: <T>(task: () => Promise<T>) => task() },
    ai: {
      runOneShot: (label: string, _system: string, userPrompt: string) => {
        oneShotCalls.push(label);
        prompts.push(userPrompt);
        let text = 'keep';
        if (label.startsWith('Action Options')) {
          text = OPTIONS;
        } else if (label.startsWith('Action Choice')) {
          text = options.pick ?? PICK_FIRST;
        }
        return Promise.resolve({ text, exchange: {} });
      },
    },
    actionDispatcher: {
      dispatch: (intent: ActionIntent) => {
        dispatched.push(intent);
        return `req-${dispatched.length}`;
      },
      release: () => undefined,
      getInFlight: () => undefined,
    },
    memoryRepository: { createMemory: () => ({ id: 1 }) },
    memoryRetrieval: { retrieve: () => Promise.resolve([]) },
    semanticMemory: { recall: () => '' },
    dailyPlan: {
      activePlan: () => undefined,
      needsLazyPlan: () => false,
      generateLazy: () => Promise.resolve(),
    },
    ...(options.moment
      ? {
          modQuery: {
            query: (kind: string, args: Record<string, unknown>) => {
              queries.push({ kind, args });
              return Promise.resolve(options.moment);
            },
            onHoldReleased: () => undefined,
          },
        }
      : {}),
  } as unknown as ApiContext;
  // The stub carries the autonomy siblings (actionDispatcher, dailyPlan) itself
  const cognition = new CognitionService(ctx, ctx as unknown as AutonomyServices);
  return { ctx, cache, cognition, dispatched, oneShotCalls, prompts, queries };
}

function report(): SimStateReport {
  return {
    type: 'state_report',
    seq: 1,
    lot: { zone_id: 1, clock: { hour: 10, paused: false } },
    sims: [
      {
        sim_id: '100',
        sim_name: 'Jonah Alder',
        location: { zone_id: 1 },
        sims: [{ sim_id: '200', tier: 'same_room', name: 'Zoe', distance: 3, age: 'ADULT', social: { has_met: true } }],
        objects: [
          { object_id: '900', action_keys: ['grab_snack'], name: 'object_fridge', tier: 'same_room', distance: 4 },
        ],
        self: { mood: 'Fine', needs: { hunger: 50 }, age: 'ADULT' },
        activity: { queue: [], running: null, in_social: false },
      },
    ],
  };
}

// The standard report with its one Sim changed in place
function reportWith(mutate: (entry: SimStateEntry) => void): SimStateReport {
  const built = report();
  const [entry] = built.sims ?? [];
  mutate(entry);
  return built;
}

const desire = {
  score: 8,
  reason: 'I want to actually ask Zoe out',
  thought: 'Zoe. Say it and mean it.',
  speaker: 'Conscience',
  transcript: 'Conscience: Who do you want to go on a date with?\nJonah Alder: Zoe. She listens.',
};

// A promise that has not settled yet stays 'pending' after a macrotask turn
async function settled<T>(promise: Promise<T>): Promise<'pending' | T> {
  return Promise.race([
    promise,
    new Promise<'pending'>((resolve) =>
      setTimeout(() => {
        resolve('pending');
      }, 0),
    ),
  ]);
}

describe('acting on a conversation', () => {
  it('stages the action scene and dispatches as an ordinary, non-preempting push', async () => {
    const { cache, cognition, dispatched, oneShotCalls, prompts } = buildCtx();
    cache.ingest(report());

    const result = await cognition.actOnConversation('100', desire);

    // The transcript never mentioned food, so grab_snack is off the menu: one valid option
    // is left and the choice stage is skipped (the sim takes it, review still runs)
    expect(oneShotCalls.map((label) => label.split(':')[0])).toEqual(['Action Options', 'Action Review']);
    expect(prompts[0]).toContain('What was just said to you, in conversation with Conscience:');
    expect(prompts[0]).toContain('Jonah Alder: Zoe. She listens.');
    expect(result.acted).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      sim_id: '100',
      action: 'chat',
      target_sim_id: '200',
      source: 'conversation',
      motivation: 'After talking with Conscience: I want to actually ask Zoe out',
    });
    // 09-22: the high-priority preempt cancelled the voiced reply and the player's clicks
    expect(dispatched[0].priority).toBeUndefined();
    expect(dispatched[0].preempt).toBeUndefined();
  });

  it('has its own bar, above the tick threshold', async () => {
    const { cache, cognition, dispatched, oneShotCalls } = buildCtx({ threshold: 6, conversationThreshold: 8 });
    cache.ingest(report());
    const result = await cognition.actOnConversation('100', { ...desire, score: 7 });
    expect(result.acted).toBe(false);
    expect(oneShotCalls).toEqual([]);
    expect(dispatched).toEqual([]);
  });

  it('with the feature off, arms the desire for the next tick instead', async () => {
    const { cache, cognition, dispatched, oneShotCalls } = buildCtx({ enabled: false });
    cache.ingest(report());
    const result = await cognition.actOnConversation('100', desire);
    expect(result.acted).toBe(false);
    expect(oneShotCalls).toEqual([]);
    expect(dispatched).toEqual([]);
    // The armed desire is what makes the next tick eligible for an on-lot sim
    expect(cognition.getStats().deliberations).toBe(0);
  });

  it('chooses but never dispatches for a bench replay', async () => {
    const { cache, cognition, dispatched } = buildCtx();
    cache.ingest(report());
    const result = await cognition.actOnConversation('100', { ...desire, suggestOnly: true });
    expect(result.acted).toBe(false);
    expect(result.intent?.action).toBe('chat');
    expect(dispatched).toEqual([]);
  });

  it('stands down for a sim the mod has not reported', async () => {
    const { cognition, dispatched, oneShotCalls } = buildCtx();
    const result = await cognition.actOnConversation('999', desire);
    expect(result.acted).toBe(false);
    expect(oneShotCalls).toEqual([]);
    expect(dispatched).toEqual([]);
  });
});

describe('waiting for the reply to finish airing', () => {
  it('holds the action until the scene closes, then acts', async () => {
    const { cache, cognition, dispatched, oneShotCalls } = buildCtx();
    cache.ingest(report());

    const pending = cognition.actOnConversation('100', { ...desire, sceneId: 'scene-1' });
    expect(await settled(pending)).toBe('pending');
    expect(oneShotCalls).toEqual([]);
    expect(dispatched).toEqual([]);

    // Some other scene closing is not this one
    cognition.releaseConversationActions('scene-other');
    expect(await settled(pending)).toBe('pending');

    cognition.releaseConversationActions('scene-1');
    const result = await pending;
    expect(result.acted).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ action: 'chat', source: 'conversation' });
  });

  it('a later line replaces the held action', async () => {
    const { cache, cognition, dispatched } = buildCtx();
    cache.ingest(report());

    const first = cognition.actOnConversation('100', { ...desire, sceneId: 'scene-1' });
    const second = cognition.actOnConversation('100', { ...desire, reason: 'Go and find Zoe', sceneId: 'scene-2' });
    expect(await first).toEqual({ acted: false, deferred: true });

    cognition.releaseConversationActions('scene-1');
    expect(await settled(second)).toBe('pending');
    expect(dispatched).toEqual([]);

    cognition.releaseConversationActions('scene-2');
    expect((await second).acted).toBe(true);
    expect(dispatched[0].motivation).toBe('After talking with Conscience: Go and find Zoe');
  });

  it('a bench replay never waits', async () => {
    const { cache, cognition } = buildCtx();
    cache.ingest(report());
    const result = await cognition.actOnConversation('100', { ...desire, sceneId: 'scene-1', suggestOnly: true });
    expect(result.intent?.action).toBe('chat');
  });

  it('is released by the scene registry closing the scene', () => {
    const ctx = mockApiContext();
    const release = vi.spyOn(autonomyOf(ctx).cognitionService, 'releaseConversationActions');

    ctx.scenePlayback.roundQueued('scene-9', ['100'], 1, [{ speaker: 'Jonah Alder', text: 'Zoe. She listens.' }]);
    ctx.scenePlayback.playbackEnded('scene-9', true);

    expect(release).toHaveBeenCalledWith('scene-9');
  });
});

describe('what a conversation may turn into', () => {
  it('keeps idle and self-care verbs off the menu unless they came up', () => {
    const denied = deniedConversationActions('Conscience: How was your day?\nJonah Alder: Long. Fine, though.');
    expect(denied.has('practice_speech')).toBe(true);
    expect(denied.has('use_toilet')).toBe(true);
    expect(denied.has('sit')).toBe(true);
    expect(denied.has('grab_snack')).toBe(true);
    // Never on the list: socials and the like are what a conversation leads to
    expect(denied.has('chat')).toBe(false);
    expect(denied.has('deep_conversation')).toBe(false);

    const asked = deniedConversationActions('Conscience: Go take a shower and then sit down for a bit.');
    expect(asked.has('take_shower')).toBe(false);
    expect(asked.has('sit')).toBe(false);
    expect(asked.has('practice_speech')).toBe(true);
    // Word match, not substring: "babysitting" is not "sit"
    expect(deniedConversationActions('babysitting all day').has('sit')).toBe(true);
  });

  it('does not offer the fridge for a line that never mentioned food', async () => {
    const { cache, cognition, dispatched, prompts } = buildCtx({ pick: PICK_SECOND });
    cache.ingest(report());

    // The director still names grab_snack (OPTIONS); it dies in validation, so the only
    // option left is the chat, and a pick of "2" never reaches a choice stage
    const result = await cognition.actOnConversation('100', desire);

    // The prompt prints action keys with spaces
    expect(prompts[0]).not.toContain('grab snack');
    expect(result.acted).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ action: 'chat', target_sim_id: '200' });
  });

  it('offers it when the player brought it up', async () => {
    const { cache, cognition, dispatched, prompts } = buildCtx({ pick: PICK_SECOND });
    cache.ingest(report());

    const result = await cognition.actOnConversation('100', {
      ...desire,
      transcript: 'Conscience: You should eat something.\nJonah Alder: Yeah. I could raid the fridge.',
    });

    expect(prompts[0]).toContain('grab snack');
    expect(result.acted).toBe(true);
    expect(dispatched[0]).toMatchObject({ action: 'grab_snack', target_object_id: '900' });
  });
});

// Autonomy parts 1 and 4 (2026-10-21): a viewer is not in the world, the conversation lane
// takes the tick's own gates and the hourly budget, and it asks the mod's moment first.
describe('acting on a conversation: viewers and the gate', () => {
  const viewerDesire = { ...desire, speaker: 'Chat (WoolyWolfee)', speakerKind: 'viewer' as const };

  it("a viewer's line never acts or arms with the setting off", async () => {
    const { cache, cognition, dispatched, oneShotCalls } = buildCtx();
    cache.ingest(report());
    const result = await cognition.actOnConversation('100', viewerDesire);
    expect(result.acted).toBe(false);
    expect(oneShotCalls).toEqual([]);
    expect(dispatched).toEqual([]);
    expect(cognition.getPhase('100')).toBe('IDLE');
    // Not armed either: the next tick must not act on it quietly
    cache.ingest({ ...report(), seq: 2 });
    expect(cognition.getStats().deliberations).toBe(0);
  });

  it('with the setting on, the prompt says the speaker is a viewer', async () => {
    const { cache, cognition, prompts } = buildCtx({ fromViewers: true });
    cache.ingest(report());
    const result = await cognition.actOnConversation('100', viewerDesire);
    expect(result.acted).toBe(true);
    expect(prompts[0]).toContain(
      'Chat (WoolyWolfee) is a viewer watching from outside the world: you cannot talk to, leave or confront them in the world.',
    );
  });

  it('asleep or mid-conversation arms the desire instead of staging', async () => {
    for (const activity of [
      { queue: [], running: 'bed_sleep', in_social: false },
      { queue: [], running: 'sim_Chat', in_social: true },
    ]) {
      const { cache, cognition, oneShotCalls } = buildCtx();
      cache.ingest(
        reportWith((entry) => {
          entry.activity = activity;
          if (activity.running === 'bed_sleep') {
            entry.self = { ...entry.self, asleep: true };
          }
        }),
      );
      const result = await cognition.actOnConversation('100', desire);
      expect(result.acted).toBe(false);
      expect(oneShotCalls).toEqual([]);
    }
  });

  it('the hourly budget counts conversation actions', async () => {
    const { cache, cognition, dispatched, oneShotCalls } = buildCtx({ hourlyBudget: 1 });
    cache.ingest(report());
    expect((await cognition.actOnConversation('100', desire)).acted).toBe(true);
    cognition.onOutcome({ sim_id: '100', outcome: 'success', request_id: 'req-1', action: 'chat' });
    const callsAfterFirst = oneShotCalls.length;
    const second = await cognition.actOnConversation('100', desire);
    expect(second.acted).toBe(false);
    expect(oneShotCalls).toHaveLength(callsAfterFirst);
    expect(dispatched).toHaveLength(1);
  });

  it('too tired to go out keeps go_out off the conversation menu', async () => {
    const { cache, cognition, prompts } = buildCtx();
    const tired = reportWith((entry) => {
      entry.self = { mood: 'Fine', needs: { hunger: 50, energy: -50 }, age: 'ADULT' };
    });
    tired.lot = { ...tired.lot, action_keys: ['go_out'] };
    tired.venues = [{ zone_id: '77', name: 'Rattlesnake Juice', venue: 'bar', same_world: true }];
    cache.ingest(tired);
    await cognition.actOnConversation('100', {
      ...desire,
      transcript: `${desire.transcript}\nConscience: go out and find her`,
    });
    expect(prompts[0]).not.toContain('OFFERED household actions');
    expect(prompts[0]).toContain('NOT possible right now, do not choose: go out.');
  });

  it("asks the mod's moment on the 'conversation' lane and stands down when it is closed", async () => {
    const { cache, cognition, dispatched, oneShotCalls, queries } = buildCtx({
      moment: { ok: true, result: { ok: false, key: 'head_busy', why: 'Jonah is busy with mentor Cooking' } },
    });
    cache.ingest(report());
    const result = await cognition.actOnConversation('100', { ...desire, targetSimId: '200' });
    expect(result.acted).toBe(false);
    expect(oneShotCalls).toEqual([]);
    expect(dispatched).toEqual([]);
    expect(queries[0]).toEqual({ kind: 'moment', args: { sim_id: '100', lane: 'conversation', target_sim_id: '200' } });
    expect(cognition.getPhase('100')).toBe('COOLDOWN');
  });
});
