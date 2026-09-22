import { describe, expect, it } from 'vitest';
import { CognitionService } from 'main/sentient-sims/services/CognitionService';
import { SimStateCache } from 'main/sentient-sims/services/SimStateCache';
import { ApiContext } from 'main/sentient-sims/services/ApiContext';
import { SimStateReport } from 'main/sentient-sims/models/SimStateReport';
import { ActionIntent } from 'main/sentient-sims/models/ActionIntent';

// 2026-09-21: a reply to the player whose action score crosses the threshold acts NOW
// (CognitionService.actOnConversation) over the sim's full vocabulary, dispatched as
// 'conversation', instead of arming a desire for the next tick.

const OPTIONS = JSON.stringify({
  scene: 'Zoe came up and it stuck.',
  options: [
    { action: 'chat', target_sim_id: '200', label: 'Go talk to Zoe' },
    { action: 'grab_snack', target_object_id: '900', label: 'Raid the fridge' },
  ],
});
const PICK_FIRST = '{"choice": 1, "motivation": "Zoe is right there"}';

type CtxOptions = {
  threshold?: number;
  enabled?: boolean;
  autonomyLevel?: 'off' | 'suggest' | 'full';
};

function buildCtx(options: CtxOptions = {}) {
  const cache = new SimStateCache();
  const dispatched: ActionIntent[] = [];
  const oneShotCalls: string[] = [];
  const prompts: string[] = [];
  const ctx = {
    settings: {
      // The tick loop stays off: only actOnConversation deliberates here
      cognitionEnabled: false,
      cognitionAutonomyLevel: options.autonomyLevel ?? 'full',
      cognitionTickIntervalSeconds: 0,
      cognitionMaxConcurrent: 1,
      cognitionPerSimHourlyBudget: 100,
      cognitionActionScoreThreshold: options.threshold ?? 6,
      conversationActionsEnabled: options.enabled ?? true,
    },
    simStateCache: cache,
    db: { isLoaded: () => true },
    generationQueue: { runCognition: <T>(task: () => Promise<T>) => task() },
    ai: {
      runOneShot: (label: string, _system: string, userPrompt: string) => {
        oneShotCalls.push(label);
        prompts.push(userPrompt);
        let text = 'keep';
        if (label.startsWith('Action Options')) {
          text = OPTIONS;
        } else if (label.startsWith('Action Choice')) {
          text = PICK_FIRST;
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
    },
    memoryRepository: { createMemory: () => ({ id: 1 }) },
    memoryRetrieval: { retrieve: () => Promise.resolve([]) },
    semanticMemory: { recall: () => '' },
    dailyPlan: {
      activePlan: () => undefined,
      needsLazyPlan: () => false,
      generateLazy: () => Promise.resolve(),
    },
  } as unknown as ApiContext;
  const cognition = new CognitionService(ctx);
  return { ctx, cache, cognition, dispatched, oneShotCalls, prompts };
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

const desire = {
  score: 8,
  reason: 'I want to actually ask Zoe out',
  thought: 'Zoe. Say it and mean it.',
  speaker: 'Conscience',
  transcript: 'Conscience: Who do you want to go on a date with?\nJonah Alder: Zoe. She listens.',
};

describe('acting on a conversation', () => {
  it('stages the action scene now and dispatches as the player talking', async () => {
    const { cache, cognition, dispatched, oneShotCalls, prompts } = buildCtx();
    cache.ingest(report());

    const result = await cognition.actOnConversation('100', desire);

    expect(oneShotCalls.map((label) => label.split(':')[0])).toEqual([
      'Action Options',
      'Action Choice',
      'Action Review',
    ]);
    expect(prompts[0]).toContain('What was just said to you, in conversation with Conscience:');
    expect(prompts[0]).toContain('Jonah Alder: Zoe. She listens.');
    expect(result.acted).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      sim_id: '100',
      action: 'chat',
      target_sim_id: '200',
      source: 'conversation',
      priority: 'high',
      preempt: true,
      motivation: 'After talking with Conscience: I want to actually ask Zoe out',
    });
  });

  it('does nothing below the threshold', async () => {
    const { cache, cognition, dispatched, oneShotCalls } = buildCtx({ threshold: 6 });
    cache.ingest(report());
    const result = await cognition.actOnConversation('100', { ...desire, score: 4 });
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
