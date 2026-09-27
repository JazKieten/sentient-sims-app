import { describe, expect, it } from 'vitest';
import { ApiContext } from 'main/sentient-sims/services/ApiContext';
import { DailyPlanService, extractDiaryProse, parsePlannerJson } from 'main/sentient-sims/services/DailyPlanService';
import type { AutonomyServices } from 'main/sentient-sims/tiers/autonomy';
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

  // The stub carries the autonomy sibling (dailyPlanRepository) itself
  return { service: new DailyPlanService(ctx, ctx as unknown as AutonomyServices), rows, plannerPrompts };
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

  it('repairs a goals array written as bare "id" pairs', () => {
    const parsed = parsePlannerJson('{"goals": ["id": "want_MakeFriend", "id": "want_GoForJog"], "diary": "a day"}');
    expect(parsed).toEqual({ goals: ['want_MakeFriend', 'want_GoForJog'], diary: 'a day' });
  });

  it('leaves a well-formed goals array alone and still fails on real garbage', () => {
    expect(parsePlannerJson('{"goals": ["want_MakeFriend"]}')).toEqual({
      goals: ['want_MakeFriend'],
    });
    expect(parsePlannerJson('{"goals": [not json at all}')).toBeUndefined();
  });
});

// Live 2026-08-15: a sleep-plan completion that broke the schema twice (free prose before
// the object, goals written as bare "id" pairs) was stored WHOLE as the diary memory —
// prose plus raw JSON — and recalled into 216 later prompts.
describe('extractDiaryProse', () => {
  const LEAKED =
    "I spent the day recovering from a low-energy slump, and I'm looking forward to a more " +
    'energetic tomorrow. \n{"diary": "I spent the day recovering with my household.", ' +
    '"goal_review": [], "goals": ["id": "want_MakeFriend", "id": "want_GoForJog"], ' +
    '"persona": "I am upbeat today."}';

  it('never lets raw JSON reach the stored diary', () => {
    const diary = extractDiaryProse(LEAKED);
    expect(diary).not.toContain('{');
    expect(diary).not.toContain('goal_review');
    expect(diary).toBe('I spent the day recovering with my household.');
  });

  it('salvages the diary out of a completion truncated at the token cap', () => {
    // Both rows actually poisoned in the live DB (2026-08-13) were cut off mid-object, so
    // there is no closing brace for parsePlannerJson to find at all
    const truncated =
      '{"diary": "Today was a bit of a rollercoaster.", "goal_review": [{"id": "want_ReadBook", ' +
      '"verdict": "ignored"}], "goals": ["id": "want_ReadBook"], "persona": "I want to be conf';
    expect(extractDiaryProse(truncated)).toBe('Today was a bit of a rollercoaster.');
  });

  it('salvages the diary field when the object cannot be parsed at all', () => {
    const diary = extractDiaryProse('Some prose first.\n{"diary": "The bit I actually wrote.", "goals": [<<<]}');
    expect(diary).toBe('The bit I actually wrote.');
  });

  it('falls back to the prose before the object when there is no usable diary field', () => {
    expect(extractDiaryProse('A quiet day at home.\n{"goals": ["x"]}')).toBe('A quiet day at home.');
  });

  it('passes plain prose through untouched', () => {
    expect(extractDiaryProse('  A quiet day at home.  ')).toBe('A quiet day at home.');
    expect(extractDiaryProse('')).toBe('');
  });
});

