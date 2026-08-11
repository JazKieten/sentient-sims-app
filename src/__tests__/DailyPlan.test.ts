import { describe, expect, it } from 'vitest';
import { ApiContext } from 'main/sentient-sims/services/ApiContext';
import { DailyPlanService, parsePlannerJson } from 'main/sentient-sims/services/DailyPlanService';
import { DailyPlan, sleepPlanDays } from 'main/sentient-sims/models/DailyPlan';
import { GoalPoolEntry, SimStateEntry } from 'main/sentient-sims/models/SimStateReport';
import {
  ALWAYS_AVAILABLE_ACTIONS,
  DISCRETIONARY_ACTIONS,
  isRomanceAge,
  offLoadoutActions,
} from 'main/sentient-sims/models/ActionLoadout';

const POOL: GoalPoolEntry[] = [
  { id: 'objective_FriendOfTheWorld_ChatWith3', source: 'aspiration', label: 'Chat with 3 sims' },
  { id: 'statistic_DailyTask_PracticeWriting', source: 'daily_task', label: 'Practice writing' },
  { id: 'Whim_BuyPainting', source: 'want', label: 'Buy a painting' },
];

// In-memory stand-in for the daily_plan table (the real one is exercised live; every
// DB-backed test in this repo needs a working better-sqlite3 binding)
function buildService(options: { plannerText?: string | (() => string); loadoutSize?: number } = {}) {
  const rows = new Map<string, DailyPlan>();
  const plannerPrompts: string[] = [];
  const key = (simId: string, day: number) => `${simId}|${day}`;

  const ctx = {
    settings: {
      dailyGoalsEnabled: true,
      dailyLoadoutSize: options.loadoutSize ?? 6,
    },
    dailyPlanRepository: {
      getPlan: (simId: string, day: number) => rows.get(key(simId, day)),
      savePlan: (plan: DailyPlan) => rows.set(key(plan.sim_id, plan.absolute_day), { ...plan }),
      saveReview: (simId: string, day: number, review: DailyPlan['review']) => {
        const existing = rows.get(key(simId, day));
        if (existing) {
          existing.review = review;
        }
      },
    },
    participantRepository: {
      getParticipant: () => ({ id: '100', description: 'A restless blues guitarist.' }),
    },
    ai: {
      runOneShot: (_label: string, _system: string, userPrompt: string) => {
        plannerPrompts.push(userPrompt);
        const text = typeof options.plannerText === 'function' ? options.plannerText() : options.plannerText;
        return Promise.resolve({ text: text ?? '', exchange: {} });
      },
    },
  } as unknown as ApiContext;

  return { service: new DailyPlanService(ctx), rows, plannerPrompts };
}

function simEntry(overrides: Partial<SimStateEntry> = {}): SimStateEntry {
  return {
    sim_id: '100',
    sim_name: 'Marisol Vega',
    sims: [],
    objects: [],
    self: { traits: ['MusicLover'], needs: { fun: -30, social: 10 }, goal_pool: POOL },
    ...overrides,
  };
}

describe('ActionLoadout sets', () => {
  it('partitions the whitelist: no key is both always-available and discretionary', () => {
    DISCRETIONARY_ACTIONS.forEach((action) => {
      expect(ALWAYS_AVAILABLE_ACTIONS.has(action)).toBe(false);
    });
    // The survival floor and the safety lanes are never filterable, whatever the loadout
    ['grab_snack', 'sleep', 'use_toilet', 'chat', 'cancel_current', 'clean_up', 'go_home'].forEach((action) => {
      expect(ALWAYS_AVAILABLE_ACTIONS.has(action)).toBe(true);
    });
  });

  it('offLoadoutActions returns the discretionary complement and fails open when absent', () => {
    const off = offLoadoutActions(['play_guitar', 'flirt']);
    expect(off.has('watch_tv')).toBe(true);
    expect(off.has('play_guitar')).toBe(false);
    expect(off.has('flirt')).toBe(false);
    expect(off.has('grab_snack')).toBe(false);
    expect(offLoadoutActions(undefined).size).toBe(0);
    expect(offLoadoutActions([]).size).toBe(0);
  });
});

