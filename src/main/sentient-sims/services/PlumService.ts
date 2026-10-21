// Plum: Claude in the game. The model loop and the conversation live here; the mod is the
// eyes and hands (plum/ss_plum_tools.py) and the tab (overlay/overlay_plum.py).
//
// Transport (websocketServer.ts): the mod sends {plum: {kind: catalogue|say|tool_result|
// control}}; the app sends {type: 'plum_tool_call'} for every tool the mod runs and
// {type: 'plum_event'} for everything the tab shows (rows, status, history, errors).
//
// The loop is manual (the SDK's tool runner has no seam for a tool that runs in another
// process): stream, finalMessage, and while stop_reason is tool_use run every tool_use block
// of the turn and answer them all in ONE user message, is_error on a failure, capped at
// MAX_ITERATIONS. The system prompt and the sorted strict tool list are the cache prefix;
// the volatile <live> block is the first text block of each player turn.
//
// Two kinds of turn. A CHAT turn (the player typed, or a wake_me they asked for) runs on the
// thread: its messages accumulate, roll at THREAD_ROLL_TOKENS, and are the player's
// conversation. A DIRECTOR turn (a director tick, a script's or an arc's wake) is DETACHED
// (roadmap C1, 2026-10-20): ONE user message [<live>, <director_note>, tick text] on a local
// messages array that is dropped when the turn ends, so every director request is the cache
// prefix plus a few thousand tokens, flat, however long the show runs (before: the director
// rode the chat thread, 25k -> 150k over an evening and the 1M window in ~13 h). Its rows still
// land on the shared thread.rows for the tab; its only memory across ticks is the note it
// rewrites with the director_note tool, kept per save in plum_note (kind 'director').
//
// Fewer calls per turn (roadmap C2, 2026-10-20): the <live> block carries the household Sims
// (plumLiveSims.ts), so a turn need not open with look_at_lot; every push, click and whisper
// that took points the camera at its actor (followActor, the mod's camera_focus, result
// ignored) so the show is on screen while chained beats fire with no model turn; and an
// iteration whose tool calls are ALL fire-and-forget (FIRE_AND_FORGET_TOOLS) beside a text
// block ENDS the turn: a detached turn drops the results (the journal says what happened), a
// chat turn carries them at the head of its next user message, where the API wants them.
//
// Destructive tools, defence in depth: the prompt (ask, then confirmed_by_player), every call
// a visible row, the plumAllowWrites switch, and the ask-answer-act rule here: a destructive
// call is forwarded only when the player's latest line arrived after a reply of Plum's.
import { randomUUID } from 'crypto';
import log from 'electron-log';
import Anthropic from '@anthropic-ai/sdk';
import { ApiContext } from './ApiContext';
import { sendModNotification, getModClockState } from '../websocketServer';
import { ModWebsocketMessageType } from '../models/ModWebsocketMessage';
import { PlumModMessage, PlumModToolResult } from '../models/ModLogWebsocketMessage';
import { AnthropicPlumClient, describeModelError, PlumEffort, PlumModelClient } from './plum/PlumModelClient';
import { describe as describeTrigger, PlumWakeService, WakeDeps } from './plum/PlumWake';
import { PlumWhisperService } from './plum/PlumWhisper';
import { PLUM_SYSTEM_PROMPT, directorNoteBlock, liveBlock } from './plum/plumPrompt';
import { describeLiveSims } from './plum/plumLiveSims';
import { costOf, formatDollars } from './plum/plumPricing';
import { buildAppTools, resolveSimId } from './plum/PlumAppTools';
import { PlumNote, PlumRepository, PlumStoredRow } from '../db/PlumRepository';
import type { PlumBrainSlot } from '../tiers/types';
import {
  AppTool,
  CatalogueEntry,
  catalogueFingerprint,
  mergeCatalogue,
  ModToolDef,
  readSummary,
  toApiTools,
  trimDetail,
} from './plum/PlumTools';

export const MAX_ITERATIONS = 12;
export const DEFAULT_TOOL_TIMEOUT_MS = 20000;
export const MAX_TOKENS = 4096;
// Tools whose result tells the model nothing it needs this turn: an iteration made only of
// these (with words beside them) ends the turn instead of buying a model call to say "done"
// (2026-10-17: 24 wake_me-only, 11 remember-only, 7 set_trigger-only, 5 camera_focus-only
// iterations in a day, each followed by one more call)
export const FIRE_AND_FORGET_TOOLS: ReadonlySet<string> = new Set([
  'wake_me',
  'set_trigger',
  'remember',
  'director_note',
  'camera_focus',
  'notify',
]);
// The implicit camera focus after a push, click or whisper: fire and forget, short leash
export const CAMERA_FOCUS_TIMEOUT_MS = 5000;

// whisper: Plum's line to a Sim (name = the Sim); reply: the Sim's answer (name, ok, summary
// = agreed | declined | why the click did not take). PlumWhisper.ts adds both.
export type PlumRowKind = 'player' | 'plum' | 'tool' | 'director' | 'error' | 'whisper' | 'reply';

export type PlumRow = {
  row_id: string;
  kind: PlumRowKind;
  text: string;
  ts: string;
  name?: string;
  summary?: string;
  detail?: string;
  ok?: boolean;
  done?: boolean;
};

export type PlumStatusState = 'idle' | 'thinking' | 'tool';

// How one turn runs. The director (autonomy tier, DirectorService) drives DETACHED turns:
// its text is not a player row, its replies are director rows, it may push at most one
// beat, and it never touches the chat thread's messages (see the header).
export type PlumTurnOptions = {
  effort?: PlumEffort;
  director?: boolean;
  maxPushes?: number;
  // A wake-up trigger fired (PlumWake): nobody typed, so no player row and the
  // ask-answer-act clock does not move
  wake?: boolean;
  // The wake belongs to a script or an arc (a trigger with `then` or `script`, set with the
  // director off): it is a director turn too (the director's model, detached). A wake_me the
  // player asked for in chat stays a chat turn.
  script?: boolean;
};

// The kind a `[Plum] turn` log line names (scripts/plum-cost.py groups by it)
export type PlumTurnKind = 'chat' | 'director' | 'wake';

// How a turn ended, for the caller that needs to know (DirectorService backs off an API 400)
export type PlumTurnResult = {
  error?: { status?: number; message: string };
};

