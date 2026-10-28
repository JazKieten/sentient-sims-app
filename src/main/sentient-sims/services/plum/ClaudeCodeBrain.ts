// Plum's brain through Claude Code (DEV tier, plan tender-wishing-pebble 2026-10-19): Plum's
// thinking comes from an unmodified Claude Code session the developer starts on their own
// plan (`npm run plum:claude`, scripts/plum-claude/) instead of the API loop. The tab, the
// tools, the guard rails, the director, the triggers and the whispers stay PlumService's.
//
// The wire. scripts/plum-claude/server.mjs is a stdio MCP server inside that session,
// loaded as a development channel. It holds an SSE stream to GET /plum/cc/events: a `turn`
// event becomes a channel notification (the session sees `<channel source="plum" turn=..>`),
// a `catalogue` event makes it re-list the tools. Its tools post to /plum/cc/tool and the
// player-facing `reply` to /plum/cc/reply. scripts/plum-claude/hook.mjs posts the session's
// hooks to /plum/cc/hook: UserPromptSubmit acks a turn (its prompt carries the turn marker,
// and its prompt_id binds the turn), Stop / StopFailure end ONLY the turn bound to their
// prompt_id. Everything is under a token the app writes to <userData>/plum-claude/token.
//
// Rules: one delivered turn at a time, and never a push while the session is busy with
// another prompt (the terminal's own, or an abandoned turn that never stopped); a turn with
// no ack in ACK_TIMEOUT_MS is stalled (Claude Code QUEUES a channel event while its terminal
// is busy: a menu like /usage open, text typed in the prompt; measured 2026-10-20) and is
// given up only after ACK_GIVEUP_MS, when the channel may really be missing; a bound turn with no
// activity for IDLE_TIMEOUT_MS is abandoned, its write tools refused and its late Stop
// absorbed. A tool call no turn owns (typed in the terminal) goes through looseTool.
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Express, NextFunction, Request, Response } from 'express';
import log from 'electron-log';
import type { ApiContext } from '../ApiContext';
import type { PlumToolOutcome, PlumTurnResult } from '../PlumService';
import type { PlumBrainSlot, PlumTurnPort } from '../../tiers/types';
import { PLUM_SYSTEM_PROMPT } from './plumPrompt';

export const ACK_TIMEOUT_MS = 20_000;
export const ACK_GIVEUP_MS = 3 * 60_000;
export const IDLE_TIMEOUT_MS = 5 * 60_000;
// A prompt the session is busy with that shows no activity for this long is taken to be over
// (Esc in the terminal fires no Stop), so the next turn may go
export const STALE_BUSY_MS = 2 * 60_000;
// How long a turn waits for the session to finish another prompt before giving up
export const BUSY_WAIT_MS = 5 * 60_000;
export const LIMIT_HOLD_MS = 10 * 60_000;
export const HEARTBEAT_MS = 15_000;

const NOT_RUNNING = 'Claude Code session is not running (start it with `npm run plum:claude`)';
const STALLED =
  "Claude Code hasn't picked up the turn: close any menu (like /usage) or clear typed text in its terminal";
const NOT_REGISTERED =
  'Claude Code did not pick up the turn in 3 minutes: close any menu in its terminal, or restart it with `npm run plum:claude`';
const PLAN_LIMIT = "Claude plan limit reached; switch Plum's brain to API in Settings";
const SIGNED_OUT =
  "Claude Code could not sign in; run /login in its terminal or switch Plum's brain to API in Settings";

const MARKER = /\[plum turn ([A-Za-z0-9]+)/;

// One SSE client (the MCP server in the session)
export type BrainSink = {
  send(event: string, data: unknown): void;
};

type Turn = {
  port: PlumTurnPort;
  delivered: boolean;
  acked: boolean;
  promptId?: string;
  carriesSeed: boolean;
  resolve(result: PlumTurnResult): void;
  done: boolean;
  ackTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  waitTimer?: NodeJS.Timeout;
};

type BusyPrompt = { promptId: string; lastActivity: number };

export type HookInput = {
  hook_event_name?: string;
  prompt_id?: string;
  prompt?: string;
  source?: string;
  error?: string;
  error_details?: string;
  last_assistant_message?: string;
};

export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
};

