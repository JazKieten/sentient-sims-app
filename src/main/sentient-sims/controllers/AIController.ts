import { Request, Response } from 'express';
import log from 'electron-log';
import { InteractionEvents, SSEventType } from '../models/InteractionEvents';
import { DirectedSceneRequest } from '../models/DirectedSceneRequest';
import { playTTS, sendChatGeneration } from '../util/notifyRenderer';
import { OpenAICompatibleRequest } from '../models/OpenAICompatibleRequest';
import { InteractionEventStatus } from '../models/InteractionEventResult';
import { BuffEventRequest, BuffDescriptionRequest, ClassificationRequest } from '../models/OpenAIRequestBuilder';
import { CatchErrors } from './decorators/CatchError';
import { ApiContext } from '../services/ApiContext';
import {
  InteractionClaimRequest,
  InteractionFinalizeRequest,
  InteractionPrefetchRequest,
} from '../services/GenerationQueueService';
import { ApiTypeFromValue } from '../models/ApiType';
import { ImageGenerationRequest } from '../models/ImageGeneration';
import { OutcomeVerdict } from '../services/OutcomeVerdictService';
import { runTier0 } from '../bench/tier0';

export class AIController {
  private readonly ctx: ApiContext;

  constructor(ctx: ApiContext) {
    this.ctx = ctx;
  }

  @CatchErrors()
  sentientSimsGenerate = async (req: Request, res: Response) => {
    const promptRequest = req.body as OpenAICompatibleRequest;
    const response = await this.ctx.ai.generate(promptRequest);
    log.debug(response);
    res.json({ text: response.text });
    sendChatGeneration({
      text: response.text,
      status: InteractionEventStatus.GENERATED,
      request: promptRequest,
    });
  };

  @CatchErrors()
  generateImage = async (req: Request, res: Response) => {
    const request = req.body as ImageGenerationRequest;
    if (!request.prompt) {
      res.status(400).json({ error: 'Must include prompt in request body' });
      return;
    }

    const response = await this.ctx.ai.generateImage(request);
    res.json(response);
  };

  @CatchErrors()
  interactionEvent = async (req: Request, res: Response) => {
    const event = req.body as InteractionEvents;

    log.debug(`Interaction event: ${JSON.stringify(req.body)}`);

    // V-2: the player's spoken line rides the speech lane (drained before everything else)
    const isPlayerVoice = (event as { source?: string }).source === 'player_voice';
    // The chat window blocks on this response while prefetch traffic is speculative,
    // so chat messages skip ahead of queued prefetch generations
    const isChat = event.event_type === SSEventType.CHAT || event.event_type === SSEventType.CHAT_CONTINUE;
    const result = isPlayerVoice
      ? await this.ctx.generationQueue.runSpeech(() => this.ctx.ai.interactionEvent(event))
      : await this.ctx.generationQueue.runExclusive(() => this.ctx.ai.interactionEvent(event), {
          priority: isChat,
        });
    result.input = event;
    // Leading newline so each generation stands apart from the previous one in the game window;
    // memories, TTS, and the app chat UI keep the untouched text. Classic mode sends it verbatim.
    const spacedText = this.ctx.settings.directedScenesEnabled && result.text ? `\n${result.text}` : result.text;
    res.json({ ...result, text: spacedText });
    if (result.text) {
      sendChatGeneration(result);
    }
  };

  @CatchErrors()
  interactionPrefetch = async (req: Request, res: Response) => {
    const request = req.body as InteractionPrefetchRequest;
    log.debug(`Interaction prefetch: ${request.correlation_id}`);
    res.json(await this.ctx.generationQueue.prefetch(request));
  };

  @CatchErrors()
  interactionClaim = async (req: Request, res: Response) => {
    const request = req.body as InteractionClaimRequest;
    log.debug(`Interaction claim: ${request.correlation_id}`);
    const { result, play } = await this.ctx.generationQueue.claim(request);
    play();
    result.input = request.event;
    const spacedText = this.ctx.settings.directedScenesEnabled && result.text ? `\n${result.text}` : result.text;
    res.json({ ...result, text: spacedText });
    if (result.text) {
      sendChatGeneration(result);
    }
  };

