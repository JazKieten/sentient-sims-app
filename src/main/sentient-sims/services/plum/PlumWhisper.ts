// Plum whispers: the Sim's side of one line Plum says to them (core).
//
// Plum directs the way the game itself does, as a voice in a Sim's head the Sim can choose
// not to listen to (plan merry-conjuring-dahl, 2026-10-17). One whisper is: Plum's line to
// the Sim, optionally the pie-menu item Plum hopes they pick, then ONE actor-model call
// (the cheap model, the Sim's live status, facts and the thread so far) answering in
// character with {willing, reply, thought}. Agreement clicks the item through the mod's
// click_pie_menu with source 'whisper' (the game's tests run again, a greyed item is refused
// with its reason, the click yields to the player's own clicks and is stamped mod-owned),
// and ONLY a click that took airs the thought: a "(to self)" line to the mod (memories row,
// subtitle, balloon) stored as the Sim's own monologue memory. The exchange itself is two
// rows in the Plum tab (whisper / reply) and a journal line; the Sim never learns a Plum
// exists (conscience framing, prompts/plumWhisper.ts).
//
// Autonomy's AskActionService has the same two steps for a player's ask; it is a stripped
// module, so this is the core copy rather than an ext slot.
import log from 'electron-log';
import type { ApiContext } from '../ApiContext';
import type { PlumService } from '../PlumService';
import type { SentientSim } from '../../models/SentientSim';
import type { MemoryEntity } from '../../db/entities/MemoryEntity';
import { AIActionType } from '../../models/AIActionType';
import { StageId } from '../../pipeline/stages';
import { buildWhisperSystemPrompt } from '../../pipeline/prompts/plumWhisper';
import { firstJsonBlockLoose } from '../../util/jsonBlock';
import { formatSelfStatus } from '../../util/formatSelfStatus';
import { markScenePaced } from '../../util/pacedScenes';
import { sendSceneLineToMod } from '../../util/notifyRenderer';

export type WhisperItem = {
  // The pie-menu key (or label) click_pie_menu takes, as pie_menu listed it
  key: string;
  label: string;
  // The click's target when it is another Sim or an object (click_pie_menu's `target`)
  targetId?: string;
  targetName?: string;
};

export type WhisperRequest = {
  simId: string;
  simName: string;
  line: string;
  item?: WhisperItem;
  origin: 'chat' | 'script';
  // The script beat this whisper is ("script \"Dinner\" beat 2"), for the log and the journal
  beatLabel?: string;
};

export type WhisperDecision = { willing: boolean; reply: string; thought?: string };

export type WhisperClick = { changed: string; key: string; interaction_id?: string };

export type WhisperResult = {
  // The Sim agreed (the world may still have said no: see `refused`)
  accepted: boolean;
  reply: string;
  thought?: string;
  // The click that took
  clicked?: WhisperClick;
  // The Sim agreed but the click did not take (greyed, a player click pending, refused)
  refused?: string;
  // The thought went out to the game (a memory row and a (to self) line)
  delivered?: boolean;
};

export type WhisperDeps = { now?: () => number };

type Exchange = { at: number; line: string; reply: string; accepted: boolean };

export const THREAD_MAX = 8;
export const THREAD_TTL_MS = 30 * 60_000;
export const REPLY_MAX_TOKENS = 400;
export const CLICK_TIMEOUT_MS = 20_000;
const RECENT_MEMORIES = 4;
const MEMORY_CHARS = 300;
// The reply when the model gave nothing usable twice: a glitch, never a refusal (the tag
// and the freeze reason say so, Plum re-whispers or replaces)
export const NO_ANSWER = '(no usable answer)';
const DECISION_TRIES = 2;

export class PlumWhisperService {
  private readonly ctx: ApiContext;

  private readonly plum: PlumService;

  private readonly deps: WhisperDeps;

  // Per Sim, the last exchanges with the voice: the Sim remembers being nudged
  private readonly threads = new Map<string, Exchange[]>();