export const REPLY_TOOL: McpTool = {
  name: 'reply',
  description:
    'Say something to the player in the Plum tab. The ONLY way the player sees your words: text you write ' +
    'outside this tool reaches nobody. `turn` is the id from the [plum turn ID ...] line of the message you ' +
    'are answering. One to three sentences, plain text.',
  inputSchema: {
    type: 'object',
    properties: {
      turn: { type: 'string', description: 'The turn id from the [plum turn ID kind=...] line' },
      text: { type: 'string', description: 'What the player reads' },
    },
    required: ['turn', 'text'],
    additionalProperties: false,
  },
};

export const PERSONA_WIRING = `

How you are wired in this session. You run inside Claude Code on the developer's own machine, not through the API, and you have NO file, shell or web tools: only the Plum tools, named mcp__plum__<tool>.
- Every message from the game arrives as a <channel source="plum"> event whose text starts with a line "[plum turn ID kind=chat|director|wake|night]", then the <live> block, then (on the first turn of a conversation) your notes and the end of the earlier conversation, then the message itself.
- The player sees ONLY what you send with mcp__plum__reply, passing that turn's ID as \`turn\`. Anything else you write stays in this terminal, which the player never sees. Answer every chat turn with a reply; a director tick or a wake may stay silent when nothing matters.
- When the turn's work is done, stop. Do not wait for, or ask, the terminal for anything.
- In a director tick (kind=director), when you name an arc, the reply's text carries "ARC: <name>" on its own line.
- In a night call (kind=night) you are writing ONE Sim's intentions for the new day: call mcp__plum__edit_intentions once with the edits, one line of narration beside it, no reply.
- Lines typed in this terminal come from the developer, not the player: answer them here, and never call a destructive tool for them.`;

export class ClaudeCodeBrain implements PlumBrainSlot {
  private readonly ctx: ApiContext;

  private readonly now: () => number;

  private readonly sinks = new Set<BrainSink>();

  private current: Turn | undefined;

  // The prompt the session is working on (from UserPromptSubmit until its Stop)
  private busy: BusyPrompt | undefined;

  // prompt_ids of turns given up on (timed out): their Stop is absorbed, their writes refused
  private readonly abandoned = new Set<string>();

  // turn ids given up on before their ack: a late ack records its prompt_id as abandoned
  private readonly abandonedTurns = new Set<string>();

  private needsSeed = true;

  private channelDown: string | undefined;

  // The delivered turn has not been picked up yet (past ACK_TIMEOUT_MS)
  private stalled = false;

  private limitUntil: number | undefined;

  private limitReason: string | undefined;

  token: string | undefined;

  constructor(ctx: ApiContext, options: { now?: () => number } = {}) {
    this.ctx = ctx;
    this.now = options.now ?? (() => Date.now());
  }

  // --- PlumBrainSlot ---------------------------------------------------------------------

  unavailable(): string | undefined {
    if (this.sinks.size === 0) {
      return NOT_RUNNING;
    }
    if (this.channelDown) {
      return this.channelDown;
    }
    if (this.stalled) {
      return STALLED;
    }
    if (this.limitUntil !== undefined && this.now() < this.limitUntil) {
      return this.limitReason ?? PLAN_LIMIT;
    }
    return undefined;
  }

  runTurn(port: PlumTurnPort): Promise<PlumTurnResult> {
    return new Promise<PlumTurnResult>((resolve) => {
      const turn: Turn = { port, delivered: false, acked: false, carriesSeed: false, resolve, done: false };
      if (this.current && !this.current.done) {
        // PlumService runs one turn at a time; a second one here is a bug upstream
        this.finish(this.current, { error: { status: 503, message: 'a newer Plum turn replaced this one' } });
      }
      this.current = turn;
      turn.waitTimer = setTimeout(() => {
        if (!turn.delivered) {
          this.finish(turn, {
            error: { status: 503, message: 'Claude Code stayed busy with another prompt; the turn was not sent' },
          });
        }
      }, BUSY_WAIT_MS);
      this.tryDeliver();
    });
  }

