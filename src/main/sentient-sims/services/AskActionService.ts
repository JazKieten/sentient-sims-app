import log from 'electron-log';
import { StageId } from '../pipeline/stages';
import { ApiContext } from './ApiContext';
import { AIActionType, actionTypeForEvent } from '../models/AIActionType';
import { CognitionIntent, offeredActions, validateIntent } from '../models/CognitionIntent';
import { InteractionEventResult, InteractionEventStatus, LLMExchange } from '../models/InteractionEventResult';
import { SSEvent } from '../models/InteractionEvents';
import { SentientSim } from '../models/SentientSim';
import { SimStateEntry } from '../models/SimStateReport';
import { playerPersonaFlavor } from '../models/PlayerVoicePersona';
import { MemoryEntity } from '../db/entities/MemoryEntity';
import { firstJsonBlock, firstJsonBlockLoose } from '../util/formatCognitionPrompt';
import {
  ASK_MATCH_SYSTEM_PROMPT,
  ASK_TRIAGE_SYSTEM_PROMPT,
  buildAskDecisionSystemPrompt,
} from '../pipeline/prompts/ask';
import { markScenePaced } from '../util/pacedScenes';
import { sendSceneLineToMod } from '../util/notifyRenderer';
import { DialogueLine, formatSceneForChatWindow } from '../formatter/PromptFormatter';
import { formatPreviouslyInScene } from './AIService';
import type { DirectedGenerationOptions } from './AIService';

// The ask-action sub-type of the actions pipeline: a solo player line (The Voice, Twitch
// Chat) may be a REQUEST for the sim to do something rather than talk. A cheap triage
// stage decides talk-vs-do; a "do" is matched onto the sim's FULL offered vocabulary —
// deliberately NOT the daily loadout subset cognition deliberates over, because the
// speaker may ask for anything the sim can physically do right now — and the sim then
// answers a single yes-or-no question in character: will you do it? The answer's "why or
// why not" airs out loud as the sim's thought, exactly like a solo monologue beat, and a
// yes dispatches the matched action down the normal enqueue_interaction path (the mod's
// age gate and preflight still apply). Every miss — talk, no state report, nothing
// offered matches, an unparseable stage — returns undefined so the caller falls through
// to the ordinary directed voice reply. This pipeline fails inert, never wrong.

// The triage and match prompts now live in the stage registry (pipeline/prompts/ask);
// re-exported here so existing importers keep working.
export { ASK_TRIAGE_SYSTEM_PROMPT, ASK_MATCH_SYSTEM_PROMPT } from '../pipeline/prompts/ask';

// Dispatch identity: bypasses the dispatcher's one-in-flight rule the same way
// 'player_command' does — the sim just consented to a player-driven request, which beats
// whatever idle plan cognition had in flight.
export const ASK_ACTION_SOURCE = 'player_ask';

type AskDecision = { willing: boolean; thought: string };

export class AskActionService {
  private readonly ctx: ApiContext;

  constructor(ctx: ApiContext) {
    this.ctx = ctx;
  }

