import log from 'electron-log';
import { StageId } from '../pipeline/stages';
import { ApiContext } from './ApiContext';
import type { AutonomyServices } from '../tiers/autonomy';
import { AIActionType } from '../models/AIActionType';
import { CognitionIntent, offeredActions, validateIntent } from '../models/CognitionIntent';
import { SimStateEntry } from '../models/SimStateReport';
import { sendPlayerVoiceStatusToMod, sendPopUpNotification } from '../util/notifyRenderer';
import { firstJsonBlock } from '../util/formatCognitionPrompt';
import { COMMAND_SYSTEM_PROMPT } from '../pipeline/prompts/utility';

// V-8: the direct-command hotkey. Speech is an ORDER for the player's active sim, not talk:
// one cheap one-shot maps the utterance onto the sim's currently OFFERED vocabulary (same
// bind-to-offered machinery cognition uses — never an invented verb), then it goes down the
// normal cognition dispatch path at critical priority as source 'player_command'. The mod's
// age gate and preflight still apply, so a command can come back 'ineligible' and is
// reported honestly. An utterance that maps to nothing is a toast, never a guess.

export class VoiceCommandService {
  private readonly ctx: ApiContext;

  private readonly autonomy: Pick<AutonomyServices, 'actionDispatcher'>;

  constructor(ctx: ApiContext, autonomy: Pick<AutonomyServices, 'actionDispatcher'>) {
    this.ctx = ctx;
    this.autonomy = autonomy;
  }

  private commandedSim(): SimStateEntry | undefined {
    const report = this.ctx.simStateCache.getReport();
    const sims = report?.sims ?? [];
    return sims.find((entry) => entry.is_active) ?? sims.find((entry) => entry.is_household !== false) ?? sims[0];
  }

  async handleCommand(utterance: string): Promise<boolean> {
    const text = utterance.trim();
    if (!text) {
      return false;
    }
    const entry = this.commandedSim();
    const report = this.ctx.simStateCache.getReport();
    if (!entry || !entry.sim_id) {
      sendPopUpNotification('Voice command: no sim to command yet (waiting for the game report)');
      sendPlayerVoiceStatusToMod('error', 'No sim to command yet');
      return false;
    }
    const simLabel = entry.sim_name ?? entry.sim_id;
    const lotActionKeys = report?.lot?.action_keys ?? [];
    const offered = offeredActions(entry, lotActionKeys);
    const situation = [
      `You are ${simLabel} (sim_id ${entry.sim_id}).`,
      `OFFERED object actions: ${[...offered.objectActions.entries()].map(([key, objectId]) => `${key} (target_object_id ${objectId})`).join(', ') || '(none)'}`,
      `OFFERED lot actions: ${[...offered.lotActions].join(', ') || '(none)'}`,
      `OFFERED social actions (need a target_sim_id): chat, ask_about_day, ask_about_career, get_to_know, deep_conversation, compliment_outfit, gossip, apologize, tell_joke, tell_funny_story, hug, flirt, kiss, insult`,
      `OFFERED people: ${[...offered.simTargets.entries()].map(([id, info]) => `${info.name ?? 'someone'} (sim_id ${id})`).join(', ') || '(nobody in the room)'}`,
      '',
      `The player's order: "${text}"`,
    ].join('\n');

    let intent: CognitionIntent | undefined;
    try {
      const shot = await this.ctx.ai.runOneShot(
        `Voice Command: ${simLabel}`,
        COMMAND_SYSTEM_PROMPT,
        situation,
        120,
        undefined,
        AIActionType.VOICE_COMMAND,
        undefined,
        { stageId: StageId.VOICE_COMMAND },
      );
      const parsed = firstJsonBlock(shot.text) as
        | { action?: string | null; target_sim_id?: string; target_object_id?: string; confidence?: number }
        | undefined;
      if (parsed && typeof parsed.action === 'string' && parsed.action) {
        intent = {
          kind: 'action',
          action: parsed.action,
          target_sim_id: parsed.target_sim_id ? String(parsed.target_sim_id) : undefined,
          target_object_id: parsed.target_object_id ? String(parsed.target_object_id) : undefined,
          motivation: `${simLabel} was told: "${text}"`,
        };
      }
    } catch (error) {
      log.warn('[VoiceCommand] mapping call failed', error);
    }

    const validated = intent ? validateIntent(intent, entry, lotActionKeys) : undefined;
    if (!validated?.ok || validated.intent.kind !== 'action' || !validated.intent.action) {
      log.info(`[VoiceCommand] "${text}" could not be mapped to an offered action for ${simLabel}`);
      sendPopUpNotification(`Couldn't map "${text}" to an action ${simLabel} can do right now`);
      sendPlayerVoiceStatusToMod('error', "Couldn't map that to an action");
      return false;
    }
    try {
      const requestId = this.autonomy.actionDispatcher.dispatch({
        sim_id: entry.sim_id,
        action: validated.intent.action,
        target_sim_id: validated.intent.target_sim_id,
        target_object_id: validated.intent.target_object_id,
        motivation: validated.intent.motivation,
        priority: 'critical',
        // The player's order beats a sim's own idle plan; the dispatcher's one-in-flight rule
        // only guards cognition-sourced intents
        source: 'player_command',
      });
      log.info(`[VoiceCommand] ${simLabel} -> ${validated.intent.action} (${requestId}) from "${text}"`);
      return true;
    } catch (error) {
      log.warn('[VoiceCommand] dispatch refused', error);
      sendPopUpNotification(
        `Voice command could not be sent to the game: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}