// What running one tool came to: `summary` is the row's text (label included), `content`
// what the model is told, `result` the tool's own answer on success
export type PlumToolOutcome = {
  ok: boolean;
  summary: string;
  content: string;
  result?: unknown;
  error?: string;
};

type PendingCall = {
  resolve(result: PlumModToolResult): void;
  timer: NodeJS.Timeout;
};

type Thread = {
  id: string;
  fingerprint: string;
  messages: Anthropic.Beta.Messages.BetaMessageParam[];
  rows: PlumRow[];
  // The ask-answer-act clock: when Plum last finished a reply, and when the player last spoke
  lastReplyAt?: number;
  lastPlayerLineAt?: number;
  // What the first user message of this thread carries from before it: Plum's notes and the
  // tail of the previous conversation, rendered as text (never replayed MessageParams: an
  // edited history invalidates preserved thinking, and a truncated transcript is an edit)
  seed?: string;
  // The whole context of the last request (input + cache read + cache write), for the roll
  contextTokens?: number;
  // Results of the fire-and-forget tools that ended the last chat turn, owed to the API at
  // the head of the next user message (a tool_use without its tool_result is a 400)
  pendingResults?: Anthropic.Beta.Messages.BetaToolResultBlockParam[];
};

export const HISTORY_ROWS = 30;
// A chat thread past this many tokens of context rolls to a fresh one (summary note + seed).
// A chat roll saves cents a turn and costs Plum the exact things the player said, so chat
// keeps 60k (Scott 2026-10-18). A director turn never rolls: it is detached and has no
// thread to roll (the 30k director threshold of 2026-10-18 went with roadmap C1).
export const THREAD_ROLL_TOKENS = 60_000;
// The director's own note between ticks: kept in plum_note under this kind, one row per save
export const DIRECTOR_NOTE_KIND = 'director';
// The tab's "$x.xx this hour" while directing sums the calls of this sliding window
const COST_WINDOW_MS = 3_600_000;
export const SEED_ROWS = 20;
export const SEED_NOTES = 40;
export const SUMMARY_MIN_ROWS = 4;

export type PlumServiceOptions = {
  // Tests hand in a scripted client; production builds one per turn from the current key
  clientFactory?: (apiKey: string) => PlumModelClient;
  appTools?: AppTool[];
  wakeDeps?: WakeDeps;
  now?: () => number;
};

export class PlumService {
  private readonly ctx: ApiContext;

  private readonly clientFactory: (apiKey: string) => PlumModelClient;

  private readonly appTools: AppTool[];

  private readonly repository: PlumRepository | undefined;

  private readonly now: () => number;

  // Plum's own wake-up triggers (the wake_me tool)
  readonly wake: PlumWakeService;

  // Plum whispering to a Sim as the voice in their head (the whisper tool, script beats)
  readonly whisper: PlumWhisperService;

  private modTools: ModToolDef[] = [];

  private modTier = 'unknown';

  private modEnabled = true;

  private catalogue: CatalogueEntry[] = [];

  private thread: Thread;

  private readonly pendingCalls = new Map<string, PendingCall>();

  private turnRunning = false;

  private readonly queuedLines: { text: string; options: PlumTurnOptions }[] = [];

  // push_action calls so far in the running turn (the director's one-beat rule)
  private turnPushes = 0;

  // Every model call's price, for "$x.xx this hour" (pruned to the window on read)
  private usageLog: { at: number; cost: number }[] = [];

  // The director's memory between detached turns (the director_note tool), per save
  private directorNote: string | undefined;

  constructor(ctx: ApiContext, options: PlumServiceOptions = {}) {
    this.ctx = ctx;
    this.clientFactory = options.clientFactory ?? ((apiKey) => new AnthropicPlumClient(apiKey));
    this.appTools =
      options.appTools ??
      buildAppTools(
        ctx,
        () => this.wake,
        () => this.whisper,
        () => this,
      );
    // A stub context in a test may have no repository; Plum then remembers nothing
    this.repository = 'plumRepository' in ctx ? ctx.plumRepository : undefined;
    this.now = options.now ?? (() => Date.now());
    this.catalogue = mergeCatalogue([], this.offeredAppTools());
    this.thread = this.newThread();
    this.wake = new PlumWakeService(ctx, this, { now: this.now, ...options.wakeDeps });
    this.wake.attach();
    this.whisper = new PlumWhisperService(ctx, this, { now: this.now });
  }

  // The app tools this build offers: a tool gated on a tier slot (onlyWith) is left out when
  // the context has none. The slots are filled after this service is built, so the catalogue
  // is rebuilt when the mod connects (onCatalogue), which is before any turn runs.
  private offeredAppTools(): AppTool[] {
    return this.appTools.filter((tool) => !tool.onlyWith || Boolean(this.ctx.ext[tool.onlyWith]));
  }

  // --- what the mod sends ---------------------------------------------------------------

  onModMessage(message: PlumModMessage) {
    switch (message.kind) {
      case 'catalogue':
        this.onCatalogue(message.tools ?? [], message.tier ?? 'unknown', message.enabled !== false);
        return;
      case 'say':
        this.onSay(typeof message.text === 'string' ? message.text : '');
        return;
      case 'tool_result':
        this.onToolResult(message);
        return;
      case 'control':
        this.onControl(message.action, message.brief);
        return;
      case 'interaction_ended':
        this.wake.onInteractionEnded(message);
        return;
      default:
        log.warn(`[Plum] unknown mod message kind ${String((message as { kind?: unknown }).kind)}`);
    }
  }

  onModDisconnected() {
    for (const [requestId, pending] of this.pendingCalls) {
      clearTimeout(pending.timer);
      pending.resolve({ kind: 'tool_result', request_id: requestId, ok: false, error: 'the game disconnected' });
    }
    this.pendingCalls.clear();
  }

  private onCatalogue(tools: ModToolDef[], tier: string, enabled: boolean) {
    this.modTools = tools;
    this.modTier = tier;
    this.modEnabled = enabled;
    this.catalogue = mergeCatalogue(this.modTools, this.offeredAppTools());
    const fingerprint = catalogueFingerprint(this.catalogue);
    if (fingerprint !== this.thread.fingerprint) {
      // Swapping tools under a transcript breaks the cache and confuses the model; a thread
      // that has not sent a turn yet (fresh, or restored from the save before the mod
      // connected) is simply re-stamped and keeps its rows and seed
      if (this.thread.messages.length === 0) {
        this.thread.fingerprint = fingerprint;
      } else {
        log.info('[Plum] the tool catalogue changed; starting a new conversation');
        this.thread = this.newThread();
      }
    }
    log.info(`[Plum] catalogue from a ${tier} mod: ${this.catalogue.length} tools, mod enabled=${enabled}`);
    this.ctx.ext.plumBrain?.onCatalogueChanged?.();
    this.emitStatus('idle');
  }