  // The fork runDirectedGeneration takes before staging a solo voice/chat reply. Returns
  // the finished result when the whole ask-action path ran (including an in-character
  // refusal); returns undefined on ANY miss so the ordinary talk pipeline runs instead.
  async tryAskedAction(
    event: SSEvent,
    options: DirectedGenerationOptions,
    playbackOptions: { priority?: boolean; deferPlayback?: boolean; onPlaybackReady?: (play: () => void) => void } = {},
  ): Promise<InteractionEventResult | undefined> {
    const playerLine = options.playerLine;
    if (!this.ctx.settings.askActionsEnabled || !playerLine || event.sentient_sims.length !== 1) {
      return undefined;
    }
    const sim = event.sentient_sims[0];
    // No state report for this sim (older mod build, zone loading, an alias-only Twitch
    // target) means no offered vocabulary to match against — skip even the triage call
    const entry = this.ctx.simStateCache.getSim(sim.sim_id);
    if (!entry) {
      return undefined;
    }

    const exchanges: LLMExchange[] = [];
    const interactionActionType = actionTypeForEvent(event.event_type);

    if (!(await this.triageSaysDo(playerLine.text, exchanges, interactionActionType))) {
      return undefined;
    }
    log.info(`[AskAction] "${playerLine.text}" triaged as a request for ${sim.name} to act`);

    const report = this.ctx.simStateCache.getReport();
    const lotActionKeys = report?.lot?.action_keys ?? [];
    const matched = await this.matchAction(
      sim,
      entry,
      lotActionKeys,
      playerLine.text,
      exchanges,
      interactionActionType,
    );
    if (!matched) {
      log.info(`[AskAction] nothing offered matches "${playerLine.text}" for ${sim.name} — answering as talk`);
      return undefined;
    }

    const decision = await this.decide(
      event,
      options,
      playerLine,
      sim,
      entry,
      matched,
      exchanges,
      interactionActionType,
    );
    if (!decision) {
      // Every other miss on this path says so out loud; this one used to be the pipeline's
      // one silent exit, which read in the log as "the ask never happened"
      log.info(`[AskAction] no usable decision from ${sim.name} for "${playerLine.text}" — answering as talk`);
      return undefined;
    }
    log.info(
      `[AskAction] ${sim.name} ${decision.willing ? 'accepts' : 'refuses'} [${matched.intent.action}]: ${decision.thought}`,
    );

    if (decision.willing) {
      try {
        this.ctx.actionDispatcher.dispatch({
          sim_id: sim.sim_id,
          action: matched.intent.action,
          target_sim_id: matched.intent.target_sim_id,
          target_object_id: matched.intent.target_object_id,
          motivation: `${playerLine.speaker} asked: "${playerLine.text}"`,
          priority: 'critical',
          // The sim said yes to the speaker: whatever they were doing is off. The mod
          // cancels their queued and running interactions before pushing this one.
          preempt: true,
          source: ASK_ACTION_SOURCE,
        });
      } catch (error) {
        // The sim already said yes; a dropped dispatch (mod reconnecting) still airs the
        // acceptance — the speaker can simply ask again
        log.warn('[AskAction] dispatch refused', error);
      }
    }

    return this.deliver(event, options, playbackOptions, playerLine, sim, decision, exchanges);
  }

  private async triageSaysDo(
    text: string,
    exchanges: LLMExchange[],
    interactionActionType: AIActionType,
  ): Promise<boolean> {
    try {
      const shot = await this.ctx.ai.runOneShot(
        'Ask Triage',
        ASK_TRIAGE_SYSTEM_PROMPT,
        `The line: "${text}"`,
        30,
        undefined,
        AIActionType.ASK_TRIAGE,
        interactionActionType,
        { stageId: StageId.WERNICKE_TRIAGE },
      );
      exchanges.push(shot.exchange);
      const parsed = firstJsonBlock(shot.text) as { intent?: string } | undefined;
      return parsed?.intent === 'do';
    } catch (error) {
      // An unreachable triage must never cost the player their reply — treat as talk
      log.warn('[AskAction] triage call failed', error);
      return false;
    }
  }

  // Matches against everything the state report offers RIGHT NOW — object providers,
  // context-gated lot verbs, socials toward present sims — with no daily-loadout hiding.
  // validateIntent is the same mechanical gate cognition uses, so a hallucinated key,
  // target, or id degrades here instead of reaching the mod.
  private async matchAction(
    sim: SentientSim,
    entry: SimStateEntry,
    lotActionKeys: string[],
    text: string,
    exchanges: LLMExchange[],
    interactionActionType: AIActionType,
  ): Promise<{ intent: CognitionIntent & { action: string }; label: string } | undefined> {
    const offered = offeredActions(entry, lotActionKeys);
    const situation = [
      `You are matching for ${sim.name} (sim_id ${sim.sim_id}).`,
      `OFFERED object actions: ${[...offered.objectActions.entries()].map(([key, objectId]) => `${key} (target_object_id ${objectId})`).join(', ') || '(none)'}`,
      `OFFERED lot actions: ${[...offered.lotActions].join(', ') || '(none)'}`,
      `OFFERED social actions (need a target_sim_id): chat, ask_about_day, ask_about_career, get_to_know, deep_conversation, compliment_outfit, gossip, apologize, tell_joke, tell_funny_story, hug, flirt, kiss, insult`,
      `OFFERED people: ${[...offered.simTargets.entries()].map(([id, info]) => `${info.name ?? 'someone'} (sim_id ${id})`).join(', ') || '(nobody in the room)'}`,
      '',
      `The request: "${text}"`,
    ].join('\n');

    let candidate: CognitionIntent | undefined;
    let label = '';
    try {
      const shot = await this.ctx.ai.runOneShot(
        `Ask Match: ${sim.name}`,
        ASK_MATCH_SYSTEM_PROMPT,
        situation,
        150,
        undefined,
        AIActionType.ASK_ACTION_MATCH,
        interactionActionType,
        { stageId: StageId.WERNICKE_MATCH },
      );
      exchanges.push(shot.exchange);
      // Loose for the same reason as the decision stage: "label" is prose, and an
      // unquoted one would throw away a perfectly good action match
      const parsed = firstJsonBlockLoose(shot.text) as
        | { action?: string | null; target_sim_id?: string; target_object_id?: string; label?: string }
        | undefined;
      if (parsed && typeof parsed.action === 'string' && parsed.action) {
        candidate = {
          kind: 'action',
          action: parsed.action,
          target_sim_id: parsed.target_sim_id || undefined,
          target_object_id: parsed.target_object_id || undefined,
        };
        label = typeof parsed.label === 'string' ? parsed.label.slice(0, 120) : '';
      }
    } catch (error) {
      log.warn('[AskAction] match call failed', error);
    }

    const validated = candidate ? validateIntent(candidate, entry, lotActionKeys) : undefined;
    if (!validated?.ok || validated.intent.kind !== 'action' || !validated.intent.action) {
      return undefined;
    }
    return {
      intent: validated.intent as CognitionIntent & { action: string },
      label: label || validated.intent.action.replace(/_/g, ' '),
    };
  }

