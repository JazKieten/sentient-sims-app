import log from 'electron-log';
import { PLAYER_VOICE_PERSONA_LABELS, playerPersonaFlavor } from '../models/PlayerVoicePersona';
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
import { synthesizeInteractionDescription } from '../util/synthesizePreAction';
import { InteractionEventResult, InteractionEventStatus, LLMExchange } from '../models/InteractionEventResult';
import {
  notifyMapAnimation,
  notifyMapInteraction,
  playTTS,
  playTTSLines,
  PlayTTSVoiceOptions,
  sendChatGeneration,
  sendSceneLineToMod,
} from '../util/notifyRenderer';
import { voiceTypeForTTS } from '../models/VoiceType';
import { markScenePaced } from '../util/pacedScenes';
import { applySimAliasNames } from '../util/simAliases';
import { GenerationOptions, PromptRequestBuilderOptions } from './PromptRequestBuilderService';
import { containsPlayerSim } from '../util/eventContainsPlayerSim';
import { ApiType } from '../models/ApiType';
import {
  defaultClassificationPrompt,
  defaultWantsPrefixes,
  defaultWantsPrompt,
  directedSceneBudgetMs,
} from '../constants';
import { PromptHistoryMode } from '../models/PromptHistoryMode';
import {
  BuffEventRequest,
  BuffDescriptionRequest,
  ClassificationRequest,
  OneShotRequest,
  OpenAIRequestBuilder,
} from '../models/OpenAIRequestBuilder';
import { OpenAICompatibleRequest } from '../models/OpenAICompatibleRequest';
import { promptFor } from '../pipeline/prompts';
import { StageId } from '../pipeline/stages';
import {
  buildBriefingSystemPrompt,
  buildSceneReviewSystemPrompt,
  buildSceneSalienceSystemPrompt,
  buildSpeechSystemPrompt,
  DIRECTOR_REVIEW_SYSTEM_PROMPT,
} from '../pipeline/prompts/scene';
import { buildConsolidationSystemPrompt, buildDiaryOnlySystemPrompt } from '../pipeline/prompts/consolidation';
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
import { sleepPlanDays } from '../models/DailyPlan';
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
import { parsePlannerJson, extractDiaryProse, DailyPlanService } from './DailyPlanService';
import { SceneState } from './SceneService';
import { MemoryTrace } from '../models/MemoryTrace';
import { pngToPaintingDds } from '../image/paintingDds';
import { ImageGenerationRequest, ImageGenerationResponse } from '../models/ImageGeneration';

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

// A performance that opens with someone ELSE's speaker label is not this actor's line —
// live 2026-08-17: in a continued voice scene the actor put "The Voice: Let's just say
// I've been watching…" in THINK, and that invented line aired as the sim's own thought,
// was voiced by TTS, and entered their memories as something the player said.
export function isForeignSpeakerLine(text: string, actorName: string | undefined, speakerNames: string[]): boolean {
  const others = [...Object.values(PLAYER_VOICE_PERSONA_LABELS), ...speakerNames].filter(
    (name) => !actorName || name.toLowerCase() !== actorName.toLowerCase(),
  );
  return others.some((name) => new RegExp(`^["'(]*${escapeRegExp(name)}\\s*[:\\-—]`, 'i').test(text.trim()));
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
export type SceneScore = {
  memory: number;
  action: number;
  action_reason?: string;
  // V-5a: the scene's own continue signal rides the scorer (structured JSON, runs on both
  // dialogue and solo paths, fails soft) — never the reviewer, which is the stage that
  // already misbehaved by continuing on its own
  unfinished?: boolean;
  continue?: number;
};

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
    const verdict = value as {
      memory?: unknown;
      action?: unknown;
      action_reason?: unknown;
      unfinished?: unknown;
      continue?: unknown;
    };
    const memory = clamp(verdict.memory);
    const action = clamp(verdict.action);
    if (memory === undefined && action === undefined) {
      return;
    }
    const unfinished =
      typeof verdict.unfinished === 'boolean'
        ? verdict.unfinished
        : typeof verdict.unfinished === 'string'
          ? verdict.unfinished.trim().toLowerCase() === 'true'
          : undefined;
    scores.set(name, {
      memory: memory ?? 3,
      action: action ?? 1,
      action_reason: typeof verdict.action_reason === 'string' ? verdict.action_reason : undefined,
      unfinished,
      continue: clamp(verdict.continue),
    });
  });
  return scores;
}

// The reviewer returns one `Name: line` per row; rows that don't start with a known
// speaker (commentary, headers) are discarded
function parseReviewedLines(rawText: string, speakerNames: string[]): DialogueLine[] {
  const lines: DialogueLine[] = [];
  // V-5b: delivered lines are numbered for the reviewer; the numbers may come back
  cleanupAIOutput(rawText.replace(/^\s*\d+[.)]\s+/gm, ''))
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
  // V-5a: which round of a self-continuing scene this is (1 = the opening beat) and the
  // lines the previous rounds already aired, so the continuation sees them before the
  // mod's POST /memories lands the transcript
  round?: number;
  carriedLines?: DialogueLine[];
  // A chat beat opens with a line the player already typed: it drives the scene and seeds the
  // transcript the actors reply to, the sim who said it takes no actor turn, and it stays out
  // of the aired scene (the mod already showed it, and it rides along as the memory's action)
  playerLine?: DialogueLine;
  // What the playerLine's speaker IS, for speakers outside the player-voice personas
  // (e.g. Twitch 'Chat'). Overrides the persona flavor sentence.
  playerLineFlavor?: string;
  // Display-only speaker for the game (e.g. "Chat (viewer)"): decorates the scene-line
  // subtitle and the mod-bound memory copy; the model and the stored row see only
  // playerLine.speaker. Keep the first word identical to playerLine.speaker — the mod's
  // memories window sections on it, and its 30s subtitle dedupe compares full strings.
  playerLineDisplaySpeaker?: string;
  directorModel?: string;
  // Parallel to event.sentient_sims order
  actorModels?: (string | undefined)[];
  // Real game events return the memory to the mod, which saves it back via POST /memories
  // when the interaction completes; the scenario tester has no mod, so it saves directly
  saveMemory?: boolean;
  // Twitch !ask: the app speaks the viewer's typed question in a dedicated chat voice before
  // the sim's reply. spokenText is what is voiced ("nova asks: ..."); the in-game subtitle
  // still comes from the direct playerLine send, so the prepended TTS line is flagged
  // skipSceneLine. Continuations never set this (playerLine is cleared alongside it).
  speakPlayerLine?: { voiceId: string; spokenText: string };
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
  // V-2: play this scene next (front of the renderer's scene queue) — the reply to
  // something the player just said
  priority?: boolean;
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