  private onSay(text: string) {
    const line = text.trim();
    if (!line) {
      return;
    }
    if (this.turnRunning) {
      this.queuedLines.push({ text: line, options: {} });
      return;
    }
    void this.runTurn(line);
  }

  private onToolResult(message: PlumModToolResult) {
    const pending = message.request_id ? this.pendingCalls.get(message.request_id) : undefined;
    if (!pending) {
      log.warn(`[Plum] tool_result for an unknown request ${message.request_id}`);
      return;
    }
    clearTimeout(pending.timer);
    this.pendingCalls.delete(message.request_id);
    pending.resolve(message);
  }

  private onControl(action: string, brief?: string) {
    switch (action) {
      case 'open':
        this.emitHistory();
        this.emitStatus(this.turnRunning ? 'thinking' : 'idle');
        return;
      case 'new_thread':
        void this.startNewThread();
        return;
      case 'start_director':
      case 'stop_director': {
        const director = this.ctx.ext.director;
        if (!director) {
          this.emitError('Director mode is not part of this build of the companion app.');
          return;
        }
        if (action === 'start_director') {
          director.start(brief);
        } else {
          director.stop();
        }
        this.emitStatus('idle');
        return;
      }
      default:
        log.warn(`[Plum] unknown control ${action}`);
    }
  }

  // --- the turn -------------------------------------------------------------------------

  get isRunning(): boolean {
    return this.turnRunning;
  }

  get threadId(): string {
    return this.thread.id;
  }

  get rows(): readonly PlumRow[] {
    return this.thread.rows;
  }

  get messages(): readonly Anthropic.Beta.Messages.BetaMessageParam[] {
    return this.thread.messages;
  }

  // Which turns are the director's: a director tick and a script's or an arc's wake. They run
  // on the director's model, DETACHED from the chat thread (one local user message, nothing
  // kept), and never roll it. Everything else is chat. The one rule for all three.
  private isDirectorTurn(options: PlumTurnOptions): boolean {
    return Boolean(options.director || options.script);
  }

  // The text blocks every turn opens with: the <live> block, then for a detached turn the
  // director's note (its only memory), for a chat turn on a fresh thread the seed
  private turnPrefix(detached: boolean): Anthropic.Beta.Messages.BetaTextBlockParam[] {
    const blocks: Anthropic.Beta.Messages.BetaTextBlockParam[] = [
      { type: 'text', text: this.liveContextBlock({ detached }) },
    ];
    if (detached) {
      if (this.directorNote) {
        blocks.push({ type: 'text', text: directorNoteBlock(this.directorNote) });
      }
    } else if (this.thread.messages.length === 0 && this.thread.seed) {
      blocks.push({ type: 'text', text: this.thread.seed });
    }
    return blocks;
  }

  // --- the director's note (director_note tool) ------------------------------------------

  get directorNoteText(): string | undefined {
    return this.directorNote;
  }

  // Rewritten at the end of every director turn by the model; an empty note clears it. Kept
  // per save so an app restart hands the show back to the next tick.
  setDirectorNote(note: string) {
    const text = note.trim();
    this.directorNote = text || undefined;
    if (!this.repository?.isLoaded()) {
      return;
    }
    try {
      this.repository.replaceNote(DIRECTOR_NOTE_KIND, text, [], this.gameDay());
    } catch (error) {
      log.warn('[Plum] could not store the director note', error);
    }
  }

  private modelFor(options: PlumTurnOptions): string {
    return this.isDirectorTurn(options) ? this.ctx.settings.plumDirectorModel : this.ctx.settings.plumModel;
  }

  private static kindOf(options: PlumTurnOptions): PlumTurnKind {
    if (options.director) {
      return 'director';
    }
    return options.wake ? 'wake' : 'chat';
  }

  async runTurn(text: string, options: PlumTurnOptions = {}): Promise<PlumTurnResult> {
    if (this.turnRunning) {
      this.queuedLines.push({ text, options });
      return {};
    }
    this.turnRunning = true;
    this.turnPushes = 0;
    try {
      const result = await this.runTurnInner(text, options);
      // An external brain keeps its own context (Claude Code compacts); nothing to roll here
      if (!this.externalBrain()) {
        await this.rollIfLong(options);
      }
      return result;
    } finally {
      this.turnRunning = false;
      this.emitStatus('idle');
      const next = this.queuedLines.shift();
      if (next) {
        void this.runTurn(next.text, next.options);
      }
    }
  }

