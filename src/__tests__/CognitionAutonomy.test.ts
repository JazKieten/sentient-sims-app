import { afterEach, describe, expect, it, vi } from 'vitest';
import { CognitionService } from 'main/sentient-sims/services/CognitionService';
import type { AutonomyServices } from 'main/sentient-sims/tiers/autonomy';
import { SimStateCache } from 'main/sentient-sims/services/SimStateCache';
import { ApiContext } from 'main/sentient-sims/services/ApiContext';
import { SimStateEntry, SimStateReport } from 'main/sentient-sims/models/SimStateReport';
import { ActionIntent, VocabularyRow } from 'main/sentient-sims/models/ActionIntent';
import type { ModQueryResult } from 'main/sentient-sims/services/ModQueryService';
import { IntentionService } from 'main/sentient-sims/services/intentions/IntentionService';
import type { IntentionRow } from 'main/sentient-sims/models/IntentionRow';
import { NightCallService } from 'main/sentient-sims/services/intentions/NightCallService';
import { BILLS_SAY } from 'main/sentient-sims/services/intentions/IntentionSeeds';
import type { PlumTurnOptions } from 'main/sentient-sims/services/PlumService';

// Autonomy parts 1-4 (2026-10-21): every lane asks the mod's moment predicate before a model
// call (the gate), the options stage offers the mod's pie-menu rows and the choice goes back
// as a click (the vocabulary), the prompt sees money, work, venue, the household and the
// director, and the 10-19 review's smallest fixes.

type Answer = ModQueryResult<unknown> | ((args: Record<string, unknown>) => ModQueryResult<unknown>);

type CtxOptions = {
  gateEnabled?: boolean;
  vocabulary?: 'pie' | 'whitelist';
  moment?: Answer;
  vocabularyAnswer?: Answer;
  optionsJson?: string;
  choiceJson?: string;
  scoresJson?: string;
  plan?: { goals: { label: string }[]; persona?: string; loadout?: string[] };
  inFlight?: Record<string, ActionIntent>;
  wake?: { simId?: string; simName?: string; doing?: string; note?: string }[];
  arc?: string;
  tickIntervalSeconds?: number;
  maxConcurrent?: number;
  // Part 5: the row lane on, with a REAL IntentionService over a Map repository
  rows?: boolean;
  // Part 7: the legacy per-tick deliberation (default on here so chat 1-2's cases hold)
  legacyTick?: boolean;
  voiceWhy?: boolean;
};

type VoicedCall = {
  lines: { speaker: string; text: string; simId?: string }[];
  options?: { paced?: boolean; pacedText?: string };
};

const HIGH_SCORES = '{"memory": 4, "action": 9, "action_reason": "I want a snack."}';
const SNACK_OPTIONS = JSON.stringify({
  scene: 'You are peckish.',
  options: [{ action: 'grab_snack', target_object_id: '900', label: 'Raid the fridge' }],
});
const PICK_FIRST = '{"choice": 1, "motivation": "grabbing a bite"}';

const ASK_ROW: VocabularyRow = {
  id: 'r12',
  target: 'Adrian Calloway',
  target_id: '200',
  target_kind: 'sim',
  category: 'Friendly > Small Talk',
  label: 'Ask about Day',
  key: 'mixer_social_AskAboutDay',
};
const STEREO_ROW: VocabularyRow = {
  id: 'r20',
  target: 'object_stereo',
  target_id: '950',
  target_kind: 'object',
  category: 'Stereo',
  label: 'Listen to Music <choice>',
  key: 'stereo_Listen',
  options: ['Pop', 'Jazz'],
};

function answer(value: Answer | undefined, fallback: ModQueryResult<unknown>, args: Record<string, unknown>) {
  if (value === undefined) {
    return fallback;
  }
  return typeof value === 'function' ? value(args) : value;
}

