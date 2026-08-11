import { Repository } from './Repository';
import { DailyPlan, DailyPlanEntity, DailyPlanGoalReview, dailyPlanFromEntity } from '../models/DailyPlan';

export class DailyPlanRepository extends Repository {
  getPlan(simId: string, absoluteDay: number): DailyPlan | undefined {
    const entity = this.dbService
      .getDb()
      .prepare('SELECT * FROM daily_plan WHERE sim_id = ? AND absolute_day = ?')
      .get([simId, absoluteDay]) as DailyPlanEntity | undefined;
    return entity ? dailyPlanFromEntity(entity) : undefined;
  }

  savePlan(plan: DailyPlan) {
    return this.dbService
      .getDb()
      .prepare(
        `INSERT OR REPLACE INTO daily_plan(sim_id, absolute_day, goals, persona, loadout, source, review)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run([
        plan.sim_id,
        plan.absolute_day,
        JSON.stringify(plan.goals),
        plan.persona ?? null,
        plan.loadout ? JSON.stringify(plan.loadout) : null,
        plan.source,
        plan.review ? JSON.stringify(plan.review) : null,
      ]);
  }

  // The nightly diary grades the day that just ended — written onto that day's row
  saveReview(simId: string, absoluteDay: number, review: DailyPlanGoalReview[]) {
    return this.dbService
      .getDb()
      .prepare('UPDATE daily_plan SET review = ? WHERE sim_id = ? AND absolute_day = ?')
      .run([JSON.stringify(review), simId, absoluteDay]);
  }
}