  // The yes-or-no beat: not a menu of options — one matched action, one in-character
  // decision, and the "why or why not" that will air as the sim's out-loud thought.
  private async decide(
    event: SSEvent,
    options: DirectedGenerationOptions,
    playerLine: { speaker: string; text: string },
    sim: SentientSim,
    entry: SimStateEntry,
    matched: { intent: CognitionIntent & { action: string }; label: string },
    exchanges: LLMExchange[],
    interactionActionType: AIActionType,
  ): Promise<AskDecision | undefined> {
    // V-3 parity with runDirectedGeneration: the one semantic spot where the sim learns
    // WHAT is speaking to them
    const persona = this.ctx.settings.playerVoicePersona;
    let flavor = options.playerLineFlavor;
    if (!flavor && playerLine.speaker === this.ctx.settings.playerSpeakerName) {
      flavor = playerPersonaFlavor(persona, this.ctx.settings.playerVoicePersonaBio);
    }

    // The same scene-context blocks the director gets, so the decision is grounded in
    // location, time, and who this sim is
    let sceneContext = '';
    let recentlyBlock = '';
    try {
      const config = this.ctx.providerConfigs.getConfigForDirectedStage(
        AIActionType.ASK_DECISION,
        interactionActionType,
      );
      const promptRequest = await this.ctx.promptBuilder.buildPromptRequest(event, {
        apiType: config.apiType,
        modelSettings: await this.ctx.modelSettings.getModelSettings(config.model, config.apiType),
      });
      sceneContext = [
        promptRequest.location,
        promptRequest.dateTime,
        promptRequest.season,
        promptRequest.weather,
        promptRequest.postures,
        promptRequest.participants,
      ]
        .filter((part) => part && part.trim().length > 0)
        .join('\n');
      recentlyBlock = formatPreviouslyInScene(promptRequest.memories.slice(-4));
    } catch (error) {
      // Context is a quality upgrade, not a requirement — decide from the request alone
      log.warn('[AskAction] scene context unavailable for the decision stage', error);
    }

    const speakerIs = flavor ? ` ${playerLine.speaker} is ${flavor}.` : '';
    // "a voice" reads wrong once the speaker has a name of their own ("Jaz — a voice...")
    const heardAs = this.ctx.settings.playerVoicePersonaName
      ? 'someone only you can hear'
      : 'a voice only you can hear';
    // A consent decision turns on who is asking and who it involves: refusing to flirt
    // with your own child is a fact question, not a mood question. The target is the
    // focus so the block carries the relationship that matters here.
    let factsBlock: string;
    try {
      factsBlock = this.ctx.semanticMemory.recall(sim.sim_id, {
        mentionedSimIds: matched.intent.target_sim_id ? [matched.intent.target_sim_id] : [],
      });
    } catch {
      // Deciding without the facts block is the pre-3.1 behaviour, and a refusal that
      // never happens because recall threw is worse than one made without them
      factsBlock = '';
    }
    const decisionSystemPrompt = buildAskDecisionSystemPrompt({
      simName: sim.name,
      speaker: playerLine.speaker,
      heardAs,
      speakerIs,
      sceneContext: factsBlock
        ? `${factsBlock}
${sceneContext}`
        : sceneContext,
    });

    const target = matched.intent.target_sim_id
      ? offeredActions(entry).simTargets.get(matched.intent.target_sim_id)?.name
      : undefined;
    const decisionUserText = `${recentlyBlock ? `Recently:\n${recentlyBlock}\n\n` : ''}${playerLine.speaker} asked: "${playerLine.text}"
What you would do: [${matched.intent.action}] ${matched.label}${target ? `, with ${target}` : ''}

Will you do it?`;

    try {
      const shot = await this.ctx.ai.runOneShot(
        `Ask Decision: ${sim.name}`,
        decisionSystemPrompt,
        decisionUserText,
        150,
        undefined,
        AIActionType.ASK_DECISION,
        interactionActionType,
        { stageId: StageId.PREFRONTAL_DECIDE },
      );
      exchanges.push(shot.exchange);
      // Loose: this stage asks for a prose "thought", and the answer comes back with it
      // unquoted often enough that a strict parse threw the sim's decision away silently
      const parsed = firstJsonBlockLoose(shot.text) as { willing?: unknown; thought?: unknown } | undefined;
      const thought = typeof parsed?.thought === 'string' ? parsed.thought.trim().slice(0, 300) : '';
      if (!parsed || typeof parsed.willing !== 'boolean' || thought.length <= 1) {
        log.warn(
          `[AskAction] ${sim.name}'s decision was unusable; received: ${JSON.stringify(shot.text.slice(0, 200))}`,
        );
        return undefined;
      }
      return { willing: parsed.willing, thought };
    } catch (error) {
      log.warn('[AskAction] decision call failed', error);
      return undefined;
    }
  }