  onCatalogueChanged() {
    this.broadcast('catalogue', { changed: true });
  }

  onThreadReset() {
    this.needsSeed = true;
  }

  // --- the SSE side ----------------------------------------------------------------------

  addSink(sink: BrainSink) {
    this.sinks.add(sink);
    this.needsSeed = true;
    log.info(`[Plum/cc] Claude Code connected (${this.sinks.size} client(s))`);
    this.refreshStatus();
    this.tryDeliver();
  }

  removeSink(sink: BrainSink) {
    this.sinks.delete(sink);
    log.info(`[Plum/cc] Claude Code disconnected (${this.sinks.size} client(s))`);
    if (this.sinks.size === 0) {
      this.busy = undefined;
      const turn = this.current;
      if (turn && !turn.done && turn.delivered) {
        this.abandon(turn, { error: { status: 503, message: 'the Claude Code session closed mid-turn' } });
      }
    }
    this.refreshStatus();
  }

  private broadcast(event: string, data: unknown) {
    for (const sink of this.sinks) {
      try {
        sink.send(event, data);
      } catch (error) {
        log.warn('[Plum/cc] could not write to a client', error);
      }
    }
  }

  private refreshStatus() {
    try {
      this.ctx.plum.emitStatus(this.ctx.plum.isRunning ? 'thinking' : 'idle');
    } catch (error) {
      log.debug('[Plum/cc] no status to refresh', error);
    }
  }

  // --- delivery --------------------------------------------------------------------------

  private sessionBusy(): boolean {
    if (!this.busy) {
      return false;
    }
    if (this.now() - this.busy.lastActivity > STALE_BUSY_MS) {
      log.info(`[Plum/cc] prompt ${this.busy.promptId} went quiet; taking it as over`);
      this.busy = undefined;
      return false;
    }
    return true;
  }

  private tryDeliver() {
    const turn = this.current;
    if (!turn || turn.done || turn.delivered || this.sinks.size === 0 || this.sessionBusy()) {
      return;
    }
    const { port } = turn;
    const parts = [`[plum turn ${port.id} kind=${port.kind}${port.detached ? ' detached=true' : ''}]`, port.live];
    // A detached director turn carries its own memory (the <director_note> inside live); the
    // seed is the chat's and waits for the next chat turn
    if (this.needsSeed && !port.detached) {
      const seed = port.seed();
      if (seed) {
        parts.push(seed);
      }
      turn.carriesSeed = true;
    }
    parts.push(port.text);
    turn.delivered = true;
    clearTimeout(turn.waitTimer);
    // A night call has no <live> block: leave no blank part for it
    this.broadcast('turn', {
      turn: port.id,
      kind: port.kind,
      content: parts.filter((part) => part.trim()).join('\n\n'),
    });
    log.info(`[Plum/cc] turn ${port.id} kind=${port.kind} sent${turn.carriesSeed ? ' with the seed' : ''}`);
    turn.ackTimer = setTimeout(() => {
      if (turn.acked || turn.done) {
        return;
      }
      log.warn(`[Plum/cc] turn ${port.id} not picked up after ${ACK_TIMEOUT_MS / 1000} s; waiting`);
      this.stalled = true;
      this.refreshStatus();
      turn.ackTimer = setTimeout(() => {
        if (!turn.acked && !turn.done) {
          this.channelDown = NOT_REGISTERED;
          this.abandon(turn, { error: { status: 503, message: NOT_REGISTERED } });
          this.refreshStatus();
        }
      }, ACK_GIVEUP_MS - ACK_TIMEOUT_MS);
    }, ACK_TIMEOUT_MS);
  }