function buildCtx(options: CtxOptions = {}) {
  const cache = new SimStateCache();
  const dispatched: ActionIntent[] = [];
  const oneShotCalls: string[] = [];
  const prompts: string[] = [];
  const queries: { kind: string; args: Record<string, unknown> }[] = [];
  const holdListeners: ((event: { sim_id: string; interaction_id: string }) => void)[] = [];
  const voiced: VoicedCall[] = [];
  const memories: { memory: { content?: string; event_type?: string; action?: string } }[] = [];
  const turns: { text: string; options: PlumTurnOptions }[] = [];
  const ctx = {
    settings: {
      cognitionLegacyTick: options.legacyTick ?? true,
      intentionVoiceWhy: options.voiceWhy ?? true,
      intentionNightCallEnabled: true,
      nonControllableSimsSpeak: true,
      plumEnabled: true,
      cognitionEnabled: true,
      cognitionAutonomyLevel: 'full',
      cognitionTickIntervalSeconds: options.tickIntervalSeconds ?? 0,
      cognitionMaxConcurrent: options.maxConcurrent ?? 1,
      cognitionPerSimHourlyBudget: 100,
      cognitionActionScoreThreshold: 7,
      cognitionGateEnabled: options.gateEnabled ?? true,
      cognitionVocabulary: options.vocabulary ?? 'whitelist',
      // Off by default so the parts 1-4 cases keep the legacy paths (collision 12)
      intentionRowsEnabled: options.rows ?? false,
      intentionBeatMinutes: 120,
      intentionNeedFloor: -60,
      conversationActionsFromViewers: false,
      conversationActionsEnabled: true,
      conversationActionScoreThreshold: 8,
      stagePromptOverrides: {},
    },
    simStateCache: cache,
    db: { isLoaded: () => true },
    ext: options.arc ? { director: { status: () => ({ active: true, arc: options.arc }) } } : {},
    plum: {
      wake: {
        list: () =>
          (options.wake ?? []).map((trigger, index) => ({
            id: `w${index}`,
            kind: 'sim_finishes',
            setAt: 0,
            ...trigger,
          })),
        describeScript: () => [],
      },
      isRunning: false,
      brainUnavailable: () => undefined,
      runTurn: (text: string, turnOptions: PlumTurnOptions) => {
        turns.push({ text, options: turnOptions });
        return Promise.resolve({});
      },
    },
    generationQueue: { runCognition: <T>(task: () => Promise<T>) => task() },
    ai: {
      playTtsLines: (lines: VoicedCall['lines'], _sims: unknown, playOptions: VoicedCall['options']) => {
        voiced.push({ lines, options: playOptions });
      },
      runOneShot: (label: string, _system: string, userPrompt: string) => {
        oneShotCalls.push(label);
        prompts.push(userPrompt);
        let text = 'keep';
        if (label.startsWith('Cognition Monologue')) {
          text = 'Just taking stock of the day.';
        } else if (label.startsWith('Cognition Scores')) {
          text = options.scoresJson ?? HIGH_SCORES;
        } else if (label.startsWith('Action Options')) {
          text = options.optionsJson ?? SNACK_OPTIONS;
        } else if (label.startsWith('Action Choice')) {
          text = options.choiceJson ?? PICK_FIRST;
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
      getInFlight: (simId: string) => (options.inFlight?.[simId] ? { intent: options.inFlight[simId] } : undefined),
    },
    modQuery: {
      query: (kind: string, args: Record<string, unknown>) => {
        queries.push({ kind, args });
        if (kind === 'moment') {
          return Promise.resolve(answer(options.moment, { ok: true, result: { ok: true } }, args));
        }
        return Promise.resolve(answer(options.vocabularyAnswer, { ok: true, result: { rows: [ASK_ROW] } }, args));
      },
      onHoldReleased: (listener: (event: { sim_id: string; interaction_id: string }) => void) => {
        holdListeners.push(listener);
      },
      // The rows' listener for the game's goal events (part 5); no test fires one here
      onGoalCompleted: () => undefined,
    },
    memoryRepository: {
      createMemory: (request: { memory: { content?: string; event_type?: string; action?: string } }) => {
        memories.push(request);
        return { id: memories.length };
      },
      getOwnDayMemories: () => [],
    },
    memoryRetrieval: { retrieve: () => Promise.resolve([]) },
    semanticMemory: { recall: () => '' },
    dailyPlan: {
      activePlan: () => options.plan,
      needsLazyPlan: () => false,
      generateLazy: () => Promise.resolve(),
    },
  } as unknown as ApiContext;
  const storedRows = new Map<string, IntentionRow[]>();
  (ctx as unknown as { intentions: IntentionService }).intentions = new IntentionService(ctx, {
    intentionRepository: {
      getRows: (simId: string, day: number) => storedRows.get(`${simId}|${day}`),
      saveRows: (simId: string, day: number, rows: IntentionRow[]) => {
        storedRows.set(`${simId}|${day}`, rows);
      },
    } as never,
    modQuery: (ctx as unknown as { modQuery: AutonomyServices['modQuery'] }).modQuery,
  });
  (ctx as unknown as { nightCall: NightCallService }).nightCall = new NightCallService(ctx, {
    intentions: (ctx as unknown as { intentions: IntentionService }).intentions,
  });
  const cognition = new CognitionService(ctx, ctx as unknown as AutonomyServices);
  const release = (interactionId: string) => {
    holdListeners.forEach((listener) => {
      listener({ sim_id: '100', interaction_id: interactionId });
    });
  };
  const intentions = (ctx as unknown as { intentions: IntentionService }).intentions;
  return {
    ctx,
    cache,
    cognition,
    dispatched,
    oneShotCalls,
    prompts,
    queries,
    release,
    intentions,
    voiced,
    memories,
    turns,
  };
}

function report(
  seq: number,
  entry: Partial<SimStateEntry> = {},
  lot: Partial<SimStateReport['lot']> = {},
  extra: Partial<SimStateReport> = {},
): SimStateReport {
  return {
    type: 'state_report',
    seq,
    lot: { zone_id: 1, clock: { hour: 10, paused: false }, ...lot },
    sims: [
      {
        sim_id: '100',
        sim_name: 'Elliot Calloway',
        location: { zone_id: 1 },
        sims: [
          {
            sim_id: '200',
            tier: 'same_room',
            name: 'Adrian Calloway',
            distance: 3,
            age: 'ADULT',
            social: { has_met: true },
          },
        ],
        objects: [
          { object_id: '900', action_keys: ['grab_snack'], name: 'object_fridge', tier: 'same_room', distance: 4 },
        ],
        self: { mood: 'Fine', needs: { hunger: 50 }, age: 'ADULT' },
        activity: { queue: [], running: null, in_social: false },
        ...entry,
      },
    ],
    ...extra,
  };
}

async function settle() {
  for (let i = 0; i < 160; i += 1) {
    await Promise.resolve();
  }
}

const optionsPrompt = (prompts: string[]) =>
  [...prompts].reverse().find((prompt) => prompt.includes('inner monologue:')) ?? '';

describe('the gate (part 1)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a closed moment means no model call and a cooldown; the query names the lane', async () => {
    const { cache, cognition, oneShotCalls, queries } = buildCtx({
      moment: {
        ok: true,
        result: { ok: false, key: 'mid_social', why: 'Elliot is mid-conversation with Adrian (sim_Chat)' },
      },
    });
    cache.ingest(report(1));
    await settle();
    expect(oneShotCalls).toEqual([]);
    expect(cognition.getPhase('100')).toBe('COOLDOWN');
    expect(queries[0]).toEqual({ kind: 'moment', args: { sim_id: '100', lane: 'tick' } });
  });

  it("a player's click holds the Sim across reports until the mod releases that very click", async () => {
    const { cache, cognition, oneShotCalls, queries, release } = buildCtx({
      moment: {
        ok: true,
        result: { ok: false, key: 'player_click', hold: { interaction_id: '777', name: 'phone_AskOnDate' } },
      },
      tickIntervalSeconds: 0,
    });
    cache.ingest(report(1));
    await settle();
    expect(oneShotCalls).toEqual([]);
    expect(queries).toHaveLength(1);
    // The hold is live: later reports query nothing and deliberate nothing
    cache.ingest(report(2));
    await settle();
    cache.ingest(report(3));
    await settle();
    expect(queries).toHaveLength(1);
    expect(oneShotCalls).toEqual([]);
    // Another click ending is not this one
    release('778');
    cache.ingest(report(4));
    await settle();
    expect(oneShotCalls).toEqual([]);
    // The click ends: the hold goes, the Sim is IDLE, the next report deliberates (the mod now
    // answers ok)
    release('777');
    expect(cognition.getPhase('100')).toBe('IDLE');
  });

  it('a hold the mod never releases expires after 180 s', async () => {
    let held = true;
    const { cache, oneShotCalls, queries } = buildCtx({
      moment: () =>
        held
          ? { ok: true, result: { ok: false, key: 'player_click', hold: { interaction_id: '777', name: 'sim_Chat' } } }
          : { ok: true, result: { ok: true } },
    });
    cache.ingest(report(1));
    await settle();
    expect(queries).toHaveLength(1);
    held = false;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 181_000);
    cache.ingest(report(2));
    await settle();
    expect(queries).toHaveLength(2);
    expect(oneShotCalls[0]).toContain('Cognition Monologue');
  });

  it('the critical-need rule dispatches through a closed moment (asleep) but not under a hold or a special state', async () => {
    const starving = { self: { mood: 'Fine', needs: { hunger: -90 }, age: 'ADULT' } };
    const asleep = buildCtx({
      moment: { ok: true, result: { ok: false, key: 'asleep', why: 'Elliot is asleep (bed_sleep)' } },
    });
    asleep.cache.ingest(report(1, starving));
    await settle();
    expect(asleep.dispatched.map((intent) => intent.action)).toEqual(['grab_snack']);
    expect(asleep.queries[0]).toEqual({ kind: 'moment', args: { sim_id: '100', lane: 'critical_need' } });

    const held = buildCtx({
      moment: { ok: true, result: { ok: false, key: 'player_click', hold: { interaction_id: '5', name: 'sim_Chat' } } },
    });
    held.cache.ingest(report(1, starving));
    await settle();
    expect(held.dispatched).toEqual([]);

    const reaped = buildCtx({ moment: { ok: true, result: { ok: false, key: 'reaped', special: 'reaped' } } });
    reaped.cache.ingest(report(1, starving));
    await settle();
    expect(reaped.dispatched).toEqual([]);
  });

  it('a wire failure fails open', async () => {
    const { cache, oneShotCalls } = buildCtx({ moment: { ok: false, error: 'moment query timed out after 3000ms' } });
    cache.ingest(report(1));
    await settle();
    expect(oneShotCalls[0]).toContain('Cognition Monologue');
  });

  it('with the gate off nothing is asked', async () => {
    const { cache, oneShotCalls, queries } = buildCtx({ gateEnabled: false });
    cache.ingest(report(1));
    await settle();
    expect(queries).toEqual([]);
    expect(oneShotCalls[0]).toContain('Cognition Monologue');
  });

  it("an armed desire queries the 'armed' lane with the scene's other Sim", async () => {
    const { cache, cognition, queries } = buildCtx();
    cognition.armDesireFromScene('100', { score: 9, reason: 'Adrian', targetSimId: '200' });
    cache.ingest(report(1));
    await settle();
    expect(queries[0]).toEqual({ kind: 'moment', args: { sim_id: '100', lane: 'armed', target_sim_id: '200' } });
  });
});

