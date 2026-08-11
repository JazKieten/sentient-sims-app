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

// A sim who goes to bed at 00:05 is ALREADY in the day they will wake into, so the
// overnight plan belongs to today and the day that just ended is yesterday. Bedtimes
// between 22:00 and 02:00 are ordinary in The Sims 4, so treating every sleep as
// "plan endingDay + 1" misfiled the good plan a day ahead on a large share of nights,
// graded a plan that had existed for seconds, and left the day actually lived
// unreviewed (observed live 2026-08-10: rows for days 43/44/45 all wrong).
export const NIGHT_STARTS_HOUR = 17;
export const SMALL_HOURS_END_HOUR = 5;

// Which day a sleep boundary plans for, and which day its review grades.
// undefined = this sleep is a daytime nap: the sim wakes into a day that is already
// planned and only half-lived, so there is nothing to plan and nothing to grade.
export function sleepPlanDays(
  endingDay: number,
  hour?: number,
): { targetDay: number; reviewDay: number } | undefined {
  if (hour === undefined) {
    // Older mod sends no clock hour — keep the original behaviour rather than guess
    return { targetDay: endingDay + 1, reviewDay: endingDay };
  }
  if (hour < SMALL_HOURS_END_HOUR) {
    return { targetDay: endingDay, reviewDay: endingDay - 1 };
  }
  if (hour >= NIGHT_STARTS_HOUR) {
    return { targetDay: endingDay + 1, reviewDay: endingDay };
  }
  return undefined;
}

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
