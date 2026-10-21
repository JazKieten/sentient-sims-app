// Plum whispers: Plum's nudge to a Sim, made as the Sim's own click (core).
//
// Plum directs the way the game itself does, as a voice in a Sim's head. One whisper is
// Plum's line to the Sim, kept in Plum's thread as a hidden row (the tab never shows it),
// plus optionally the pie-menu item Plum wants them to pick, clicked through the mod's
// click_pie_menu with source 'whisper': the game's tests run again, a greyed item is refused
// with its reason, the click yields to the player's own clicks and is stamped mod-owned. No
// model is asked and nothing is said back: the Sim neither answers nor voices a thought, and
// the Sim never learns a Plum exists. A talk-only whisper (no item) runs nothing.
import log from 'electron-log';
import type { ApiContext } from '../ApiContext';
import type { PlumService } from '../PlumService';

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

export type WhisperClick = { changed: string; key: string; interaction_id?: string };

export type WhisperResult = {
  // The click that took
  clicked?: WhisperClick;
  // The click did not take (greyed, a player click pending, writes off, the mod refused)
  refused?: string;
};

export const CLICK_TIMEOUT_MS = 20_000;

export class PlumWhisperService {
  private readonly ctx: ApiContext;

  private readonly plum: PlumService;

  constructor(ctx: ApiContext, plum: PlumService) {
    this.ctx = ctx;
    this.plum = plum;
  }

  // The whole whisper: the hidden row, the click, the log line
  async whisper(request: WhisperRequest): Promise<WhisperResult> {
    const line = request.line.trim();
    const label = request.beatLabel ?? `whisper to ${request.simName}`;
    this.plum.addQuietRow({ kind: 'whisper', name: request.simName, text: line });
    const result: WhisperResult = request.item ? await this.click(request, request.item) : {};
    log.info(`[PlumWhisper] ${label}: ${describeOutcome({ ...request, line }, result)}`);
    return result;
  }

  // The item as the Sim's choice. Not through runScheduledTool: the click is the whisper's,
  // not a push of Plum's, so it counts for nothing against a turn's cap
  private async click(request: WhisperRequest, item: WhisperItem): Promise<WhisperResult> {
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
    // The show is where the Sim is: the camera follows a click that took
    this.plum.followActor(request.simId);
    return { clicked };
  }
}

// One line for the log and the journal: what Plum said and what came of it
export function describeOutcome(request: WhisperRequest, result: WhisperResult): string {
  const said = `you told ${request.simName} "${request.line.trim()}"`;
  if (!request.item) {
    return said;
  }
  if (result.clicked) {
    return `${said} -> ${result.clicked.changed}`;
  }
  return `${said} -> ${request.item.label} did not take: ${result.refused ?? 'the click did not take'}`;
}