  private ack(turn: Turn, promptId?: string) {
    if (!turn.acked) {
      turn.acked = true;
      clearTimeout(turn.ackTimer);
      if (this.stalled) {
        this.stalled = false;
        this.refreshStatus();
      }
      if (turn.carriesSeed) {
        this.needsSeed = false;
      }
    }
    if (promptId && !turn.promptId) {
      turn.promptId = promptId;
    }
    this.touch(turn);
  }

  // Anything the session did for this turn: the idle clock restarts
  private touch(turn: Turn) {
    clearTimeout(turn.idleTimer);
    turn.idleTimer = setTimeout(() => {
      if (!turn.done) {
        this.abandon(turn, {
          error: {
            status: 503,
            message: `Claude Code went quiet for ${IDLE_TIMEOUT_MS / 60_000} minutes; the turn was given up`,
          },
        });
      }
    }, IDLE_TIMEOUT_MS);
  }

  private finish(turn: Turn, result: PlumTurnResult) {
    if (turn.done) {
      return;
    }
    turn.done = true;
    this.stalled = false;
    clearTimeout(turn.ackTimer);
    clearTimeout(turn.idleTimer);
    clearTimeout(turn.waitTimer);
    if (this.current === turn) {
      this.current = undefined;
    }
    turn.resolve(result);
  }

  private abandon(turn: Turn, result: PlumTurnResult) {
    if (turn.promptId) {
      this.abandoned.add(turn.promptId);
    } else {
      this.abandonedTurns.add(turn.port.id);
    }
    log.warn(`[Plum/cc] turn ${turn.port.id} abandoned: ${result.error?.message ?? ''}`);
    this.finish(turn, result);
  }

  // --- hooks -----------------------------------------------------------------------------

  onHook(input: HookInput) {
    const event = input.hook_event_name ?? '';
    const promptId = typeof input.prompt_id === 'string' ? input.prompt_id : undefined;
    // Any sign of life clears the "not registered" hold
    if (this.channelDown) {
      this.channelDown = undefined;
      this.refreshStatus();
    }
    switch (event) {
      case 'SessionStart':
        if (input.source === 'startup' || input.source === 'clear') {
          this.needsSeed = true;
        }
        return;
      case 'UserPromptSubmit':
        this.onPromptSubmit(promptId, typeof input.prompt === 'string' ? input.prompt : '');
        return;
      case 'Stop':
        this.onStop(promptId, undefined);
        return;
      case 'StopFailure':
        this.onStop(promptId, input);
        return;
      default:
        // PreCompact, PostCompact, PreToolUse: activity on whatever prompt is running
        this.noteActivity(promptId);
    }
  }

  private noteActivity(promptId: string | undefined) {
    if (this.busy && (!promptId || promptId === this.busy.promptId)) {
      this.busy.lastActivity = this.now();
    }
    const turn = this.current;
    if (turn && !turn.done && turn.acked && (!promptId || !turn.promptId || turn.promptId === promptId)) {
      this.touch(turn);
    }
  }

  private onPromptSubmit(promptId: string | undefined, prompt: string) {
    const turn = this.current;
    // A new prompt while a bound turn never stopped: the developer pressed Esc and typed
    if (turn && !turn.done && turn.promptId && promptId && turn.promptId !== promptId) {
      this.abandon(turn, { error: { status: 503, message: 'interrupted in the Claude Code terminal' } });
    }
    if (promptId) {
      this.busy = { promptId, lastActivity: this.now() };
    }
    const marker = MARKER.exec(prompt)?.[1];
    if (!marker) {
      return;
    }
    if (this.abandonedTurns.has(marker)) {
      if (promptId) {
        this.abandoned.add(promptId);
      }
      return;
    }
    const live = this.current;
    if (live && !live.done && live.port.id === marker) {
      this.ack(live, promptId);
    }
  }

