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
import { ModQueryService } from '../services/ModQueryService';
import { IntentionRepository } from '../db/IntentionRepository';
import { IntentionService } from '../services/intentions/IntentionService';
import { NightCallService } from '../services/intentions/NightCallService';
import { RowMemoryRepository } from '../db/RowMemoryRepository';
import { RowMemoryService } from '../services/intentions/RowMemoryService';
import { VocabularySampler } from '../services/intentions/VocabularySampler';
import { BudgetGate } from '../services/intentions/BudgetGate';
import { ProcedureRepository } from '../db/ProcedureRepository';
import { ProcedureService } from '../services/intentions/ProcedureService';
import { ExperienceRepository } from '../db/ExperienceRepository';
import { ExperienceService } from '../services/intentions/ExperienceService';

export interface AutonomyServices {
  dailyPlanRepository: DailyPlanRepository;
  // The intention rows' own table (autonomy part 5)
  intentionRepository: IntentionRepository;
  actionOutcomeRepository: ActionOutcomeRepository;
  actionDispatcher: ActionDispatcherService;
  // Cognition's questions to the mod before a model call (the moment gate, the vocabulary)
  modQuery: ModQueryService;
  outcomeVerdict: OutcomeVerdictService;
  dailyPlan: DailyPlanService;
  // Row memory's tables (renovation R1, migration 027)
  rowMemoryRepository: RowMemoryRepository;
  // Counters per row key across days, the decision log, the household log, the menus seen (R1)
  rowMemory: RowMemoryService;
  // Procedures and pitfalls (R4, migration 029): what ran for a key, what failures taught
  procedureRepository: ProcedureRepository;
  procedures: ProcedureService;
  // The private view's experiences (R5a, migration 030), ranked for the night call
  experienceRepository: ExperienceRepository;
  experiences: ExperienceService;
  // The ordered row list per household Sim (autonomy part 5)
  intentions: IntentionService;
  // Once a day per Sim, the menus that matter (renovation R2)
  vocabularySampler: VocabularySampler;
  // SOFAI's rule for the day's remaining model calls: only when they fit the window (R3)
  budgetGate: BudgetGate;
  // One Plum turn per household Sim at the day rollover that edits the list (part 6)
  nightCall: NightCallService;
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
  autonomy.intentionRepository = new IntentionRepository(ctx.db);
  autonomy.actionOutcomeRepository = new ActionOutcomeRepository(ctx.db);
  autonomy.actionDispatcher = new ActionDispatcherService();
  autonomy.modQuery = new ModQueryService();
  autonomy.outcomeVerdict = new OutcomeVerdictService(autonomy.actionOutcomeRepository);
  autonomy.dailyPlan = new DailyPlanService(ctx, autonomy);
  autonomy.rowMemoryRepository = new RowMemoryRepository(ctx.db);
  autonomy.rowMemory = new RowMemoryService(ctx, autonomy);
  autonomy.procedureRepository = new ProcedureRepository(ctx.db);
  autonomy.procedures = new ProcedureService(ctx, autonomy);
  autonomy.experienceRepository = new ExperienceRepository(ctx.db);
  autonomy.experiences = new ExperienceService(ctx, autonomy);
  autonomy.budgetGate = new BudgetGate();
  // The household's interactions the mod forwards (interactions/ss_household_log.py)
  autonomy.modQuery.onInteractionLog((event) => {
    autonomy.rowMemory.onInteractionLog(event.records);
  });
  // Needs modQuery for the game's goal_completed events
  autonomy.intentions = new IntentionService(ctx, autonomy);
  autonomy.vocabularySampler = new VocabularySampler(autonomy);
  // Hears the rows' day rollover; cognition ticks it from the state report
  autonomy.nightCall = new NightCallService(ctx, autonomy);
  // Subscribes to simStateCache reports and reaches back into ai/queue/dispatcher
  autonomy.cognitionService = new CognitionService(ctx, autonomy);
  autonomy.askAction = new AskActionService(ctx, autonomy);
  autonomy.voiceCommand = new VoiceCommandService(ctx, autonomy);
  autonomy.controller = new CognitionController(ctx, autonomy);
  // Plum's director mode (improv-watch as a service) and the grading of Plum's pushes
  autonomy.director = new DirectorService(ctx, { outcomes: autonomy.actionOutcomeRepository });
  services.set(ctx, autonomy);

  ctx.ext.director = autonomy.director;
  // The edit door of Plum's edit_intentions tool (the night call's one write)
  ctx.ext.intentions = {
    applyEdits: (simId, edits) => autonomy.intentions.applyEdits(simId, edits),
  };
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
      // speakerKind rides the request as is (ConversationDesire carries the same field)
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
  // Intention rows (part 5): the inspection surface and the debug fire
  app.get('/cognition/rows', controller.getRows);
  // Row memory (R1): before /:simId, which would read 'stats' as a sim id
  app.get('/cognition/rows/stats', controller.getRowStats);
  app.get('/cognition/rows/stats/:simId', controller.getRowStats);
  app.get('/cognition/rows/:simId', controller.getRows);
  app.post('/cognition/debug/rows/fire', controller.debugFireRow);
  // The night call (part 6), forced now for one Sim
  app.post('/cognition/debug/night-call', controller.debugNightCall);
  // Procedures and pitfalls (R4), and the live check's forced failure
  app.get('/cognition/procedures', controller.getProcedures);
  app.get('/cognition/procedures/:simId', controller.getProcedures);
  app.post('/cognition/debug/procedure-fail', controller.debugProcedureFail);
  // The private view (R5a): a Sim's experiences and how the night would rank them now
  app.get('/cognition/experiences/:simId', controller.getExperiences);
}

export const autonomyTier: TierRegistration = {
  name: 'autonomy',
  construct,
  routes,
  // {cognition: {...}} is the query channel's; everything else is not ours
  onModMessage: (ctx, message) =>
    message.cognition ? autonomyOf(ctx).modQuery.onModMessage(message.cognition) : false,
  onModDisconnected: (ctx) => {
    const autonomy = autonomyOf(ctx);
    autonomy.modQuery.onModDisconnected();
    autonomy.cognitionService.onModDisconnected();
    autonomy.intentions.onModDisconnected();
    autonomy.vocabularySampler.onModDisconnected();
  },
  onDatabaseLoaded: (ctx) => {
    // The bounding pass for the graded outcomes this save holds (F5)
    autonomyOf(ctx).outcomeVerdict.pruneOnLoad();
    // Rows are per save, and so is their memory
    autonomyOf(ctx).intentions.onDatabaseLoaded();
    autonomyOf(ctx).rowMemory.onDatabaseLoaded();
    autonomyOf(ctx).procedures.onDatabaseLoaded();
    autonomyOf(ctx).experiences.onDatabaseLoaded();
    autonomyOf(ctx).vocabularySampler.onDatabaseLoaded();
  },
  onSceneClosed: (ctx, closed) => {
    // A reply to the player that wanted to act may act now that it has been heard
    autonomyOf(ctx).cognitionService.releaseConversationActions(closed.sceneId);
  },
  shutdown: (ctx) => {
    autonomyOf(ctx).director.stop();
    autonomyOf(ctx).intentions.flush();
  },
};