describe('the vocabulary (part 2)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pie mode offers rows and dispatches the chosen row as a click', async () => {
    const { cache, dispatched, prompts } = buildCtx({
      vocabulary: 'pie',
      optionsJson: JSON.stringify({
        scene: 'Adrian is right there.',
        options: [{ row: 'r12', label: 'Ask Adrian about his day' }],
      }),
    });
    cache.ingest(
      report(
        1,
        {},
        { action_keys: ['go_out'] },
        { venues: [{ zone_id: '77', name: 'Rattlesnake Juice', venue: 'bar', same_world: true }] },
      ),
    );
    await settle();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      sim_id: '100',
      action: 'mixer_social_AskAboutDay',
      target_sim_id: '200',
      pie: { target_id: '200', target_kind: 'sim', item: 'mixer_social_AskAboutDay', label: 'Ask about Day' },
    });
    const prompt = optionsPrompt(prompts);
    expect(prompt).toContain('With Adrian Calloway: r12. Ask about Day (Friendly > Small Talk)');
    expect(prompt).toContain('The household: w1. go out');
    expect(prompt).not.toContain('OFFERED social actions');
    expect(prompt).not.toContain('OFFERED object actions');
    // The monologue prompt in pie mode keeps the people and drops the whitelist lists
    expect(prompts[0]).toContain('OFFERED people to talk to');
    expect(prompts[0]).not.toContain('OFFERED object actions');
  });

  it('a collapsed row fans out by option; an option the row does not list is dropped', async () => {
    const { cache, dispatched, oneShotCalls } = buildCtx({
      vocabulary: 'pie',
      vocabularyAnswer: { ok: true, result: { rows: [STEREO_ROW] } },
      optionsJson: JSON.stringify({
        options: [
          { row: 'r20', option: 'Metal', label: 'Something loud' },
          { row: 'r20', option: 'Jazz', label: 'Something smooth' },
        ],
      }),
    });
    cache.ingest(report(1));
    await settle();
    // One valid option: no choice call
    expect(oneShotCalls.filter((label) => label.startsWith('Action Choice'))).toEqual([]);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      action: 'stereo_Listen',
      target_object_id: '950',
      pie: { target_id: '950', target_kind: 'object', item: 'stereo_Listen', option: 'Jazz', label: 'Jazz' },
    });
  });

  it('a failed outcome suppresses the key and the row is gone next tick', async () => {
    const { cache, cognition, dispatched, prompts } = buildCtx({
      vocabulary: 'pie',
      optionsJson: JSON.stringify({ options: [{ row: 'r12', label: 'Ask Adrian about his day' }] }),
    });
    cache.ingest(report(1));
    await settle();
    expect(dispatched).toHaveLength(1);
    cognition.onOutcome({ sim_id: '100', outcome: 'failure', request_id: 'req-1', action: 'mixer_social_AskAboutDay' });
    cache.ingest(report(2));
    await settle();
    expect(dispatched).toHaveLength(1);
    expect(optionsPrompt(prompts)).not.toContain('r12. Ask about Day');
  });

  it('a vocabulary the mod cannot build falls back to the whitelist prompt', async () => {
    const { cache, dispatched, prompts } = buildCtx({
      vocabulary: 'pie',
      vocabularyAnswer: { ok: false, error: 'vocabulary query timed out after 5000ms' },
    });
    cache.ingest(report(1));
    await settle();
    expect(optionsPrompt(prompts)).toContain('OFFERED object actions: grab snack');
    expect(dispatched[0]).toMatchObject({ action: 'grab_snack', target_object_id: '900' });
    expect(dispatched[0].pie).toBeUndefined();
  });

  it('a transient retry re-sends the click', async () => {
    const { cache, cognition, dispatched } = buildCtx({
      vocabulary: 'pie',
      optionsJson: JSON.stringify({ options: [{ row: 'r12', label: 'Ask Adrian about his day' }] }),
    });
    cache.ingest(report(1));
    await settle();
    expect(dispatched).toHaveLength(1);
    vi.useFakeTimers();
    cognition.onOutcome({
      sim_id: '100',
      outcome: 'canceled',
      request_id: 'req-1',
      action: 'mixer_social_AskAboutDay',
      cause: 'target_left',
    });
    vi.advanceTimersByTime(4_001);
    expect(dispatched).toHaveLength(2);
    expect(dispatched[1].pie).toMatchObject({ item: 'mixer_social_AskAboutDay', target_id: '200' });
  });

  it('a row the Sim is already running is an echo, not a dispatch', async () => {
    const { cache, cognition, dispatched } = buildCtx({
      vocabulary: 'pie',
      optionsJson: JSON.stringify({ options: [{ row: 'r12', label: 'Ask Adrian about his day' }] }),
    });
    cache.ingest(
      report(1, {
        self: { mood: 'Fine', needs: { hunger: 20 }, age: 'ADULT' },
        activity: { queue: [], running: 'mixer_social_AskAboutDay', in_social: false },
      }),
    );
    await settle();
    expect(dispatched).toEqual([]);
    expect(cognition.getStats().continues).toBe(1);
  });
});