  private onStop(promptId: string | undefined, failure: HookInput | undefined) {
    // A prompt the session was busy with that is not the turn's own (typed in the terminal)
    const otherPrompt = promptId !== undefined && this.busy?.promptId === promptId;
    if (promptId && this.busy?.promptId === promptId) {
      this.busy = undefined;
    } else if (!promptId) {
      this.busy = undefined;
    }
    if (promptId && this.abandoned.delete(promptId)) {
      log.info(`[Plum/cc] late stop of an abandoned turn absorbed (${promptId})`);
      this.tryDeliver();
      return;
    }
    const turn = this.current;
    // Bound by prompt_id; an unbound delivered turn (no UserPromptSubmit seen) takes a Stop
    // only when that Stop belongs to no other known prompt
    if (!turn || turn.done || !turn.delivered) {
      log.info(`[Plum/cc] stop for ${promptId ?? 'an unknown prompt'} ignored (no turn of ours)`);
      this.tryDeliver();
      return;
    }
    const owns = turn.promptId ? turn.promptId === promptId : !otherPrompt;
    if (!owns) {
      log.info(`[Plum/cc] stop for ${promptId ?? 'an unknown prompt'} ignored (no turn of ours)`);
      this.tryDeliver();
      return;
    }
    if (!failure) {
      this.finish(turn, {});
    } else {
      this.finish(turn, { error: this.failureOf(failure) });
      this.refreshStatus();
    }
    this.tryDeliver();
  }

  // StopFailure's error names (hooks reference, 2026-10-19)
  private failureOf(failure: HookInput): { status: number; message: string } {
    const kind = failure.error ?? 'unknown';
    const detail = failure.error_details || failure.last_assistant_message || '';
    const suffix = detail ? ` (${detail.slice(0, 160)})` : '';
    if (kind === 'rate_limit' || kind === 'billing_error') {
      this.holdFor(PLAN_LIMIT);
      return { status: 429, message: PLAN_LIMIT };
    }
    if (kind === 'authentication_failed' || kind === 'oauth_org_not_allowed' || kind === 'account_on_hold') {
      this.holdFor(SIGNED_OUT);
      return { status: 401, message: SIGNED_OUT };
    }
    if (kind === 'overloaded') {
      return { status: 529, message: `Claude is overloaded right now; try again in a minute${suffix}` };
    }
    return { status: 503, message: `Claude Code failed the turn: ${kind}${suffix}` };
  }

  private holdFor(reason: string) {
    this.limitUntil = this.now() + LIMIT_HOLD_MS;
    this.limitReason = reason;
  }

  // --- tools and replies -----------------------------------------------------------------