describe('goal -> action connection (Phase 3)', () => {
  const REACHABLE_POOL: GoalPoolEntry[] = [
    { id: 'objective_Bodybuilder_Jog3', source: 'aspiration', label: 'Aspiration (Bodybuilder): jog x3', action_keys: ['jog', 'workout'], reachable: true },
    { id: 'objective_Painter_Skill3', source: 'aspiration', label: 'Aspiration (Painter): painting to 3', action_keys: ['paint'], reachable: true },
    { id: 'objective_Nothing_Serves', source: 'aspiration', label: 'Aspiration (Odd): earn simoleons', action_keys: [], reachable: false },
  ];

  it('bindGoalId tolerates trimming, case, id: prefixes and labels (G-6)', () => {
    const { service } = buildService({ loadoutSize: 8 });
    const bind = (goals: unknown[]) => service.validate({ goals }, REACHABLE_POOL, 'ADULT').goals.map((goal) => goal.id);
    expect(bind([' objective_Bodybuilder_Jog3 '])).toEqual(['objective_Bodybuilder_Jog3']);
    expect(bind(['OBJECTIVE_bodybuilder_jog3'])).toEqual(['objective_Bodybuilder_Jog3']);
    expect(bind(['id: objective_Painter_Skill3'])).toEqual(['objective_Painter_Skill3']);
    expect(bind(['Aspiration (Painter): painting to 3'])).toEqual(['objective_Painter_Skill3']);
    expect(bind(['objective_Made_Up'])).toEqual([]);
  });

  it('force-includes the verbs that serve the chosen goals into the loadout (G-5)', () => {
    const { service } = buildService({ loadoutSize: 6 });
    const output = service.validate(
      {
        goals: ['objective_Bodybuilder_Jog3', 'objective_Painter_Skill3'],
        loadout: ['tell_joke', 'gossip', 'hug', 'flirt', 'kiss', 'insult'],
      },
      REACHABLE_POOL,
      'ADULT',
    );
    expect(output.loadout).toContain('jog');
    expect(output.loadout).toContain('workout');
    expect(output.loadout).toContain('paint');
    // size 6 + tolerance 2 = 8: one model pick trimmed to make room for the third key
    expect(output.loadout).toHaveLength(8);
    expect(output.rejected?.some((entry) => entry.reason.includes('trimmed'))).toBe(true);
  });

  it('renders serve-it-with verbs, unreachable markers, and lot annotations (G-5)', () => {
    const { service } = buildService({ loadoutSize: 8 });
    const block = service.buildChoicesBlock(REACHABLE_POOL, undefined, 'ADULT', [], new Set(['paint', 'chat']));
    expect(block).toContain('[serve it with: jog, workout]');
    expect(block).toContain('[no action in your vocabulary serves this yet]');
    expect(block).toContain('jog (not on this lot)');
    expect(block).not.toContain('paint (not on this lot)');
  });

  it('flags a goal ignored 3 planned days running and withholds it on the 4th (G-8)', () => {
    const { service } = buildService({ loadoutSize: 8 });
    const goal = REACHABLE_POOL[0];
    for (let day = 10; day <= 12; day += 1) {
      service.acceptPlan('100', day, { goals: [goal] }, 'sleep');
      service.recordReview('100', day, [{ id: goal.id, verdict: 'ignored' }]);
    }
    const stuck = service.stuckGoals('100', 13);
    expect(stuck.get(goal.id)).toBe(3);
    expect(service.buildChoicesBlock(REACHABLE_POOL, undefined, 'ADULT', [], undefined, stuck)).toContain(
      'carried 3 days without moving',
    );
    service.acceptPlan('100', 13, { goals: [goal] }, 'sleep');
    service.recordReview('100', 13, [{ id: goal.id, verdict: 'ignored' }]);
    const withheld = service.stuckGoals('100', 14);
    expect(withheld.get(goal.id)).toBe(4);
    expect(service.buildChoicesBlock(REACHABLE_POOL, undefined, 'ADULT', [], undefined, withheld)).not.toContain(
      'objective_Bodybuilder_Jog3',
    );
  });
});

describe('persona wording (N-5)', () => {
  it('strips a leading "Tomorrow," so the persona reads in the present', () => {
    const { service } = buildService();
    expect(service.validate({ persona: 'Tomorrow, I will be the calm one in the room.' }, []).persona).toBe(
      'I will be the calm one in the room.',
    );
    expect(service.validate({ persona: "Tomorrow I'm bold." }, []).persona).toBe("I'm bold.");
    expect(service.validate({ persona: 'I am the calm one.' }, []).persona).toBe('I am the calm one.');
  });
});

describe('outing nudges (C1, 2026-08-27)', () => {
  it('nudges an outgoing personality toward an outing slot', () => {
    const { service } = buildService();
    // Traits arrive as raw tuning names (verified live)
    const block = service.buildChoicesBlock(POOL, undefined, 'ADULT', [], undefined, undefined, {
      traits: ['trait_SelfAssured', 'trait_Perfectionist'],
    });
    expect(block).toContain('outing key (go_out)');
  });

  it('stays quiet for a homebody on a weekday', () => {
    const { service } = buildService();
    const block = service.buildChoicesBlock(POOL, undefined, 'ADULT', [], undefined, undefined, {
      traits: ['trait_Loner', 'trait_Geek'],
      plannedWeekday: 3,
    });
    expect(block).not.toContain('outing key (go_out)');
    expect(block).not.toContain('weekend');
  });

  it('nudges on weekend days only (0=Sunday, 6=Saturday, verified live)', () => {
    const { service } = buildService();
    for (const [day, expected] of [
      [0, true],
      [6, true],
      [5, false],
    ] as [number, boolean][]) {
      const block = service.buildChoicesBlock(POOL, undefined, 'ADULT', [], undefined, undefined, {
        plannedWeekday: day,
      });
      expect(block.includes('It is the weekend'), String(day)).toBe(expected);
    }
  });

  it('never matches "bro" as a substring of another trait', () => {
    const { service } = buildService();
    const block = service.buildChoicesBlock(POOL, undefined, 'ADULT', [], undefined, undefined, {
      traits: ['trait_Hidden_BrokenHome', 'trait_Umbrella_User'],
    });
    expect(block).not.toContain('outing key (go_out)');
  });
});
