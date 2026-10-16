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
import { AnthropicPlumClient, describeModelError, PlumModelClient } from './plum/PlumModelClient';
import { PLUM_SYSTEM_PROMPT, liveBlock } from './plum/plumPrompt';
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

export type PlumRowKind = 'player' | 'plum' | 'tool' | 'director' | 'error';

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
};

export type PlumServiceOptions = {
  // Tests hand in a scripted client; production builds one per turn from the current key
  clientFactory?: (apiKey: string) => PlumModelClient;
  appTools?: AppTool[];
  now?: () => number;
};

export class PlumService {
  private readonly ctx: ApiContext;

  private readonly clientFactory: (apiKey: string) => PlumModelClient;

  private readonly appTools: AppTool[];

  private readonly now: () => number;

  private modTools: ModToolDef[] = [];

  private modTier = 'unknown';

  private modEnabled = true;

  private catalogue: CatalogueEntry[] = [];

  private thread: Thread;

  private readonly pendingCalls = new Map<string, PendingCall>();

  private turnRunning = false;

  private readonly queuedLines: string[] = [];

  constructor(ctx: ApiContext, options: PlumServiceOptions = {}) {
    this.ctx = ctx;
    this.clientFactory = options.clientFactory ?? ((apiKey) => new AnthropicPlumClient(apiKey));
    this.appTools = options.appTools ?? [];
    this.now = options.now ?? (() => Date.now());
    this.catalogue = mergeCatalogue([], this.appTools);
    this.thread = this.newThread();
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
    this.catalogue = mergeCatalogue(this.modTools, this.appTools);
    const fingerprint = catalogueFingerprint(this.catalogue);
    if (fingerprint !== this.thread.fingerprint) {
      // Swapping tools under a transcript breaks the cache and confuses the model; a thread
      // with no rows yet is simply re-stamped
      if (this.thread.rows.length === 0) {
        this.thread.fingerprint = fingerprint;
      } else {
        log.info('[Plum] the tool catalogue changed; starting a new conversation');
        this.thread = this.newThread();
      }
    }
    log.info(`[Plum] catalogue from a ${tier} mod: ${this.catalogue.length} tools, mod enabled=${enabled}`);
    this.emitStatus('idle');
  }

  private onSay(text: string) {
    const line = text.trim();
    if (!line) {
      return;
    }
    if (this.turnRunning) {
      this.queuedLines.push(line);
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
        this.thread = this.newThread();
        this.emitHistory();
        this.emitStatus('idle');
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

  async runTurn(text: string): Promise<void> {
    if (this.turnRunning) {
      this.queuedLines.push(text);
      return;
    }
    this.turnRunning = true;
    try {
      await this.runTurnInner(text);
    } finally {
      this.turnRunning = false;
      this.emitStatus('idle');
      const next = this.queuedLines.shift();
      if (next) {
        void this.runTurn(next);
      }
    }
  }

  private async runTurnInner(text: string): Promise<void> {
    const settings = this.ctx.settings;
    if (!settings.plumEnabled) {
      this.emitError("Plum is turned off in the companion app's Settings.");
      return;
    }
    if (!this.modEnabled) {
      this.emitError('Plum is turned off in the Sentient Sims mod settings.');
      return;
    }
    const apiKey = settings.plumApiKey;
    if (!apiKey) {
      this.emitError("Plum needs an Anthropic API key: add one under Plum in the companion app's Settings.");
      return;
    }
    const client = this.clientFactory(apiKey);
    // Kept for the history replay only: the tab already echoed the line when it was typed
    this.addRow({ kind: 'player', text });
    this.thread.lastPlayerLineAt = this.now();
    this.thread.messages.push({
      role: 'user',
      content: [
        { type: 'text', text: this.liveContextBlock() },
        { type: 'text', text },
      ],
    });
    const tools = toApiTools(this.catalogue);
    const system: Anthropic.Beta.Messages.BetaTextBlockParam[] = [
      { type: 'text', text: PLUM_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ];

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
      this.emitStatus('thinking');
      let response: Anthropic.Beta.Messages.BetaMessage;
      try {
        response = await client.create({
          model: settings.plumModel,
          system,
          tools,
          messages: this.thread.messages,
          maxTokens: MAX_TOKENS,
          effort: 'medium',
        });
      } catch (error) {
        log.error('[Plum] model call failed', error);
        this.emitError(describeModelError(error));
        return;
      }
      const usage = response.usage;
      log.info(
        `[Plum] turn ${iteration + 1}: stop=${response.stop_reason} in=${usage.input_tokens} ` +
          `cache_read=${usage.cache_read_input_tokens ?? 0} cache_write=${usage.cache_creation_input_tokens ?? 0} ` +
          `out=${usage.output_tokens}`,
      );

      if (response.stop_reason === 'refusal') {
        this.emitError("Plum declined that one (Anthropic's safety classifier stopped the reply).");
        return;
      }
      if (response.stop_reason === 'max_tokens') {
        // Never run tools on an input that may be cut off
        this.emitError('Plum ran out of room mid-reply; try asking in smaller steps.');
        return;
      }

      // Stored verbatim: an edited history invalidates preserved thinking
      this.thread.messages.push({ role: 'assistant', content: response.content });

      for (const block of response.content) {
        if (block.type === 'text' && block.text.trim()) {
          const row = this.addRow({ kind: 'plum', text: block.text.trim() });
          this.emit({ kind: 'assistant', thread_id: this.thread.id, row });
        }
      }

      const toolUses = response.content.filter(
        (block): block is Anthropic.Beta.Messages.BetaToolUseBlock => block.type === 'tool_use',
      );
      if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
        this.thread.lastReplyAt = this.now();
        return;
      }

      this.emitStatus('tool');
      // Every tool_use of one assistant turn is answered in ONE user message, in order
      const results: Anthropic.Beta.Messages.BetaToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        results.push(await this.runToolUse(toolUse));
      }
      this.thread.messages.push({ role: 'user', content: results });
    }
    this.emitError(`Plum stopped after ${MAX_ITERATIONS} tool calls in one turn; ask again to continue.`);
    this.thread.lastReplyAt = this.now();
  }