  catalogue(): McpTool[] {
    const tools = this.ctx.plum.externalCatalogue().map(({ definition }) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: { ...definition.input_schema, type: 'object' },
      annotations: { readOnlyHint: definition.risk === 'read' },
    }));
    return [...tools, REPLY_TOOL];
  }

  // Which turn a tool call belongs to: the bound turn while the session works on it
  private owner(): { turn?: Turn; abandoned: boolean } {
    const turn = this.current;
    if (turn && !turn.done && turn.delivered) {
      if (!turn.acked && !this.busy) {
        // No UserPromptSubmit seen for it (the fallback): the call is its ack
        this.ack(turn);
      }
      if (turn.acked && (!turn.promptId || !this.busy || this.busy.promptId === turn.promptId)) {
        return { turn, abandoned: false };
      }
    }
    if (this.busy && this.abandoned.has(this.busy.promptId)) {
      return { abandoned: true };
    }
    return { abandoned: false };
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<PlumToolOutcome> {
    if (this.channelDown) {
      this.channelDown = undefined;
      this.refreshStatus();
    }
    if (this.busy) {
      this.busy.lastActivity = this.now();
    }
    const { turn, abandoned } = this.owner();
    if (turn) {
      this.touch(turn);
      const outcome = await turn.port.runTool(name, args);
      if (!turn.done) {
        this.touch(turn);
      }
      return outcome;
    }
    if (abandoned) {
      const entry = this.ctx.plum.externalCatalogue().find((candidate) => candidate.definition.name === name);
      if (entry?.definition.risk !== 'read') {
        const message = `${name} refused: that turn was given up on (it went quiet), so it may only look`;
        return { ok: false, summary: message, error: message, content: message };
      }
    }
    return this.ctx.plum.looseTool(name, args);
  }

  reply(turnId: string, text: string): { ok: boolean; message: string } {
    const turn = this.current;
    if (!turn || turn.done || turn.port.id !== turnId) {
      return {
        ok: false,
        message: `turn ${turnId} is not the turn the player is waiting on; nobody saw that reply`,
      };
    }
    if (!turn.acked) {
      this.ack(turn);
    }
    this.touch(turn);
    turn.port.say(text);
    return { ok: true, message: 'the player sees it' };
  }

  persona(): string {
    return PLUM_SYSTEM_PROMPT + PERSONA_WIRING;
  }

  // --- the token ---------------------------------------------------------------------------

  // Kept across restarts so a running session survives an app restart
  loadToken(dir: string) {
    const file = path.join(dir, 'token');
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(file)) {
        const stored = fs.readFileSync(file, 'utf8').trim();
        if (stored) {
          this.token = stored;
          return;
        }
      }
      this.token = randomBytes(24).toString('hex');
      fs.writeFileSync(file, this.token, 'utf8');
    } catch (error) {
      log.warn('[Plum/cc] could not write the token; the Claude Code routes stay closed', error);
    }
  }
}

// The routes the session's scripts talk to, all behind the token. Plain try/catch: the
// @CatchErrors decorator pops a dialog on every throw.
export function claudeCodeRoutes(app: Express, brain: ClaudeCodeBrain) {
  const guard = (req: Request, res: Response, next: NextFunction) => {
    const given = req.get('x-plum-token');
    if (!brain.token || given !== brain.token) {
      res.status(401).json({ error: 'bad or missing x-plum-token' });
      return;
    }
    next();
  };

  app.get('/plum/cc/events', guard, (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(': connected\n\n');
    const sink: BrainSink = {
      send: (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      },
    };
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    brain.addSink(sink);
    req.on('close', () => {
      clearInterval(heartbeat);
      brain.removeSink(sink);
    });
  });

  app.get('/plum/cc/catalogue', guard, (_req: Request, res: Response) => {
    try {
      res.json({ tools: brain.catalogue() });
    } catch (error) {
      log.warn('[Plum/cc] catalogue failed', error);
      res.status(500).json({ error: String(error) });
    }
  });

  app.get('/plum/cc/persona', guard, (_req: Request, res: Response) => {
    res.type('text/plain').send(brain.persona());
  });

  app.post('/plum/cc/tool', guard, async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { name?: unknown; args?: unknown };
      const name = typeof body.name === 'string' ? body.name : '';
      const args = body.args && typeof body.args === 'object' ? (body.args as Record<string, unknown>) : {};
      res.json(await brain.callTool(name, args));
    } catch (error) {
      log.warn('[Plum/cc] tool failed', error);
      const message = error instanceof Error ? error.message : String(error);
      res.json({ ok: false, summary: message, content: message, error: message });
    }
  });

  app.post('/plum/cc/reply', guard, (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { turn?: unknown; text?: unknown };
      const turn = typeof body.turn === 'string' || typeof body.turn === 'number' ? String(body.turn) : '';
      res.json(brain.reply(turn, typeof body.text === 'string' ? body.text : ''));
    } catch (error) {
      log.warn('[Plum/cc] reply failed', error);
      res.json({ ok: false, message: String(error) });
    }
  });

  app.post('/plum/cc/hook', guard, (req: Request, res: Response) => {
    try {
      brain.onHook((req.body ?? {}) as HookInput);
    } catch (error) {
      log.warn('[Plum/cc] hook failed', error);
    }
    res.json({});
  });
}
