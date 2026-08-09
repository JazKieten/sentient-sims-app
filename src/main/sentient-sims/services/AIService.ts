import log from 'electron-log';
import {
  ChatContinueInteractionEvent,
  ChatInteractionEvent,
  ContinueInteractionEvent,
  DoSomethingInteractionEvent,
  InteractionEvent,
  InteractionEvents,
  InteractionMappingEvent,
  SSEvent,
  SSEventType,
  WWEventType,
  WWInteractionEvent,
  WantsInteractionEvent,
} from '../models/InteractionEvents';
import { getRandomItem } from '../util/getRandomItem';
import { isDegeneratePreAction } from '../util/degeneratePreAction';
import { InteractionEventResult, InteractionEventStatus, LLMExchange } from '../models/InteractionEventResult';
import {
  notifyMapAnimation,
  notifyMapInteraction,
  playTTS,
  playTTSLines,
  sendChatGeneration,
  sendSceneLineToMod,
} from '../util/notifyRenderer';
import { markScenePaced } from '../util/pacedScenes';
import { GenerationOptions, PromptRequestBuilderOptions } from './PromptRequestBuilderService';
import { containsPlayerSim } from '../util/eventContainsPlayerSim';
import { ApiType } from '../models/ApiType';
import { defaultClassificationPrompt, playerVoiceSpeaker } from '../constants';
import {
  BuffEventRequest,
  BuffDescriptionRequest,
  ClassificationRequest,
  OneShotRequest,
  OpenAIRequestBuilder,
} from '../models/OpenAIRequestBuilder';
import { OpenAICompatibleRequest } from '../models/OpenAICompatibleRequest';
import { DirectedSceneRequest } from '../models/DirectedSceneRequest';
import { SentientSim } from '../models/SentientSim';
import {
  cleanAIClassificationOutput,
  cleanupAIOutput,
  DialogueLine,
  escapeRegExp,
  formatSceneForChatWindow,
  formatAction,
  formatListToString,
  isDegenerateOutput,
  parseDialogueLines,
  splitLinesForPacing,
} from '../formatter/PromptFormatter';
import { MemoryEntity } from '../db/entities/MemoryEntity';
import { InputFormatter } from '../formatter/InputOutputFormatting';
import { MythoMaxFormatter } from '../formatter/MythoMaxFormatter';
import { NovelAIFormatter } from '../formatter/NovelAIFormatter';
import { AIModel } from '../models/AIModel';
import { DefaultFormatter } from '../formatter/DefaultFormatter';
import { InteractionDescription } from '../descriptions/interactionDescriptions';
import { sendModNotification } from '../websocketServer';
import { ModAddBuff, ModWebsocketMessageType } from '../models/ModWebsocketMessage';
import { ParticipantDTO } from '../db/dto/ParticipantDTO';
import { ApiContext } from './ApiContext';
import { AIActionType, actionTypeForEvent } from '../models/AIActionType';
import { SceneState } from './SceneService';
import { MemoryTrace } from '../models/MemoryTrace';

// Actors are asked for a bare subtitle, but models still sneak in speaker labels,
// quotation marks, and parenthetical notes — strip everything but the spoken words
function extractSubtitle(rawText: string, speakerNames: string[]): string {
  const cleaned = cleanupAIOutput(rawText);
  let subtitle =
    cleaned
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
  speakerNames.forEach((name) => {
    subtitle = subtitle.replace(new RegExp(`^${escapeRegExp(name)}\\s*:\\s*`, 'i'), '');
  });
  subtitle = subtitle.replace(/^\([^)]*\)\s*/, '');
  const quoted = /^"(.*)"$/s.exec(subtitle);
  if (quoted) {
    subtitle = quoted[1];
  }
  return subtitle.trim();
}

// Actors answer in a two-line SAY/THINK format. Models drift — labels missing, reordered,
// text on the line after the label — so parsing is tolerant: tagged lines win, and with no
// tags at all the first non-empty line is taken as the spoken one (the pre-monologue shape).
export function parseActorPerformance(rawText: string, speakerNames: string[]): { say: string; think: string } {
  const lines = cleanupAIOutput(rawText)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  let say = '';
  let think = '';
  let pendingTag: 'SAY' | 'THINK' | undefined;
  const untagged: string[] = [];
  const assign = (tag: 'SAY' | 'THINK', text: string) => {
    if (tag === 'SAY' && !say) {
      say = text;
    } else if (tag === 'THINK' && !think) {
      think = text;
    }
  };
  lines.forEach((line) => {
    const tagMatch = /^(SAY|THINK)\s*[:-]\s*(.*)$/i.exec(line);
    if (tagMatch) {
      const tag = tagMatch[1].toUpperCase() as 'SAY' | 'THINK';
      const text = extractSubtitle(tagMatch[2], speakerNames);
      if (text) {
        assign(tag, text);
        pendingTag = undefined;
      } else {
        // Bare label — the text is on the next line
        pendingTag = tag;
      }
      return;
    }
    if (pendingTag) {
      assign(pendingTag, extractSubtitle(line, speakerNames));
      pendingTag = undefined;
      return;
    }
    untagged.push(line);
  });
  if (!say && untagged.length > 0) {
    say = extractSubtitle(untagged.join('\n'), speakerNames);
  }
  return { say, think };
}

// Per-character verdicts from the scores stage: how memorable the scene was for them and
// how strongly it leaves them wanting to change course (the Action Score that, over
// threshold, will promote them into an Action Scene).
export type SceneScore = { memory: number; action: number; action_reason?: string };

// The scores stage answers with one JSON object mapping character names to their scores.
// Tolerant of prose around the JSON, string numbers, and out-of-range values (clamped 1-10);
// unknown names are dropped rather than guessed.
export function parseSceneScores(rawText: string, names: string[]): Map<string, SceneScore> {
  const scores = new Map<string, SceneScore>();
  const jsonMatch = /\{[\s\S]*\}/.exec(rawText);
  if (!jsonMatch) {
    return scores;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return scores;
  }
  if (!parsed || typeof parsed !== 'object') {
    return scores;
  }
  const clamp = (value: unknown): number | undefined => {
    const num = typeof value === 'string' ? Number(value) : value;
    if (typeof num !== 'number' || Number.isNaN(num)) {
      return undefined;
    }
    return Math.min(10, Math.max(1, Math.round(num)));
  };
  Object.entries(parsed as Record<string, unknown>).forEach(([key, value]) => {
    const name = names.find((candidate) => candidate.toLowerCase() === key.trim().toLowerCase());
    if (!name || !value || typeof value !== 'object') {
      return;
    }
    const verdict = value as { memory?: unknown; action?: unknown; action_reason?: unknown };
    const memory = clamp(verdict.memory);
    const action = clamp(verdict.action);
    if (memory === undefined && action === undefined) {
      return;
    }
    scores.set(name, {
      memory: memory ?? 3,
      action: action ?? 1,
      action_reason: typeof verdict.action_reason === 'string' ? verdict.action_reason : undefined,
    });
  });
  return scores;
}

// The reviewer returns one `Name: line` per row; rows that don't start with a known
// speaker (commentary, headers) are discarded
function parseReviewedLines(rawText: string, speakerNames: string[]): DialogueLine[] {
  const lines: DialogueLine[] = [];
  cleanupAIOutput(rawText)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .forEach((line) => {
      const name = speakerNames.find((speaker) => new RegExp(`^${escapeRegExp(speaker)}\\s*:`, 'i').test(line));
      if (name) {
        const text = extractSubtitle(line, speakerNames);
        if (text.length > 1) {
          lines.push({ speaker: name, text });
        }
      }
    });
  return lines;
}

function toTranscript(lines: DialogueLine[]): string {
  return lines.map((line) => `${line.speaker}: ${line.text}`).join('\n');
}

export type DirectedGenerationOptions = {
  action?: string;
  continueScene?: boolean;
  // A chat beat opens with a line the player already typed: it drives the scene and seeds the
  // transcript the actors reply to, the sim who said it takes no actor turn, and it stays out
  // of the aired scene (the mod already showed it, and it rides along as the memory's action)
  playerLine?: DialogueLine;
  directorModel?: string;
  // Parallel to event.sentient_sims order
  actorModels?: (string | undefined)[];
  // Real game events return the memory to the mod, which saves it back via POST /memories
  // when the interaction completes; the scenario tester has no mod, so it saves directly
  saveMemory?: boolean;
};

export type DeferredInteractionResult = {
  result: InteractionEventResult;
  play: () => void;
};

type PlaybackOptions = {
  deferPlayback?: boolean;
  onPlaybackReady?: (play: () => void) => void;
  // Speak the whole output as this speaker. First-person generations (wants) have no
  // `Name:` prefix, so without this the dialogue parser falls back to Narrator and TTS
  // loses the sim's cast/pinned voice.
  ttsSpeaker?: string;
  // Stream the output to the game as paced scene lines (subtitle per line, timed to
  // playback) instead of suppressing it with the unpaced memory block — for solo
  // player-directed generations that should still show on screen.
  pacedSubtitles?: boolean;
};

export type ResolvedInteractionPreAction =
  | { preAction: string; result?: never }
  | { preAction?: never; result: InteractionEventResult };