  private async runTurnInner(text: string, options: PlumTurnOptions): Promise<PlumTurnResult> {
    const settings = this.ctx.settings;
    if (!settings.plumEnabled) {
      this.emitError("Plum is turned off in the companion app's Settings.");
      return {};
    }
    if (!this.modEnabled) {
      this.emitError('Plum is turned off in the Sentient Sims mod settings.');
      return {};
    }
    const brain = this.externalBrain();
    if (brain) {
      return this.runExternalTurn(brain, text, options);
    }
    const apiKey = settings.plumApiKey;
    if (!apiKey) {
      this.emitError("Plum needs an Anthropic API key: add one under Plum in the companion app's Settings.");
      return {};
    }
    const client = this.clientFactory(apiKey);
    const model = this.modelFor(options);
    const kind = PlumService.kindOf(options);
    const detached = this.isDirectorTurn(options);
    if (!options.director && !options.wake) {
      // Kept for the history replay only: the tab already echoed the line when it was typed
      this.addRow({ kind: 'player', text });
      this.thread.lastPlayerLineAt = this.now();
    }
    // The tool results the last chat turn ended on come first, then <live> and the text
    const carried = detached ? undefined : this.thread.pendingResults;
    this.thread.pendingResults = undefined;
    const content: Anthropic.Beta.Messages.BetaContentBlockParam[] = [...(carried ?? []), ...this.turnPrefix(detached)];
    content.push({ type: 'text', text });
    // A detached turn's messages live and die with the turn; a chat turn's are the thread's.
    // Where this turn starts in them: a refusal rolls back to here, or the flagged text would
    // ride every later request and the classifier would refuse them all (2026-10-17: one
    // declined line left Plum mute until "New conversation").
    const messages: Anthropic.Beta.Messages.BetaMessageParam[] = detached ? [] : this.thread.messages;
    const turnStart = messages.length;
    messages.push({ role: 'user', content });
    const tools = toApiTools(this.catalogue);
    const system: Anthropic.Beta.Messages.BetaTextBlockParam[] = [
      { type: 'text', text: PLUM_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ];

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
      this.emitStatus('thinking');
      let response: Anthropic.Beta.Messages.BetaMessage;
      try {
        response = await client.create({
          model,
          system,
          tools,
          messages,
          maxTokens: MAX_TOKENS,
          effort: options.effort ?? 'medium',
        });
      } catch (error) {
        log.error('[Plum] model call failed', error);
        const message = describeModelError(error);
        this.emitError(message);
        const status = (error as { status?: unknown }).status;
        return { error: { ...(typeof status === 'number' ? { status } : {}), message } };
      }
      const usage = response.usage;
      const contextTokens =
        usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
      if (!detached) {
        // The chat thread's size, for its roll; a detached turn's context is its own
        this.thread.contextTokens = contextTokens;
      }
      this.recordUsage(model, usage);
      // The meter (scripts/plum-cost.py) reads these
      log.info(
        `[Plum] turn ${iteration + 1}: stop=${response.stop_reason} in=${usage.input_tokens} ` +
          `cache_read=${usage.cache_read_input_tokens ?? 0} cache_write=${usage.cache_creation_input_tokens ?? 0} ` +
          `out=${usage.output_tokens} ctx=${contextTokens} kind=${kind} model=${model} detached=${detached}`,
      );

      if (response.stop_reason === 'refusal') {
        const details = response.stop_details;
        log.warn(`[Plum] refusal details: ${JSON.stringify(details ?? null)}`);
        messages.length = turnStart;
        // The rolled-back message carried the results owed from the last turn: owe them again
        if (carried) {
          this.thread.pendingResults = carried;
        }
        const category = details?.category ? ` [${details.category}]` : '';
        const why = details?.explanation ? ` ${details.explanation}` : '';
        this.emitError(
          `Plum declined that one (Anthropic's safety classifier stopped the reply${category}).${why} ` +
            'That line was dropped from the conversation; the next one starts clean.',
        );
        return {};
      }
      if (response.stop_reason === 'max_tokens') {
        // Never run tools on an input that may be cut off
        this.emitError('Plum ran out of room mid-reply; try asking in smaller steps.');
        return {};
      }

      // Stored verbatim: an edited history invalidates preserved thinking
      messages.push({ role: 'assistant', content: response.content });

      for (const block of response.content) {
        if (block.type === 'text' && block.text.trim()) {
          const row = this.addRow({ kind: options.director ? 'director' : 'plum', text: block.text.trim() });
          this.emit({ kind: options.director ? 'director' : 'assistant', thread_id: this.thread.id, row });
        }
      }

      const toolUses = response.content.filter(
        (block): block is Anthropic.Beta.Messages.BetaToolUseBlock => block.type === 'tool_use',
      );
      if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
        this.thread.lastReplyAt = this.now();
        return {};
      }

      this.emitStatus('tool');
      // Every tool_use of one assistant turn is answered in ONE user message, in order
      const results: Anthropic.Beta.Messages.BetaToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        results.push(await this.runToolUse(toolUse, options));
      }
      // Fire and forget: nothing in these results changes what Plum would say, and it already
      // said it. The turn ends here; a chat thread still owes the API the results.
      const spoke = response.content.some((block) => block.type === 'text' && block.text.trim());
      if (spoke && toolUses.every((toolUse) => FIRE_AND_FORGET_TOOLS.has(toolUse.name))) {
        if (!detached) {
          this.thread.pendingResults = results;
        }
        log.info(`[Plum] turn ended on fire-and-forget tools (${toolUses.map((toolUse) => toolUse.name).join(', ')})`);
        this.thread.lastReplyAt = this.now();
        return {};
      }
      messages.push({ role: 'user', content: results });
    }
    this.emitError(`Plum stopped after ${MAX_ITERATIONS} tool calls in one turn; ask again to continue.`);
    this.thread.lastReplyAt = this.now();
    return {};
  }

  // --- an external brain (dev tier: a local Claude Code session) ---------------------------

  // The brain that thinks instead of the API loop, when the setting asks for one this build has
  private externalBrain(): PlumBrainSlot | undefined {
    return this.ctx.settings.plumBrain === 'claude-code' ? this.ctx.ext.plumBrain : undefined;
  }

  // Why a turn cannot run now on the external brain (session down, plan limit), or undefined.
  // The director and the wakes hold on it instead of filling the tab with errors.
  brainUnavailable(): string | undefined {
    return this.externalBrain()?.unavailable();
  }

  // One turn on the external brain. The brain sees the same <live> block, seed and text the
  // API loop would send; its tool calls run through runTool (rows, write and destructive
  // guards, the director's push cap) and its replies become rows through say.
  private async runExternalTurn(brain: PlumBrainSlot, text: string, options: PlumTurnOptions): Promise<PlumTurnResult> {
    const reason = brain.unavailable();
    if (reason) {
      // Before liveContextBlock: building it drains the trigger journal, which would be lost
      this.emitError(reason);
      return { error: { status: 503, message: reason } };
    }
    const kind = PlumService.kindOf(options);
    const detached = this.isDirectorTurn(options);
    // The seed is the conversation BEFORE this turn (the turn's own text rides after it)
    const priorRows = this.thread.rows.slice(-SEED_ROWS);
    if (!options.director && !options.wake) {
      // Kept for the history replay only: the tab already echoed the line when it was typed
      this.addRow({ kind: 'player', text });
      this.thread.lastPlayerLineAt = this.now();
    }
    // The same opening blocks the API loop sends: <live>, then the director's note on a
    // detached turn (the brain keeps its own context, so nothing is dropped on its side; the
    // note is still what the API path would see, and the brain's seed is a chat matter)
    const live = this.turnPrefix(detached)
      .map((block) => block.text)
      .join('\n\n');
    const startedAt = this.now();
    let tools = 0;
    this.emitStatus('thinking');
    const result = await brain.runTurn({
      id: randomUUID().slice(0, 8),
      kind,
      detached,
      live,
      seed: () => {
        let notes: PlumNote[] = [];
        if (this.repository?.isLoaded()) {
          try {
            notes = this.repository.notes(SEED_NOTES);
          } catch (error) {
            log.warn('[Plum] could not read the notes', error);
          }
        }
        return this.renderSeed(notes, priorRows);
      },
      text,
      runTool: async (name, args) => {
        tools += 1;
        this.emitStatus('tool');
        const outcome = await this.runTool(name, args, { maxPushes: options.maxPushes });
        this.emitStatus('thinking');
        return outcome;
      },
      say: (said) => {
        const line = said.trim();
        if (!line) {
          return;
        }
        const row = this.addRow({ kind: options.director ? 'director' : 'plum', text: line });
        this.emit({ kind: options.director ? 'director' : 'assistant', thread_id: this.thread.id, row });
      },
    });
    this.thread.lastReplyAt = this.now();
    if (result.error) {
      this.emitError(result.error.message);
    }
    log.info(
      `[Plum] external turn kind=${kind} detached=${detached} tools=${tools} ms=${this.now() - startedAt}` +
        (result.error ? ` error=${result.error.status ?? ''} ${result.error.message}` : ''),
    );
    return result;
  }

  // The tool list the external brain offers its model (the same entries the API loop sends)
  externalCatalogue(): readonly CatalogueEntry[] {
    return this.catalogue;
  }

  // A tool the external brain's model called outside any turn (typed in its own terminal):
  // never a destructive tool, and never a push while the director owns the beats
  async looseTool(name: string, args: Record<string, unknown>): Promise<PlumToolOutcome> {
    const entry = this.catalogue.find((candidate) => candidate.definition.name === name);
    const refuse = (message: string): PlumToolOutcome => {
      log.warn(`[Plum] loose ${name}: ${message}`);
      return { ok: false, summary: message, error: message, content: message };
    };
    if (entry?.definition.risk === 'destructive') {
      return refuse(`${name} refused: a destructive tool runs only inside a turn the player started`);
    }
    if (PlumService.isPushTool(name) && this.ctx.ext.director?.status().active) {
      return refuse(`${name} refused: the director is running the beats`);
    }
    return this.runTool(name, args, { label: 'terminal' });
  }

  // plan_arc pushes beat 1 itself (through runScheduledTool, which has no cap), so it is the
  // turn's push too; a whisper and a script's first beat move a Sim the same way
  private static isPushTool(name: string): boolean {
    return name === 'push_action' || name === 'plan_arc' || name === 'whisper' || name === 'plan_script';
  }

  // --- the meter ---------------------------------------------------------------------------

  private recordUsage(model: string, usage: Anthropic.Beta.Messages.BetaUsage) {
    const at = this.now();
    this.usageLog.push({ at, cost: costOf(model, usage) });
    const cutoff = at - COST_WINDOW_MS;
    this.usageLog = this.usageLog.filter((entry) => entry.at > cutoff);
  }

  // Dollars spent on model calls in the last hour (every kind of turn, summary calls included)
  costThisHour(): number {
    const cutoff = this.now() - COST_WINDOW_MS;
    return this.usageLog.filter((entry) => entry.at > cutoff).reduce((sum, entry) => sum + entry.cost, 0);
  }

  // The model asked for a tool: run it and build the tool_result block the loop answers with
  private async runToolUse(
    toolUse: Anthropic.Beta.Messages.BetaToolUseBlock,
    options: PlumTurnOptions = {},
  ): Promise<Anthropic.Beta.Messages.BetaToolResultBlockParam> {
    const args = (toolUse.input ?? {}) as Record<string, unknown>;
    const outcome = await this.runTool(toolUse.name, args, { maxPushes: options.maxPushes });
    return {
      type: 'tool_result' as const,
      tool_use_id: toolUse.id,
      content: outcome.content,
      ...(outcome.ok ? {} : { is_error: true as const }),
    };
  }

  // A trigger fired and acts on Plum's behalf (PlumWake): the same runner, the row labelled
  // with the trigger, no per-turn push cap, and never a destructive tool, whatever the
  // trigger stored (defence in depth: set_trigger only ever stores push_action)
  async runScheduledTool(name: string, args: Record<string, unknown>, label: string): Promise<PlumToolOutcome> {
    const entry = this.catalogue.find((candidate) => candidate.definition.name === name);
    if (entry?.definition.risk === 'destructive') {
      const message = `${name} refused: a trigger may not run a destructive tool`;
      log.warn(`[Plum] ${label}: ${message}`);
      return { ok: false, summary: message, error: message, content: message };
    }
    return this.runTool(name, args, { label });
  }

  // One tool, from the model loop or a trigger: the visible row (started / finished events,
  // persisted), the write and destructive guards, the director's push cap, app-vs-mod
  // dispatch, and the dispatcher registration after a push
  private async runTool(
    name: string,
    args: Record<string, unknown>,
    options: { maxPushes?: number; label?: string } = {},
  ): Promise<PlumToolOutcome> {
    const entry = this.catalogue.find((candidate) => candidate.definition.name === name);
    const prefix = options.label ? `${options.label}: ` : '';
    const row = this.addRow({
      kind: 'tool',
      text: '',
      name,
      summary: prefix + (entry && entry.definition.risk === 'read' ? readSummary(name, args) : name),
      done: false,
    });
    this.emit({ kind: 'tool_call_started', thread_id: this.thread.id, row });

    const finish = (ok: boolean, summary: string, detail: unknown, content: string, result?: unknown) => {
      row.done = true;
      row.ok = ok;
      row.summary = prefix + summary;
      row.detail = trimDetail(detail);
      this.persistRowUpdate(row);
      this.emit({
        kind: 'tool_call_finished',
        thread_id: this.thread.id,
        row_id: row.row_id,
        ok,
        summary: row.summary,
        detail: row.detail,
      });
      return {
        ok,
        summary: row.summary,
        content,
        ...(ok ? { result } : { error: content }),
      };
    };

    if (!entry) {
      return finish(false, `${name} is not a tool`, null, `unknown tool ${name}`);
    }
    const { risk } = entry.definition;
    if (risk !== 'read' && !this.ctx.settings.plumAllowWrites) {
      const message = `${name} refused: "Plum may change things" is off in the companion app's Settings.`;
      return finish(false, message, null, message);
    }
    if (risk === 'destructive' && !this.destructiveAllowed()) {
      const message =
        `${name} refused by the app: a destructive tool runs only after you have asked the ` +
        'player and they have answered yes in their own message. Ask first.';
      return finish(false, `${name} held: ask the player first`, null, message);
    }
    if (risk === 'destructive') {
      // The call counts as the act: the next one needs a fresh yes
      this.thread.lastReplyAt = this.now();
    }
    const isPush = PlumService.isPushTool(name);
    if (isPush && options.maxPushes !== undefined && this.turnPushes >= options.maxPushes) {
      const message = 'one beat per tick: this push waits for the next tick (verify the last one first)';
      return finish(false, `${name} held: one beat per tick`, null, message);
    }

    let outcome: PlumModToolResult;
    if (entry.app) {
      try {
        const result = await entry.app.run(args);
        outcome = { kind: 'tool_result', request_id: '', ok: true, result };
      } catch (error) {
        outcome = {
          kind: 'tool_result',
          request_id: '',
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    } else {
      outcome = await this.callMod(name, args, entry.definition.timeout_ms || DEFAULT_TOOL_TIMEOUT_MS);
    }

    if (!outcome.ok) {
      const error = outcome.error ?? 'unknown error';
      return finish(false, `${name} failed: ${error}`, { error }, error);
    }
    const result = outcome.result ?? {};
    // The mod watches the interaction a push or click created for its exact end: a
    // `doing` trigger on it waits for that, not for the state report's guess
    const interactionId = (result as { interaction_id?: unknown }).interaction_id;
    const actorSpec = typeof args.sim === 'string' ? args.sim : '';
    const actorId = actorSpec ? resolveSimId(this.ctx, actorSpec) : undefined;
    if (typeof interactionId === 'string' && actorId) {
      const interactionName = (result as { interaction?: unknown }).interaction;
      this.wake.noteWatched(actorId, interactionId, typeof interactionName === 'string' ? interactionName : '');
    }
    if (isPush && options.maxPushes !== undefined) {
      this.turnPushes += 1;
    }
    if ((name === 'push_action' || name === 'click_pie_menu') && actorId) {
      this.followActor(actorId);
    }
    if (name === 'push_action') {
      // The autonomy tier grades the push's outcome like one of cognition's
      const requestId = (result as { request_id?: unknown }).request_id;
      if (typeof requestId === 'string') {
        this.ctx.ext.plumPush?.(requestId, {
          sim_id: typeof args.sim === 'string' ? args.sim : '',
          action: typeof args.action === 'string' ? args.action : '',
          target: typeof args.target === 'string' ? args.target : undefined,
        });
      }
    }
    const changed =
      typeof (result as { changed?: unknown }).changed === 'string'
        ? (result as { changed: string }).changed
        : undefined;
    // A read tool that still reports a `changed` line (wake_me) shows it like a write
    const summary = changed ?? (risk === 'read' ? readSummary(name, args) : `ran ${name}`);
    return finish(true, summary, result, JSON.stringify(result), result);
  }

  // The camera goes to the Sim a push, click or whisper just moved (Scott, 2026-10-17: "I would
  // love to really see the action"; chained beats fire with no Plum turn, so no tool call of
  // Plum's would move it). Through the mod's camera_focus tool, no row, result ignored; off
  // with plumCameraFollows, and never when writes are off or the mod has no such tool.
  followActor(simId: string) {
    if (!this.ctx.settings.plumCameraFollows || !this.ctx.settings.plumAllowWrites) {
      return;
    }
    if (!this.modTools.some((tool) => tool.name === 'camera_focus')) {
      return;
    }
    void this.callMod('camera_focus', { sim: simId }, CAMERA_FOCUS_TIMEOUT_MS).then((outcome) => {
      if (!outcome.ok) {
        log.info(`[Plum] camera did not follow sim ${simId}: ${outcome.error ?? 'unknown error'}`);
      }
      return outcome;
    });
  }

  // Ask, answer, act: the player's latest line must be newer than Plum's last finished reply
  private destructiveAllowed(): boolean {
    const { lastReplyAt, lastPlayerLineAt } = this.thread;
    return lastReplyAt !== undefined && lastPlayerLineAt !== undefined && lastPlayerLineAt > lastReplyAt;
  }

  callMod(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<PlumModToolResult> {
    const requestId = `plum-${randomUUID()}`;
    return new Promise<PlumModToolResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(requestId);
        resolve({
          kind: 'tool_result',
          request_id: requestId,
          ok: false,
          error: `the game did not answer ${name} within ${Math.round(timeoutMs / 1000)} s (loading screen, or the mod is busy)`,
        });
      }, timeoutMs);
      this.pendingCalls.set(requestId, { resolve, timer });
      sendModNotification({
        type: ModWebsocketMessageType.PLUM_TOOL_CALL,
        request_id: requestId,
        name,
        args,
        timeout_ms: timeoutMs,
      });
    });
  }

  // --- context ---------------------------------------------------------------------------

  // `detached`: the block opens a director turn, which carries the director's note as its own
  // block; a chat turn while the director is running gets the note inside <live> instead, so
  // the two Plums agree about the show
  liveContextBlock({ detached = false }: { detached?: boolean } = {}): string {
    const report = this.ctx.simStateCache.getReport();
    const lot = report?.lot;
    const clock = lot?.clock;
    let clockText: string | undefined;
    if (clock && typeof clock.hour === 'number') {
      const minute = String(clock.minute ?? 0).padStart(2, '0');
      const day = typeof clock.absolute_day === 'number' ? ` day ${clock.absolute_day}` : '';
      clockText = `${clock.hour}:${minute}${day}`;
    }
    const modClock = getModClockState();
    // The armed triggers and what triggers did since the last turn: how Plum learns what
    // its past self's triggers did, as text in the user turn (never an edited assistant one)
    return liveBlock({
      clock: clockText,
      paused: modClock ? modClock.paused : clock?.paused,
      lot: lot?.lot_name,
      venue: lot?.venue,
      funds: lot?.funds,
      // The cast: who is up, doing what, in what mood, with what wants (no look_at_lot needed)
      ...describeLiveSims(report),
      triggers: this.wake.list().map((trigger) => `${trigger.id} ${describeTrigger(trigger)}`),
      script: this.wake.describeScript(),
      journal: this.wake.takeJournal(),
      ...(!detached && this.directorNote && this.ctx.ext.director?.status().active
        ? { director: this.directorNote }
        : {}),
    });
  }

  // --- events to the tab -------------------------------------------------------------------

  private newThread(seed?: string): Thread {
    return {
      id: `thread-${randomUUID()}`,
      fingerprint: catalogueFingerprint(this.catalogue),
      messages: [],
      rows: [],
      ...(seed ? { seed } : {}),
    };
  }

  private addRow(fields: Omit<PlumRow, 'row_id' | 'ts'>): PlumRow {
    const row: PlumRow = { row_id: `row-${randomUUID()}`, ts: this.timeLabel(), ...fields };
    this.thread.rows.push(row);
    this.persistRow(row);
    return row;
  }

  // A row another service adds to the conversation (a whisper and its reply): stored by
  // kind like every row and sent to the tab as an event of that kind
  addVisibleRow(fields: Omit<PlumRow, 'row_id' | 'ts'>): PlumRow {
    const row = this.addRow(fields);
    this.emit({ kind: row.kind, thread_id: this.thread.id, row });
    return row;
  }

  // --- memory across sessions (db/PlumRepository.ts) -----------------------------------------

  private gameDay(): number | undefined {
    return this.ctx.simStateCache.getReport()?.lot?.clock?.absolute_day;
  }

  private persistRow(row: PlumRow) {
    if (!this.repository?.isLoaded()) {
      return;
    }
    try {
      this.repository.appendMessage(this.thread.id, row.kind, row, this.gameDay());
    } catch (error) {
      log.warn('[Plum] could not store a row', error);
    }
  }

  // A tool row is stored when it starts; its finish is stored as an update row of its own so
  // the replay shows the outcome (the stored row ids differ from the live row_id on purpose)
  private persistRowUpdate(row: PlumRow) {
    if (!this.repository?.isLoaded()) {
      return;
    }
    try {
      this.repository.appendMessage(this.thread.id, 'tool_update', row, this.gameDay());
    } catch (error) {
      log.warn('[Plum] could not store a tool update', error);
    }
  }

  private storedRowsToRows(stored: PlumStoredRow[]): PlumRow[] {
    const rows: PlumRow[] = [];
    for (const entry of stored) {
      // Stored JSON: trust nothing about its shape
      const content = entry.content as Partial<PlumRow>;
      if (entry.role === 'tool_update') {
        const existing = rows.find((row) => row.row_id === content.row_id);
        if (existing) {
          Object.assign(existing, content);
        }
        continue;
      }
      if (content.row_id && content.kind) {
        rows.push({ ...content } as PlumRow);
      }
    }
    return rows;
  }

  // The save's database opened: pick the last conversation in it back up, as rows for the
  // tab and as the text seed of the next model turn
  onDatabaseLoaded() {
    if (!this.repository?.isLoaded()) {
      return;
    }
    try {
      const threadId = this.repository.lastThreadId();
      const stored = threadId ? this.repository.recentRows(threadId, HISTORY_ROWS) : [];
      const rows = this.storedRowsToRows(stored);
      const seed = this.renderSeed(this.repository.notes(SEED_NOTES), rows.slice(-SEED_ROWS));
      this.thread = this.newThread(seed);
      if (threadId && rows.length > 0) {
        // Same thread id: the rows stay one conversation in the store
        this.thread.id = threadId;
        this.thread.rows = rows;
      }
      // The director's note is the save's too: the next tick picks the show back up
      this.directorNote = this.repository.latestNote(DIRECTOR_NOTE_KIND)?.text || undefined;
      log.info(
        `[Plum] database loaded: ${rows.length} rows of the last conversation, seed ${seed.length} chars` +
          (this.directorNote ? `, director note ${this.directorNote.length} chars` : ''),
      );
    } catch (error) {
      log.warn('[Plum] could not read the last conversation', error);
      this.thread = this.newThread();
      this.directorNote = undefined;
    }
    this.ctx.ext.plumBrain?.onThreadReset?.();
    this.emitHistory();
    this.emitStatus(this.turnRunning ? 'thinking' : 'idle');
  }

  renderSeed(allNotes: PlumNote[], rows: readonly PlumRow[]): string {
    const lines: string[] = [];
    // The director's note is the detached turns' memory, not the chat's: a chat turn sees it
    // in <live> while the director runs, and never as a note of its own
    const notes = allNotes.filter((note) => note.kind !== DIRECTOR_NOTE_KIND);
    if (notes.length > 0) {
      lines.push('<plum_notes>', 'Notes you kept for yourself in earlier sessions of this save (newest last):');
      for (const note of notes) {
        const day = note.game_day === undefined ? '' : ` (day ${note.game_day})`;
        lines.push(`- [${note.kind}${day}] ${note.text}`);
      }
      lines.push('</plum_notes>');
    }
    if (rows.length > 0) {
      lines.push('<earlier_conversation>', 'The end of your previous conversation with the player, rendered as text:');
      rows.forEach((row, index) => {
        // A player line answered by an error row never got a reply, and when the error was a
        // classifier refusal the line re-triggers it from the seed (2026-10-17: "Hi" on a fresh
        // thread was refused because the seed carried the declined line); leave such lines out
        if (row.kind === 'player' && rows[index + 1]?.kind === 'error') {
          return;
        }
        if (row.kind === 'tool') {
          lines.push(
            `[tool] ${row.name ?? ''}: ${row.summary ?? ''}${row.done && row.ok === false ? ' (failed)' : ''}`,
          );
        } else if (row.kind === 'player' || row.kind === 'plum' || row.kind === 'director') {
          lines.push(`[${row.kind}] ${row.text}`);
        } else if (row.kind === 'whisper') {
          lines.push(`[you, to ${row.name ?? 'a Sim'}] ${row.text}`);
        } else if (row.kind === 'reply') {
          lines.push(`[${row.name ?? 'the Sim'}] ${row.text}${row.summary ? ` (${row.summary})` : ''}`);
        }
      });
      lines.push('</earlier_conversation>');
    }
    return lines.join('\n');
  }

  // A long chat thread rolls on its own, still inside the turn (turnRunning holds, new lines
  // queue). A director turn is detached and left nothing on the thread, so it never rolls it
  // (and never spends a summary call).
  private async rollIfLong(options: PlumTurnOptions): Promise<void> {
    if (this.isDirectorTurn(options) || (this.thread.contextTokens ?? 0) < THREAD_ROLL_TOKENS) {
      return;
    }
    log.info(`[Plum] the conversation passed ${THREAD_ROLL_TOKENS / 1000}k tokens; rolling to a fresh thread`);
    await this.startNewThread({ keepRows: true, model: this.modelFor(options) });
  }

  // New conversation: one cheap summary call writes a note for the future, then the next
  // thread starts seeded with the notes and the tail of this one. keepRows: the player did
  // not ask for a new conversation (the auto roll), so the tab keeps its rows. model: the
  // summary runs on the model of the turn that rolled (the director's for a director roll)
  async startNewThread({ keepRows = false, model }: { keepRows?: boolean; model?: string } = {}): Promise<void> {
    const ending = this.thread;
    const spoken = ending.rows.filter(
      (row) => row.kind === 'player' || row.kind === 'plum' || row.kind === 'director',
    ).length;
    // No summary call on an external brain: it would spend the API key the developer chose not to use
    const external = this.externalBrain();
    if (spoken >= SUMMARY_MIN_ROWS && !external) {
      await this.summarize(ending, model ?? this.ctx.settings.plumModel);
    }
    let notes: PlumNote[] = [];
    if (this.repository?.isLoaded()) {
      try {
        notes = this.repository.notes(SEED_NOTES);
      } catch (error) {
        log.warn('[Plum] could not read the notes', error);
      }
    }
    this.thread = this.newThread(this.renderSeed(notes, ending.rows.slice(-SEED_ROWS)));
    if (keepRows) {
      this.thread.rows = ending.rows;
    }
    this.emitHistory();
    if (external) {
      // The Claude Code session keeps its own context; only the player can clear it
      external.onThreadReset?.();
      this.emitStatus('idle', 'New conversation: run /clear in the Claude Code terminal too');
      return;
    }
    this.emitStatus('idle');
  }

  // The note the roll writes. With triggers armed or a director running, the note also has to
  // carry the arc: the <live> block will list the triggers for the next thread, but WHY each
  // was set is the one thing only this transcript knows.
  summaryPrompt(): string {
    const lines = [
      'The player is starting a new conversation. In at most four sentences, write a note to your ' +
        'future self about this one: what the player wanted, what you changed in the game, anything you ' +
        'promised or should follow up on, and anything about the household worth remembering.',
    ];
    const armed = this.wake.list();
    const directing = this.ctx.ext.director?.status().active === true;
    if (armed.length > 0 || directing) {
      lines.push(
        `You are ${directing ? 'directing' : 'running triggers'}: add up to four more sentences naming the arc ` +
          '(its name, premise and cast), which beats landed and how the Sims played them, and every wake-up ' +
          `trigger you have armed${armed.length > 0 ? ` (${armed.map((trigger) => trigger.id).join(', ')})` : ''} ` +
          'with WHY you set it. The next conversation sees the armed triggers in its <live> block but not your reasons.',
      );
    }
    lines.push('Plain text, no tools.');
    return lines.join(' ');
  }

  private async summarize(thread: Thread, model: string): Promise<void> {
    const apiKey = this.ctx.settings.plumApiKey;
    if (!apiKey || !this.ctx.settings.plumEnabled || thread.messages.length === 0) {
      return;
    }
    const client = this.clientFactory(apiKey);
    const system: Anthropic.Beta.Messages.BetaTextBlockParam[] = [
      { type: 'text', text: PLUM_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ];
    try {
      this.emitStatus('thinking', 'Plum is writing a note to its future self');
      const response = await client.create({
        model,
        system,
        tools: toApiTools(this.catalogue),
        // The results the thread still owes ride first, or the request is refused
        messages: [
          ...thread.messages,
          { role: 'user', content: [...(thread.pendingResults ?? []), { type: 'text', text: this.summaryPrompt() }] },
        ],
        maxTokens: 600,
        effort: 'low',
      });
      this.recordUsage(model, response.usage);
      const text = response.content
        .filter((block): block is Anthropic.Beta.Messages.BetaTextBlock => block.type === 'text')
        .map((block) => block.text.trim())
        .join(' ')
        .trim();
      if (text && this.repository?.isLoaded()) {
        this.repository.addNote('summary', text, [], this.gameDay());
      }
      log.info(`[Plum] summary note: ${text.slice(0, 120)}`);
    } catch (error) {
      log.warn('[Plum] the summary call failed; starting the new conversation without it', error);
    }
  }

  private timeLabel(): string {
    const date = new Date(this.now());
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  private emit(event: Record<string, unknown>) {
    sendModNotification({ type: ModWebsocketMessageType.PLUM_EVENT, ...event });
  }

  emitStatus(state: PlumStatusState, text?: string) {
    const directorActive = this.ctx.ext.director?.status().active ?? false;
    // While directing, the status line is the next armed trigger plus the hour's spend (the
    // tab already shows text; no DLL change)
    let line = text;
    const external = this.externalBrain();
    if (line === undefined && external) {
      // An external brain spends the developer's own plan, not the key: no meter
      const parts = [external.unavailable() ?? (directorActive ? this.wake.status() : undefined), 'via Claude Code'];
      line = parts.filter((part): part is string => Boolean(part)).join(' | ');
    } else if (line === undefined && directorActive) {
      const parts = [this.wake.status(), `${formatDollars(this.costThisHour())} this hour`].filter(
        (part): part is string => Boolean(part),
      );
      line = parts.join(' | ');
    }
    this.emit({
      kind: 'status',
      state,
      ...(line ? { text: line } : {}),
      director_available: Boolean(this.ctx.ext.director),
      director_active: directorActive,
      enabled: { mod: this.modEnabled, app: this.ctx.settings.plumEnabled },
    });
  }

  private emitHistory() {
    const director = this.ctx.ext.director?.status();
    this.emit({
      kind: 'history',
      thread_id: this.thread.id,
      rows: this.thread.rows.slice(-HISTORY_ROWS),
      director: director ? { active: director.active, arc: director.arc } : { active: false },
    });
  }

  private emitError(text: string) {
    log.warn(`[Plum] ${text}`);
    this.addRow({ kind: 'error', text });
    this.emit({ kind: 'error', thread_id: this.thread.id, text });
  }
}