  // Mirrors finishMonologueScene's delivery: the thought is the whole beat — a monologue
  // memory row headed by the speaker's attributed ask, aired aloud as a paced
  // "(to self)" scene line so the mod never double-subtitles it.
  private deliver(
    event: SSEvent,
    options: DirectedGenerationOptions,
    playbackOptions: { priority?: boolean; deferPlayback?: boolean; onPlaybackReady?: (play: () => void) => void },
    playerLine: { speaker: string; text: string },
    sim: SentientSim,
    decision: AskDecision,
    exchanges: LLMExchange[],
  ): InteractionEventResult {
    // "(to self)" (not "(thinking)"): the mod renders this tag as white spoken
    // text with the label dropped — the sim's answer to the player should read
    // as speech in the memories window even after a refresh rebuilds the rows
    // from this stored copy. Ordinary monologues keep "(thinking)" and stay
    // italic thoughts.
    const finalText = `${sim.name} (to self): ${decision.thought}`;
    const askedLine = `${playerLine.speaker}: ${playerLine.text}`;

    const newMemory: MemoryEntity = {
      content: finalText,
      location_id: event.environment.location_id,
      event_type: 'monologue',
      // The ask heads the row in the memories window, attributed like any chat beat
      action: askedLine,
    };

    this.ctx.memoryTrace.recordPending([finalText, formatSceneForChatWindow(finalText)], {
      pipeline: 'ask_action',
      exchanges,
    });

    if (options.saveMemory) {
      // No mod round trip exists on this path (Twitch): persist here, credited to the
      // asking viewer in-game while the stored row keeps the clean speaker
      const participants = this.ctx.participantRepository.getParticipants([{ id: sim.sim_id, fullName: sim.name }]);
      const modDisplayAction = options.playerLineDisplaySpeaker
        ? `${options.playerLineDisplaySpeaker}: ${playerLine.text}`
        : undefined;
      markScenePaced(finalText);
      this.ctx.memoryRepository.createMemory(
        { memory: newMemory, participants, index: { owner: sim.sim_id } },
        { modDisplayAction },
      );
    }

    const play = () => {
      // The ask itself opens the beat in the in-game memories window. The Voice's own
      // asks are not TTS-voiced — the player already said it out loud — but a Twitch
      // question has no one to say it, so speakPlayerLine gives it the chat voice.
      sendSceneLineToMod({
        speaker: options.playerLineDisplaySpeaker ?? playerLine.speaker,
        text: playerLine.text,
      });
      markScenePaced(finalText);
      // Same shape as runDirectedGeneration's talk path: the question airs as the beat's
      // first TTS line, pre-cast to the chat voice, with its subtitle already sent above
      // (skipSceneLine). Without this, an ask that triaged as "do" lost the narration the
      // identical question keeps when it triages as "talk".
      const spokenQuestion: DialogueLine[] = options.speakPlayerLine
        ? [
            {
              speaker: options.playerLineDisplaySpeaker ?? playerLine.speaker,
              text: options.speakPlayerLine.spokenText,
              voiceId: options.speakPlayerLine.voiceId,
              skipSceneLine: true,
            },
          ]
        : [];
      this.ctx.ai.playTtsLines(
        [...spokenQuestion, { speaker: `${sim.name} (to self)`, text: decision.thought }],
        event.sentient_sims,
        {
          paced: true,
          pacedText: finalText,
          priority: playbackOptions.priority,
        },
      );
    };
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
}