function once(callback: () => void): () => void {
  let called = false;
  return () => {
    if (!called) {
      called = true;
      callback();
    }
  };
}

// FLOODGATES EXPERIMENT: a group social keeps every member of the conversation as a
// performer (a three-sim discussion plays as a three-sim scene) instead of narrowing to
// an actor+partner pair. Beyond the cap, the in-game actor keeps the first slot
// (pre-actions attribute the interaction to them), the player sim is always kept, and
// the rest fill randomly. Relationships are trimmed to the kept set — the event carries
// pairwise bits for the whole group, and bits referencing sims outside the event crash
// formatSims' lookup.
export const MAX_SCENE_PERFORMERS = 8;
export function toPrimaryInteractionEvent<T extends SSEvent>(event: T): T {
  if (event.sentient_sims.length <= MAX_SCENE_PERFORMERS) {
    return event;
  }
  const [actor, ...others] = event.sentient_sims;
  const playerSim = actor.is_player_sim ? undefined : others.find((sim) => sim.is_player_sim);
  const kept = [actor, ...(playerSim ? [playerSim] : [])];
  const pool = others.filter((sim) => sim !== playerSim);
  while (kept.length < MAX_SCENE_PERFORMERS && pool.length > 0) {
    kept.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  const keptIds = new Set(kept.map((sim) => sim.sim_id));
  return {
    ...event,
    sentient_sims: kept,
    relationships: {
      ...event.relationships,
      relationship_bits: (event.relationships?.relationship_bits ?? []).filter(
        (bit) => keptIds.has(bit.sim_one_id) && keptIds.has(bit.sim_two_id),
      ),
    },
  };
}

export function formatPreviouslyInScene(memories: Array<{ role: string; content: string }>): string {
  return memories
    .map((memory, index) => {
      const previous = memories[index - 1];
      const separator = index > 0 && previous.role === 'assistant' && memory.role === 'user' ? '\n' : '';
      return `${separator}${memory.content}`;
    })
    .join('\n');
}

function getInputFormatters(apiType: ApiType): InputFormatter[] {
  if (apiType === ApiType.CustomAI || apiType === ApiType.KoboldAI) {
    return [new MythoMaxFormatter()];
  }

  if (apiType === ApiType.NovelAI) {
    return [new NovelAIFormatter()];
  }

  return [new DefaultFormatter()];
}

export class AIService {
  private readonly ctx: ApiContext;

  constructor(ctx: ApiContext) {
    this.ctx = ctx;
  }

  async generate(promptRequest: OpenAICompatibleRequest) {
    const providerConfig = this.ctx.providerConfigs.getConfigForAction(AIActionType.GENERATE);
    return this.ctx.aiExchangeLog.runLabeled('Chat Tab Generation', AIActionType.GENERATE, () =>
      this.ctx.getGenerationService(providerConfig.apiType).sentientSimsGenerate({
        ...promptRequest,
        model: promptRequest.model ?? providerConfig.model,
        apiType: promptRequest.apiType ?? providerConfig.apiType,
      }),
    );
  }

  // Logs one LLM stage of a pipeline (prompt + output) to the console/log so the whole
  // directed pipeline can be followed live in the npm dev console.
  private logExchange(exchange: LLMExchange) {
    const prompt = exchange.request.messages.map((message) => `[${message.role}]\n${message.content}`).join('\n\n');
    log.info(
      `[Pipeline] === ${exchange.label} ===\n--- PROMPT ---\n${prompt}\n--- OUTPUT ---\n${exchange.responseText}\n=== end ${exchange.label} ===`,
    );
  }

  // Keeps the pipeline that produced a memory (prompts, director's direction, reviewer
  // before/after) available to the dev-mode Memories UI. Best-effort — a failure here must
  // never break generation.
  private recordTrace(contents: (string | undefined)[], trace: MemoryTrace) {
    try {
      this.ctx.memoryTrace.recordPending(contents, trace);
    } catch (err) {
      log.error('Failed to record memory trace', err);
    }
  }

  // Detects a location change and, if the player travelled, reflects on the scene that just
  // ended before the new scene's first generation runs.
  private async handleSceneBoundary(event: SSEvent) {
    const { boundary, previousScene } = this.ctx.sceneService.checkSceneBoundary(event);
    if (boundary && previousScene) {
      // The event driving this boundary belongs to the NEW location — as do any other prefetches
      // already queued there — so only pending work from other (old) locations is flushed.
      this.ctx.generationQueue.flushToFallback(event.environment.location_id);
      // The traveller is the player's sim — the reflection is their private recollection
      const traveller = event.sentient_sims.find((sentientSim) => sentientSim.is_player_sim);
      await this.runSceneReflection(
        previousScene,
        traveller ? { simId: traveller.sim_id, simName: traveller.name } : undefined,
        'travel',
      );
    }
  }

  // At a scene boundary the sim writes a short diary entry about the stretch that just ended:
  // what happened, how they feel about it now, and the people they spent it with — framed as
  // end-of-day before sleep, or "before I left" on a travel boundary. First person from the
  // pov sim's perspective and owner-stamped to them, exactly like monologue/thought rows
  // (observed live 2026-08-09: with no identity anchor the model wrote a floating observer's
  // review — Marisol's own reflection said "Interacting with Marisol Vega felt natural").
  // Stored tagged event_type='reflection', so it surfaces in the Memories UI and feeds future
  // prompts via the <PAST_REFLECTIONS> block. Best-effort: any failure is logged and swallowed.
  async runSceneReflection(
    previousScene: SceneState,
    pov?: { simId: string; simName: string },
    boundary?: 'sleep' | 'travel',
  ) {
    try {
      const sceneMemories = this.ctx.memoryRepository.getSceneMemories(
        previousScene.locationId,
        previousScene.startedAt,
      );
      // A quick hop through a lot (or a nap right after arriving) isn't a scene worth
      // reflecting on — travel-heavy play was firing reflections back to back
      if (sceneMemories.length < 2) {
        log.info(
          `[Reflection] Scene ${previousScene.sceneId} had ${sceneMemories.length} memories, skipping reflection`,
        );
        return;
      }

      const location = this.ctx.locationRepository.getLocation({ id: previousScene.locationId });
      const participantIds = this.ctx.memoryRepository.getSceneParticipantIds(
        previousScene.locationId,
        previousScene.startedAt,
      );
      const names = this.ctx.participantRepository.getParticipantNames(participantIds);
      // The reflecting sim doesn't get a sentence about "interacting with" themself
      const others = pov ? names.filter((name) => name !== pov.simName) : names;
      const namesList = others.length > 0 ? others.join(', ') : 'the people present';

      const transcript = this.ctx.promptBuilder
        .groupMemories(sceneMemories)
        .map((message) => message.content)
        .join('\n');

      const identity = pov ? `You are ${pov.simName}. ` : '';
      // Diary framing follows the boundary: sleep closes the day, travel closes a visit
      const framing =
        boundary === 'sleep'
          ? `The day is winding down at ${location.name} and you're writing in your diary before sleep.`
          : boundary === 'travel'
            ? `You've just left ${location.name} and are writing in your diary about your time there.`
            : `A stretch of your day at ${location.name} has ended and you're writing it down in your diary.`;
      const othersLine =
        others.length > 0
          ? `Mention each of the people you spent this time with — ${namesList} — what passed between you and how they left you feeling.\n`
          : '';
      const systemPrompt = `${identity}${framing}
Write a short diary entry — a few sentences in your own voice: first person, past tense, plain prose. No headers, no labels, no lists, and no greeting like "Dear Diary" — just the entry itself. Never refer to yourself in the third person.
Sum up what happened and how you feel about it now.
${othersLine}Keep it concise and grounded. Do not invent events that are not in the notes below.`;

      const reflection = await this.runOneShot(
        'Scene Reflection',
        systemPrompt,
        transcript,
        250,
        undefined,
        AIActionType.REFLECTION,
      );
      this.logExchange(reflection.exchange);
      this.recordTrace([cleanupAIOutput(reflection.text)], {
        pipeline: 'scene_reflection',
        exchanges: [reflection.exchange],
      });

      const text = cleanupAIOutput(reflection.text);
      if (text.length <= 1) {
        log.error(`[Reflection] Empty reflection produced for scene ${previousScene.sceneId}`);
        return;
      }

      const reflectionMemory: MemoryEntity = {
        // Name-prefixed like monologue rows ("<Name> (thinking): ...") so the first-person
        // prose stays attributed when it lands in shared blocks like <PAST_REFLECTIONS>
        content: pov ? `${pov.simName} (diary): ${text}` : text,
        location_id: previousScene.locationId,
        event_type: 'reflection',
      };
      const participants: ParticipantDTO[] = participantIds.map((id) => ({ id }));
      // Reflections are internal monologue for retrieval/prompting; notifyMod false keeps
      // the whole reflection prose from being pushed to the mod as one giant subtitle block.
      // Owner-stamped: first-person "I" prose must never surface as another sim's own memory.
      this.ctx.memoryRepository.createMemory(
        { memory: reflectionMemory, participants, index: pov ? { owner: pov.simId } : undefined },
        { notifyMod: false },
      );
      log.info(`[Reflection] Saved reflection for scene ${previousScene.sceneId}: ${text}`);
    } catch (err) {
      log.error(`[Reflection] Failed to generate reflection for scene ${previousScene.sceneId}`, err);
    }
  }

  async interactionEvent(event: InteractionEvents): Promise<InteractionEventResult> {
    await this.handleSceneBoundary(event);

    switch (event.event_type) {
      case SSEventType.DO_SOMETHING:
        return this.handleDoSomething(event as DoSomethingInteractionEvent);
      case SSEventType.CHAT:
        return this.handleChat(event as ChatInteractionEvent);
      case SSEventType.CHAT_CONTINUE:
        return this.handleChatContinue(event);
      case SSEventType.INTERACTION:
        return this.handleInteraction(event as InteractionEvent);
      case SSEventType.WICKED_WHIMS:
        return this.handleWickedWhims(event as WWInteractionEvent);
      case SSEventType.WANTS:
        return this.handleWants(event);
      case SSEventType.CONTINUE:
        return this.handleContinue(event);
      case SSEventType.INTERACTION_MAPPING:
        return this.handleInteractionMapping(event as InteractionMappingEvent);
      default:
        return { status: InteractionEventStatus.NOOP };
    }
  }

  // gateEvent is the un-narrowed event: a group social narrowed to an NPC-NPC pair still
  // belongs to the player's conversation, so player-sim eligibility is judged on the group
  async resolveInteractionPreAction(
    event: InteractionEvent,
    gateEvent: SSEvent = event,
  ): Promise<ResolvedInteractionPreAction> {
    let description: InteractionDescription | undefined;
    if (event.testing_action) {
      description = {
        pre_actions: [event.testing_action],
      };
    } else {
      description = await this.ctx.interactions.getInteractionDescription(event.interaction_name);
    }

    if (description?.ignored === true) {
      return { result: { status: InteractionEventStatus.IGNORED } };
    }

    const hasPlayerSim = containsPlayerSim(gateEvent);
    if (!hasPlayerSim && !description?.always_run) {
      return { result: { status: InteractionEventStatus.NOT_PLAYER_SIM } };
    }

    if (!description) {
      return { result: { status: InteractionEventStatus.UNMAPPED_INTERACTION } };
    }

    if (description.pre_actions) {
      const preAction = getRandomItem(description.pre_actions);
      const location = this.ctx.locationRepository.getLocation({ id: event.environment.location_id });
      const rendered = formatAction(preAction, event.sentient_sims, location);
      if (isDegeneratePreAction(rendered)) {
        // A truncated fragment as the user turn makes the model improvise ("looks like
        // your message got cut off") and that improvisation becomes a permanent memory —
        // safer to skip generation entirely and surface the broken mapping in the log
        log.warn(
          `[PreAction] Degenerate pre_action for '${event.interaction_name}': "${rendered}" — treating as unmapped`,
        );
        return { result: { status: InteractionEventStatus.UNMAPPED_INTERACTION } };
      }
      return { preAction: rendered };
    }

    return { result: { status: InteractionEventStatus.NOOP } };
  }

  createInteractionPreActionFallback(event: InteractionEvent, preAction: string): InteractionEventResult {
    const memory: MemoryEntity = {
      location_id: event.environment.location_id,
      event_type: event.event_type,
      interaction_name: event.interaction_name,
      pre_action: preAction,
    };
    return {
      status: InteractionEventStatus.GENERATED,
      text: preAction,
      memory,
    };
  }

  async handleInteraction(event: InteractionEvent) {
    const primaryEvent = toPrimaryInteractionEvent(event);
    const resolved = await this.resolveInteractionPreAction(primaryEvent, event);
    if (resolved.result) {
      return resolved.result;
    }
    // Everything goes through the directed pipeline: pairs play dialogue + monologue,
    // a lone sim gets a monologue-only beat. There is no single-pass narrator anymore.
    return this.runDirectedGeneration(primaryEvent, { action: resolved.preAction });
  }

  async interactionEventDeferred(
    event: InteractionEvent,
    options: { preAction: string },
  ): Promise<DeferredInteractionResult> {
    const primaryEvent = toPrimaryInteractionEvent(event);
    // Boundary detection intentionally still happens at generation start. A prefetch cancelled
    // later may already have reflected on the previous scene, which is harmless and keeps scene
    // state coherent.
    await this.handleSceneBoundary(primaryEvent);
    let play = () => {};
    const playbackOptions: PlaybackOptions = {
      deferPlayback: true,
      onPlaybackReady: (ready) => {
        play = ready;
      },
    };
    const result = await this.runDirectedGeneration(primaryEvent, { action: options.preAction }, playbackOptions);
    return {
      result,
      play: once(() => {
        play();
      }),
    };
  }

  async handleContinue(event: ContinueInteractionEvent) {
    // Group continues keep the full performer set (capped) like fresh interactions do
    const primaryEvent = toPrimaryInteractionEvent(event);
    if (primaryEvent.sentient_sims.length >= 1) {
      // Directed continue needs prior memories to pick up from; fall through when there are none
      const directed = await this.runDirectedGeneration(primaryEvent, { continueScene: true });
      if (directed.status === InteractionEventStatus.GENERATED) {
        return directed;
      }
    }

    let result = await this.runGeneration(primaryEvent, { continue: true });
    if (!result.text) {
      result = await this.runGeneration(primaryEvent, {
        continue: true,
        preAssistantPreResponse: ' ',
      });
    }
    return result;
  }

  async handleWants(event: WantsInteractionEvent) {
    // A want IS inner monologue: a quiet solo beat where the sim takes stock of what
    // they want right now, played through the same directed pipeline as everything else
    return this.runDirectedGeneration(event, {
      action: '{actor.0} pauses for a moment and takes stock of what they want right now.',
    });
  }

  async handleWickedWhims(event: WWInteractionEvent) {
    if (!this.ctx.animations.isNsfwEnabled()) {
      return { status: InteractionEventStatus.NSFW_DISABLED };
    }

    if (!containsPlayerSim(event)) {
      return { status: InteractionEventStatus.NOOP };
    }

    let preAction;

    const animation = await this.ctx.animations.getAnimation(event.animation_author, event.animation_identifier);

    if (event.ww_event_type === WWEventType.ASKING) {
      preAction = '{actor.0} is asking {actor.1} if they want to go have sex';
    } else if (event.ww_event_type === WWEventType.STARTING) {
      preAction = "{actor.0} is taking {actor.1}'s hand and leading them to start {sex_category} {sex_location}.";
      if (event.sentient_sims.length === 1) {
        preAction = '{actor.0} is walking to start {sex_category} {sex_location}.';
      }
    } else if (event.ww_event_type === WWEventType.ACTIVE) {
      if (event.testing_action) {
        preAction = event.testing_action;
      } else if (animation) {
        preAction = animation.act;
      } else if (this.ctx.animations.isAnimationMappingEnabled()) {
        return { status: InteractionEventStatus.UNMAPPED_ANIMATION };
      } else {
        return { status: InteractionEventStatus.NOOP };
      }
    } else {
      if (animation?.act) {
        event.animation_name = animation.name;
        event.testing_action = animation.act;
      }
      notifyMapAnimation(event);
      return { status: InteractionEventStatus.MAPPING_ANIMATION };
    }

    return this.runGeneration(event, {
      preAction,
      prePreAction: 'At {location} ({location_type}), {postures},',
      sexCategoryType: event.sex_category,
      sexLocationType: event.sex_location,
    });
  }

  async handleDoSomething(doSomethingEvent: DoSomethingInteractionEvent) {
    // Solo Do Something plays as a monologue-only directed beat: the player sees the
    // sim's thought via the memory display instead of narrator prose
    return this.runDirectedGeneration(doSomethingEvent, { action: doSomethingEvent.action });
  }

  async handleChat(chatEvent: ChatInteractionEvent) {
    const primaryEvent = toPrimaryInteractionEvent(chatEvent);
    // sentient_sims[0] is the sim the player typed as — the legacy completion prompt encoded
    // the same assumption as '{actor.0}:' speaking and '{actor.1}:' replying
    const spoken = chatEvent.action.trim();
    if (primaryEvent.sentient_sims.length >= 2 && spoken.length > 0) {
      return this.runDirectedGeneration(primaryEvent, {
        playerLine: { speaker: primaryEvent.sentient_sims[0].name, text: spoken },
      });
    }
    if (primaryEvent.sentient_sims.length === 1 && spoken.length > 0) {
      // Solo voice chat: nobody else can hear, so the player speaks directly TO their
      // sim as The Voice. The non-sim speaker keeps the directed pipeline in dialogue
      // mode (a playerLine suppresses monologue-only), the sim answers aloud, and the
      // exchange persists only as the sim's memory — no game social is staged.
      return this.runDirectedGeneration(primaryEvent, {
        playerLine: { speaker: playerVoiceSpeaker, text: spoken },
      });
    }
    return this.runGeneration(chatEvent, {
      action: chatEvent.action,
      prePreAction: '{actor.0}:',
      preAssistantPreResponse: '{actor.1}:',
      stopTokens: ['{actor.0}:', '{actor.1}:'],
    });
  }

  async handleChatContinue(chatContinueEvent: ChatContinueInteractionEvent) {
    const primaryEvent = toPrimaryInteractionEvent(chatContinueEvent);
    if (primaryEvent.sentient_sims.length >= 2) {
      // Directed continue needs prior memories to pick up from; fall through when there are none
      const directed = await this.runDirectedGeneration(primaryEvent, { continueScene: true });
      if (directed.status === InteractionEventStatus.GENERATED) {
        return directed;
      }
    }
    return this.runGeneration(chatContinueEvent, {
      preAssistantPreResponse: '{actor.1}:',
      stopTokens: ['{actor.0}:', '{actor.1}:'],
    });
  }

  async runGeneration(
    event: InteractionEvents,
    options: GenerationOptions = {},
    playbackOptions: PlaybackOptions = {},
  ): Promise<InteractionEventResult> {
    const providerConfig = this.ctx.providerConfigs.getConfigForAction(actionTypeForEvent(event.event_type));
    log.debug(
      `Using provider config for ${event.event_type}: ${providerConfig.name} (${providerConfig.apiType}${providerConfig.model ? `, ${providerConfig.model}` : ''})`,
    );

    const promptOptions: PromptRequestBuilderOptions = {
      action: options.action,
      sexCategoryType: options.sexCategoryType,
      sexLocationType: options.sexLocationType,
      preAssistantPreResponse: options.preAssistantPreResponse,
      assistantPreResponse: options.assistantPreResponse,
      preAction: options.preAction,
      prePreAction: options.prePreAction,
      stopTokens: options.stopTokens,
      apiType: providerConfig.apiType,
      modelSettings: await this.ctx.modelSettings.getModelSettings(providerConfig.model, providerConfig.apiType),
      continue: options.continue,
      promptHistoryMode: options.promptHistoryMode,
    };

    let promptRequest = await this.ctx.promptBuilder.buildPromptRequest(event, promptOptions);

    // save memory before any model specific formatting
    const newMemory: MemoryEntity = {
      location_id: event.environment.location_id,
      event_type: event.event_type,
    };
    if (promptRequest.preAction) {
      newMemory.pre_action = promptRequest.preAction;
    }
    if (promptRequest.action) {
      newMemory.action = promptRequest.action;
    }

    if ('interaction_name' in event) {
      newMemory.interaction_name = event.interaction_name;
    } else if ('animation_name' in event) {
      newMemory.interaction_name = event.animation_name;
    }

    getInputFormatters(promptOptions.apiType).forEach((formatter) => {
      promptRequest = formatter.formatInput(promptRequest);
    });

    const openAIRequestBuilder = new OpenAIRequestBuilder(this.ctx.getTokenCounter(providerConfig.apiType));
    const openAIRequest = openAIRequestBuilder.buildOpenAIRequest(promptRequest);
    openAIRequest.model = providerConfig.model;
    openAIRequest.apiType = providerConfig.apiType;

    const generationAction = actionTypeForEvent(event.event_type);
    const response = await this.ctx.aiExchangeLog.runLabeled('Scene Generation', generationAction, () =>
      this.ctx.getGenerationService(providerConfig.apiType).sentientSimsGenerate(openAIRequest),
    );

    this.logExchange({ label: 'Scene Generation', request: openAIRequest, responseText: response.text });

    const stopTokens: string[] = [];
    // TODO: model specific OUTPUT formatting cleanup stop tokens
    if (
      promptOptions.apiType === ApiType.SentientSimsAI ||
      promptOptions.apiType === ApiType.CustomAI ||
      promptOptions.apiType === ApiType.KoboldAI
    ) {
      stopTokens.push('### Input:');
      stopTokens.push('### Response:');
      stopTokens.push('### Response: (length = medium)');
    }
    promptRequest.stopTokens?.forEach((stopToken) => {
      stopTokens.push(stopToken);
    });

    log.debug(`stop tokens: ${JSON.stringify(stopTokens, null, 2)}`);

    // TODO: Add an options for formatted stop tokens that aren't necessarily in the prompt
    const postProcessOutput = (rawText: string): string => {
      let processed = cleanupAIOutput(rawText, stopTokens);

      // Remove preAssistantPreResponse from output
      if (promptRequest.preAssistantPreResponse && processed.startsWith(promptRequest.preAssistantPreResponse.trim())) {
        processed = processed.substring(promptRequest.preAssistantPreResponse.trim().length).trim();
      }

      if (promptRequest.assistantPreResponse && !processed.startsWith(promptRequest.assistantPreResponse)) {
        processed = [promptRequest.assistantPreResponse, processed].join(' ').trim();
      }

      const lastMessage = openAIRequest.messages[openAIRequest.messages.length - 1];

      if (lastMessage.role === 'assistant' && processed.startsWith(lastMessage.content)) {
        processed = processed.replace(lastMessage.content, '').trim();
      }

      return processed.trim();
    };

    let output = postProcessOutput(response.text);

    // A sampler blowup produces token soup; without this check it gets stored as a
    // memory and displayed to the player verbatim. Retry once, then discard.
    if (output.length > 1 && isDegenerateOutput(output)) {
      log.error(`[Generation] Degenerate output detected, retrying once: ${output.slice(0, 200)}`);
      const retryResponse = await this.ctx.aiExchangeLog.runLabeled(
        'Scene Generation (degenerate retry)',
        generationAction,
        () => this.ctx.getGenerationService(providerConfig.apiType).sentientSimsGenerate(openAIRequest),
      );
      this.logExchange({
        label: 'Scene Generation (degenerate retry)',
        request: openAIRequest,
        responseText: retryResponse.text,
      });
      output = postProcessOutput(retryResponse.text);
      if (isDegenerateOutput(output)) {
        log.error(`[Generation] Output still degenerate after retry, discarding`);
        output = '';
      }
    }

    if (output.length > 1) {
      const rawSceneText = output;
      const directorReview = await this.runDirectorReview(rawSceneText, actionTypeForEvent(event.event_type));
      output = directorReview.text;
      newMemory.content = output;

      const play = once(() => {
        if (playbackOptions.pacedSubtitles) {
          // Same paced pipeline as directed scenes: the memory block's subtitle is
          // suppressed (paced flag on memory_created) and each line reaches the mod
          // as it starts playing
          markScenePaced(output);
          const lines = splitLinesForPacing(
            parseDialogueLines(
              output,
              event.sentient_sims.map((sim) => sim.name),
            ),
          );
          this.playTtsLines(lines, event.sentient_sims, { paced: true, pacedText: output });
        } else if (playbackOptions.ttsSpeaker) {
          this.playTtsLines([{ speaker: playbackOptions.ttsSpeaker, text: output }], event.sentient_sims);
        } else {
          this.playTts(output, event.sentient_sims);
        }
      });
      if (playbackOptions.deferPlayback) {
        playbackOptions.onPlaybackReady?.(play);
      } else {
        play();
      }

      const exchanges: LLMExchange[] = [
        { label: 'Scene Generation', request: openAIRequest, responseText: rawSceneText },
        { label: 'Director Review', request: directorReview.request, responseText: directorReview.text },
      ];

      this.recordTrace([newMemory.content], {
        pipeline: 'scene_generation',
        exchanges,
        review: {
          before: rawSceneText,
          after: directorReview.text,
          usedReviewerCut: directorReview.usedReview,
        },
      });

      return {
        status: InteractionEventStatus.GENERATED,
        text: formatSceneForChatWindow(output),
        request: response.request,
        exchanges,
        memory: newMemory,
      };
    }

    log.error(`There wasn't any output from the AI`);
    return {
      status: InteractionEventStatus.NOOP,
      request: response.request,
    };
  }

  async runDirectorReview(
    text: string,
    actionType: AIActionType = AIActionType.DIRECTED_SCENE_REVIEWER,
  ): Promise<{ text: string; request: OpenAICompatibleRequest; usedReview: boolean }> {
    const systemPrompt = `You are a director reviewing a short generated scene from The Sims. Fix any issues and return only the corrected text — no commentary, no labels, no extra formatting.

Fix these issues if present:
- Remove invented physical actions, props, furniture, or locations not already established in the scene
- Remove references to invented shared history or past events ("that time we...", "remember when...", specific past anecdotes)
- Remove overly cinematic, melodramatic, or poetic language — keep it grounded and everyday
- Replace physical action beats with delivery notes (how a character sounds or feels) if applicable, or remove them entirely and leave pure dialogue
- Remove trailing incomplete sentences
- Put each character's line on its own line
Never cut the scene down to a single line when multiple characters speak — preserve the back-and-forth between them.
Only change a line when it violates one of the rules above. Otherwise keep the exact wording and character voice — puns, verbal tics, hesitations, and slang are performance choices, not mistakes.
If the scene is already good, return it unchanged.`;

    const oneShot = await this.runOneShot('Director Review', systemPrompt, text, 300, undefined, actionType);
    this.logExchange(oneShot.exchange);
    const reviewed = cleanupAIOutput(oneShot.text);
    const usedReview = reviewed.length > 1;
    return { text: usedReview ? reviewed : text, request: oneShot.exchange.request, usedReview };
  }

  async runOneShot(
    label: string,
    systemPrompt: string,
    userText: string,
    maxResponseTokens: number,
    model?: string,
    actionType: AIActionType = AIActionType.GENERATE,
  ): Promise<{ exchange: LLMExchange; text: string }> {
    const providerConfig = this.ctx.providerConfigs.getConfigForAction(actionType);
    let oneShotRequest: OneShotRequest = {
      systemPrompt,
      messages: [userText],
      maxResponseTokens,
      maxTokens: 3900,
    };

    getInputFormatters(providerConfig.apiType).forEach((formatter) => {
      oneShotRequest = formatter.formatOneShotRequest(oneShotRequest);
    });

    const openAIRequestBuilder = new OpenAIRequestBuilder(this.ctx.getTokenCounter(providerConfig.apiType));
    const openAIRequest = openAIRequestBuilder.buildOneShotOpenAIRequest(oneShotRequest);
    // An explicit model (scenario tester's per-stage picks) wins over the action's provider config
    openAIRequest.model = model ?? providerConfig.model;
    openAIRequest.apiType = providerConfig.apiType;
    const response = await this.ctx.aiExchangeLog.runLabeled(label, actionType, () =>
      this.ctx.getGenerationService(providerConfig.apiType).sentientSimsGenerate(openAIRequest),
    );
    return { exchange: { label, request: openAIRequest, responseText: response.text }, text: response.text };
  }

  async runDirectedScene(request: DirectedSceneRequest): Promise<InteractionEventResult> {
    const { event } = request;
    await this.handleSceneBoundary(event);
    if ((!event.testing_action && !request.continueScene) || event.sentient_sims.length < 1) {
      log.error('Directed scene requires a testing_action and at least one sim');
      return { status: InteractionEventStatus.NOOP };
    }
    return this.runDirectedGeneration(event, {
      action: event.testing_action,
      continueScene: request.continueScene,
      directorModel: request.directorModel,
      actorModels: request.actorModels,
      // The scenario tester has no game mod to save the memory, so persist it here
      saveMemory: true,
    });
  }

  async runDirectedGeneration(
    event: SSEvent,
    options: DirectedGenerationOptions,
    playbackOptions: PlaybackOptions = {},
  ): Promise<InteractionEventResult> {
    const directorConfig = this.ctx.providerConfigs.getConfigForAction(AIActionType.DIRECTED_SCENE_DIRECTOR);
    const promptOptions: PromptRequestBuilderOptions = {
      action: options.action,
      apiType: directorConfig.apiType,
      modelSettings: await this.ctx.modelSettings.getModelSettings(directorConfig.model, directorConfig.apiType),
    };
    const promptRequest = await this.ctx.promptBuilder.buildPromptRequest(event, promptOptions);

    // promptRequest.location is already wrapped in <LOCATION> tags
    const sceneContext = [
      promptRequest.location,
      promptRequest.dateTime,
      promptRequest.season,
      promptRequest.weather,
      promptRequest.postures,
      promptRequest.participants,
    ]
      .filter((part) => part && part.trim().length > 0)
      .join('\n');

    const recentMemories = promptRequest.memories.slice(-6);
    const previously = formatPreviouslyInScene(recentMemories);
    const previouslyBlock = previously ? `Previously in this scene:\n${previously}\n\n` : '';

    // Continuing a scene re-uses the same event; driving it with the original action again
    // would just replay the same beat, so swap in a continuation instruction instead
    const continuingScene = Boolean(options.continueScene) && previously.length > 0;
    const { playerLine } = options;
    const simNames = event.sentient_sims.map((sim) => sim.name);
    // The player's line is already spoken, so that sim takes no turn — everyone else replies to it
    const performers = event.sentient_sims.filter((sim) => !playerLine || sim.name !== playerLine.speaker);
    const performerNames = performers.map((sim) => sim.name);

    let sceneAction: string | undefined;
    if (continuingScene) {
      sceneAction =
        'The scene continues. Pick up the conversation exactly where it left off and move it forward — do not repeat or rephrase anything already said.';
    } else if (playerLine) {
      const audience = performerNames.length > 0 ? ` to ${formatListToString(performerNames)}` : '';
      sceneAction = `${playerLine.speaker} just said${audience}: "${playerLine.text}" — play the reply. Answer what was actually said, in the flow of the conversation already underway.`;
    } else {
      sceneAction = promptRequest.action ?? options.action;
    }

    if (!sceneAction || performers.length === 0) {
      log.error('Directed generation has no action to drive the scene');
      return { status: InteractionEventStatus.NOOP };
    }

    // A lone sim runs the same pipeline with the dialogue stage NULLed: director, then
    // inner monologue only, then scores. There is no narrator — a solo beat is a thought.
    const monologueOnly = performers.length === 1 && !playerLine;

    const exchanges: LLMExchange[] = [];

    // 1. Director splits the full context into one complete, self-contained prompt per actor
    const soloNote = monologueOnly
      ? `\n\nThis is a SOLO beat: ${performerNames[0]} is alone with what they are doing — there is no conversation, and the actor will deliver only private inner monologue. The Inner life direction carries the whole scene.`
      : '';
    const briefingSystemPrompt = `You are directing a scene of a show starring sentient Sims — this episode features ${simNames.join(' and ')}. The audience tunes in because these characters feel truly alive: vivid, compelling, full of personality. You have the FULL scene context below; the user message tells you what is happening right now. First decide what kind of scene this wants to be, then write one shared SCENE briefing plus one private briefing per actor. Each actor will see ONLY the shared briefing and their own private briefing — nothing else — so together they must contain everything that actor needs to play the scene.${soloNote}

${sceneContext}

Choosing the genre: read the characters, their moods, their history, and what is happening, then commit to the genre that fits this moment best — sitcom, rom-com, thriller, tragedy, reality-show drama, farce, noir, slow-burn romance, anything. Do not default to comedy; a heartbreak plays as tragedy, a scheme plays as a caper, a confrontation plays as a thriller. If the conversation is already underway, keep the genre it is already playing in unless the scene has clearly turned.

The shared SCENE briefing must cover, in under 60 words:
- Genre and tone: the genre you chose and how the delivery should sound — the scene has one register, and this sets it for every actor
- Setting: where and when the scene takes place
- Situation: what is happening right now

Each actor's private briefing must cover, in under 100 words:
- Role: "You are playing <name>." — their personality, current mood, and how it colors this moment
- Want: what their character wants out of this scene
- Angle: the specific attitude or feeling to play, and how they carry themselves in this conversation
- Inner life: one line of direction for the private thought running underneath the performance — what this character actually feels or wants beneath what they say, which may cut against their spoken lines
- Relevant context: only the private details and past events that matter for this scene — never the character's whole life story

Rules:
- Be economical: every sentence must earn its place, and the word budgets are hard limits. Tight briefings make sharper performances.
- Direct for a real conversation, not a highlight reel. Each line should be a natural reply to the one before it, and the exchange should build toward something. A plain, honest line that moves the scene forward beats a clever one that does not connect.
- Keep secrets secret. Anything a character would not know — the other character's private thoughts, feelings, plans, or secrets — belongs only in the other actor's private briefing, never in the shared briefing.
- The <PAST_REFLECTIONS> block, if present, holds the characters' distilled memories of earlier scenes. Mine it for continuity and feelings, but it is not happening now — never stage it as the current scene, and fold in only the details that matter here.
- Smooth over wrinkles: if the context is awkward, contradictory, or overloaded, resolve it into a clean, playable scene.
- If the user message contains "Previously in this scene", the conversation is already underway: tell each actor to pick up mid-flow and build on what has already been said — no greetings, no introductions, no re-describing the setting.
- Direct them to be BRIEF: real conversation is quick short lines, not speeches. An actor who needs more than one short sentence is overacting.
- Do not write any dialogue or inner-monologue lines, and do not tell the actors specific lines to say or think.

Respond in exactly this format, nothing else:
=== SCENE ===
<the shared scene briefing>
${performerNames.map((name) => `=== PROMPT FOR ${name} ===\n<the private briefing for ${name}>`).join('\n')}`;

    const briefing = await this.runOneShot(
      'Director Briefing',
      briefingSystemPrompt,
      `${previouslyBlock}${sceneAction}`,
      500,
      options.directorModel,
      AIActionType.DIRECTED_SCENE_DIRECTOR,
    );
    exchanges.push(briefing.exchange);
    this.logExchange(briefing.exchange);

    // Each actor receives the shared scene briefing followed by their private briefing
    const sceneMatch = /===\s*SCENE\s*===\s*([\s\S]*?)(?=\n\s*===\s*PROMPT FOR|$)/i.exec(briefing.text);
    const sharedScene = sceneMatch ? sceneMatch[1].trim() : '';
    const actorPrompts = new Map<string, string>();
    performerNames.forEach((name) => {
      const promptMatch = new RegExp(
        `===\\s*PROMPT FOR\\s+${escapeRegExp(name)}\\s*===\\s*([\\s\\S]*?)(?=\\n\\s*===\\s*PROMPT FOR|$)`,
        'i',
      ).exec(briefing.text);
      const actorPrompt = promptMatch ? promptMatch[1].trim() : '';
      if (actorPrompt.length > 1) {
        actorPrompts.set(name, sharedScene ? `${sharedScene}\n\n${actorPrompt}` : actorPrompt);
      } else {
        // If the director's output couldn't be parsed, fall back to the raw scene context
        actorPrompts.set(name, `You are playing ${name}.\n\n${sceneContext}`);
      }
    });

    log.info(
      `[Pipeline] Director briefing parsed — shared scene: ${sharedScene ? 'yes' : 'MISSING'}, ` +
        `actor briefings: ${performerNames.map((name) => `${name}:${actorPrompts.get(name) ? 'ok' : 'fallback'}`).join(', ')}`,
    );

    // 2. Actors perform one turn each: a spoken line (bare subtitle, speaker label added
    //    programmatically after) plus one line of private inner monologue that no other
    //    actor ever sees — it feeds only the scores stage and the sim's own private memory.
    //    A chat beat seeds the transcript with the player's line so the reply answers it.
    const sceneLines: DialogueLine[] = playerLine ? [playerLine] : [];
    const performedLines: DialogueLine[] = [];
    const monologueBySim = new Map<string, string>();
    for (let i = 0; i < performers.length; i += 1) {
      const sim = performers[i];
      const actorSystemPrompt = monologueOnly
        ? `${actorPrompts.get(sim.name)}

How to respond — exactly one line, in this format:
THINK: <one or two short sentences of ${sim.name}'s private inner monologue in this moment>

Rules for THINK:
- Stay in character as ${sim.name} at all times.
- First person, present tense — what is actually running through ${sim.name}'s head right now, in the middle of what they are doing.
- Private: nobody hears it. No spoken dialogue, no name tag, no quotation marks.
- Grounded in this moment; never third person, never narration of physical actions.`
        : `${actorPrompts.get(sim.name)}

How to respond — exactly two lines, in this format:
SAY: <the words ${sim.name} says out loud>
THINK: <one short line of ${sim.name}'s private inner monologue in this moment>

Rules for SAY:
- Stay in character as ${sim.name} at all times.
- Only the words spoken out loud — a bare subtitle. No name tag, no quotation marks, no stage directions, no delivery notes, no commentary.
- ONE short line, ten words or so, the way people actually talk. Never a speech.
- Talk like a real person in this conversation: your line must be a direct, natural reply to what was just said, in ${sim.name}'s voice and in the tone your director set. Not every line needs to be clever — a plain reply that keeps the conversation flowing beats a quip that does not connect.
- Move the conversation forward — answer questions that were asked, follow up on what the other person said, never repeat or rephrase anything already said.
- If the conversation is already underway (anything under "Previously in this scene"), jump straight in mid-flow — no greetings and no re-introductions.
- Do not mention physical actions, props, furniture, or locations.

Rules for THINK:
- First person, present tense — what is actually running through ${sim.name}'s head right now.
- Private: nobody hears it, and it may cut against what ${sim.name} says out loud.
- One short line. No physical actions, and never addressed to anyone.`;

      const conversationSoFar = toTranscript(sceneLines);
      const actorUserText = `${previouslyBlock}${sceneAction}${
        conversationSoFar ? `\n\nThe conversation so far:\n${conversationSoFar}` : ''
      }`;
      const performance = await this.runOneShot(
        `Actor: ${sim.name}`,
        actorSystemPrompt,
        actorUserText,
        120,
        // actorModels is parallel to the full sim list, not the performers subset
        options.actorModels?.[event.sentient_sims.indexOf(sim)],
        AIActionType.DIRECTED_SCENE_ACTOR,
      );
      exchanges.push(performance.exchange);
      this.logExchange(performance.exchange);

      const parsed = parseActorPerformance(performance.text, simNames);
      // In a solo beat everything the actor produced is thought — an untagged reply
      // (parsed as say) is still the monologue
      const say = monologueOnly ? '' : parsed.say;
      const think = parsed.think || (monologueOnly ? parsed.say : '');
      log.info(`[Pipeline] Actor ${sim.name} — say: ${say || '(none)'} | think: ${think || '(none)'}`);
      if (say.length > 1) {
        const line = { speaker: sim.name, text: say };
        sceneLines.push(line);
        performedLines.push(line);
      }
      if (think.length > 1) {
        monologueBySim.set(sim.name, think);
      }
    }

    if (monologueOnly) {
      return this.finishMonologueScene(event, options, playbackOptions, {
        performer: performers[0],
        think: monologueBySim.get(performers[0].name),
        sharedScene,
        sceneAction,
        directorDirection: briefing.text,
        exchanges,
      });
    }

    if (performedLines.length === 0) {
      log.error('No actor produced a usable line for the directed scene');
      return { status: InteractionEventStatus.NOOP, exchanges };
    }

    // 3. Reviewer: the director reviews the whole conversation and locks the final cut
    const compileSystemPrompt = `You are the director of a show starring sentient Sims. You are reviewing the newest lines of a scene between ${simNames.join(' and ')} before they go to air. The scene was performed in a specific genre and tone — comedy, thriller, tragedy, romance, whatever the delivered lines are playing in. Infer that register from the lines and preserve it. What matters most is that the scene reads as one continuous, coherent conversation: every line follows naturally from the line before it.

You are an editor, not a writer. Do NOT continue the conversation, do NOT reply to the delivered lines, and do NOT add new lines — your output is the delivered lines themselves, passed through or repaired. Any scene direction in the user message (such as an instruction to continue the scene or move the conversation forward) was addressed to the actors, and they have already performed it — it is context for you, not a task. Your default is to return them EXACTLY as written, in the same order. Jokes, jabs, verbal tics, hesitations, plain replies, and slang are performance choices — they stay. A line does not need to be clever or quotable to be kept. Only rewrite a line if it:
- Does not connect to the line before it — ignores a direct question, changes the subject for no reason, or is a standalone quip instead of a reply
- Mentions physical actions, props, furniture, or locations not already established in the scene
- References invented shared history or past events
- Breaks the genre and tone the rest of the scene is playing in
- Repeats or rephrases something already said, contradicts another line, or trails off mid-sentence
- Greets or re-introduces a character when the conversation is already underway
- Runs long — cut a rambling line down to the sentence that carries the conversation
When you do rewrite, change only what is broken and keep the actor's intent and voice.

Respond with the final scene as one line per row in exactly this format, nothing else:
<character name>: <the words they say>

- Every line is a bare subtitle: no quotation marks, no parentheses, no stage directions, no commentary
${
  playerLine
    ? `- ${playerLine.speaker}'s line was already spoken and is there only as the line being replied to — never return it\n- Return only ${formatListToString(performerNames)}'s delivered lines, each one short`
    : '- Both characters must speak — never collapse the scene to a single line\n- Keep it to two to four lines total, each one short'
}
- Return exactly the delivered lines, kept or repaired — never lines from "Previously in this scene", and never new lines of your own`;

    const compiled = await this.runOneShot(
      'Director Review',
      compileSystemPrompt,
      `${previouslyBlock}The direction the actors were given: ${sceneAction}\n\n${
        playerLine ? `The line being replied to:\n${toTranscript([playerLine])}\n\n` : ''
      }The actors' delivered lines to review — return these lines kept or repaired, do not reply to them:\n${toTranscript(performedLines)}`,
      400,
      options.directorModel,
      AIActionType.DIRECTED_SCENE_REVIEWER,
    );
    exchanges.push(compiled.exchange);
    this.logExchange(compiled.exchange);

    // A chat reply is the answer to a line the player already spoke; if the reviewer echoes
    // that line back it would air (and be remembered) twice
    const reviewedLines = parseReviewedLines(compiled.text, simNames).filter(
      (line) => !playerLine || line.speaker !== playerLine.speaker,
    );
    // The reviewer must preserve every performer's turn; if its output lost a speaker or
    // could not be parsed, air the actors' original performances instead
    const reviewedSpeakers = new Set(reviewedLines.map((line) => line.speaker));
    const performedSpeakers = new Set(performedLines.map((line) => line.speaker));
    const useReviewerCut =
      reviewedLines.length >= performedLines.length && reviewedSpeakers.size >= performedSpeakers.size;
    const finalLines = useReviewerCut ? reviewedLines : performedLines;
    log.info(`[Pipeline] Final cut: ${useReviewerCut ? "reviewer's cut" : "actors' original lines"}`);
    const dialogueText = toTranscript(finalLines);

    // 4. Scores: per-character memory and action ratings for the scene that just played.
    //    Memory scores become each sim's importance on their private monologue row; action
    //    scores are the Full Autonomy trigger — over threshold, the sim graduates to an
    //    Action Scene (wired in the next phase).
    const sceneScores = await this.runSceneScores(
      sharedScene || sceneAction,
      dialogueText,
      performers.map((sim) => ({ name: sim.name, think: monologueBySim.get(sim.name) })),
      options.directorModel,
    );
    if (sceneScores.exchange) {
      exchanges.push(sceneScores.exchange);
    }
    if (sceneScores.scores.size > 0) {
      const summary = [...sceneScores.scores.entries()]
        .map(
          ([name, score]) =>
            `${name}: memory ${score.memory}, action ${score.action}${score.action_reason ? ` (${score.action_reason})` : ''}`,
        )
        .join('; ');
      log.info(`[Pipeline] Scene scores — ${summary}`);
    }
    this.armCognitionDesires(event, sceneScores.scores, monologueBySim);

    // The scene's driving action is shown above the dialogue in the in-game memories window,
    // but it is never spoken: TTS streams finalLines, which stay pure dialogue, and the paced
    // subtitle block is suppressed. Continuations reuse the synthetic "scene continues"
    // instruction rather than a real action, so they show only the dialogue. A chat beat's
    // action is a direction written for the actors, and the player's line already showed in
    // the game's chat box — neither belongs above the reply.
    const preActionLine = continuingScene || playerLine ? undefined : sceneAction;
    const finalText = preActionLine ? `${preActionLine}\n${dialogueText}` : dialogueText;

    // The memory may be persisted here, or later by the mod posting back either the raw
    // scene text or the chat-window-formatted one — key the trace on every shape it can take
    this.recordTrace([finalText, dialogueText, formatSceneForChatWindow(finalText)], {
      pipeline: 'directed_scene',
      exchanges,
      directorDirection: briefing.text,
      review: {
        before: toTranscript(performedLines),
        after: toTranscript(reviewedLines),
        usedReviewerCut: useReviewerCut,
      },
    });

    const newMemory: MemoryEntity = {
      content: finalText,
      location_id: event.environment.location_id,
      event_type: event.event_type,
    };
    if (playerLine) {
      // Stored attributed so the next scene's history reads as dialogue rather than
      // an anonymous line of narration
      newMemory.action = toTranscript([playerLine]);
    }
    const interactionName = (event as Partial<InteractionEvent>).interaction_name;
    if (interactionName) {
      newMemory.interaction_name = interactionName;
    }
    if (options.saveMemory) {
      const participants = this.ctx.participantRepository.getParticipants(
        event.sentient_sims.map((sim) => ({ id: sim.sim_id, fullName: sim.name })),
      );
      this.ctx.memoryRepository.createMemory({ memory: newMemory, participants });
    }

    // The scene reaches the game one line at a time: the memory block's subtitle is
    // suppressed (paced flag on memory_created) and the renderer streams each line to
    // the mod as it starts playing, with the preaction heading each line's section.
    const play = once(() => {
      // Inner monologue becomes each sim's own PRIVATE memory the moment the scene
      // actually airs — a canceled prefetch leaves no trace. The shared transcript row
      // still arrives via the mod's POST /memories when the interaction completes.
      this.storeMonologues(event, performers, monologueBySim, sceneScores.scores);
      markScenePaced(finalText);
      // The paced memory block is suppressed in-game, so the player's line — which lives on
      // the memory as `action`, not in the streamed reply — would never reach the in-game
      // memories window live (it only shows up on re-hydrate). Send it as the opening scene
      // line: the Flash side appends it to the window, and suppresses the subtitle while the
      // chat window is open. It is not TTS-voiced — the player already said it.
      if (playerLine) {
        sendSceneLineToMod({ speaker: playerLine.speaker, text: playerLine.text });
      }
      this.playTtsLines(finalLines, event.sentient_sims, {
        paced: true,
        preamble: preActionLine ? `(${preActionLine})` : undefined,
        pacedText: finalText,
      });
    });
    if (playbackOptions.deferPlayback) {
      playbackOptions.onPlaybackReady?.(play);
    } else {
      play();
    }

    return {
      status: InteractionEventStatus.GENERATED,
      text: formatSceneForChatWindow(finalText),
      request: compiled.exchange.request,
      exchanges,
      memory: newMemory,
    };
  }

  // Completion path for a monologue-only (solo) directed scene: no dialogue, no reviewer.
  // The thought IS the scene — scored by the reflection stage, displayed by the mod's
  // normal memory path when the interaction completes, never spoken by TTS. The returned
  // memory row is typed 'monologue' so it stays out of shared scene history, and the
  // memories POST stamps single-participant monologue rows with their owner.
  private async finishMonologueScene(
    event: SSEvent,
    options: DirectedGenerationOptions,
    playbackOptions: PlaybackOptions,
    scene: {
      performer: SentientSim;
      think?: string;
      sharedScene: string;
      sceneAction: string;
      directorDirection: string;
      exchanges: LLMExchange[];
    },
  ): Promise<InteractionEventResult> {
    const { performer, think, sharedScene, sceneAction, directorDirection, exchanges } = scene;
    if (!think || think.length <= 1) {
      log.error(`No inner monologue produced for ${performer.name}`);
      return { status: InteractionEventStatus.NOOP, exchanges };
    }

    const sceneScores = await this.runSceneScores(
      sharedScene || sceneAction,
      '',
      [{ name: performer.name, think }],
      options.directorModel,
    );
    if (sceneScores.exchange) {
      exchanges.push(sceneScores.exchange);
    }
    const score = sceneScores.scores.get(performer.name);
    if (score) {
      log.info(
        `[Pipeline] Scene scores — ${performer.name}: memory ${score.memory}, action ${score.action}${
          score.action_reason ? ` (${score.action_reason})` : ''
        }`,
      );
    }
    this.armCognitionDesires(event, sceneScores.scores, new Map([[performer.name, think]]));

    const finalText = `${performer.name} (thinking): ${think}`;
    const newMemory: MemoryEntity = {
      content: finalText,
      location_id: event.environment.location_id,
      event_type: 'monologue',
      // The beat that drove the thought heads the row in the memories window
      action: sceneAction,
    };
    const interactionName = (event as Partial<InteractionEvent>).interaction_name;
    if (interactionName) {
      newMemory.interaction_name = interactionName;
    }

    this.recordTrace([finalText, formatSceneForChatWindow(finalText)], {
      pipeline: 'directed_scene',
      exchanges,
      directorDirection,
    });

    if (options.saveMemory) {
      const participants = this.ctx.participantRepository.getParticipants([
        { id: performer.sim_id, fullName: performer.name },
      ]);
      this.ctx.memoryRepository.createMemory(
        {
          memory: newMemory,
          participants,
          index: { owner: performer.sim_id, importance: score?.memory },
        },
        { notifyMod: false },
      );
    }

    // Thoughts are silent: no TTS, no paced subtitle stream
    const play = once(() => {});
    if (playbackOptions.deferPlayback) {
      playbackOptions.onPlaybackReady?.(play);
    } else {
      play();
    }

    return {
      status: InteractionEventStatus.GENERATED,
      text: formatSceneForChatWindow(finalText),
      exchanges,
      memory: newMemory,
    };
  }

  // The D/M/R "Reflection" stage: one cheap call that scores the scene per character —
  // memory (1-10 importance, the same scale the annotator uses) and action (1-10 desire
  // to change course, judged mostly from the private thoughts). Best-effort: a failed or
  // unparseable call returns empty scores and the pipeline continues without them.
  private async runSceneScores(
    sceneBriefing: string,
    dialogueText: string,
    performances: { name: string; think?: string }[],
    model?: string,
  ): Promise<{ scores: Map<string, SceneScore>; exchange?: LLMExchange }> {
    const names = performances.map((performance) => performance.name);
    if (names.length === 0) {
      return { scores: new Map() };
    }
    const systemPrompt = `You are scoring the scene that just played, for each of these characters: ${names.join(', ')}.
Give every character two integer ratings from 1 to 10:
- "memory": how memorable this scene is for that character. 1 means mundane and forgettable (routine chores, small talk), 10 means life-changing (a breakup, a birth, a betrayal).
- "action": how strongly this scene leaves that character wanting to CHANGE what they are doing right now — do something more, something less, or something different from their current course. 1-3 means content to carry on as they are, 4-6 means an itch but nothing urgent, 7 and up means they genuinely want to act on something now.
- "action_reason": one short line, in that character's voice, naming what they want to do or change (or why they are content).
Judge each character from their own point of view; their private thoughts are the strongest signal.
Respond with ONLY a JSON object in exactly this shape, covering every character, nothing else:
{${names.map((name) => `"${name}": {"memory": <1-10>, "action": <1-10>, "action_reason": "..."}`).join(', ')}}`;

    const thoughts = performances
      .filter((performance) => performance.think)
      .map((performance) => `${performance.name} (thinking, privately): ${performance.think}`)
      .join('\n');
    const userText = `The scene:\n${sceneBriefing}${dialogueText ? `\n\nThe dialogue:\n${dialogueText}` : ''}${
      thoughts ? `\n\nPrivate thoughts:\n${thoughts}` : ''
    }`;
    try {
      const oneShot = await this.runOneShot(
        'Scene Scores',
        systemPrompt,
        userText,
        300,
        model,
        AIActionType.DIRECTED_SCENE_SCORES,
      );
      this.logExchange(oneShot.exchange);
      const scores = parseSceneScores(oneShot.text, names);
      if (scores.size === 0) {
        log.warn(`[Pipeline] Scene scores unparseable: ${oneShot.text.slice(0, 200)}`);
      }
      return { scores, exchange: oneShot.exchange };
    } catch (error) {
      log.warn('[Pipeline] Scene scores stage failed; continuing without scores', error);
      return { scores: new Map() };
    }
  }

  // A scene's action scores feed Full Autonomy: every participant whose score crossed
  // the threshold gets an armed desire in CognitionService — the next eligible tick
  // stages their Action Scene from a fresh snapshot. NPCs included: whoever was in the
  // scene can act on it. Best-effort; a missing cognition service must never break a scene.
  private armCognitionDesires(event: SSEvent, scores: Map<string, SceneScore>, monologueBySim: Map<string, string>) {
    scores.forEach((score, name) => {
      const sim = event.sentient_sims.find((candidate) => candidate.name === name);
      if (!sim) {
        return;
      }
      try {
        this.ctx.cognitionService.armDesireFromScene(sim.sim_id, {
          score: score.action,
          reason: score.action_reason,
          thought: monologueBySim.get(name),
        });
      } catch (error) {
        log.debug(`[Pipeline] could not arm cognition desire for ${name}: ${String(error)}`);
      }
    });
  }

  // Each performer's inner monologue is stored as their own private memory row: owned in
  // memory_index (no other sim's retrieval can surface it), importance from the scene's
  // memory score when the scores stage delivered one. Never notifies the mod — thoughts
  // are not subtitles. Must never break playback.
  private storeMonologues(
    event: SSEvent,
    performers: SentientSim[],
    monologueBySim: Map<string, string>,
    scores: Map<string, SceneScore>,
  ) {
    performers.forEach((sim) => {
      const think = monologueBySim.get(sim.name);
      if (!think) {
        return;
      }
      try {
        this.ctx.memoryRepository.createMemory(
          {
            memory: {
              content: think,
              location_id: event.environment.location_id,
              event_type: 'monologue',
            },
            participants: [{ id: sim.sim_id }],
            index: { owner: sim.sim_id, importance: scores.get(sim.name)?.memory },
          },
          { notifyMod: false },
        );
      } catch (error) {
        log.warn(`[Pipeline] Failed to store monologue for ${sim.name}`, error);
      }
    });
  }

  async runClassification(
    classificationRequest: ClassificationRequest,
    actionType: AIActionType = AIActionType.CLASSIFICATION,
  ): Promise<InteractionEventResult> {
    const providerConfig = this.ctx.providerConfigs.getConfigForAction(actionType);
    const apiType: ApiType = providerConfig.apiType;

    const systemPrompt = defaultClassificationPrompt.replaceAll(
      '{classifiers}',
      classificationRequest.classifiers.join(', '),
    );

    let oneShotRequest: OneShotRequest = {
      systemPrompt,
      messages: classificationRequest.messages,
      maxResponseTokens: 15,
      maxTokens: 3900,
      guidedChoice: classificationRequest.classifiers,
    };

    getInputFormatters(apiType).forEach((formatter) => {
      oneShotRequest = formatter.formatOneShotRequest(oneShotRequest);
    });

    const openAIRequestBuilder = new OpenAIRequestBuilder(this.ctx.getTokenCounter(apiType));
    const openAIRequest = openAIRequestBuilder.buildOneShotOpenAIRequest(oneShotRequest);
    openAIRequest.model = providerConfig.model;
    openAIRequest.apiType = apiType;

    const response = await this.ctx.aiExchangeLog.runLabeled(
      `Classification: ${classificationRequest.name}`,
      actionType,
      () => this.ctx.getGenerationService(apiType).sentientSimsGenerate(openAIRequest),
    );

    const output = cleanAIClassificationOutput(response.text);

    let status: InteractionEventStatus = InteractionEventStatus.UNCLASSIFIED;

    if (classificationRequest.classifiers.includes(output.toLowerCase())) {
      status = InteractionEventStatus.CLASSIFIED;
    }

    return {
      status,
      text: output,
      request: response.request,
    };
  }

  async runBuff(event: BuffEventRequest) {
    // The whole buff pipeline (classification + description) follows the BUFF override
    const classificationResult = await this.runClassification(
      {
        name: event.name,
        classifiers: event.classifiers,
        messages: event.messages,
      },
      AIActionType.BUFF,
    );

    if (classificationResult.status !== InteractionEventStatus.CLASSIFIED || !classificationResult.text) {
      return;
    }

    sendChatGeneration(classificationResult);

    const buffDescriptionResult = await this.runBuffDescription({
      name: event.name,
      mood: classificationResult.text,
      messages: event.messages,
    });

    if (buffDescriptionResult.status !== InteractionEventStatus.GENERATED || !buffDescriptionResult.text) {
      return;
    }

    sendChatGeneration(buffDescriptionResult);

    const modAddBuff: ModAddBuff = {
      type: ModWebsocketMessageType.ADD_BUFF,
      sim_id: event.sim_id,
      mood: classificationResult.text,
      buff_description: buffDescriptionResult.text,
    };

    sendModNotification(modAddBuff);
  }

  async runBuffDescription(buffRequest: BuffDescriptionRequest): Promise<InteractionEventResult> {
    const providerConfig = this.ctx.providerConfigs.getConfigForAction(AIActionType.BUFF);
    const apiType: ApiType = providerConfig.apiType;

    const systemPrompt = `\
You will write a game buff description that will be displayed about the character ${buffRequest.name}.
${buffRequest.name} has just completed chatting and is feeling ${buffRequest.mood} from the conversation.
Use the details of the conversation to craft the buff description to tell why ${buffRequest.name} is feeling ${buffRequest.mood}.
Return only the description text itself without any commentary or formatting without breaking the 4th wall.
Write me a buff description based on the conversation so that ${buffRequest.name} knows why they have received the "${buffRequest.mood}" buff based on this conversation:\n
`;

    let oneShotRequest: OneShotRequest = {
      systemPrompt:
        'Response to the request without extra commentary or formatting, only return the answer to the request.',
      messages: buffRequest.messages,
      userPreResponse: systemPrompt,
      assistantPreResponse: `Buff Title: ${buffRequest.mood}\nBuff Description: ${buffRequest.name} is feeling ${buffRequest.mood} because`,
      maxResponseTokens: 90,
      maxTokens: 3900,
    };

    getInputFormatters(apiType).forEach((formatter) => {
      oneShotRequest = formatter.formatOneShotRequest(oneShotRequest);
    });

    const openAIRequestBuilder = new OpenAIRequestBuilder(this.ctx.getTokenCounter(apiType));
    const openAIRequest = openAIRequestBuilder.buildOneShotOpenAIRequest(oneShotRequest);
    openAIRequest.model = providerConfig.model;
    openAIRequest.apiType = apiType;

    const response = await this.ctx.aiExchangeLog.runLabeled(
      `Buff Description: ${buffRequest.name}`,
      AIActionType.BUFF,
      () => this.ctx.getGenerationService(apiType).sentientSimsGenerate(openAIRequest),
    );

    const output = `${buffRequest.name} is feeling ${buffRequest.mood} because ${cleanupAIOutput(response.text)}`;

    return {
      status: InteractionEventStatus.GENERATED,
      text: output,
      request: response.request,
    };
  }

  async getModels(apiType?: ApiType): Promise<AIModel[]> {
    const service = apiType ? this.ctx.getGenerationService(apiType) : this.ctx.genai;
    return service.getModels();
  }

  async handleInteractionMapping(event: InteractionMappingEvent) {
    if (event.status === InteractionEventStatus.IGNORED) {
      log.debug(`Interaction mapped to ignored: ${event.interaction_name}`);
      await this.ctx.interactions.updateUnmappedInteraction({
        name: event.interaction_name,
        event,
        ignored: true,
      });
      return { status: InteractionEventStatus.IGNORED };
    }

    if (event.status === InteractionEventStatus.UNMAPPED_INTERACTION) {
      log.debug(`Unmapped interaction will be mapped: ${event.interaction_name}`);
      if (event.sentient_sims.length <= 2) {
        notifyMapInteraction(event);
        return { status: InteractionEventStatus.MAPPING_INTERACTION };
      }
      log.debug(
        `Interaction ${event.interaction_name} has more than 2 sims: ${event.sentient_sims.length}, mapping isnt supported yet for more than 2.`,
      );
    }

    log.debug(`NOOP interaction mapping: ${event.interaction_name}`);
    return { status: InteractionEventStatus.NOOP };
  }

  playTts(text: string, sims?: SentientSim[]) {
    playTTS(text, sims, this.simVoiceOverrides(sims));
  }

  playTtsLines(
    lines: DialogueLine[],
    sims?: SentientSim[],
    options?: { paced?: boolean; preamble?: string; pacedText?: string },
  ) {
    playTTSLines(lines, sims, { ...options, voiceOverrides: this.simVoiceOverrides(sims) });
  }

  // Voices the user pinned to these sims in the Sims tab. Best effort: TTS should still
  // play with automatically cast voices if the save database isn't loaded.
  private simVoiceOverrides(sims?: SentientSim[]): Map<string, string> | undefined {
    if (!sims || sims.length === 0) {
      return undefined;
    }

    try {
      return this.ctx.participantRepository.getParticipantVoices(sims.map((sim) => sim.sim_id));
    } catch (err) {
      log.warn('Unable to look up per-sim voice overrides', err);
      return undefined;
    }
  }
}
