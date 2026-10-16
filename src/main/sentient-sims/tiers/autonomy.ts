// The AUTONOMY tier's entry module (release 4.5): Full Autonomy (the cognition tick and the
// push engine), the daily plan, asked actions, the voice command chord and the graded
// outcome log. Listed in tiers.json, so the core build deletes it and the generated
// index.ts never names it.
//
// The services live here, per context, not on ApiContext: core reaches them only through
// the ApiContext.ext slots this module fills. Autonomy and dev code reads them with
// autonomyOf(ctx).
import type { Express } from 'express';
import type { ApiContext } from '../services/ApiContext';
import type { TierRegistration } from './types';
import { DailyPlanRepository } from '../db/DailyPlanRepository';
import { ActionOutcomeRepository } from '../db/ActionOutcomeRepository';
import { ActionDispatcherService } from '../services/ActionDispatcherService';
import { OutcomeVerdictService } from '../services/OutcomeVerdictService';
import { DailyPlanService } from '../services/DailyPlanService';
import { CognitionService } from '../services/CognitionService';
import { AskActionService } from '../services/AskActionService';
import { VoiceCommandService } from '../services/VoiceCommandService';
import { CognitionController } from '../controllers/CognitionController';
import { createSleepPlanner } from '../services/SleepPlanner';
import { DirectorService } from '../services/DirectorService';

export interface AutonomyServices {
  dailyPlanRepository: DailyPlanRepository;
  actionOutcomeRepository: ActionOutcomeRepository;
  actionDispatcher: ActionDispatcherService;
  outcomeVerdict: OutcomeVerdictService;
  dailyPlan: DailyPlanService;
  cognitionService: CognitionService;
  askAction: AskActionService;
  voiceCommand: VoiceCommandService;
  controller: CognitionController;
  director: DirectorService;
}

const services = new WeakMap<ApiContext, AutonomyServices>();

export function autonomyOf(ctx: ApiContext): AutonomyServices {
  const found = services.get(ctx);
  if (!found) {
    throw new Error('the autonomy tier is not registered on this context');
  }
  return found;
}

function construct(ctx: ApiContext) {
  // Filled in dependency order; each service keeps the same object and reads its siblings
  // from it when it runs
  const autonomy = {} as AutonomyServices;
  autonomy.dailyPlanRepository = new DailyPlanRepository(ctx.db);
  autonomy.actionOutcomeRepository = new ActionOutcomeRepository(ctx.db);
  autonomy.actionDispatcher = new ActionDispatcherService();
  autonomy.outcomeVerdict = new OutcomeVerdictService(autonomy.actionOutcomeRepository);
  autonomy.dailyPlan = new DailyPlanService(ctx, autonomy);
  // Subscribes to simStateCache reports and reaches back into ai/queue/dispatcher
  autonomy.cognitionService = new CognitionService(ctx, autonomy);
  autonomy.askAction = new AskActionService(ctx, autonomy);
  autonomy.voiceCommand = new VoiceCommandService(ctx, autonomy);
  autonomy.controller = new CognitionController(ctx, autonomy);
  // Plum's director mode (improv-watch as a service) and the grading of Plum's pushes
  autonomy.director = new DirectorService(ctx, { outcomes: autonomy.actionOutcomeRepository });
  services.set(ctx, autonomy);

  ctx.ext.director = autonomy.director;
  ctx.ext.plumPush = (requestId, push) => {
    const sims = ctx.simStateCache.getReport()?.sims ?? [];
    const sim = sims.find((entry) => entry.sim_name?.toLowerCase() === push.sim_id.toLowerCase());
    autonomy.actionDispatcher.registerExternal(requestId, {
      sim_id: sim?.sim_id ?? push.sim_id,
      action: push.action,
      source: 'claude',
    });
  };

  ctx.ext.askAction = autonomy.askAction;
  ctx.ext.voiceCommand = autonomy.voiceCommand;
  ctx.ext.sleepPlanner = createSleepPlanner(ctx, autonomy);
  ctx.ext.conversationActions = {
    actOnConversation: async (simId, request) => {
      const result = await autonomy.cognitionService.actOnConversation(simId, request);
      return {
        acted: result.acted,
        action: result.intent?.action,
        target: result.intent?.target_sim_id ?? result.intent?.target_object_id,
      };
    },
    armDesireFromScene: (simId, desire) => {
      autonomy.cognitionService.armDesireFromScene(simId, desire);
    },
  };
  ctx.ext.plumCognition = (simId) => {
    const absoluteDay = ctx.simStateCache.getReport()?.lot?.clock?.absolute_day;
    const plan = autonomy.dailyPlan.activePlan(simId, absoluteDay);
    const outcomes = autonomy.actionOutcomeRepository.isLoaded()
      ? autonomy.actionOutcomeRepository.list({ simId, limit: 5 }).map((record) => ({
          at: record.at,
          action: record.action,
          interaction: record.interactionName,
          outcome: record.outcome,
          verdict: record.verdict,
          claim: record.claim,
        }))
      : [];
    return {
      ...(plan ? { plan: { goals: plan.goals, persona: plan.persona, source: plan.source } } : {}),
      outcomes,
    };
  };
  ctx.ext.selfStatusPlan = (simId, absoluteDay) => {
    const plan = autonomy.dailyPlan.activePlan(simId, absoluteDay);
    if (!plan || (plan.goals.length === 0 && !plan.persona)) {
      return undefined;
    }
    return {
      goals: plan.goals.map((goal) => ({
        label: goal.label,
        action_keys: goal.action_keys,
        reachable: goal.reachable,
      })),
      persona: plan.persona,
    };
  };
}

function routes(app: Express, ctx: ApiContext) {
  const { controller } = autonomyOf(ctx);
  app.post('/cognition/outcome', controller.postOutcome);
  app.post('/cognition/perception', controller.postPerception);
  app.post('/cognition/debug/enqueue', controller.debugEnqueue);
  app.post('/cognition/debug/perception', controller.debugRequestPerception);
  // F5: graded outcomes for the loaded save
  app.get('/ai/outcomes', controller.getOutcomes);
}

export const autonomyTier: TierRegistration = {
  name: 'autonomy',
  construct,
  routes,
  onDatabaseLoaded: (ctx) => {
    // The bounding pass for the graded outcomes this save holds (F5)
    autonomyOf(ctx).outcomeVerdict.pruneOnLoad();
  },
  onSceneClosed: (ctx, closed) => {
    // A reply to the player that wanted to act may act now that it has been heard
    autonomyOf(ctx).cognitionService.releaseConversationActions(closed.sceneId);
  },
  shutdown: (ctx) => {
    autonomyOf(ctx).director.stop();
  },
};