// N-1: one clause per valence, appended to the scene action so the director and the
// actors play the beat in the register the game meant
export function valenceFraming(valence: string | undefined): string | undefined {
  switch (valence) {
    case 'negative':
      return 'This is a HOSTILE beat: it lands as genuinely unfriendly, hurtful or angry — never warm, never a joke between friends.';
    case 'romance':
      return 'This is a ROMANTIC beat: play the attraction and the charge between them.';
    case 'positive':
      return undefined;
    default:
      return undefined;
  }
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
  // When the sleeper can plan (feature on, goal_pool cached, day known, tomorrow not
  // already planned), the diary call doubles as the nightly planner: one JSON call
  // returns the diary AND tomorrow's goals/persona/loadout plus a review of today's
  // goals. Any parse failure degrades to the plain diary — the reflection must never
  // be lost to plan parsing; the lazy planner covers the plan side.
  private buildSleepPlanContext(
    pov: { simId: string; simName: string },
    sleepClock?: { hour?: number; absolute_day?: number },
  ) {
    try {
      if (!this.ctx.settings.dailyGoalsEnabled) {
        return undefined;
      }
      const entry = this.ctx.simStateCache.getSim(pov.simId);
      const pool = entry?.self?.goal_pool;
      const endingDay = sleepClock?.absolute_day ?? this.ctx.simStateCache.getReport()?.lot?.clock?.absolute_day;
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
      const alreadyPlanned = this.ctx.dailyPlan.activePlan(pov.simId, targetDay)?.source === 'sleep';
      const dayThatEnded = this.ctx.dailyPlan.activePlan(pov.simId, reviewDay);
      const reviewPending = dayThatEnded !== undefined && dayThatEnded.goals.length > 0 && !dayThatEnded.review;
      if (alreadyPlanned && !reviewPending) {
        return undefined;
      }
      return {
        pool,
        reviewDay,
        targetDay,
        todaysPlan: dayThatEnded,
        description: this.ctx.dailyPlan.participantDescription(pov.simId, pov.simName),
        traits: entry.self?.traits ?? [],
        // Gates the romance group out of the planner's ACTION STYLES for non-adults
        age: entry.self?.age,
        ageBlocked: entry.self?.age_blocked,
        // G-5/G-8: what tonight's lot serves (annotation only) and goals carried too long
        lotServes: DailyPlanService.lotServedKeys(entry, this.ctx.simStateCache.getReport()?.lot?.action_keys),
        stuck: this.ctx.dailyPlan.stuckGoals(pov.simId, targetDay),
      };
    } catch (err) {
      log.warn('[DailyPlan] sleep plan context failed; running plain reflection', err);
      return undefined;
    }
  }

  async runSceneReflection(
    previousScene: SceneState,
    pov?: { simId: string; simName: string },
    boundary?: 'sleep' | 'travel',
    sleepClock?: { hour?: number; absolute_day?: number },
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
          `[Reflection] Scene ${previousScene.sceneId} had ${sceneMemories.length} memories, skipping reflection` +
            (boundary === 'sleep' ? ' (sleep-path daily plan skipped too; the lazy planner covers it)' : ''),
        );
        return;
      }

      const location = this.ctx.locationRepository.getLocation({ id: previousScene.locationId });
      const participantIds = this.ctx.memoryRepository.getSceneParticipantIds(
        previousScene.locationId,
        previousScene.startedAt,
      );
      // The diary is first-person: writing one in the name of a sim who was not in the
      // scene puts a durable memory of an evening they never attended in their head, and
      // it WILL be retrieved as context on their next tick. Live 2026-08-16: Ariel, at
      // home and not even instanced, was handed a diary of Mackenzie's night at the bar
      // ("Talking with Jalen was easy...") because her sleep boundary fired while the
      // app's active scene was still the bar's. A pov who owns no memory in the scene is
      // not the reflecting mind — drop the reflection rather than misattribute it (the
      // sim's next boundary writes a real one; the lazy planner covers the plan side).
      if (pov && !participantIds.includes(pov.simId)) {
        log.warn(
          `[Reflection] ${pov.simName} was not in scene ${previousScene.sceneId} at ` +
            `location ${previousScene.locationId}; skipping the diary rather than attributing it to them`,
        );
        return;
      }
      const names = this.ctx.participantRepository.getParticipantNames(participantIds);
      // The reflecting sim doesn't get a sentence about "interacting with" themself
      const others = pov ? names.filter((name) => name !== pov.simName) : names;
      const namesList = others.length > 0 ? others.join(', ') : 'the people present';

      const transcript = this.ctx.promptBuilder
        .groupMemories(sceneMemories)
        .map((message) => message.content)
        .join('\n');

      const reflectionContext = {
        identity: pov ? `You are ${pov.simName}. ` : '',
        boundary,
        locationName: location.name,
        namesList,
        hasOthers: others.length > 0,
      };

      const planContext = boundary === 'sleep' && pov ? this.buildSleepPlanContext(pov, sleepClock) : undefined;
      const systemPrompt = planContext
        ? buildConsolidationSystemPrompt({
            ...reflectionContext,
            choicesBlock: this.ctx.dailyPlan.buildChoicesBlock(
              planContext.pool,
              planContext.todaysPlan,
              planContext.age,
              planContext.ageBlocked,
              planContext.lotServes,
              planContext.stuck,
            ),
            aboutLine: `${planContext.description ? `About you: ${planContext.description}\n` : ''}${
              planContext.traits.length > 0 ? `Your traits: ${planContext.traits.join(', ')}\n` : ''
            }`,
            hasTodaysGoals: (planContext.todaysPlan?.goals.length ?? 0) > 0,
            loadoutSize: this.ctx.settings.dailyLoadoutSize,
          })
        : buildDiaryOnlySystemPrompt(reflectionContext);

      const reflection = await this.runOneShot(
        planContext ? 'Scene Reflection + Daily Plan' : 'Scene Reflection',
        systemPrompt,
        transcript,
        planContext ? 900 : 250,
        undefined,
        planContext ? AIActionType.DAILY_PLAN : AIActionType.REFLECTION,
        undefined,
        { stageId: planContext ? StageId.CONSOLIDATION_PLAN : StageId.CONSOLIDATION_REFLECT },
      );
      this.logExchange(reflection.exchange);

      let text = cleanupAIOutput(reflection.text);
      if (planContext && pov) {
        const parsed = parsePlannerJson(reflection.text);
        if (parsed && typeof parsed.diary === 'string' && parsed.diary.trim().length > 1) {
          text = cleanupAIOutput(parsed.diary);
          try {
            this.ctx.dailyPlan.recordReview(pov.simId, planContext.reviewDay, parsed.goal_review);
            const validated = this.ctx.dailyPlan.validate(
              parsed,
              planContext.pool,
              planContext.age,
              planContext.ageBlocked,
              pov.simName,
            );
            this.ctx.dailyPlan.acceptPlan(pov.simId, planContext.targetDay, validated, 'sleep');
          } catch (err) {
            log.warn(`[DailyPlan] failed to accept sleep plan for ${pov.simName}`, err);
          }
        } else {
          // The diary must never be lost to plan parsing — nor may raw JSON reach
          // permanent memory (live 2026-08-15). Keep the prose, drop the schema, and let
          // the lazy planner cover tomorrow.
          text = cleanupAIOutput(extractDiaryProse(reflection.text));
          log.warn(
            `[DailyPlan] sleep planner output unparseable for ${pov.simName}; lazy path will plan. ` +
              `Received: ${JSON.stringify(reflection.text.slice(0, 120))}`,
          );
        }
      }
      this.recordTrace([text], {
        pipeline: 'scene_reflection',
        exchanges: [reflection.exchange],
      });

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
      // Reflections are internal monologue for retrieval/prompting. The push reaches the
      // mod's memories window live as the sim's thought; the mod keeps reflection rows off
      // the subtitle/pause path (ss_memories_service _INNER_VOICE_EVENT_TYPES).
      // Owner-stamped: first-person "I" prose must never surface as another sim's own memory.
      this.ctx.memoryRepository.createMemory({
        memory: reflectionMemory,
        participants,
        index: pov ? { owner: pov.simId } : undefined,
      });
      log.info(`[Reflection] Saved reflection for scene ${previousScene.sceneId}: ${text}`);
    } catch (err) {
      log.error(`[Reflection] Failed to generate reflection for scene ${previousScene.sceneId}`, err);
    }
  }

  async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResponse> {
    const providerConfig = this.ctx.imageProviderConfigs.getResolvedConfig(request.configId);
    log.debug(
      `Using image provider config: ${providerConfig.name} (${providerConfig.apiType}${providerConfig.model ? `, ${providerConfig.model}` : ''})`,
    );
    const response = await this.ctx.getImageGenerationService(providerConfig.apiType).generateImage({
      ...request,
      model: request.model ?? providerConfig.model,
    });
    if (request.format !== 'dds') {
      return response;
    }
    const png = Buffer.from(response.imageBase64, 'base64');
    const textureInstanceId = this.storePaintingRecord(request, png);
    const dds = await pngToPaintingDds(png);
    return { ...response, imageBase64: dds.toString('base64'), textureInstanceId };
  }

  // The painting row is the master copy of the artwork; the mod's loose DDS
  // file is only a cache rebuilt from it. Failing to store the record (no
  // save database loaded) downgrades to the old session-only texture instead
  // of failing the generation: without an id the mod allocates a random one.
  private storePaintingRecord(request: ImageGenerationRequest, png: Buffer): string | undefined {
    try {
      const painting = this.ctx.paintingRepository.createPainting({
        prompt: request.prompt,
        image: png,
        metadata: request.metadata === undefined ? undefined : JSON.stringify(request.metadata),
      });
      log.debug(`Stored painting ${painting.uuid} with texture instance id ${painting.instance_id}`);
      return painting.instance_id;
    } catch (err) {
      log.error('Unable to store painting record, texture will be session-only', err);
      return undefined;
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
      // N-3: a weak-but-true line beats a contentless scene (the "popup/code glitch"
      // hallucination class). Junk tunings come back ignored; the name is logged so
      // the mapping browser work stays greppable.
      const synthesized = synthesizeInteractionDescription(event.interaction_name, event.sentient_sims.length);
      if (synthesized?.ignored) {
        log.debug(`[PreAction] unmapped '${event.interaction_name}' looks like scaffolding; ignored`);
        return { result: { status: InteractionEventStatus.IGNORED } };
      }
      if (synthesized?.pre_actions) {
        log.info(`[PreAction] UNMAPPED '${event.interaction_name}' -> synthesized "${synthesized.pre_actions[0]}"`);
        description = synthesized;
      } else {
        return { result: { status: InteractionEventStatus.UNMAPPED_INTERACTION } };
      }
    }

    if (description.pre_actions) {
      const preAction = getRandomItem(description.pre_actions);
      const location = this.ctx.locationRepository.getLocation({ id: event.environment.location_id });
      const rendered = formatAction(preAction, event.sentient_sims, location);
      if (isDegeneratePreAction(rendered, preAction)) {
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

  // A directed scene needs several AI round trips, so it has more ways to fail than the
  // single-call classic path; callers treat any failure as "fall back to classic"
  private async tryDirectedGeneration(
    event: SSEvent,
    options: DirectedGenerationOptions,
    playbackOptions: PlaybackOptions = {},
  ): Promise<InteractionEventResult | undefined> {
    try {
      return await this.runDirectedGeneration(event, options, playbackOptions);
    } catch (err) {
      log.error('Directed scene generation failed, falling back to classic generation', err);
      return undefined;
    }
  }

  async handleContinue(event: ContinueInteractionEvent) {
    // Group continues keep the full performer set (capped) like fresh interactions do
    const primaryEvent = toPrimaryInteractionEvent(event);
    if (primaryEvent.sentient_sims.length >= 1) {
      // Directed continue needs prior memories to pick up from; fall through when there are none
      const directed = await this.tryDirectedGeneration(primaryEvent, { continueScene: true });
      if (directed?.status === InteractionEventStatus.GENERATED) {
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
    const randomAction = defaultWantsPrefixes[Math.floor(Math.random() * defaultWantsPrefixes.length)];
    return this.runGeneration(
      event,
      {
        preAction: defaultWantsPrompt,
        preAssistantPreResponse: `{actor.0}:`,
        assistantPreResponse: randomAction,
        promptHistoryMode: PromptHistoryMode.NO_USER_HISTORY,
      },
      {
        // Wants are the actor's own first-person voice — speak them as the actor so the
        // sim's cast/pinned ElevenLabs voice is used instead of the global default
        ttsSpeaker: event.sentient_sims[0]?.name,
      },
    );
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
    const directed = await this.tryDirectedGeneration(doSomethingEvent, { action: doSomethingEvent.action });
    if (directed?.status === InteractionEventStatus.GENERATED) {
      return directed;
    }
    return this.runGeneration(
      doSomethingEvent,
      {
        action: doSomethingEvent.action,
        prePreAction: 'At {location} ({location_type}), {postures},',
      },
      {
        // The player asked for this on their own sim and is watching for the result —
        // stream it as paced subtitles rather than a suppressed memory block
        pacedSubtitles: true,
      },
    );
  }

  async handleChat(chatEvent: ChatInteractionEvent) {
    const primaryEvent = toPrimaryInteractionEvent(chatEvent);
    // sentient_sims[0] is the sim the player typed as — the legacy completion prompt encoded
    // the same assumption as '{actor.0}:' speaking and '{actor.1}:' replying
    const spoken = chatEvent.action.trim();
    if (this.ctx.settings.directedScenesEnabled && primaryEvent.sentient_sims.length >= 2 && spoken.length > 0) {
      // V-2 applies here too: the player just spoke (as their sim) and is waiting on the
      // answer — on a busy lot it otherwise queues behind autonomous scenes (live
      // 2026-08-17: 15s from generated to voiced)
      const directed = await this.tryDirectedGeneration(
        primaryEvent,
        { playerLine: { speaker: primaryEvent.sentient_sims[0].name, text: spoken } },
        { priority: true },
      );
      if (directed?.status === InteractionEventStatus.GENERATED) {
        return directed;
      }
    }
    if (primaryEvent.sentient_sims.length === 1 && spoken.length > 0) {
      // Solo voice chat: nobody else can hear, so the player speaks directly TO their
      // sim as The Voice. The non-sim speaker keeps the directed pipeline in dialogue
      // mode (a playerLine suppresses monologue-only), the sim answers aloud, and the
      // exchange persists only as the sim's memory — no game social is staged.
      // V-3: the persona decides who is speaking (label must match the mod's speaker —
      // pushed via update_setting), and V-2 replies to the player play next, not fourth
      return this.runDirectedGeneration(
        primaryEvent,
        {
          playerLine: { speaker: this.ctx.settings.playerSpeakerName, text: spoken },
        },
        { priority: true },
      );
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
    if (this.ctx.settings.directedScenesEnabled && primaryEvent.sentient_sims.length >= 2) {
      // Directed continue needs prior memories to pick up from; fall through when there are none
      const directed = await this.tryDirectedGeneration(primaryEvent, { continueScene: true });
      if (directed?.status === InteractionEventStatus.GENERATED) {
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
    // Service NPCs arrive named "Sim <id>"; the alias table gives them their real name
    // so prompts and transcripts never call the Grim Reaper "Sim"
    event.sentient_sims = applySimAliasNames(event.sentient_sims);
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

    const directedScenes = this.ctx.settings.directedScenesEnabled;

    // TODO: Add an options for formatted stop tokens that aren't necessarily in the prompt
    const postProcessOutput = (rawText: string): string => {
      let processed = cleanupAIOutput(rawText, stopTokens, { classic: !directedScenes });

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
      if (!directedScenes) {
        newMemory.content = output;
        // Classic playback: one narrator utterance, no per-speaker parsing or voice casting
        this.playTtsLines([{ speaker: 'Narrator', text: output }]);
        return {
          status: InteractionEventStatus.GENERATED,
          text: output,
          request: response.request,
          memory: newMemory,
        };
      }

      const rawSceneText = output;
      const exchanges: LLMExchange[] = [
        { label: 'Scene Generation', request: openAIRequest, responseText: rawSceneText },
      ];
      let usedReviewerCut = false;
      try {
        const directorReview = await this.runDirectorReview(rawSceneText, actionTypeForEvent(event.event_type));
        output = directorReview.text;
        usedReviewerCut = directorReview.usedReview;
        exchanges.push({
          label: 'Director Review',
          request: directorReview.request,
          responseText: directorReview.text,
        });
      } catch (err) {
        log.error('Director review failed, using the scene as generated', err);
      }
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

      this.recordTrace([newMemory.content], {
        pipeline: 'scene_generation',
        exchanges,
        review: {
          before: rawSceneText,
          after: output,
          usedReviewerCut,
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
    interactionActionType?: AIActionType,
  ): Promise<{ text: string; request: OpenAICompatibleRequest; usedReview: boolean }> {
    const systemPrompt = DIRECTOR_REVIEW_SYSTEM_PROMPT;

    const oneShot = await this.runOneShot(
      'Director Review',
      systemPrompt,
      text,
      300,
      undefined,
      AIActionType.DIRECTED_SCENE_REVIEWER,
      interactionActionType,
      { stageId: StageId.PREFRONTAL_REVIEW },
    );
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
    // The interaction that started this call, so a stage with no override of its own still
    // honours an override set on the interaction (see getConfigForDirectedStage)
    interactionActionType?: AIActionType,
    // Which pipeline stage this call IS. An options bag rather than a ninth positional:
    // 3.2 adds simId here so a stage can resolve against one Sim'''s Sentience.
    options?: { stageId?: StageId },
  ): Promise<{ exchange: LLMExchange; text: string }> {
    const providerConfig = this.ctx.providerConfigs.getConfigForDirectedStage(actionType, interactionActionType);
    // The context budget belongs to the model, not to this call site: a hardcoded 3900 threw
    // away most of a 16k window on the big models and silently cut the payload on every one.
    const resolvedModel = model ?? providerConfig.model;
    const modelSettings = await this.ctx.modelSettings.getModelSettings(resolvedModel, providerConfig.apiType);
    // A stage the player has overridden sends their prompt instead of the built one
    const resolvedSystemPrompt = options?.stageId
      ? promptFor(options.stageId, systemPrompt, this.ctx.settings.stagePromptOverrides)
      : systemPrompt;
    let oneShotRequest: OneShotRequest = {
      systemPrompt: resolvedSystemPrompt,
      messages: [userText],
      maxResponseTokens,
      maxTokens: modelSettings.max_tokens,
    };

    getInputFormatters(providerConfig.apiType).forEach((formatter) => {
      oneShotRequest = formatter.formatOneShotRequest(oneShotRequest);
    });

    const openAIRequestBuilder = new OpenAIRequestBuilder(this.ctx.getTokenCounter(providerConfig.apiType));
    const openAIRequest = openAIRequestBuilder.buildOneShotOpenAIRequest(oneShotRequest);
    // An explicit model (scenario tester's per-stage picks) wins over the action's provider config
    openAIRequest.model = resolvedModel;
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
    // Service NPCs arrive named "Sim <id>"; the alias table gives them their real name
    // so prompts and transcripts never call the Grim Reaper "Sim"
    event.sentient_sims = applySimAliasNames(event.sentient_sims);
    // A solo player line (The Voice, Twitch Chat) may be a request for the sim to DO
    // something rather than talk. The ask-action sub-type triages it, and only a fully
    // completed run (matched action + in-character yes/no, refusals included) replaces
    // the scene — any miss falls through to the ordinary reply below.
    if (!options.continueScene && options.playerLine && event.sentient_sims.length === 1) {
      const asked = await this.ctx.askAction.tryAskedAction(event, options, playbackOptions);
      if (asked) {
        return asked;
      }
    }
    const interactionActionType = actionTypeForEvent(event.event_type);
    const directorConfig = this.ctx.providerConfigs.getConfigForDirectedStage(
      AIActionType.DIRECTED_SCENE_DIRECTOR,
      interactionActionType,
    );
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
    const carried = (options.carriedLines ?? []).length > 0 ? toTranscript(options.carriedLines ?? []) : '';
    const previously = [formatPreviouslyInScene(recentMemories), carried].filter(Boolean).join('\n');
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
    // The beat as it HAPPENED, with none of the prompt scaffolding the actors are given
    // (the "Open the scene:" opener, the valence clause). Live 2026-08-16: memory rows
    // stored `<interaction> + <director instruction> + <dialogue>`, so sims recalled
    // stage directions as events — one row even remembered being told "never a joke
    // between friends". Anything a sim can read back uses this; only the model sees
    // sceneAction.
    let displayAction: string | undefined;
    if (continuingScene) {
      sceneAction =
        'The scene continues. Pick up the conversation exactly where it left off and move it forward — do not repeat or rephrase anything already said.';
    } else if (playerLine) {
      const audience = performerNames.length > 0 ? ` to ${formatListToString(performerNames)}` : '';
      sceneAction = `${playerLine.speaker} just said${audience}: "${playerLine.text}" — play the reply. Answer what was actually said, in the flow of the conversation already underway.`;
      // V-3: the one semantic spot where the sim learns WHAT is speaking to them
      const persona = this.ctx.settings.playerVoicePersona;
      if (options.playerLineFlavor) {
        sceneAction += ` ${playerLine.speaker} is ${options.playerLineFlavor}. Their words are heard only by ${formatListToString(performerNames)}; nobody else in the room hears them.`;
      } else if (playerLine.speaker === this.ctx.settings.playerSpeakerName) {
        const flavor = playerPersonaFlavor(persona, this.ctx.settings.playerVoicePersonaBio);
        sceneAction += ` ${playerLine.speaker} is ${flavor}. Their words are heard only by ${formatListToString(performerNames)}; nobody else in the room hears them.`;
      }
    } else {
      sceneAction = promptRequest.action ?? options.action;
      displayAction = sceneAction;
      // V-5b: a fresh scene OPENS — the actors are just starting this conversation.
      // Without it they launched mid-thought ("That reminds me of a joke:" before the
      // joke) because nothing told them this was the first exchange.
      if (sceneAction && !previously) {
        sceneAction = `${sceneAction} Open the scene: the characters are just starting this conversation — the first line begins it, nothing was said before.`;
      }
      // N-1: the interaction's own valence frames the beat. Without it the model read
      // 'YellAT' as a friendly chat (playtest 08-04..08-14) — the pre_action text alone
      // was not enough once the director chose a warm genre.
      const valenceClause = valenceFraming((event as { valence?: string }).valence);
      if (sceneAction && valenceClause) {
        sceneAction = `${sceneAction} ${valenceClause}`;
      }
    }

    if (!sceneAction || performers.length === 0) {
      log.error('Directed generation has no action to drive the scene');
      return { status: InteractionEventStatus.NOOP };
    }

    // A lone sim runs the same pipeline with the dialogue stage NULLed: director, then
    // inner monologue only, then scores. There is no narrator — a solo beat is a thought.
    const monologueOnly = performers.length === 1 && !playerLine;

    const exchanges: LLMExchange[] = [];
    // The mod abandons an interaction request after 80 seconds, so each stage checks the
    // clock before starting another round trip and airs what it has instead of timing out
    const startedAt = Date.now();
    const overBudget = () => Date.now() - startedAt > directedSceneBudgetMs;

    // 1. Director splits the full context into one complete, self-contained prompt per actor
    const briefingSystemPrompt = buildBriefingSystemPrompt({
      simNames,
      performerNames,
      sceneContext,
      monologueOnly,
    });

    // A failed briefing is recoverable � actors fall back to the raw scene context below
    let briefingText = '';
    try {
      const briefing = await this.runOneShot(
        'Director Briefing',
        briefingSystemPrompt,
        `${previouslyBlock}${sceneAction}`,
        500,
        options.directorModel,
        AIActionType.DIRECTED_SCENE_DIRECTOR,
        interactionActionType,
        { stageId: StageId.PLANNING_BRIEF },
      );
      exchanges.push(briefing.exchange);
      this.logExchange(briefing.exchange);
      briefingText = briefing.text;
    } catch (err) {
      log.error('Director briefing failed, actors will use the raw scene context', err);
    }

    if (overBudget()) {
      log.error('Directed scene ran out of time during the director briefing');
      return { status: InteractionEventStatus.NOOP, exchanges };
    }

    // Each actor receives the shared scene briefing followed by their private briefing
    const sceneMatch = /===\s*SCENE\s*===\s*([\s\S]*?)(?=\n\s*===\s*PROMPT FOR|$)/i.exec(briefingText);
    const sharedScene = sceneMatch ? sceneMatch[1].trim() : '';
    const actorPrompts = new Map<string, string>();
    performerNames.forEach((name) => {
      const promptMatch = new RegExp(
        `===\\s*PROMPT FOR\\s+${escapeRegExp(name)}\\s*===\\s*([\\s\\S]*?)(?=\\n\\s*===\\s*PROMPT FOR|$)`,
        'i',
      ).exec(briefingText);
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
      const actorSystemPrompt = buildSpeechSystemPrompt({
        simName: sim.name,
        actorPrompt: actorPrompts.get(sim.name) ?? '',
        monologueOnly,
      });

      const conversationSoFar = toTranscript(sceneLines);
      const actorUserText = `${previouslyBlock}${sceneAction}${
        conversationSoFar ? `\n\nThe conversation so far:\n${conversationSoFar}` : ''
      }`;
      if (performedLines.length > 0 && overBudget()) {
        log.error('Directed scene ran out of time mid-performance, airing the lines delivered so far');
        break;
      }

      try {
        const performance = await this.runOneShot(
          `Actor: ${sim.name}`,
          actorSystemPrompt,
          actorUserText,
          120,
          // actorModels is parallel to the full sim list, not the performers subset
          options.actorModels?.[event.sentient_sims.indexOf(sim)],
          AIActionType.DIRECTED_SCENE_ACTOR,
          interactionActionType,
          { stageId: StageId.BROCA_SPEECH },
        );
        exchanges.push(performance.exchange);
        this.logExchange(performance.exchange);

        const parsed = parseActorPerformance(performance.text, simNames);
        // In a solo beat everything the actor produced is thought — an untagged reply
        // (parsed as say) is still the monologue
        let say = monologueOnly ? '' : parsed.say;
        let think = parsed.think || (monologueOnly ? parsed.say : '');
        // The actor wrote somebody else's line (typically the player's next line in a
        // continued voice scene) — drop it rather than air it as this sim's own words
        // The player's own label is in the set too: with a custom name set, "Jaz: ..."
        // is exactly the impersonation the default labels already guard against
        const foreignSpeakers = [...simNames, this.ctx.settings.playerSpeakerName];
        if (say && isForeignSpeakerLine(say, sim.name, foreignSpeakers)) {
          log.warn(`[Pipeline] Actor ${sim.name} spoke for another speaker — dropping say: ${say}`);
          say = '';
        }
        if (think && isForeignSpeakerLine(think, sim.name, foreignSpeakers)) {
          log.warn(`[Pipeline] Actor ${sim.name} thought another speaker's line — dropping think: ${think}`);
          think = '';
        }
        log.info(`[Pipeline] Actor ${sim.name} — say: ${say || '(none)'} | think: ${think || '(none)'}`);
        if (say.length > 1) {
          const line = { speaker: sim.name, text: say };
          sceneLines.push(line);
          performedLines.push(line);
        }
        if (think.length > 1) {
          // Keyed by sim_id, never name: two sims sharing a name string collided in
          // this map and the wrong sim's thought landed in the other's owned memory
          // row (live 2026-08-26, finding #4)
          monologueBySim.set(sim.sim_id, think);
        }
      } catch (err) {
        // A failed actor loses their line, not the scene
        log.error(`Actor generation failed for ${sim.name}`, err);
      }
    }

    if (monologueOnly) {
      return this.finishMonologueScene(event, options, playbackOptions, {
        performer: performers[0],
        think: monologueBySim.get(performers[0].sim_id),
        sharedScene,
        sceneAction,
        displayAction,
        directorDirection: briefingText,
        exchanges,
      });
    }

    if (performedLines.length === 0) {
      log.error('No actor produced a usable line for the directed scene');
      return { status: InteractionEventStatus.NOOP, exchanges };
    }

    // 3. Reviewer: the director reviews the whole conversation and locks the final cut
    const compileSystemPrompt = buildSceneReviewSystemPrompt({
      simNames,
      performerNames,
      hasPlayerLine: Boolean(playerLine),
      playerLineSpeaker: playerLine?.speaker,
      performerNamesList: formatListToString(performerNames),
    });

    // The review pass is a polish step: without time or on failure, the actors' lines air as delivered
    let reviewedLines: DialogueLine[] = [];
    if (overBudget()) {
      log.error('Directed scene ran out of time before the director review, airing the lines as performed');
    } else {
      try {
        // V-5b: the reviewer's contract is STRUCTURAL now — the delivered lines are numbered
        // and it returns those numbers' lines; the continuation instruction is summarised,
        // never passed verbatim (passing "The scene continues... move it forward" verbatim
        // is what made it write new lines — a2ef601 truncated the symptom, this fixes it)
        const numbered = performedLines.map((line, index) => `${index + 1}. ${line.speaker}: ${line.text}`).join('\n');
        const directionSummary = continuingScene
          ? 'a continuation beat of a conversation already underway'
          : (displayAction ?? sceneAction);
        const compiled = await this.runOneShot(
          'Director Review',
          compileSystemPrompt,
          `${previouslyBlock}What the actors were directed to play: ${directionSummary}\n\n${
            playerLine ? `The line being replied to:\n${toTranscript([playerLine])}\n\n` : ''
          }The ${performedLines.length} delivered line(s) to review, numbered — return exactly these ${performedLines.length} lines (same numbers, same order), kept or repaired, and nothing after them:\n${numbered}`,
          400,
          options.directorModel,
          AIActionType.DIRECTED_SCENE_REVIEWER,
          interactionActionType,
          { stageId: StageId.PREFRONTAL_REVIEW },
        );
        exchanges.push(compiled.exchange);
        this.logExchange(compiled.exchange);

        // A chat reply is the answer to a line the player already spoke; if the reviewer echoes
        // that line back it would air (and be remembered) twice
        reviewedLines = parseReviewedLines(compiled.text, simNames).filter(
          (line) => !playerLine || line.speaker !== playerLine.speaker,
        );
        // The reviewer is an editor, not a writer: it may keep or repair the delivered lines,
        // never extend the scene. If it continued the conversation anyway, everything past the
        // delivered line count is its invention — cut it off there.
        if (reviewedLines.length > performedLines.length) {
          log.warn(
            `[Pipeline] Reviewer returned ${reviewedLines.length} lines for ${performedLines.length} delivered — truncating its continuation`,
          );
          reviewedLines = reviewedLines.slice(0, performedLines.length);
        }
      } catch (err) {
        log.error('Director review failed, airing the lines as performed', err);
      }
    }
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
      performers.map((sim) => ({ name: sim.name, think: monologueBySim.get(sim.sim_id) })),
      options.directorModel,
      interactionActionType,
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

    // V-5a: multi-round conversations. The scorer says whether the exchange is still open
    // and how strongly the scene wants another round; capped by sceneMaxRounds and the
    // remaining scene budget. Applies to dialogue AND voice replies (a sim's answer to the
    // player can take 2-3 beats to finish). The next round is kicked off from play() so
    // it appends to the same paced scene stream, after this round has started airing.
    const round = options.round ?? 1;
    const wantsMore = [...sceneScores.scores.values()].some(
      (score) => score.unfinished === true || (score.continue ?? 0) >= 7,
    );
    const roundsAllowed = round < this.ctx.settings.sceneMaxRounds;
    // A lone sim answering the player has nobody to continue WITH: the next round would
    // carry no player line, so it would run as a solo monologue told to "move the
    // conversation forward" — and the actor obliged by writing the player's next line
    // as their own thought (live 2026-08-17: "The Voice: Let's just say I've been
    // watching…" aired as Ehren's inner monologue). The player speaks next, not the sim.
    const partnerless = Boolean(playerLine) && performers.length === 1;
    const continueNext =
      wantsMore && roundsAllowed && !overBudget() && !monologueOnly && !partnerless && !options.saveMemory;
    if (wantsMore && !continueNext) {
      log.info(
        `[Pipeline] Scene wants another round but ${
          !roundsAllowed
            ? `round cap ${this.ctx.settings.sceneMaxRounds} reached`
            : overBudget()
              ? 'the scene budget is spent'
              : partnerless
                ? 'the only other speaker is the player — waiting for them'
                : 'this path does not continue'
        }`,
      );
    }

    // The scene's driving action is shown above the dialogue in the in-game memories window,
    // but it is never spoken: TTS streams finalLines, which stay pure dialogue, and the paced
    // subtitle block is suppressed. Continuations reuse the synthetic "scene continues"
    // instruction rather than a real action, so they show only the dialogue. A chat beat's
    // action is a direction written for the actors, and the player's line already showed in
    // the game's chat box — neither belongs above the reply.
    const preActionLine = continuingScene || playerLine ? undefined : displayAction;
    const finalText = preActionLine ? `${preActionLine}\n${dialogueText}` : dialogueText;

    // The memory may be persisted here, or later by the mod posting back either the raw
    // scene text or the chat-window-formatted one — key the trace on every shape it can take
    this.recordTrace([finalText, dialogueText, formatSceneForChatWindow(finalText)], {
      pipeline: 'directed_scene',
      exchanges,
      directorDirection: briefingText,
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
      const modDisplayAction =
        playerLine && options.playerLineDisplaySpeaker
          ? toTranscript([{ ...playerLine, speaker: options.playerLineDisplaySpeaker }])
          : undefined;
      // This save pushes memory_created BEFORE play() marks the scene paced — mark first so
      // the game suppresses the block subtitle and waits for the streamed lines
      if (newMemory.content) {
        markScenePaced(newMemory.content);
      }
      this.ctx.memoryRepository.createMemory({ memory: newMemory, participants }, { modDisplayAction });
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
        sendSceneLineToMod({
          speaker: options.playerLineDisplaySpeaker ?? playerLine.speaker,
          text: playerLine.text,
        });
      }
      // Twitch chat's own voice: the question airs as the scene's first TTS line, pre-cast
      // to the configured chat voice. Its subtitle already went out just above, so the
      // renderer skips re-reporting it.
      const spokenQuestion: DialogueLine[] =
        playerLine && options.speakPlayerLine
          ? [
              {
                speaker: options.playerLineDisplaySpeaker ?? playerLine.speaker,
                text: options.speakPlayerLine.spokenText,
                voiceId: options.speakPlayerLine.voiceId,
                skipSceneLine: true,
              },
            ]
          : [];
      this.playTtsLines([...spokenQuestion, ...finalLines], event.sentient_sims, {
        paced: true,
        priority: playbackOptions.priority,
        preamble: preActionLine ? `(${preActionLine})` : undefined,
        pacedText: finalText,
      });
      if (continueNext) {
        log.info(
          `[Pipeline] Scene round ${round + 1}/${this.ctx.settings.sceneMaxRounds}: continuing the conversation`,
        );
        const carriedLines = [...(options.carriedLines ?? []), ...(playerLine ? [playerLine] : []), ...finalLines];
        // Fire-and-forget: the continuation is its own generation with its own memory row
        void this.runDirectedGeneration(
          event,
          {
            ...options,
            continueScene: true,
            playerLine: undefined,
            speakPlayerLine: undefined,
            round: round + 1,
            carriedLines,
          },
          { ...playbackOptions, deferPlayback: false, onPlaybackReady: undefined },
        ).catch((error: unknown) => {
          log.warn(`[Pipeline] Scene round ${round + 1} failed`, error);
        });
      }
    });
    if (playbackOptions.deferPlayback) {
      playbackOptions.onPlaybackReady?.(play);
    } else {
      play();
    }

    return {
      status: InteractionEventStatus.GENERATED,
      text: formatSceneForChatWindow(finalText),
      request: exchanges.at(-1)?.request,
      exchanges,
      memory: newMemory,
    };
  }

  // Completion path for a monologue-only (solo) directed scene: no dialogue, no reviewer.
  // The thought IS the scene — scored by the reflection stage, spoken aloud in the sim's
  // own voice and subtitled as "<Name> (to self):" via the paced scene-line stream. The
  // memory row still records it as a thought ("<Name> (thinking):"), typed 'monologue' so
  // it stays out of shared scene history, and the memories POST stamps single-participant
  // monologue rows with their owner.
  private async finishMonologueScene(
    event: SSEvent,
    options: DirectedGenerationOptions,
    playbackOptions: PlaybackOptions,
    scene: {
      performer: SentientSim;
      think?: string;
      sharedScene: string;
      sceneAction: string;
      // The beat without the actors' scaffolding — what the memory row may show
      displayAction?: string;
      directorDirection: string;
      exchanges: LLMExchange[];
    },
  ): Promise<InteractionEventResult> {
    const { performer, think, sharedScene, sceneAction, displayAction, directorDirection, exchanges } = scene;
    if (!think || think.length <= 1) {
      log.error(`No inner monologue produced for ${performer.name}`);
      return { status: InteractionEventStatus.NOOP, exchanges };
    }

    const sceneScores = await this.runSceneScores(
      sharedScene || sceneAction,
      '',
      [{ name: performer.name, think }],
      options.directorModel,
      actionTypeForEvent(event.event_type),
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
      // The beat that drove the thought heads the row in the memories window — the bare
      // beat, never the director's instructions to the actor
      action: displayAction ?? sceneAction,
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
      // The monologue row reaches the mod's memories window live as the sim's thought;
      // the mod keeps monologue rows off the subtitle/pause path.
      this.ctx.memoryRepository.createMemory({
        memory: newMemory,
        participants,
        index: { owner: performer.sim_id, importance: score?.memory },
      });
    }

    // The thought plays aloud as a self-directed aside: marking the scene paced suppresses
    // the memory block's "(thinking)" subtitle when the mod POSTs the memory back, and the
    // renderer streams one "(to self)" line to the game timed to the sim's own voice. Only
    // the on-screen delivery changes — the memory row above still remembers it as a thought.
    const play = once(() => {
      markScenePaced(finalText);
      this.playTtsLines([{ speaker: `${performer.name} (to self)`, text: think }], event.sentient_sims, {
        paced: true,
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
    interactionActionType?: AIActionType,
  ): Promise<{ scores: Map<string, SceneScore>; exchange?: LLMExchange }> {
    const names = performances.map((performance) => performance.name);
    if (names.length === 0) {
      return { scores: new Map() };
    }
    const systemPrompt = buildSceneSalienceSystemPrompt({ names });

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
        interactionActionType,
        { stageId: StageId.LIMBIC_SALIENCE },
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
      // Scores come back from the model keyed by NAME STRING; mapping that back to a
      // sim must be ambiguity-safe or a name collision arms the WRONG sim's next
      // action (live 2026-08-26: an infant credited with an adult's go_out). Exactly
      // one exact match wins; failing that, exactly one first-name-prefix match; still
      // ambiguous means better no desire than the wrong sim's.
      let matches = event.sentient_sims.filter((candidate) => candidate.name === name);
      if (matches.length === 0) {
        const prefix = `${name.toLowerCase()} `;
        matches = event.sentient_sims.filter((candidate) => candidate.name.toLowerCase().startsWith(prefix));
      }
      if (matches.length !== 1) {
        if (matches.length > 1) {
          log.warn(`[Pipeline] scene score for "${name}" matches ${matches.length} sims — skipping, not guessing`);
        }
        return;
      }
      const sim = matches[0];
      try {
        this.ctx.cognitionService.armDesireFromScene(sim.sim_id, {
          score: score.action,
          reason: score.action_reason,
          thought: monologueBySim.get(sim.sim_id),
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
      const think = monologueBySim.get(sim.sim_id);
      if (!think) {
        return;
      }
      try {
        // Pushed to the mod so the memories window shows the thought live under the
        // sim's lines; the mod keeps monologue rows off the subtitle/pause path.
        this.ctx.memoryRepository.createMemory({
          memory: {
            content: think,
            location_id: event.environment.location_id,
            event_type: 'monologue',
          },
          participants: [{ id: sim.sim_id }],
          index: { owner: sim.sim_id, importance: scores.get(sim.name)?.memory },
        });
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
    playTTS(text, sims, this.voiceCastingOptions(sims));
  }

  playTtsLines(
    lines: DialogueLine[],
    sims?: SentientSim[],
    options?: { paced?: boolean; preamble?: string; pacedText?: string; priority?: boolean },
  ) {
    playTTSLines(lines, sims, { ...options, ...this.voiceCastingOptions(sims) });
  }

  // Which provider's voices to cast per sim, plus the voices the user pinned to these
  // sims in the Sims tab. Best effort: TTS should still play with automatically cast
  // voices if the save database isn't loaded.
  private voiceCastingOptions(sims?: SentientSim[]): PlayTTSVoiceOptions {
    const voiceType = voiceTypeForTTS(this.ctx.settings.ttsApiType, this.ctx.settings.sentientSimsAITtsSettings.model);
    if (!voiceType || !sims || sims.length === 0) {
      return { voiceType };
    }

    try {
      return {
        voiceType,
        voiceOverrides: this.ctx.participantRepository.getParticipantVoices(
          sims.map((sim) => sim.sim_id),
          voiceType,
        ),
      };
    } catch (err) {
      log.warn('Unable to look up per-sim voice overrides', err);
      return { voiceType };
    }
  }
}