describe('DailyPlanService validation', () => {
  it('binds goals to the pool, clamps to 2, and dedupes', () => {
    const { service } = buildService();
    const output = service.validate(
      {
        goals: [
          'objective_FriendOfTheWorld_ChatWith3',
          'objective_FriendOfTheWorld_ChatWith3',
          'objective_Invented_ByTheModel',
          'statistic_DailyTask_PracticeWriting',
          'Whim_BuyPainting',
        ],
        persona: 'Today I want to be the friend who actually listens.',
        loadout: ['deep_conversation', 'tell_joke', 'play_guitar', 'dance'],
      },
      POOL,
    );
    expect(output.goals.map((goal) => goal.id)).toEqual([
      'objective_FriendOfTheWorld_ChatWith3',
      'statistic_DailyTask_PracticeWriting',
    ]);
    expect(output.persona).toContain('friend who actually listens');
    expect(output.loadout).toEqual(['deep_conversation', 'tell_joke', 'play_guitar', 'dance']);
  });

  it('drops non-discretionary loadout keys and fails open under 3 survivors', () => {
    const { service } = buildService();
    // sleep/grab_snack are always-available (not loadout material); 'fly' is invented
    const output = service.validate({ goals: [], loadout: ['sleep', 'grab_snack', 'fly', 'dance', 'gossip'] }, POOL);
    expect(output.loadout).toBeUndefined();
    // Model prose forms normalize back to keys
    const normalized = service.validate({ goals: [], loadout: ['Deep Conversation', 'tell-joke', 'DANCE'] }, POOL);
    expect(normalized.loadout).toEqual(['deep_conversation', 'tell_joke', 'dance']);
  });

  it('clamps the loadout to the configured size', () => {
    const { service } = buildService({ loadoutSize: 3 });
    const output = service.validate(
      { goals: [], loadout: ['dance', 'gossip', 'flirt', 'hug', 'watch_tv', 'read_book'] },
      POOL,
      'ADULT',
    );
    expect(output.loadout).toEqual(['dance', 'gossip', 'flirt']);
  });
});

describe('DailyPlanService persistence', () => {
  it('is idempotent per (sim, day) and treats other days as planless', () => {
    const { service } = buildService();
    const first = service.acceptPlan(
      '100',
      10,
      { goals: [POOL[0]], persona: 'Be bold.', loadout: ['dance', 'gossip', 'flirt'] },
      'sleep',
    );
    expect(first?.source).toEqual('sleep');

    // A second nap re-fires the sleep boundary; the day's plan must not be overwritten
    const second = service.acceptPlan('100', 10, { goals: [] }, 'lazy');
    expect(second?.source).toEqual('sleep');
    expect(second?.persona).toEqual('Be bold.');

    expect(service.activePlan('100', 10)?.loadout).toEqual(['dance', 'gossip', 'flirt']);
    // Yesterday's plan never governs today — the day match IS the staleness rule
    expect(service.activePlan('100', 11)).toBeUndefined();
    expect(service.needsLazyPlan('100', 11)).toBe(true);
    expect(service.needsLazyPlan('100', 10)).toBe(false);
    // An unknown day (old mod, no absolute_day) leaves everything inert
    expect(service.activePlan('100', undefined)).toBeUndefined();
    expect(service.needsLazyPlan('100', undefined)).toBe(false);
  });

  it('lets a sleep plan replace a lazy row once, keeping any review already on it', () => {
    const { service, rows } = buildService();
    // Bedtime after midnight: the lazy planner has already filled the day the sim is in
    service.acceptPlan('100', 44, { goals: [POOL[2]], persona: 'Drifting.' }, 'lazy');
    service.recordReview('100', 44, [{ id: 'Whim_BuyPainting', verdict: 'partial' }]);

    const upgraded = service.acceptPlan('100', 44, { goals: [POOL[0]], persona: 'Be bold.' }, 'sleep');
    expect(upgraded?.source).toEqual('sleep');
    expect(upgraded?.persona).toEqual('Be bold.');
    // savePlan is INSERT OR REPLACE — the verdicts must survive the row being rewritten
    expect(rows.get('100|44')?.review).toEqual([{ id: 'Whim_BuyPainting', verdict: 'partial' }]);

    // ...but only once: a second sleep boundary that night must not overwrite it
    const again = service.acceptPlan('100', 44, { goals: [], persona: 'Someone else.' }, 'sleep');
    expect(again?.persona).toEqual('Be bold.');
  });

  it('records reviews only for planned goals with valid verdicts', () => {
    const { service, rows } = buildService();
    service.acceptPlan('100', 10, { goals: [POOL[0], POOL[1]] }, 'sleep');
    service.recordReview('100', 10, [
      { id: 'objective_FriendOfTheWorld_ChatWith3', verdict: 'met' },
      { id: 'statistic_DailyTask_PracticeWriting', verdict: 'somewhat' },
      { id: 'objective_NotInThePlan', verdict: 'met' },
    ]);
    expect(rows.get('100|10')?.review).toEqual([{ id: 'objective_FriendOfTheWorld_ChatWith3', verdict: 'met' }]);
  });
});

