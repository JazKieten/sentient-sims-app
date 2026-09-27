// AUTONOMY tier (release 4.5): the nightly planner that rides the sleep diary. Moved out of
// AIService.runSceneReflection / buildSleepPlanContext verbatim; AIService asks the
// sleepPlanner slot, and a build without autonomy writes the plain diary.
//
// When the sleeper can plan (feature on, goal_pool cached, day known, tomorrow not
// already planned), the diary call doubles as the nightly planner: one JSON call
// returns the diary AND tomorrow's goals/persona/loadout plus a review of today's
// goals. Any parse failure degrades to the plain diary — the reflection must never
// be lost to plan parsing; the lazy planner covers the plan side.
import log from 'electron-log';
import type { ApiContext } from './ApiContext';
import type { AutonomyServices } from '../tiers/autonomy';
import type { SleepPlan, SleepPlannerSlot } from '../tiers/types';
import { sleepPlanDays } from '../models/DailyPlan';
import { DailyPlanService, extractDiaryProse, parsePlannerJson } from './DailyPlanService';
import { buildConsolidationSystemPrompt } from '../pipeline/prompts/plan';
import type { ReflectionPromptContext } from '../pipeline/prompts/consolidation';

function buildSleepPlanContext(
  ctx: ApiContext,
  autonomy: AutonomyServices,
  pov: { simId: string; simName: string },
  sleepClock?: { hour?: number; absolute_day?: number },
) {
  try {
    if (!ctx.settings.dailyGoalsEnabled) {
      return undefined;
    }
    const entry = ctx.simStateCache.getSim(pov.simId);
    const pool = entry?.self?.goal_pool;
    const endingDay = sleepClock?.absolute_day ?? ctx.simStateCache.getReport()?.lot?.clock?.absolute_day;
    if (!pool || pool.length === 0 || endingDay === undefined) {
      return undefined;
    }
    // The plan belongs to the day the sim WAKES INTO, which is not endingDay + 1 when
    // they went to bed after midnight
    const days = sleepPlanDays(endingDay, sleepClock?.hour);
    if (!days) {
      return undefined;
    }
    const { targetDay, reviewDay } = days;
    // A second sleep that night re-fires the boundary and must not replan — but the
    // day that ended may still be ungraded, and bailing here used to lose its review
    // for good (nothing else ever writes one)
    const alreadyPlanned = autonomy.dailyPlan.activePlan(pov.simId, targetDay)?.source === 'sleep';
    const dayThatEnded = autonomy.dailyPlan.activePlan(pov.simId, reviewDay);
    const reviewPending = dayThatEnded !== undefined && dayThatEnded.goals.length > 0 && !dayThatEnded.review;
    if (alreadyPlanned && !reviewPending) {
      return undefined;
    }
    return {
      pool,
      reviewDay,
      targetDay,
      todaysPlan: dayThatEnded,
      description: autonomy.dailyPlan.participantDescription(pov.simId, pov.simName),
      traits: entry.self?.traits ?? [],
      // Gates the romance group out of the planner's ACTION STYLES for non-adults
      age: entry.self?.age,
      ageBlocked: entry.self?.age_blocked,
      // G-5/G-8: what tonight's lot serves (annotation only) and goals carried too long
      lotServes: DailyPlanService.lotServedKeys(entry, ctx.simStateCache.getReport()?.lot?.action_keys),
      stuck: autonomy.dailyPlan.stuckGoals(pov.simId, targetDay),
      // The weekday of the day being planned (the one the sim wakes into): before
      // midnight that's tomorrow, after midnight it's already today. 0=Sun..6=Sat.
      plannedWeekday: (() => {
        const day = ctx.simStateCache.getReport()?.lot?.clock?.day;
        if (day === undefined) {
          return undefined;
        }
        const hour = sleepClock?.hour;
        return hour !== undefined && hour < 12 ? day : (day + 1) % 7;
      })(),
    };
  } catch (err) {
    log.warn('[DailyPlan] sleep plan context failed; running plain reflection', err);
    return undefined;
  }
}

export function createSleepPlanner(ctx: ApiContext, autonomy: AutonomyServices): SleepPlannerSlot {
  return {
    prepare(pov, sleepClock): SleepPlan | undefined {
      const planContext = buildSleepPlanContext(ctx, autonomy, pov, sleepClock);
      if (!planContext) {
        return undefined;
      }
      return {
        systemPrompt: (reflectionContext: ReflectionPromptContext) =>
          buildConsolidationSystemPrompt({
            ...reflectionContext,
            choicesBlock: autonomy.dailyPlan.buildChoicesBlock(
              planContext.pool,
              planContext.todaysPlan,
              planContext.age,
              planContext.ageBlocked,
              planContext.lotServes,
              planContext.stuck,
              // C1 outing nudges (Jaz's go_out rebuild): traits + the weekday being planned
              { traits: planContext.traits, plannedWeekday: planContext.plannedWeekday },
            ),
            aboutLine: `${planContext.description ? `About you: ${planContext.description}\n` : ''}${
              planContext.traits.length > 0 ? `Your traits: ${planContext.traits.join(', ')}\n` : ''
            }`,
            hasTodaysGoals: (planContext.todaysPlan?.goals.length ?? 0) > 0,
            loadoutSize: ctx.settings.dailyLoadoutSize,
          }),
        accept: (raw: string) => {
          const parsed = parsePlannerJson(raw);
          if (parsed && typeof parsed.diary === 'string' && parsed.diary.trim().length > 1) {
            try {
              autonomy.dailyPlan.recordReview(pov.simId, planContext.reviewDay, parsed.goal_review);
              const validated = autonomy.dailyPlan.validate(
                parsed,
                planContext.pool,
                planContext.age,
                planContext.ageBlocked,
                pov.simName,
              );
              autonomy.dailyPlan.acceptPlan(pov.simId, planContext.targetDay, validated, 'sleep');
            } catch (err) {
              log.warn(`[DailyPlan] failed to accept sleep plan for ${pov.simName}`, err);
            }
            return parsed.diary;
          }
          // The diary must never be lost to plan parsing — nor may raw JSON reach
          // permanent memory (live 2026-08-15). Keep the prose, drop the schema, and let
          // the lazy planner cover tomorrow.
          log.warn(
            `[DailyPlan] sleep planner output unparseable for ${pov.simName}; lazy path will plan. ` +
              `Received: ${JSON.stringify(raw.slice(0, 120))}`,
          );
          return extractDiaryProse(raw);
        },
      };
    },
  };
}