describe('the smallest fixes (part 4)', () => {
  it('"null" targets are no targets', async () => {
    const { cache, dispatched } = buildCtx({
      optionsJson: JSON.stringify({
        options: [
          { action: 'chat', target_sim_id: 'null', label: 'Talk to no one' },
          { action: 'grab_snack', target_object_id: 'null', label: 'Raid the fridge' },
        ],
      }),
    });
    cache.ingest(report(1));
    await settle();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ action: 'grab_snack', target_object_id: '900' });
  });

  it("the day's loadout never hides a verb a live want needs", async () => {
    const { cache, prompts } = buildCtx({
      plan: { goals: [], loadout: ['watch_tv'] },
    });
    cache.ingest(
      report(1, {
        objects: [
          { object_id: '910', action_keys: ['read_book'], name: 'object_bookshelf', tier: 'same_room', distance: 2 },
        ],
        self: { mood: 'Fine', needs: { hunger: 50 }, age: 'ADULT', wants: ['read_book'] },
      }),
    );
    await settle();
    expect(prompts[0]).toContain('OFFERED object actions: read book');
  });
});

describe('what the prompt sees (part 3)', () => {
  it('money, the lot, the household, the director, the weather and a bedtime', async () => {
    const { cache, prompts } = buildCtx({
      inFlight: { '200': { sim_id: '200', action: 'pay_bills' } },
      wake: [{ simId: '200', simName: 'Adrian Calloway', doing: 'Solo_Stargaze', note: 'the stargaze' }],
      arc: 'The Long Night',
      maxConcurrent: 2,
    });
    const build = (seq: number) =>
      report(
        seq,
        {
          self: {
            mood: 'Fine',
            needs: { hunger: 50 },
            age: 'CHILD',
            buffs: ['Weather_Raining', 'hidden_tracker_buff', 'Happy'],
          },
        },
        {
          clock: { hour: 22, paused: false },
          funds: 412,
          bills: { due: true, amount: 1970, shut_off: ['power'] },
          lot_name: 'Orchid A Go Go',
          venue_type: 'lounge',
          is_home: false,
        },
        {
          sims: [
            {
              sim_id: '100',
              sim_name: 'Elliot Calloway',
              location: { zone_id: 1 },
              sims: [],
              objects: [
                {
                  object_id: '900',
                  action_keys: ['grab_snack'],
                  name: 'object_fridge',
                  tier: 'same_room',
                  distance: 4,
                },
              ],
              self: {
                mood: 'Fine',
                needs: { hunger: 50 },
                age: 'CHILD',
                buffs: ['Weather_Raining', 'hidden_tracker_buff', 'Happy'],
              },
              activity: { queue: [], running: null, in_social: false },
            },
            {
              sim_id: '200',
              sim_name: 'Adrian Calloway',
              location: { zone_id: 1 },
              sims: [],
              objects: [],
              self: { mood: 'Tense', needs: { hunger: -40 } },
              activity: { queue: [], running: 'mailbox_PayBills', running_action_key: 'pay_bills', in_social: false },
            },
          ],
        },
      );
    // Adrian (hungry) ticks first and holds the one concurrent slot; Elliot ticks on the next report
    cache.ingest(build(1));
    await settle();
    cache.ingest(build(2));
    await settle();
    const prompt = prompts.find((candidate) => candidate.startsWith('You are Elliot Calloway')) ?? '';
    expect(prompt).toContain('You are at Orchid A Go Go (lounge), not your home.');
    expect(prompt).toContain(
      'Household funds: $412; bills of $1,970 are due: you cannot afford them (power already shut off).',
    );
    expect(prompt).toContain(
      'Your household right now: Adrian Calloway (sim 200): awake, pay bills (mailbox_PayBills), Tense; low: hunger -40 Adrian is already on: pay bills.',
    );
    expect(prompt).toContain('A director has Adrian Calloway doing Solo_Stargaze.');
    expect(prompt).toContain('A director is running the scene: The Long Night.');
    expect(prompt).toContain('Weather: Weather Raining.');
    expect(prompt).toContain('Feelings: Happy');
    expect(prompt).not.toContain('hidden tracker buff');
    expect(prompt).toContain('It is late; children should be in bed.');
  });

  it('a broken provider loses its verb and stays a thing in the room', async () => {
    const { cache, prompts, dispatched } = buildCtx();
    cache.ingest(report(1, {}, { conditions: [{ object_id: '900', name: 'fridge', conditions: ['broken'] }] }));
    await settle();
    expect(prompts[0]).toContain('a fridge (4m away)');
    expect(prompts[0]).not.toContain('could grab snack');
    // The default options name grab_snack at the fridge; with no provider left it dies in validation
    expect(dispatched).toEqual([]);
  });

  it('work: at work, a shift ahead, and late', async () => {
    const atWork = buildCtx();
    atWork.cache.ingest(
      report(1, {
        self: { mood: 'Fine', needs: {}, age: 'ADULT', careers: [{ career: 'career_Tech', at_work: true }] },
      }),
    );
    await settle();
    expect(atWork.prompts[0]).toContain('You are at work (career Tech).');

    const ahead = buildCtx();
    ahead.cache.ingest(
      report(
        1,
        {
          self: {
            mood: 'Fine',
            needs: {},
            age: 'ADULT',
            careers: [{ career: 'career_Tech', next_shift: '14:00:00.000 day:2 week:1' }],
          },
        },
        { clock: { hour: 10, day: 2, paused: false } },
      ),
    );
    await settle();
    expect(ahead.prompts[0]).toContain('Your shift at career Tech starts at 14:00.');

    const late = buildCtx();
    late.cache.ingest(
      report(
        1,
        {
          self: {
            mood: 'Fine',
            needs: {},
            age: 'ADULT',
            careers: [{ career: 'career_Tech', next_shift: '09:00:00.000 day:2 week:1' }],
          },
        },
        { clock: { hour: 10, day: 2, paused: false } },
      ),
    );
    await settle();
    expect(late.prompts[0]).toContain('You are late for work at career Tech (your shift started at 09:00).');
  });
});

