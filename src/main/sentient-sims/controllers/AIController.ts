import { Request, Response } from 'express';
import log from 'electron-log';
import { InteractionEvents, SSEventType, SSEvent } from '../models/InteractionEvents';
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
import { BatteryQuestion, buildQuestions, gradeBattery } from '../bench/selfKnowledge';

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

  /**
   * The self-and-relationship battery (Phase 3.1 H5): ten questions a Sim should be able
   * to answer about itself, put through the same path as overlay chat and graded against
   * the dossier the mod reported.
   *
   * The event comes from the mod, because only the mod can build a real one - the caller
   * is the game or a dev helper, not a synthetic fixture. Answers go through
   * runDirectedGeneration with a playerLine, which is the only way into the chat path
   * (the directed-scene route cannot set one).
   */
  @CatchErrors()
  selfKnowledge = async (req: Request, res: Response) => {
    const simId = Array.isArray(req.params.simId) ? req.params.simId[0] : req.params.simId;
    const body = req.body as { event?: SSEvent; only?: string[]; speaker?: string };
    const dossier = this.ctx.semanticMemory.readDossier(simId);
    if (!dossier) {
      return res.status(404).json({
        error: `no dossier stored for sim ${simId}; the mod reports one on zone load and on change`,
      });
    }
    if (!body.event || !Array.isArray(body.event.sentient_sims) || body.event.sentient_sims.length === 0) {
      return res.status(400).json({ error: 'event with one sentient sim is required' });
    }
    // R2 (2026-09-04): an event with no environment used to reach buildPromptRequest and
    // throw on `location_id`, and @CatchErrors pops a renderer notification on every throw.
    // Something posted exactly that shape every 30 s on 2026-09-03 (HANDOFF-RECUT-2026-09-04.md);
    // whatever it was, a malformed bench event is a 400 now, never a popup.
    // The type says environment is always there; the wire does not
    const environment = (body.event as { environment?: { location_id?: number } }).environment;
    if (environment?.location_id === undefined) {
      return res.status(400).json({
        error: 'event.environment.location_id is required; build the event with bench_helpers.build_single_sim_event',
      });
    }

    // "What did you do earlier today" is graded against real rows, so it is only asked
    // when there are some.
    //
    // 2026-09-05: this used to ask getRecentReflectionsForParticipants, which returns rows
    // the Sim was a PARTICIPANT in - and a reflection lists everyone who was in the scene,
    // so a toddler's "today" came back as his parents' diaries about him, spanning several
    // days, with none of his own rows in it. His correct answer ("I tried to dance", and the
    // game had logged exactly that) could not be graded because the thing he did was not in
    // the oracle. Own rows, this game day, other people's diaries left out.
    const gameDay = this.ctx.simStateCache.getReport()?.lot?.clock?.absolute_day;
    const todaysMemories =
      gameDay === undefined
        ? []
        : this.ctx.memoryRepository
            .getOwnDayMemories(simId, gameDay, 20)
            .map((memory) => ({ content: memory.content ?? '', interaction: memory.interaction_name }))
            .filter((activity) => activity.content);

    // Resolved before the questions are built: the speaker's name belongs in knownNames, or
    // a Sim answering the person in front of it by name is reported as a confabulation.
    const speaker = body.speaker || this.ctx.settings.playerSpeakerName || 'Someone';
    const genders = this.ctx.semanticMemory.gendersFor((dossier.relationships ?? []).map((edge) => edge.sim_id));
    const all = buildQuestions(dossier, todaysMemories, speaker, genders);
    const questions = body.only?.length ? all.filter((question) => body.only?.includes(question.id)) : all;

    const answers: { question: BatteryQuestion; answer: string; exchangeIds?: number[] }[] = [];
    for (const question of questions) {
      // Sequential on purpose: the battery is a conversation, and asking a Sim ten things
      // at once would let each answer be written without the others in the transcript.

      // Which provider calls this answer came from. Every stage of the scene logs one, and
      // reading a graded answer's prompt used to mean scrolling the exchange log guessing
      // at timestamps.
      const before = this.ctx.aiExchangeLog.list(1).at(0)?.id ?? 0;
      const result = await this.ctx.ai.runDirectedGeneration(body.event, {
        playerLine: { speaker, text: question.question },
        // The battery is a measurement, not a scene: its answers must not become memories
        // the Sim then remembers having said.
        saveMemory: false,
      });
      const exchangeIds = this.ctx.aiExchangeLog
        .list(20)
        .map((entry) => entry.id)
        .filter((id) => id > before)
        .sort((a, b) => a - b);
      answers.push({ question, answer: result.text ?? '', exchangeIds });
    }

    const graded = gradeBattery(simId, dossier.name, answers);
    log.info(
      `[Bench] self-knowledge for ${dossier.name ?? simId}: ${graded.passed}/${graded.total}` +
        (graded.contradictions.length > 0 ? `, ${graded.contradictions.length} contradiction(s)` : '') +
        (graded.warnings.length > 0 ? `, ${graded.warnings.length} unknown name(s)` : ''),
    );
    return res.json(graded);
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
