import { Request, Response } from 'express';
import log from 'electron-log';
import { InteractionEvents, SSEventType } from '../models/InteractionEvents';
import { sendChatGeneration } from '../util/notifyRenderer';
import { rememberSims } from '../util/knownSims';
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
    // A game event is stamped on arrival: the scene it becomes may wait in the queue
    // behind other scenes, and it is dropped rather than aired once the game has moved on
    const isGameEvent = event.event_type === SSEventType.INTERACTION || event.event_type === SSEventType.CONTINUE;
    const eventAt = Date.now();

    // (an older mod may post an event without a cast; Array.isArray keeps that alive)
    if (Array.isArray(event.sentient_sims)) {
      rememberSims(event.sentient_sims);
    }
    if (isGameEvent && Array.isArray(event.sentient_sims)) {
      this.ctx.sceneFreshness.recordEvent(
        event.sentient_sims.map((sim) => ({ simId: sim.sim_id, name: sim.name })),
        eventAt,
      );
    }
    const meta = isGameEvent ? { eventAt } : undefined;
    const result = isPlayerVoice
      ? await this.ctx.generationQueue.runSpeech(() => this.ctx.ai.interactionEvent(event, meta))
      : await this.ctx.generationQueue.runExclusive(
          ({ arrivedAt }) => this.ctx.ai.interactionEvent(event, { ...meta, arrivedAt }),
          { priority: isChat, blocking: true },
        );
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
    const { result: generated, play } = await this.ctx.generationQueue.claim(request);
    // A scene that declined to air (the game moved on while it waited) must not be
    // handed to the mod as text either: it would be stored as a memory nobody heard
    const result = !play() ? { status: InteractionEventStatus.NOOP } : generated;
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
}