describe('the intention rows (part 5)', () => {
  const DAY_CLOCK = { hour: 10, minute: 0, absolute_day: 40, day: 2, paused: false };

  it('a bills row fires as a click through the row gate with no model call, and the tick leaves that Sim alone', async () => {
    const { cache, cognition, dispatched, oneShotCalls, queries, intentions } = buildCtx({ rows: true });
    cache.ingest(
      report(
        1,
        { is_household: true },
        { clock: DAY_CLOCK, bills: { due: true, amount: 300 }, action_keys: ['pay_bills'], funds: 900 },
      ),
    );
    await settle();
    expect(oneShotCalls).toEqual([]);
    expect(queries[0]).toEqual({ kind: 'moment', args: { sim_id: '100', lane: 'row' } });
    expect(dispatched).toHaveLength(1);
    const rows = intentions.rowsFor('100');
    expect(dispatched[0]).toMatchObject({
      sim_id: '100',
      action: 'pay_bills',
      source: 'cognition',
      row_id: rows[0].id,
    });
    expect(rows[0].status).toBe('in_flight');
    expect(cognition.getPhase('100')).toBe('PENDING_OUTCOME');
    // The outcome closes the row (one-shot until) and the pending state
    cognition.onOutcome({
      request_id: 'req-1',
      sim_id: '100',
      outcome: 'success',
      action: 'pay_bills',
      verdict: 'confirmed',
    } as never);
    expect(intentions.rowsFor('100')[0].status).toBe('done');
    expect(cognition.getPhase('100')).toBe('COOLDOWN');
  });

  it('a closed row gate leaves the row waiting at no cost', async () => {
    const { cache, dispatched, intentions } = buildCtx({
      rows: true,
      moment: { ok: true, result: { ok: false, key: 'head_busy', why: 'cooking' } },
    });
    cache.ingest(
      report(
        1,
        { is_household: true },
        { clock: DAY_CLOCK, bills: { due: true, amount: 300 }, action_keys: ['pay_bills'], funds: 900 },
      ),
    );
    await settle();
    expect(dispatched).toEqual([]);
    const [bills] = intentions.rowsFor('100');
    expect(bills.status).toBe('waiting');
    expect(bills.attempts).toBe(0);
  });

  it('a scene desire on a household Sim becomes a deliberate row that fires on the next fitting report with the armed lane', async () => {
    const { cache, cognition, dispatched, oneShotCalls, queries, intentions } = buildCtx({ rows: true });
    cache.ingest(
      report(
        1,
        { is_household: true, activity: { queue: ['cook'], running: 'cook', in_social: false } },
        { clock: DAY_CLOCK },
      ),
    );
    await settle();
    cognition.armDesireFromScene('100', { score: 9, reason: 'wants to clear the air with Adrian', targetSimId: '200' });
    const [row] = intentions.rowsFor('100');
    expect(row).toMatchObject({ source: 'scene', status: 'waiting' });
    expect(row.what.kind).toBe('deliberate');
    expect(oneShotCalls).toEqual([]);
    cache.ingest(report(2, { is_household: true }, { clock: { ...DAY_CLOCK, minute: 5 } }));
    await settle();
    expect(oneShotCalls.some((label) => label.startsWith('Cognition Monologue'))).toBe(false);
    expect(oneShotCalls.some((label) => label.startsWith('Action Options'))).toBe(true);
    expect(queries.filter((query) => query.kind === 'moment').map((query) => query.args.lane)).toContain('armed');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].row_id).toBe(row.id);
    expect(intentions.rowsFor('100')[0].status).toBe('in_flight');
  });

  it('a live work note holds go_out out of the tick vocabulary', async () => {
    const careers = [{ career: 'Culinary', next_shift: '10:30:00.000 day:2 week:1', at_work: false }];
    const on = buildCtx({ rows: true });
    on.cache.ingest(
      report(
        1,
        { is_household: true, self: { mood: 'Fine', needs: { hunger: 50 }, age: 'ADULT', careers } },
        { clock: DAY_CLOCK, action_keys: ['go_out'] },
        { venues: [{ zone_id: '5', name: 'The Blue Velvet', venue: 'bar' }] },
      ),
    );
    await settle();
    expect([...on.intentions.heldKeys('100', on.cache.getReport())]).toEqual(['go_out', 'travel_to_zone']);
    expect(on.intentions.rowsFor('100')[0]).toMatchObject({ source: 'work', status: 'waiting' });
    expect(on.oneShotCalls.some((label) => label.startsWith('Cognition Monologue'))).toBe(true);
    expect(on.prompts.join('\n')).not.toContain('go_out');
    const off = buildCtx({ rows: false });
    off.cache.ingest(
      report(
        1,
        { is_household: true, self: { mood: 'Fine', needs: { hunger: 50 }, age: 'ADULT', careers } },
        { clock: DAY_CLOCK, action_keys: ['go_out'] },
        { venues: [{ zone_id: '5', name: 'The Blue Velvet', venue: 'bar' }] },
      ),
    );
    await settle();
    expect(off.prompts.join('\n')).toContain('go_out');
  });

  it('a story row the night call wrote survives the merge and fires through the deliberation', async () => {
    const { cache, intentions } = buildCtx({ rows: true });
    cache.ingest(report(1, { is_household: true }, { clock: DAY_CLOCK }));
    await settle();
    intentions.applyEdits('100', {
      drop: [],
      rewrite: [],
      add: [
        {
          why: 'I want to cook for Adrian',
          say: 'Dinner is on me tonight.',
          target_sim_id: '200',
          target_name: 'Adrian Calloway',
          from_hour: 18,
        },
      ],
    });
    cache.ingest(report(2, { is_household: true }, { clock: { ...DAY_CLOCK, minute: 5 } }));
    await settle();
    const [story] = intentions.rowsFor('100');
    expect(story).toMatchObject({ source: 'story', status: 'waiting', say: 'Dinner is on me tonight.' });
  });

  it('with the rows off, bills due means the legacy tick deliberates as in chat 1', async () => {
    const { cache, dispatched, oneShotCalls, intentions } = buildCtx({ rows: false });
    cache.ingest(
      report(
        1,
        { is_household: true },
        { clock: DAY_CLOCK, bills: { due: true, amount: 300 }, action_keys: ['pay_bills'], funds: 900 },
      ),
    );
    await settle();
    expect(oneShotCalls.some((label) => label.startsWith('Cognition Monologue'))).toBe(true);
    expect(intentions.rowsFor('100')).toEqual([]);
    expect(dispatched.every((intent) => intent.row_id === undefined)).toBe(true);
  });
});