  private async runToolUse(
    toolUse: Anthropic.Beta.Messages.BetaToolUseBlock,
  ): Promise<Anthropic.Beta.Messages.BetaToolResultBlockParam> {
    const args = (toolUse.input ?? {}) as Record<string, unknown>;
    const entry = this.catalogue.find((candidate) => candidate.definition.name === toolUse.name);
    const row = this.addRow({
      kind: 'tool',
      text: '',
      name: toolUse.name,
      summary: entry && entry.definition.risk === 'read' ? readSummary(toolUse.name, args) : toolUse.name,
      done: false,
    });
    this.emit({ kind: 'tool_call_started', thread_id: this.thread.id, row });

    const finish = (ok: boolean, summary: string, detail: unknown, content: string) => {
      row.done = true;
      row.ok = ok;
      row.summary = summary;
      row.detail = trimDetail(detail);
      this.emit({
        kind: 'tool_call_finished',
        thread_id: this.thread.id,
        row_id: row.row_id,
        ok,
        summary,
        detail: row.detail,
      });
      return {
        type: 'tool_result' as const,
        tool_use_id: toolUse.id,
        content,
        ...(ok ? {} : { is_error: true as const }),
      };
    };

    if (!entry) {
      return finish(false, `${toolUse.name} is not a tool`, null, `unknown tool ${toolUse.name}`);
    }
    const { risk } = entry.definition;
    if (risk !== 'read' && !this.ctx.settings.plumAllowWrites) {
      const message = `${toolUse.name} refused: "Plum may change things" is off in the companion app's Settings.`;
      return finish(false, message, null, message);
    }
    if (risk === 'destructive' && !this.destructiveAllowed()) {
      const message =
        `${toolUse.name} refused by the app: a destructive tool runs only after you have asked the ` +
        'player and they have answered yes in their own message. Ask first.';
      return finish(false, `${toolUse.name} held: ask the player first`, null, message);
    }
    if (risk === 'destructive') {
      // The call counts as the act: the next one needs a fresh yes
      this.thread.lastReplyAt = this.now();
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
      outcome = await this.callMod(toolUse.name, args, entry.definition.timeout_ms || DEFAULT_TOOL_TIMEOUT_MS);
    }

    if (!outcome.ok) {
      const error = outcome.error ?? 'unknown error';
      return finish(false, `${toolUse.name} failed: ${error}`, { error }, error);
    }
    const result = outcome.result ?? {};
    const changed =
      typeof (result as { changed?: unknown }).changed === 'string'
        ? (result as { changed: string }).changed
        : undefined;
    const summary = risk === 'read' ? readSummary(toolUse.name, args) : (changed ?? `ran ${toolUse.name}`);
    return finish(true, summary, result, JSON.stringify(result));
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

  liveContextBlock(): string {
    const lot = this.ctx.simStateCache.getReport()?.lot;
    const clock = lot?.clock;
    let clockText: string | undefined;
    if (clock && typeof clock.hour === 'number') {
      const minute = String(clock.minute ?? 0).padStart(2, '0');
      const day = typeof clock.absolute_day === 'number' ? ` day ${clock.absolute_day}` : '';
      clockText = `${clock.hour}:${minute}${day}`;
    }
    const modClock = getModClockState();
    return liveBlock({
      clock: clockText,
      paused: modClock ? modClock.paused : clock?.paused,
      lot: lot?.lot_name,
      venue: lot?.venue,
      funds: lot?.funds,
    });
  }

  // --- events to the tab -------------------------------------------------------------------

  private newThread(): Thread {
    return {
      id: `thread-${randomUUID()}`,
      fingerprint: catalogueFingerprint(this.catalogue),
      messages: [],
      rows: [],
    };
  }

  private addRow(fields: Omit<PlumRow, 'row_id' | 'ts'>): PlumRow {
    const row: PlumRow = { row_id: `row-${randomUUID()}`, ts: this.timeLabel(), ...fields };
    this.thread.rows.push(row);
    return row;
  }

  private timeLabel(): string {
    const date = new Date(this.now());
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  private emit(event: Record<string, unknown>) {
    sendModNotification({ type: ModWebsocketMessageType.PLUM_EVENT, ...event });
  }

  emitStatus(state: PlumStatusState, text?: string) {
    this.emit({
      kind: 'status',
      state,
      ...(text ? { text } : {}),
      director_available: Boolean(this.ctx.ext.director),
      director_active: this.ctx.ext.director?.status().active ?? false,
      enabled: { mod: this.modEnabled, app: this.ctx.settings.plumEnabled },
    });
  }

  private emitHistory() {
    const director = this.ctx.ext.director?.status();
    this.emit({
      kind: 'history',
      thread_id: this.thread.id,
      rows: this.thread.rows,
      director: director ? { active: director.active, arc: director.arc } : { active: false },
    });
  }

  private emitError(text: string) {
    log.warn(`[Plum] ${text}`);
    this.addRow({ kind: 'error', text });
    this.emit({ kind: 'error', thread_id: this.thread.id, text });
  }
}