  constructor(ctx: ApiContext, plum: PlumService, deps: WhisperDeps = {}) {
    this.ctx = ctx;
    this.plum = plum;
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  // The whole whisper: rows, the decision, the click, the thought, the journal entry
  async whisper(request: WhisperRequest): Promise<WhisperResult> {
    const line = request.line.trim();
    const label = request.beatLabel ?? `whisper to ${request.simName}`;
    this.plum.addVisibleRow({ kind: 'whisper', name: request.simName, text: line });
    const decision = await this.decide({ ...request, line });
    const result: WhisperResult = { accepted: decision.willing, reply: decision.reply, thought: decision.thought };
    if (!request.item) {
      // Talk only: nothing runs, `willing` is just how the Sim took it
      result.accepted = decision.willing;
    } else if (decision.willing) {
      const click = await this.click(request, request.item);
      if (click.clicked) {
        result.clicked = click.clicked;
        if (decision.thought) {
          result.delivered = this.deliver(request, decision.thought);
        }
      } else {
        result.refused = click.refused ?? 'the click did not take';
      }
    }
    this.remember(request.simId, line, decision.reply, result.accepted);
    this.plum.addVisibleRow({
      kind: 'reply',
      name: request.simName,
      text: decision.reply,
      ok: result.accepted && !result.refused,
      summary: replyTag(request, result),
    });
    log.info(`[PlumWhisper] ${label}: ${describeOutcome(request, result)}`);
    return result;
  }

  // One actor-model call (two on a glitch): the Sim answers the voice in character
  async decide(request: WhisperRequest): Promise<WhisperDecision> {
    const system = buildWhisperSystemPrompt({
      simName: request.simName,
      statusBlock: this.statusBlock(request.simId),
      factsBlock: this.factsBlock(request.simId, request.item?.targetId),
      recentBlock: this.recentBlock(),
      threadBlock: this.threadBlock(request.simId),
    });
    const nudge = request.item
      ? `\nIt is nudging you to: ${request.item.label}${request.item.targetName ? ` (with ${request.item.targetName})` : ''}.`
      : '';
    const user = `The voice says: "${request.line}"${nudge}\n\nAnswer as ${request.simName}.`;
    // The cheap actor model drops a quote or a comma between the fields now and then
    // (live 2026-10-17: two of five answers); the parse repairs those shapes, and a reply
    // that still reads as nothing is asked for once more before it counts as no answer.
    // An unusable answer never silently runs an action.
    for (let attempt = 1; attempt <= DECISION_TRIES; attempt += 1) {
      try {
        const shot = await this.ctx.ai.runOneShot(
          `Plum whisper: ${request.simName}`,
          system,
          user,
          REPLY_MAX_TOKENS,
          undefined,
          AIActionType.PLUM_WHISPER,
          undefined,
          { stageId: StageId.PLUM_WHISPER },
        );
        const decision = parseDecision(shot.text);
        if (decision) {
          return decision;
        }
        log.warn(
          `[PlumWhisper] ${request.simName}'s answer was unusable (try ${attempt}); received: ${JSON.stringify(shot.text.slice(0, 200))}`,
        );
      } catch (error) {
        log.warn(`[PlumWhisper] the decision call failed (try ${attempt})`, error);
      }
    }
    return { willing: false, reply: NO_ANSWER };
  }

  // The Sim agreed: click the item as THEIR choice. Not through runScheduledTool: the click
  // is the whisper's, not a push of Plum's, so it counts for nothing against a turn's cap
  private async click(
    request: WhisperRequest,
    item: WhisperItem,
  ): Promise<{ clicked?: WhisperClick; refused?: string }> {
    if (!this.ctx.settings.plumAllowWrites) {
      return { refused: '"Plum may change things" is off in the companion app\'s Settings' };
    }
    const outcome = await this.plum.callMod(
      'click_pie_menu',
      { sim: request.simId, target: item.targetId ?? null, item: item.key, source: 'whisper' },
      CLICK_TIMEOUT_MS,
    );
    if (!outcome.ok) {
      return { refused: outcome.error ?? 'the click did not take' };
    }
    const result = (outcome.result ?? {}) as { changed?: unknown; key?: unknown; interaction_id?: unknown };
    const clicked: WhisperClick = {
      changed: typeof result.changed === 'string' ? result.changed : `clicked ${item.label}`,
      key: typeof result.key === 'string' ? result.key : item.key,
    };
    if (typeof result.interaction_id === 'string' && result.interaction_id) {
      clicked.interaction_id = result.interaction_id;
      this.plum.wake.noteWatched(request.simId, result.interaction_id, clicked.key);
    }
    return { clicked };
  }

  // The thought airs ONLY for a click that took: a thought about a deed that never starts
  // reads as a lie. The Sim's own monologue memory (no `action`: the whisper itself never
  // heads the row) and a "(to self)" line the mod shows as a white row, a subtitle and a
  // balloon. Voiced like an ask answer unless plumWhisperVoiced is off.
  private deliver(request: WhisperRequest, thought: string): boolean {
    const speaker = `${request.simName} (to self)`;
    const finalText = `${speaker}: ${thought}`;
    try {
      markScenePaced(finalText);
      const memory: MemoryEntity = {
        content: finalText,
        location_id: Number(this.ctx.simStateCache.getReport()?.lot?.lot_id ?? 0),
        event_type: 'monologue',
      };
      const participants = this.ctx.participantRepository.getParticipants([
        { id: request.simId, fullName: request.simName },
      ]);
      this.ctx.memoryRepository.createMemory({ memory, participants, index: { owner: request.simId } });
    } catch (error) {
      // No database loaded (or a refused row): the line still airs, it is just not kept
      log.warn('[PlumWhisper] could not store the thought', error);
    }
    try {
      if (this.ctx.settings.plumWhisperVoiced) {
        const cast: SentientSim[] = [];
        this.ctx.ai.playTtsLines([{ speaker, text: thought, simId: request.simId }], cast, {
          paced: true,
          pacedText: finalText,
        });
      } else {
        sendSceneLineToMod({ speaker, text: thought, simId: request.simId, voiced: false });
      }
      return true;
    } catch (error) {
      log.warn('[PlumWhisper] could not air the thought', error);
      return false;
    }
  }

  // --- the context the Sim answers from ------------------------------------------------------

  private statusBlock(simId: string): string {
    try {
      const entry = this.ctx.simStateCache.getSim(simId);
      if (!entry) {
        return '';
      }
      const absoluteDay = this.ctx.simStateCache.getReport()?.lot?.clock?.absolute_day;
      // Today's plan is the autonomy tier's; core answers from the status alone
      const plan =
        entry.is_household !== false && absoluteDay !== undefined
          ? this.ctx.ext.selfStatusPlan?.(simId, absoluteDay)
          : undefined;
      return formatSelfStatus(entry, plan);
    } catch {
      return '';
    }
  }

  private factsBlock(simId: string, targetId?: string): string {
    try {
      return this.ctx.semanticMemory.recall(simId, { mentionedSimIds: targetId ? [targetId] : [] });
    } catch {
      return '';
    }
  }

  private recentBlock(): string {
    try {
      const memories = this.ctx.memoryRepository.getMemories().slice(-RECENT_MEMORIES);
      const lines = memories
        .map((memory) => (memory.content ?? memory.action ?? '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .map((text) => (text.length > MEMORY_CHARS ? `${text.slice(0, MEMORY_CHARS)}...` : text));
      return lines.length > 0 ? `Recently:\n${lines.join('\n')}` : '';
    } catch {
      return '';
    }
  }

  private threadBlock(simId: string): string {
    const exchanges = this.thread(simId);
    if (exchanges.length === 0) {
      return '';
    }
    const lines = exchanges.map(
      (exchange) =>
        `Earlier the voice said: "${exchange.line}"\nYou answered: "${exchange.reply}"${exchange.accepted ? ' (and went along with it)' : ''}`,
    );
    return `Earlier today:\n${lines.join('\n')}`;
  }

  private thread(simId: string): Exchange[] {
    const cutoff = this.now() - THREAD_TTL_MS;
    const kept = (this.threads.get(simId) ?? []).filter((exchange) => exchange.at >= cutoff);
    this.threads.set(simId, kept);
    return kept;
  }

  private remember(simId: string, line: string, reply: string, accepted: boolean) {
    const exchanges = this.thread(simId);
    exchanges.push({ at: this.now(), line, reply, accepted });
    while (exchanges.length > THREAD_MAX) {
      exchanges.shift();
    }
  }
}

// The model's {willing, reply, thought}, or undefined when nothing usable came back.
// Strict JSON first, then the loose block (unquoted prose), then field by field for the
// shapes seen live: a reply missing its closing quote before "thought", a missing comma
// between the two strings, a cut-off thought.
export function parseDecision(raw: string): WhisperDecision | undefined {
  const parsed = firstJsonBlockLoose(raw) as { willing?: unknown; reply?: unknown; thought?: unknown } | undefined;
  let willing = typeof parsed?.willing === 'boolean' ? parsed.willing : undefined;
  let reply = typeof parsed?.reply === 'string' ? parsed.reply : '';
  let thought = typeof parsed?.thought === 'string' ? parsed.thought : '';
  if (willing === undefined) {
    const match = /"willing"\s*:\s*(true|false)/i.exec(raw);
    willing = match ? match[1].toLowerCase() === 'true' : undefined;
  }
  if (!reply.trim()) {
    // Up to the thought key, a closing brace or the end; a stray quote before them is dropped
    const match = /"reply"\s*:\s*"([\s\S]*?)"?\s*,?\s*(?:"thought"\s*:|\}|$)/.exec(raw);
    reply = match ? match[1] : '';
  }
  if (!thought.trim()) {
    const match = /"thought"\s*:\s*"([\s\S]*?)"?\s*\}?\s*$/.exec(raw);
    thought = match ? match[1] : '';
  }
  reply = reply
    .replace(/\s*,\s*$/, '')
    .trim()
    .slice(0, 600);
  thought = thought.trim().slice(0, 1200);
  if (willing === undefined || !reply) {
    return undefined;
  }
  return { willing, reply, ...(thought ? { thought } : {}) };
}

// The reply row's tag: "agreed", "declined", "no usable answer", or why the agreed click
// did not take
export function replyTag(request: WhisperRequest, result: WhisperResult): string {
  if (result.reply === NO_ANSWER) {
    return 'no usable answer';
  }
  if (!request.item) {
    return '';
  }
  if (!result.accepted) {
    return 'declined';
  }
  return result.refused ? `agreed, but ${result.refused}` : 'agreed';
}

// One line for the log and the journal: what Plum said, what the Sim said, what came of it
export function describeOutcome(request: WhisperRequest, result: WhisperResult): string {
  const said = `you told ${request.simName} "${request.line.trim()}"; ${request.simName}: "${result.reply}"`;
  if (result.reply === NO_ANSWER) {
    return `${said} -> no usable answer came back (a model glitch, not a refusal)`;
  }
  if (!request.item) {
    return said;
  }
  if (!result.accepted) {
    return `${said} -> declined`;
  }
  if (result.refused) {
    return `${said} -> agreed but ${result.refused}`;
  }
  return `${said} -> agreed, ${result.clicked?.changed ?? 'clicked'}`;
}