describe('the legacy tick flag, the voiced why and the night call (parts 6 and 7)', () => {
  const DAY_CLOCK = { hour: 10, minute: 0, absolute_day: 40, day: 2, paused: false };
  const BILLS_LOT = { clock: DAY_CLOCK, bills: { due: true, amount: 300 }, action_keys: ['pay_bills'], funds: 900 };
  const TWO_OPTIONS = JSON.stringify({
    scene: 'Adrian is right there.',
    options: [
      { action: 'grab_snack', target_object_id: '900', label: 'Raid the fridge' },
      { action: 'chat', target_sim_id: '200', label: 'Talk it out with Adrian' },
    ],
  });

  it('with the legacy tick off, an idle Sim with no row is left alone (no monologue)', async () => {
    const { cache, oneShotCalls, dispatched } = buildCtx({ rows: true, legacyTick: false });
    cache.ingest(report(1, { is_household: true }, { clock: DAY_CLOCK }));
    await settle();
    cache.ingest(report(2, { is_household: true }, { clock: { ...DAY_CLOCK, minute: 5 } }));
    await settle();
    expect(oneShotCalls).toEqual([]);
    expect(dispatched).toEqual([]);
  });

  it('a deliberate row with the legacy tick off runs options and choice, never the review', async () => {
    const { cache, cognition, oneShotCalls, dispatched } = buildCtx({
      rows: true,
      legacyTick: false,
      optionsJson: TWO_OPTIONS,
    });
    cache.ingest(
      report(
        1,
        { is_household: true, activity: { queue: ['cook'], running: 'cook', in_social: false } },
        { clock: DAY_CLOCK },
      ),
    );
    await settle();
    cognition.armDesireFromScene('100', { score: 9, reason: 'wants to clear the air with Adrian', targetSimId: '200' });
    cache.ingest(report(2, { is_household: true }, { clock: { ...DAY_CLOCK, minute: 5 } }));
    await settle();
    expect(oneShotCalls.some((label) => label.startsWith('Action Options'))).toBe(true);
    expect(oneShotCalls.some((label) => label.startsWith('Action Choice'))).toBe(true);
    expect(oneShotCalls.some((label) => label.startsWith('Action Review'))).toBe(false);
    expect(oneShotCalls.some((label) => label.startsWith('Cognition Monologue'))).toBe(false);
    expect(dispatched).toHaveLength(1);
  });

  it('the legacy tick on keeps the review stage', async () => {
    const { cache, cognition, oneShotCalls } = buildCtx({ rows: true, legacyTick: true, optionsJson: TWO_OPTIONS });
    cache.ingest(
      report(
        1,
        { is_household: true, activity: { queue: ['cook'], running: 'cook', in_social: false } },
        { clock: DAY_CLOCK },
      ),
    );
    await settle();
    cognition.armDesireFromScene('100', { score: 9, reason: 'wants to clear the air with Adrian', targetSimId: '200' });
    cache.ingest(report(2, { is_household: true }, { clock: { ...DAY_CLOCK, minute: 5 } }));
    await settle();
    expect(oneShotCalls.some((label) => label.startsWith('Action Review'))).toBe(true);
  });

  it('a fired row with a say line voices it once, paced, as the Sim to self', async () => {
    const { cache, dispatched, voiced, memories } = buildCtx({ rows: true, legacyTick: false });
    cache.ingest(report(1, { is_household: true }, BILLS_LOT));
    await settle();
    expect(dispatched).toHaveLength(1);
    expect(voiced).toHaveLength(1);
    expect(voiced[0].lines).toEqual([{ speaker: 'Elliot Calloway (to self)', text: BILLS_SAY, simId: '100' }]);
    expect(voiced[0].options).toMatchObject({ paced: true, pacedText: `Elliot Calloway (to self): ${BILLS_SAY}` });
    expect(memories).toHaveLength(1);
    expect(memories[0].memory).toMatchObject({
      event_type: 'monologue',
      content: `Elliot Calloway (to self): ${BILLS_SAY}`,
    });
  });

  it('intentionVoiceWhy off: the row fires and nothing is said', async () => {
    const { cache, dispatched, voiced } = buildCtx({ rows: true, legacyTick: false, voiceWhy: false });
    cache.ingest(report(1, { is_household: true }, BILLS_LOT));
    await settle();
    expect(dispatched).toHaveLength(1);
    expect(voiced).toEqual([]);
  });

  it("a desire armed before the Sim's first report becomes a scene row on that report", async () => {
    const { cache, cognition, intentions } = buildCtx({
      rows: true,
      legacyTick: false,
      moment: { ok: true, result: { ok: false, key: 'head_busy', why: 'cooking' } },
    });
    cognition.armDesireFromScene('100', { score: 9, reason: 'wants to clear the air with Adrian', targetSimId: '200' });
    expect(intentions.rowsFor('100')).toEqual([]);
    cache.ingest(report(1, { is_household: true }, { clock: DAY_CLOCK }));
    await settle();
    const scene = intentions.rowsFor('100').find((row) => row.source === 'scene');
    expect(scene).toBeDefined();
    expect(scene?.why).toBe('wants to clear the air with Adrian');
  });

  it("an NPC's desire is dropped when the legacy tick is off", async () => {
    const { cache, cognition, oneShotCalls, intentions } = buildCtx({ rows: true, legacyTick: false });
    cache.ingest(report(1, { is_household: false }, { clock: DAY_CLOCK }));
    await settle();
    cognition.armDesireFromScene('100', { score: 9, reason: 'wants a word with Adrian', targetSimId: '200' });
    cache.ingest(report(2, { is_household: false }, { clock: { ...DAY_CLOCK, minute: 5 } }));
    await settle();
    expect(intentions.rowsFor('100')).toEqual([]);
    expect(oneShotCalls).toEqual([]);
  });

  it('the day rollover queues a night call that the next report runs as a night turn', async () => {
    const { cache, turns } = buildCtx({ rows: true, legacyTick: false });
    cache.ingest(report(1, { is_household: true }, { clock: { ...DAY_CLOCK, hour: 23, minute: 50 } }));
    await settle();
    expect(turns).toEqual([]);
    cache.ingest(report(2, { is_household: true }, { clock: { ...DAY_CLOCK, absolute_day: 41, hour: 0, minute: 5 } }));
    await settle();
    expect(turns).toHaveLength(1);
    expect(turns[0].options).toEqual({ night: true });
    expect(turns[0].text).toContain('<night_call sim="Elliot Calloway" sim_id="100" ending_day="40" new_day="41">');
  });
});
