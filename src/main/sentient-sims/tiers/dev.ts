// The DEV tier's entry module (release 4.5): the measurement and debugging surface that
// ships in neither player build. Memory traces (the Memories window's pipeline view), the
// bench routes, the AI exchange reader, the trait/mood mapping export, the directed-scene
// tester route, the Ctrl+Shift+D debug toggle and the 25146 log socket for the log viewer.
// Listed in tiers.json, so both player builds delete it and their generated index.ts never
// names it. Dev builds always carry stream and autonomy too, so this tier may read them.
import type { Express, Request, Response } from 'express';
import log from 'electron-log';
import type { ApiContext } from '../services/ApiContext';
import type { TierRegistration } from './types';
import { MemoryTraceRepository } from '../db/MemoryTraceRepository';
import { MemoryTraceService } from '../services/MemoryTraceService';
import { MappingService } from '../services/MappingService';
import { MappingController } from '../controllers/MappingController';
import { BenchController } from '../controllers/BenchController';
import registerDebugToggleHotkey from '../registerDebugToggleHotkey';
import { startRendererLogSocket } from '../rendererLogSocket';
import { DirectedSceneRequest } from '../models/DirectedSceneRequest';
import { sendChatGeneration } from '../util/notifyRenderer';
import { CatchErrors } from '../controllers/decorators/CatchError';

export interface DevServices {
  memoryTraceRepository: MemoryTraceRepository;
  memoryTrace: MemoryTraceService;
  mapping: MappingService;
  mappingController: MappingController;
  bench: BenchController;
  devRoutes: DevRoutes;
}

const services = new WeakMap<ApiContext, DevServices>();

export function devOf(ctx: ApiContext): DevServices {
  const found = services.get(ctx);
  if (!found) {
    throw new Error('the dev tier is not registered on this context');
  }
  return found;
}

// The two dev handlers that used to sit on core controllers
class DevRoutes {
  private readonly ctx: ApiContext;

  constructor(ctx: ApiContext) {
    this.ctx = ctx;
  }

  // The scenario tester (renderer ChatPage) runs a directed scene straight from the app
  @CatchErrors()
  directedSceneEvent = async (req: Request, res: Response) => {
    const request = req.body as DirectedSceneRequest;

    log.debug(`Directed scene event: ${JSON.stringify(req.body)}`);

    const result = await this.ctx.ai.runDirectedScene(request);
    result.input = request.event;
    res.json({ ...result, text: result.text ? `\n${result.text}` : result.text });
    if (result.text) {
      sendChatGeneration(result);
    }
  };

  // The LLM pipeline (prompts, director's direction, reviewer before/after) that produced
  // this memory, when it was generated since the app last started.
  getMemoryTrace = (req: Request<{ memoryId: string }>, res: Response) => {
    try {
      const { memoryId } = req.params;
      const trace = devOf(this.ctx).memoryTrace.getTrace(memoryId);
      if (!trace) {
        return res.status(404).json({ error: `No pipeline trace for memory ${memoryId}` });
      }
      return res.json(trace);
    } catch (err) {
      log.error('Error getting memory trace', err);
      return res.json({ error: err instanceof Error ? err.message : String(err) });
    }
  };
}

function construct(ctx: ApiContext) {
  const memoryTraceRepository = new MemoryTraceRepository(ctx.db);
  const memoryTrace = new MemoryTraceService(ctx.aiExchangeLog, memoryTraceRepository);
  const mapping = new MappingService();
  services.set(ctx, {
    memoryTraceRepository,
    memoryTrace,
    mapping,
    mappingController: new MappingController(mapping),
    bench: new BenchController(ctx),
    devRoutes: new DevRoutes(ctx),
  });
  ctx.ext.trace = {
    recordPending: (contents, trace) => {
      memoryTrace.recordPending(contents, trace);
    },
    appendExchange: (memoryId, exchange, pipeline) => {
      memoryTrace.appendExchange(memoryId, exchange, pipeline);
    },
  };
}

function routes(app: Express, ctx: ApiContext) {
  const { bench, mappingController, devRoutes } = devOf(ctx);
  app.get('/ai/exchanges/:exchangeId', bench.getExchange);
  app.get('/ai/exchanges', bench.getExchanges);
  // The tier-0 run-validity gate over the loaded save
  app.get('/bench/tier0', bench.getTier0);
  app.post('/bench/self-knowledge/:simId', bench.selfKnowledge);
  // The five player-facing conversations from the 09-19..21 logs, replayed through the
  // reply path with the thread, the status block and the follow-through action
  app.get('/bench/player-threads', bench.getPlayerThreadFixtures);
  app.post('/bench/player-thread/:index', bench.playerThread);
  app.get('/traits', mappingController.getTraits);
  app.get('/traits/unmapped', mappingController.getUnmappedTraits);
  app.post('/traits/export', mappingController.exportTraits);
  app.get('/moods', mappingController.getMoods);
  app.get('/moods/unmapped', mappingController.getUnmappedMoods);
  app.get('/memories/:memoryId/trace', devRoutes.getMemoryTrace);
  app.post('/ai/v2/event/directed-scene', devRoutes.directedSceneEvent);
}

export const devTier: TierRegistration = {
  name: 'dev',
  construct,
  routes,
  start: (ctx) => {
    registerDebugToggleHotkey();
    startRendererLogSocket(ctx);
  },
  onMemoryUpserted: (ctx, memory) => {
    devOf(ctx).memoryTrace.attach(memory);
  },
};
