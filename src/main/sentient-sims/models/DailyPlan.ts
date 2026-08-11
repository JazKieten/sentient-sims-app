import { GoalPoolEntry } from './SimStateReport';

// How this plan came to be: the nightly diary call, the mid-day lazy fallback, or a
// parse-failure placeholder written so the lazy path stops re-firing for the day.
export type DailyPlanSource = 'sleep' | 'lazy' | 'fallback';

export type GoalVerdict = 'met' | 'partial' | 'ignored';

export type DailyPlanGoalReview = {
  id: string;
  verdict: GoalVerdict;
};

// A sim's plan for one game day. goals are validated against the mod's goal_pool
// (never free-form); persona is the one free-form sentence; loadout is the day's
// discretionary action keys (undefined = no filter, fail open).
export type DailyPlan = {
  sim_id: string;
  absolute_day: number;
  goals: GoalPoolEntry[];
  persona?: string;
  loadout?: string[];
  source: DailyPlanSource;
  review?: DailyPlanGoalReview[];
};

export type DailyPlanEntity = {
  sim_id: string;
  absolute_day: number;
  goals: string | null;
  persona: string | null;
  loadout: string | null;
  source: string | null;
  review: string | null;
};

function parseJsonColumn(raw: string | null): unknown {
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function dailyPlanFromEntity(entity: DailyPlanEntity): DailyPlan {
  return {
    sim_id: entity.sim_id,
    absolute_day: entity.absolute_day,
    goals: (parseJsonColumn(entity.goals) as GoalPoolEntry[] | undefined) ?? [],
    persona: entity.persona ?? undefined,
    loadout: parseJsonColumn(entity.loadout) as string[] | undefined,
    source: (entity.source ?? 'fallback') as DailyPlanSource,
    review: parseJsonColumn(entity.review) as DailyPlanGoalReview[] | undefined,
  };
}