  @CatchErrors()
  interactionFinalize = (req: Request, res: Response) => {
    const request = req.body as InteractionFinalizeRequest;
    res.json({ ok: true, found: this.ctx.generationQueue.finalize(request.correlation_id) });
  };

  @CatchErrors()
  interactionCancel = (req: Request, res: Response) => {
    const request = req.body as InteractionFinalizeRequest;
    res.json({ ok: true, found: this.ctx.generationQueue.cancel(request.correlation_id) });
  };

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

  @CatchErrors()
  classificationEvent = async (req: Request, res: Response) => {
    const event = req.body as ClassificationRequest;

    const result = await this.ctx.ai.runClassification(event);
    res.json(result);
    if (result.text) {
      sendChatGeneration(result);
    }
  };

  @CatchErrors()
  buffDescription = async (req: Request, res: Response) => {
    const event = req.body as BuffDescriptionRequest;

    const result = await this.ctx.ai.runBuffDescription(event);
    res.json(result);
    if (result.text) {
      sendChatGeneration(result);
    }
  };

  @CatchErrors()
  buffEvent = async (req: Request, res: Response) => {
    const event = req.body as BuffEventRequest;

    res.json({ ok: 'ok' });
    await this.ctx.ai.runBuff(event);
  };

  @CatchErrors({ statusCode: 500 })
  getModels = async (req: Request, res: Response) => {
    const { apiType } = req.query;
    const result = await this.ctx.ai.getModels(
      typeof apiType === 'string' && apiType !== '' ? ApiTypeFromValue(apiType) : undefined,
    );
    res.json(result);
  };

  // Dev-mode AI log: every provider call this app session made, newest first.
  @CatchErrors()
  getExchanges = (req: Request, res: Response) => {
    const { limit } = req.query;
    const parsedLimit = typeof limit === 'string' ? Number(limit) : undefined;
    res.json(this.ctx.aiExchangeLog.list(parsedLimit && parsedLimit > 0 ? parsedLimit : undefined));
  };

  @CatchErrors()
  getExchange = (req: Request, res: Response) => {
    const exchangeId = Number(req.params.exchangeId);
    const exchange = this.ctx.aiExchangeLog.get(exchangeId);
    if (!exchange) {
      res.status(404).json({ error: `No AI exchange ${exchangeId}` });
      return;
    }
    res.json(exchange);
  };

  // F5: the graded outcome log for the loaded save, newest first. `verdict=suspect` is
  // the query the night watch and the bench ask — "did the action loop lie during this
  // window?" — which used to need someone reading the log as it scrolled past.
  @CatchErrors()
  getOutcomes = (req: Request, res: Response) => {
    const { sim_id: simId, verdict, limit } = req.query;
    const parsedLimit = typeof limit === 'string' ? Number(limit) : undefined;
    res.json(
      this.ctx.outcomeVerdict.list({
        simId: typeof simId === 'string' ? simId : undefined,
        verdict: typeof verdict === 'string' ? (verdict as OutcomeVerdict) : undefined,
        limit: parsedLimit && parsedLimit > 0 ? parsedLimit : undefined,
      }),
    );
  };

  // Tier-0 run-validity gate over the loaded save: machinery text stored as a diary, and
  // phantom successes written as truth. An empty array means the save is scoreable.
  @CatchErrors()
  getTier0 = (_req: Request, res: Response) => {
    const diaries = this.ctx.memoryRepository.getRecentReflections(2000).map((memory) => ({
      id: memory.id,
      // Reflection rows are stored name-prefixed ("<Name> (diary): ...")
      text: (memory.content ?? '').replace(/^.*?\(diary\):\s*/, ''),
    }));
    const outcomes = this.ctx.outcomeVerdict.list({ limit: 5000 });
    res.json({ violations: runTier0({ diaries, outcomes }), diaries: diaries.length, outcomes: outcomes.length });
  };

  @CatchErrors()
  tts = (req: Request, res: Response) => {
    const { text } = req.query;

    if (!text) {
      res.status(400).json({ error: 'Must include text query parameter' });
      return;
    }

    playTTS(text as string);

    res.status(200).json({ text });
  };
}