describe('DailyPlanService prompts', () => {
  it('flags game-verified completions for durable goals only', () => {
    const { service } = buildService();
    const yesterday: DailyPlan = {
      sim_id: '100',
      absolute_day: 10,
      // The aspiration goal is gone from today's pool (the game completed it); the want
      // is gone because whims reroll constantly — only the first is provable
      goals: [
        { id: 'objective_Finished', source: 'aspiration', label: 'Chat with 3 sims' },
        { id: 'Whim_Vanished', source: 'want', label: 'Buy a painting' },
      ],
      source: 'sleep',
    };
    const block = service.buildChoicesBlock(POOL, yesterday, 'ADULT');
    expect(block).toContain('Chat with 3 sims [the game marks this one complete]');
    expect(block).toContain('Buy a painting');
    expect(block).not.toContain('Buy a painting [the game marks this one complete]');
    // Goals are offered BY ID, and the action styles list only discretionary keys
    expect(block).toContain('id: objective_FriendOfTheWorld_ChatWith3');
    expect(block).toContain('romance: flirt, kiss');
    expect(block).not.toContain('grab_snack');
  });
});

describe('DailyPlanService lazy generation', () => {
  it('validates the planner reply and stores a lazy plan', async () => {
    const { service, rows, plannerPrompts } = buildService({
      plannerText: JSON.stringify({
        goals: ['statistic_DailyTask_PracticeWriting', 'objective_Invented'],
        persona: 'Today I finish what I start.',
        loadout: ['read_book', 'browse_web', 'deep_conversation', 'sleep'],
      }),
    });

    await service.generateLazy(simEntry(), 12);

    const plan = rows.get('100|12');
    expect(plan?.source).toEqual('lazy');
    expect(plan?.goals.map((goal) => goal.id)).toEqual(['statistic_DailyTask_PracticeWriting']);
    expect(plan?.persona).toEqual('Today I finish what I start.');
    // 'sleep' is always-available, not loadout material
    expect(plan?.loadout).toEqual(['read_book', 'browse_web', 'deep_conversation']);
    // Personality is spent here: description and traits reach the planner prompt
    expect(plannerPrompts[0]).toContain('A restless blues guitarist.');
    expect(plannerPrompts[0]).toContain('MusicLover');
  });

  it('writes a fallback row after two unparseable replies so it stops re-firing', async () => {
    const { service, rows, plannerPrompts } = buildService({ plannerText: 'no json here' });

    await service.generateLazy(simEntry(), 12);

    expect(plannerPrompts).toHaveLength(2); // one retry, then give up
    expect(rows.get('100|12')?.source).toEqual('fallback');
    expect(service.needsLazyPlan('100', 12)).toBe(false);
  });

  it('never plans without a goal pool (old mod) or for an already-planned day', async () => {
    const { service, rows, plannerPrompts } = buildService({ plannerText: '{"persona": "x"}' });

    await service.generateLazy(simEntry({ self: { traits: [] } }), 12);
    expect(plannerPrompts).toHaveLength(0);
    expect(rows.size).toBe(0);

    service.acceptPlan('100', 12, { goals: [] }, 'sleep');
    await service.generateLazy(simEntry(), 12);
    expect(plannerPrompts).toHaveLength(0);
  });
});

describe('romance age gate', () => {
  it('only teens and adults may hold or receive a romance verb', () => {
    ['TEEN', 'YOUNGADULT', 'ADULT', 'ELDER', 'adult'].forEach((age) => expect(isRomanceAge(age)).toBe(true));
    ['CHILD', 'TODDLER', 'INFANT'].forEach((age) => expect(isRomanceAge(age)).toBe(false));
    // Unknown age fails CLOSED — an older mod build sends none on perceived sims
    expect(isRomanceAge(undefined)).toBe(false);
    expect(isRomanceAge('')).toBe(false);
  });

  it('strips romance keys from a child loadout but keeps an adult one', () => {
    const { service } = buildService();
    const raw = { loadout: ['read_book', 'flirt', 'hug', 'kiss', 'tell_joke'] };

    // Live 2026-08-10: Mackenzie Scott, a CHILD, was handed 'flirt' two days running
    expect(service.validate(raw, POOL, 'CHILD').loadout).toEqual(['read_book', 'hug', 'tell_joke']);
    expect(service.validate(raw, POOL, 'ADULT').loadout).toEqual(['read_book', 'flirt', 'hug', 'kiss', 'tell_joke']);
    // No age at all is unknown, so romance is dropped
    expect(service.validate(raw, POOL).loadout).toEqual(['read_book', 'hug', 'tell_joke']);
  });

  it('drops verbs the age cannot run, from the loadout and the prompt', () => {
    const { service } = buildService();
    // From the game's own affordance tests: a CHILD cannot read_book, tell_joke or
    // deep_conversation. Live 2026-08-10: Mackenzie Scott had all three prepped.
    const blocked = ['read_book', 'tell_joke', 'deep_conversation', 'cook_meal'];
    const raw = { loadout: ['read_book', 'browse_web', 'tell_joke', 'dance', 'hug'] };

    expect(service.validate(raw, POOL, 'CHILD', blocked).loadout).toEqual(['browse_web', 'dance', 'hug']);
    // An adult with no blocked list keeps everything
    expect(service.validate(raw, POOL, 'ADULT').loadout).toEqual(raw.loadout);

    const block = service.buildChoicesBlock(POOL, undefined, 'CHILD', blocked);
    expect(block).not.toMatch(/read_book|tell_joke|deep_conversation/);
    // ...but the verbs they CAN run are still offered
    expect(block).toContain('browse_web');
  });

  it('never shows a child the romance group in the planner prompt', () => {
    const { service } = buildService();
    expect(service.buildChoicesBlock(POOL, undefined, 'CHILD')).not.toMatch(/flirt|kiss|romance/);
    expect(service.buildChoicesBlock(POOL, undefined, 'ADULT')).toMatch(/romance: flirt, kiss/);
  });
});

describe('sleepPlanDays', () => {
  it('plans the day the sim wakes into, not endingDay + 1', () => {
    // Ordinary evening bedtime: they wake tomorrow, and today is the day to grade
    expect(sleepPlanDays(43, 22)).toEqual({ targetDay: 44, reviewDay: 43 });
    expect(sleepPlanDays(43, 17)).toEqual({ targetDay: 44, reviewDay: 43 });

    // After midnight they are ALREADY in the day they wake into (live 2026-08-10: a
    // 00:05 bedtime planned day 45, graded a 13-second-old day 44, and left day 43
    // — the day actually lived — unreviewed forever)
    expect(sleepPlanDays(44, 0)).toEqual({ targetDay: 44, reviewDay: 43 });
    expect(sleepPlanDays(44, 2)).toEqual({ targetDay: 44, reviewDay: 43 });
    expect(sleepPlanDays(44, 4)).toEqual({ targetDay: 44, reviewDay: 43 });
  });

  it('plans nothing for a daytime nap', () => {
    // They wake into a day that is already planned and half-lived
    expect(sleepPlanDays(44, 5)).toBeUndefined();
    expect(sleepPlanDays(44, 13)).toBeUndefined();
    expect(sleepPlanDays(44, 16)).toBeUndefined();
  });

  it('falls back to the old behaviour when the mod sends no hour', () => {
    expect(sleepPlanDays(44, undefined)).toEqual({ targetDay: 45, reviewDay: 44 });
  });
});

describe('parsePlannerJson', () => {
  it('extracts the first JSON object from fenced or prose-wrapped output', () => {
    expect(parsePlannerJson('```json\n{"diary": "a day"}\n```')).toEqual({ diary: 'a day' });
    expect(parsePlannerJson('no json here')).toBeUndefined();
    expect(parsePlannerJson('{broken')).toBeUndefined();
  });
});
