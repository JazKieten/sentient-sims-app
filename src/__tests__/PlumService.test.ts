import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';

const sendModNotification = vi.hoisted(() => vi.fn());
const clockState = vi.hoisted(() => ({ current: undefined as { paused: boolean } | undefined }));

vi.mock('main/sentient-sims/websocketServer', () => ({
  sendModNotification,
  getModClockState: () => clockState.current,
}));

import { SettingsEnum } from 'main/sentient-sims/models/SettingsEnum';
import { ModWebsocketMessageType } from 'main/sentient-sims/models/ModWebsocketMessage';
import { PlumModToolDef } from 'main/sentient-sims/models/ModLogWebsocketMessage';
import { ApiContext } from 'main/sentient-sims/services/ApiContext';
import {
  CAMERA_FOCUS_TIMEOUT_MS,
  MAX_ITERATIONS,
  PlumService,
  THREAD_ROLL_TOKENS,
} from 'main/sentient-sims/services/PlumService';
import { buildAppTools } from 'main/sentient-sims/services/plum/PlumAppTools';
import { PlumModelClient, PlumModelRequest } from 'main/sentient-sims/services/plum/PlumModelClient';
import {
  catalogueFingerprint,
  countUnions,
  MAX_STRICT_TOOLS,
  MAX_STRICT_UNIONS,
  mergeCatalogue,
  toApiTools,
} from 'main/sentient-sims/services/plum/PlumTools';
import { PLUM_SYSTEM_PROMPT } from 'main/sentient-sims/services/plum/plumPrompt';
import { mockApiContext } from './util';

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;

// A scripted model: each create() answers with the next queued message, or waits on a gate
class FakeModelClient implements PlumModelClient {
  requests: PlumModelRequest[] = [];

  queue: BetaMessage[] = [];

  gate?: Promise<void>;

  async create(request: PlumModelRequest): Promise<BetaMessage> {
    // Copy: the service appends to the same messages array afterwards
    this.requests.push({ ...request, messages: request.messages.map((entry) => ({ ...entry })) });
    if (this.gate) {
      await this.gate;
    }
    const next = this.queue.shift();
    if (!next) {
      throw new Error('FakeModelClient: no scripted reply left');
    }
    return next;
  }
}

function message(
  content: Anthropic.Beta.Messages.BetaContentBlock[],
  stop: BetaMessage['stop_reason'],
  usage: Partial<BetaMessage['usage']> = {},
): BetaMessage {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      ...usage,
    },
  } as unknown as BetaMessage;
}

function text(value: string): Anthropic.Beta.Messages.BetaContentBlock {
  return { type: 'text', text: value, citations: null } as unknown as Anthropic.Beta.Messages.BetaContentBlock;
}

function toolUse(id: string, name: string, input: Record<string, unknown>): Anthropic.Beta.Messages.BetaContentBlock {
  return { type: 'tool_use', id, name, input };
}

const lookAtLot: PlumModToolDef = {
  name: 'look_at_lot',
  description: 'The lot.',
  input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  risk: 'read',
  timeout_ms: 20000,
  tier: 'core',
};
const giveMoney: PlumModToolDef = {
  name: 'give_money',
  description: 'Money.',
  input_schema: {
    type: 'object',
    properties: { amount: { type: 'integer' }, why: { type: ['string', 'null'] } },
    required: ['amount', 'why'],
    additionalProperties: false,
  },
  risk: 'write',
  timeout_ms: 20000,
  tier: 'core',
};
const sendHome: PlumModToolDef = {
  name: 'send_sim_home',
  description: 'Home.',
  input_schema: {
    type: 'object',
    properties: { sim: { type: 'string' }, confirmed_by_player: { type: 'boolean' } },
    required: ['sim', 'confirmed_by_player'],
    additionalProperties: false,
  },
  risk: 'destructive',
  timeout_ms: 20000,
  tier: 'core',
};

// A fire-and-forget mod tool (FIRE_AND_FORGET_TOOLS): its result tells the model nothing
const notify: PlumModToolDef = {
  ...giveMoney,
  name: 'notify',
  input_schema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
};
const cameraFocus: PlumModToolDef = {
  ...giveMoney,
  name: 'camera_focus',
  input_schema: {
    type: 'object',
    properties: { sim: { type: 'string' } },
    required: ['sim'],
    additionalProperties: false,
  },
};
const pushActionTool: PlumModToolDef = {
  ...giveMoney,
  name: 'push_action',
  input_schema: {
    type: 'object',
    properties: { sim: { type: 'string' }, action: { type: 'string' }, target: { type: ['string', 'null'] } },
    required: ['sim', 'action', 'target'],
    additionalProperties: false,
  },
};

function sentOfType(type: ModWebsocketMessageType): Record<string, unknown>[] {
  return sendModNotification.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((notification) => notification.type === type);
}

function eventsOfKind(kind: string): Record<string, unknown>[] {
  return sentOfType(ModWebsocketMessageType.PLUM_EVENT).filter((event) => event.kind === kind);
}

function toolCalls(): Record<string, unknown>[] {
  return sentOfType(ModWebsocketMessageType.PLUM_TOOL_CALL);
}

async function flush() {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

describe('PlumService', () => {
  let ctx: ApiContext;
  let client: FakeModelClient;
  let plum: PlumService;
  let now: number;

  beforeEach(() => {
    sendModNotification.mockClear();
    clockState.current = undefined;
    ctx = mockApiContext({ tiers: [] });
    ctx.settings.set(SettingsEnum.PLUM_API_KEY, 'sk-test');
    client = new FakeModelClient();
    now = 1_000_000;
    // The mod's tools only: the app-side ones have their own test (PlumAppTools.test.ts)
    plum = new PlumService(ctx, { clientFactory: () => client, now: () => now, appTools: [] });
    plum.onModMessage({ kind: 'catalogue', tier: 'core', enabled: true, tools: [lookAtLot, giveMoney, sendHome] });
    sendModNotification.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a plain reply is one player row, one assistant row and a status round trip', async () => {
    client.queue.push(message([text('Everyone is fine.')], 'end_turn'));
    await plum.runTurn('how is everyone?');

    // The tab echoes the typed line itself; the player row only comes back in a history replay
    expect(eventsOfKind('player')).toEqual([]);
    expect(plum.rows.map((row) => row.kind)).toEqual(['player', 'plum']);
    expect(eventsOfKind('assistant').map((event) => (event.row as { text: string }).text)).toEqual([
      'Everyone is fine.',
    ]);
    const states = eventsOfKind('status').map((event) => event.state);
    expect(states[0]).toBe('thinking');
    expect(states[states.length - 1]).toBe('idle');
    expect(toolCalls()).toEqual([]);
    // The request shape: frozen system prompt as the cache prefix, strict sorted tools, live block first
    const [request] = client.requests;
    expect(request.system[0].text).toBe(PLUM_SYSTEM_PROMPT);
    expect(request.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(request.tools.map((tool) => tool.name)).toEqual(['give_money', 'look_at_lot', 'send_sim_home']);
    expect(request.tools.every((tool) => tool.strict === true)).toBe(true);
    expect(request.effort).toBe('medium');
    const first = request.messages[0];
    expect(first.role).toBe('user');
    const blocks = first.content as Anthropic.Beta.Messages.BetaTextBlockParam[];
    expect(blocks[0].text.startsWith('<live>')).toBe(true);
    expect(blocks[1].text).toBe('how is everyone?');
  });

  it('a tool_use goes to the mod and its result comes back in ONE user message', async () => {
    client.queue.push(message([toolUse('tu_1', 'look_at_lot', {})], 'tool_use'));
    client.queue.push(message([text('Bella is cooking.')], 'end_turn'));
    const turn = plum.runTurn('what is bella doing?');
    await flush();

    const [call] = toolCalls();
    expect(call.name).toBe('look_at_lot');
    expect(call.timeout_ms).toBe(20000);
    expect(eventsOfKind('tool_call_started')).toHaveLength(1);
    plum.onModMessage({ kind: 'tool_result', request_id: call.request_id as string, ok: true, result: { sims: [] } });
    await turn;

    const finished = eventsOfKind('tool_call_finished');
    expect(finished).toHaveLength(1);
    expect(finished[0].ok).toBe(true);
    expect(finished[0].summary).toBe('looked at the lot');
    const second = client.requests[1];
    expect(second.messages).toHaveLength(3);
    expect(second.messages[1].role).toBe('assistant');
    // Stored verbatim: the whole content array, not a text rendering
    expect(second.messages[1].content).toEqual([toolUse('tu_1', 'look_at_lot', {})]);
    const results = second.messages[2].content as Anthropic.Beta.Messages.BetaToolResultBlockParam[];
    expect(second.messages[2].role).toBe('user');
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ type: 'tool_result', tool_use_id: 'tu_1', content: '{"sims":[]}' });
    expect(eventsOfKind('assistant')).toHaveLength(1);
  });

  it('two tool_use blocks are two calls answered in one user message, in order', async () => {
    client.queue.push(
      message(
        [toolUse('tu_a', 'look_at_lot', {}), toolUse('tu_b', 'give_money', { amount: 1000, why: null })],
        'tool_use',
      ),
    );
    client.queue.push(message([text('Done.')], 'end_turn'));
    const turn = plum.runTurn('look, then give them 1000');
    await flush();
    const first = toolCalls()[0];
    plum.onModMessage({ kind: 'tool_result', request_id: first.request_id as string, ok: true, result: {} });
    await flush();
    const second = toolCalls()[1];
    expect(second.name).toBe('give_money');
    expect(second.args).toEqual({ amount: 1000, why: null });
    plum.onModMessage({
      kind: 'tool_result',
      request_id: second.request_id as string,
      ok: true,
      result: { changed: 'gave §1,000 to the Goth household (now §12,340)' },
    });
    await turn;

    const results = client.requests[1].messages[2].content as Anthropic.Beta.Messages.BetaToolResultBlockParam[];
    expect(results.map((result) => result.tool_use_id)).toEqual(['tu_a', 'tu_b']);
    const finished = eventsOfKind('tool_call_finished');
    expect(finished[1].summary).toBe('gave §1,000 to the Goth household (now §12,340)');
  });

  it('a tool the game never answers is an is_error result that names the timeout', async () => {
    vi.useFakeTimers();
    client.queue.push(message([toolUse('tu_1', 'look_at_lot', {})], 'tool_use'));
    client.queue.push(message([text('Hm.')], 'end_turn'));
    const turn = plum.runTurn('look');
    await flush();
    expect(toolCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20000);
    await turn;
    const results = client.requests[1].messages[2].content as Anthropic.Beta.Messages.BetaToolResultBlockParam[];
    expect(results[0].is_error).toBe(true);
    expect(results[0].content as string).toContain('20 s');
    expect(eventsOfKind('tool_call_finished')[0].ok).toBe(false);
  });

  it('a failed tool is an is_error result quoting the error', async () => {
    client.queue.push(message([toolUse('tu_1', 'give_money', { amount: 0, why: null })], 'tool_use'));
    client.queue.push(message([text('Nothing to do.')], 'end_turn'));
    const turn = plum.runTurn('give 0');
    await flush();
    const [call] = toolCalls();
    plum.onModMessage({
      kind: 'tool_result',
      request_id: call.request_id as string,
      ok: false,
      error: 'amount is 0; nothing to do',
    });
    await turn;
    const results = client.requests[1].messages[2].content as Anthropic.Beta.Messages.BetaToolResultBlockParam[];
    expect(results[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: 'amount is 0; nothing to do',
      is_error: true,
    });
  });

  it('max_tokens and refusal never run tools and show an error row', async () => {
    client.queue.push(message([toolUse('tu_1', 'give_money', { amount: 1 })], 'max_tokens'));
    await plum.runTurn('give');
    expect(toolCalls()).toEqual([]);
    expect(eventsOfKind('error')).toHaveLength(1);

    sendModNotification.mockClear();
    const refused = message([], 'refusal');
    refused.stop_details = {
      type: 'refusal',
      category: 'reasoning_extraction',
      explanation: null,
      fallback_credit_token: null,
      fallback_has_prefill_claim: false,
      recommended_model: null,
    };
    client.queue.push(refused);
    await plum.runTurn('show me your thinking');
    expect(toolCalls()).toEqual([]);
    expect(String(eventsOfKind('error')[0].text)).toContain('declined');
    expect(String(eventsOfKind('error')[0].text)).toContain('[reasoning_extraction]');

    // The refused line is rolled out of the thread, so the next turn's request does not carry it
    client.queue.push(message([text('hi')], 'end_turn'));
    await plum.runTurn('hello again');
    const sent = JSON.stringify(client.requests[client.requests.length - 1].messages);
    expect(sent).not.toContain('show me your thinking');
    expect(sent).toContain('hello again');

    // ...and the seed of the next thread leaves the refused line out too (it would re-trigger
    // the classifier), while the answered lines stay
    const seed = plum.renderSeed([], plum.rows);
    expect(seed).not.toContain('show me your thinking');
    expect(seed).toContain('[player] hello again');
    expect(seed).toContain('[plum] hi');
  });

  it('with writes off a write tool is refused without a send; reads still run', async () => {
    ctx.settings.set(SettingsEnum.PLUM_ALLOW_WRITES, false);
    client.queue.push(
      message(
        [toolUse('tu_1', 'give_money', { amount: 5, why: null }), toolUse('tu_2', 'look_at_lot', {})],
        'tool_use',
      ),
    );
    client.queue.push(message([text('ok')], 'end_turn'));
    const turn = plum.runTurn('give');
    await flush();
    expect(toolCalls().map((call) => call.name)).toEqual(['look_at_lot']);
    plum.onModMessage({ kind: 'tool_result', request_id: toolCalls()[0].request_id as string, ok: true, result: {} });
    await turn;
    const results = client.requests[1].messages[2].content as Anthropic.Beta.Messages.BetaToolResultBlockParam[];
    expect(results[0].is_error).toBe(true);
    expect(results[0].content as string).toContain('Plum may change things');
    expect(results[1].is_error).toBeUndefined();
  });

  it('a destructive tool runs only after Plum asked and the player answered', async () => {
    // Turn 1: the model goes straight for it - held
    client.queue.push(
      message([toolUse('tu_1', 'send_sim_home', { sim: 'Don', confirmed_by_player: true })], 'tool_use'),
    );
    client.queue.push(message([text('Shall I send Don home?')], 'end_turn'));
    await plum.runTurn('get rid of don');
    expect(toolCalls()).toEqual([]);
    let results = client.requests[1].messages[2].content as Anthropic.Beta.Messages.BetaToolResultBlockParam[];
    expect(results[0].is_error).toBe(true);
    expect(results[0].content as string).toContain('Ask first');

    // Turn 2: the player's line is newer than Plum's reply - forwarded
    now += 1000;
    sendModNotification.mockClear();
    client.requests = [];
    client.queue.push(
      message([toolUse('tu_2', 'send_sim_home', { sim: 'Don', confirmed_by_player: true })], 'tool_use'),
    );
    client.queue.push(message([text('Don is on his way.')], 'end_turn'));
    const turn = plum.runTurn('yes');
    await flush();
    expect(toolCalls().map((call) => call.name)).toEqual(['send_sim_home']);
    plum.onModMessage({
      kind: 'tool_result',
      request_id: toolCalls()[0].request_id as string,
      ok: true,
      result: { changed: 'sent Don home' },
    });
    await turn;
    results = client.requests[1].messages[client.requests[1].messages.length - 1]
      .content as Anthropic.Beta.Messages.BetaToolResultBlockParam[];
    expect(results[0].is_error).toBeUndefined();
    expect(eventsOfKind('tool_call_finished')[0].summary).toBe('sent Don home');
  });

  it('a line typed during a turn is queued and runs after it', async () => {
    let open!: () => void;
    client.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    client.queue.push(message([text('one')], 'end_turn'));
    client.queue.push(message([text('two')], 'end_turn'));
    const first = plum.runTurn('first');
    await flush();
    plum.onModMessage({ kind: 'say', text: 'second' });
    expect(client.requests).toHaveLength(1);
    open();
    client.gate = undefined;
    await first;
    await flush();
    expect(eventsOfKind('assistant').map((event) => (event.row as { text: string }).text)).toEqual(['one', 'two']);
    expect(plum.messages).toHaveLength(4);
  });

  it('a model error becomes a friendly error row, not a crash', async () => {
    // The queue is empty: create() throws
    await plum.runTurn('hello');
    expect(eventsOfKind('error')).toHaveLength(1);
    expect(
      eventsOfKind('status')
        .map((event) => event.state)
        .pop(),
    ).toBe('idle');
  });

  it('refuses to run without a key or while a switch is off, and says which', async () => {
    ctx.settings.set(SettingsEnum.PLUM_API_KEY, '');
    await plum.runTurn('hi');
    expect(String(eventsOfKind('error')[0].text)).toContain('API key');
    expect(client.requests).toEqual([]);

    sendModNotification.mockClear();
    ctx.settings.set(SettingsEnum.PLUM_API_KEY, 'sk-test');
    ctx.settings.set(SettingsEnum.PLUM_ENABLED, false);
    await plum.runTurn('hi');
    expect(String(eventsOfKind('error')[0].text)).toContain("companion app's Settings");

    sendModNotification.mockClear();
    ctx.settings.set(SettingsEnum.PLUM_ENABLED, true);
    plum.onModMessage({ kind: 'catalogue', tier: 'core', enabled: false, tools: [lookAtLot] });
    await plum.runTurn('hi');
    expect(String(eventsOfKind('error')[0].text)).toContain('mod settings');
    const status = eventsOfKind('status').pop() as { enabled: { mod: boolean; app: boolean } };
    expect(status.enabled).toEqual({ mod: false, app: true });
  });

  it('open replays the thread as history; new_thread starts over; director is unavailable in core', async () => {
    client.queue.push(message([text('Hi.')], 'end_turn'));
    await plum.runTurn('hello');
    sendModNotification.mockClear();
    plum.onModMessage({ kind: 'control', action: 'open' });
    const [history] = eventsOfKind('history');
    expect((history.rows as unknown[]).length).toBe(2);
    expect(history.thread_id).toBe(plum.threadId);
    expect((eventsOfKind('status')[0] as { director_available: boolean }).director_available).toBe(false);

    const before = plum.threadId;
    plum.onModMessage({ kind: 'control', action: 'new_thread' });
    expect(plum.threadId).not.toBe(before);
    expect(plum.rows).toEqual([]);

    sendModNotification.mockClear();
    plum.onModMessage({ kind: 'control', action: 'start_director' });
    expect(String(eventsOfKind('error')[0].text)).toContain('Director mode');
  });

  it('a different catalogue after a conversation started begins a new thread', async () => {
    client.queue.push(message([text('Hi.')], 'end_turn'));
    await plum.runTurn('hello');
    const before = plum.threadId;
    plum.onModMessage({ kind: 'catalogue', tier: 'core', enabled: true, tools: [lookAtLot, giveMoney, sendHome] });
    expect(plum.threadId).toBe(before);
    plum.onModMessage({ kind: 'catalogue', tier: 'core', enabled: true, tools: [lookAtLot] });
    expect(plum.threadId).not.toBe(before);
  });

  it('a chat thread past THREAD_ROLL_TOKENS rolls: one low-effort summary, a seeded fresh thread, rows kept', async () => {
    client.queue.push(message([text('One.')], 'end_turn'));
    await plum.runTurn('first');
    client.queue.push(message([text('Two.')], 'end_turn'));
    await plum.runTurn('second');
    const before = plum.threadId;
    client.requests = [];
    // The whole context counts: input + cache read + cache write
    client.queue.push(
      message([text('Three.')], 'end_turn', {
        input_tokens: 400,
        cache_read_input_tokens: THREAD_ROLL_TOKENS - 500,
        cache_creation_input_tokens: 200,
      }),
    );
    client.queue.push(message([text('We talked three times; nothing changed.')], 'end_turn'));
    await plum.runTurn('third');

    expect(client.requests).toHaveLength(2);
    const [turn, summary] = client.requests;
    expect(turn.effort).toBe('medium');
    expect(summary.effort).toBe('low');
    expect(summary.maxTokens).toBe(600);
    expect(summary.messages).toHaveLength(7);
    expect(plum.threadId).not.toBe(before);
    // The player did not ask for a new conversation, so the tab keeps every row
    expect(plum.rows.map((row) => row.kind)).toEqual(['player', 'plum', 'player', 'plum', 'player', 'plum']);
    expect(plum.messages).toEqual([]);

    client.requests = [];
    client.queue.push(message([text('Fresh.')], 'end_turn'));
    await plum.runTurn('fourth');
    expect(client.requests[0].messages).toHaveLength(1);
    const blocks = client.requests[0].messages[0].content as Anthropic.Beta.Messages.BetaTextBlockParam[];
    expect(blocks[0].text.startsWith('<live>')).toBe(true);
    expect(blocks[1].text).toContain('<earlier_conversation>');
    expect(blocks[1].text).toContain('[plum] Three.');
    expect(blocks[2].text).toBe('fourth');
  });

  it('a director turn is DETACHED: one user message on the director model, the chat thread untouched, no roll, rows kept', async () => {
    ctx.settings.set(SettingsEnum.PLUM_DIRECTOR_MODEL, 'claude-haiku-5-5');
    client.queue.push(message([text('One.')], 'end_turn'));
    await plum.runTurn('first');
    client.queue.push(message([text('Two.')], 'end_turn'));
    await plum.runTurn('second');
    expect(client.requests.every((request) => request.model === 'claude-opus-5-5')).toBe(true);
    const chatMessages = [...plum.messages];
    expect(chatMessages).toHaveLength(4);
    const before = plum.threadId;
    client.requests = [];
    // A tool round and a huge context: a detached turn still never rolls or summarizes
    client.queue.push(
      message([text('Looking.'), toolUse('tu_1', 'look_at_lot', {})], 'tool_use', {
        input_tokens: THREAD_ROLL_TOKENS * 3,
      }),
    );
    client.queue.push(message([text('Beat.')], 'end_turn', { input_tokens: THREAD_ROLL_TOKENS * 3 }));
    const turn = plum.runTurn('<director_tick/>', { director: true });
    await flush();
    const [call] = toolCalls();
    plum.onModMessage({ kind: 'tool_result', request_id: call.request_id as string, ok: true, result: { sims: [] } });
    await turn;

    expect(client.requests).toHaveLength(2);
    const [first, second] = client.requests;
    expect(first.model).toBe('claude-haiku-5-5');
    expect(second.model).toBe('claude-haiku-5-5');
    // The first request is ONE user message: <live>, then the tick text (no seed, no note yet)
    expect(first.messages).toHaveLength(1);
    const blocks = first.messages[0].content as Anthropic.Beta.Messages.BetaTextBlockParam[];
    expect(blocks.map((block) => block.text.split('\n')[0])).toEqual(['<live>', '<director_tick/>']);
    // The tool round grew the LOCAL array, never the thread
    expect(second.messages).toHaveLength(3);
    expect(plum.messages).toEqual(chatMessages);
    expect(plum.threadId).toBe(before);
    // The rows still land for the tab
    expect(plum.rows.map((row) => row.kind)).toEqual([
      'player',
      'plum',
      'player',
      'plum',
      'director',
      'tool',
      'director',
    ]);

    // The chat thread's size was not touched by the detached turn: a small chat turn does not roll
    client.requests = [];
    client.queue.push(message([text('Still here.')], 'end_turn'));
    await plum.runTurn('hello again');
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0].model).toBe('claude-opus-5-5');
    expect(client.requests[0].messages).toHaveLength(5);
    expect(plum.threadId).toBe(before);
  });

  it('the chat roll while directing still asks the note to name the armed triggers and why', () => {
    const trigger = plum.wake.set({ kind: 'game_time', at: '07:00', note: 'the morning beat' });
    const prompt = plum.summaryPrompt();
    expect(prompt).toContain(trigger.id);
    expect(prompt).toContain('WHY you set it');
  });

  it('a script wake is a detached turn on the director model; a plain wake is a chat turn', async () => {
    ctx.settings.set(SettingsEnum.PLUM_DIRECTOR_MODEL, 'claude-haiku-5-5');
    client.queue.push(message([text('Wake.')], 'end_turn'));
    await plum.runTurn('<wake/>', { wake: true });
    expect(plum.messages).toHaveLength(2);
    client.queue.push(message([text('Script wake.')], 'end_turn'));
    await plum.runTurn('<wake/>', { wake: true, script: true });
    expect(client.requests.map((request) => request.model)).toEqual(['claude-opus-5-5', 'claude-haiku-5-5']);
    expect(client.requests[1].messages).toHaveLength(1);
    expect(plum.messages).toHaveLength(2);
  });

  it("director_note is the director's memory: into the next detached turn, and into a chat turn's <live> while directing", async () => {
    // The real app tools, resolving the service lazily like production does
    const noted: PlumService = new PlumService(ctx, {
      clientFactory: () => client,
      now: () => now,
      appTools: buildAppTools(
        ctx,
        () => noted.wake,
        () => noted.whisper,
        () => noted,
      ),
    });
    noted.onModMessage({ kind: 'catalogue', tier: 'core', enabled: true, tools: [lookAtLot] });
    ctx.ext.director = { start() {}, stop() {}, status: () => ({ active: true }), wake: () => true };

    client.queue.push(
      message(
        [toolUse('tu_1', 'director_note', { note: 'ARC Dinner: Bella cooks for Don.\nBeat 1 landed.' })],
        'tool_use',
      ),
    );
    client.queue.push(message([text('Cued.')], 'end_turn'));
    await noted.runTurn('<director_tick n="1"/>', { director: true });
    expect(noted.directorNoteText).toBe('ARC Dinner: Bella cooks for Don.\nBeat 1 landed.');
    const noteRow = noted.rows.find((row) => row.kind === 'tool');
    expect(noteRow?.summary).toBe('director note updated (47 chars)');

    // The next detached turn opens with <live>, the note, the tick text
    client.requests = [];
    client.queue.push(message([text('Watching.')], 'end_turn'));
    await noted.runTurn('<director_tick n="2"/>', { director: true });
    const blocks = client.requests[0].messages[0].content as Anthropic.Beta.Messages.BetaTextBlockParam[];
    expect(blocks).toHaveLength(3);
    expect(blocks[0].text.startsWith('<live>')).toBe(true);
    expect(blocks[0].text).not.toContain("director's note");
    expect(blocks[1].text).toBe('<director_note>\nARC Dinner: Bella cooks for Don.\nBeat 1 landed.\n</director_note>');
    expect(blocks[2].text).toBe('<director_tick n="2"/>');

    // A chat turn sees it inside <live> while the director runs, and not once the show is off
    client.requests = [];
    client.queue.push(message([text('Yes, Bella is cooking.')], 'end_turn'));
    await noted.runTurn('what is going on?');
    const chat = client.requests[0].messages[0].content as Anthropic.Beta.Messages.BetaTextBlockParam[];
    expect(chat[0].text).toContain(
      "director's note (the show running in the other tab):\n  ARC Dinner: Bella cooks for Don.\n  Beat 1 landed.",
    );
    expect(chat.some((block) => block.text.startsWith('<director_note>'))).toBe(false);
    ctx.ext.director = { start() {}, stop() {}, status: () => ({ active: false }), wake: () => false };
    expect(noted.liveContextBlock()).not.toContain("director's note");

    // An empty note clears it
    client.queue.push(message([toolUse('tu_2', 'director_note', { note: '' })], 'tool_use'));
    client.queue.push(message([text('Done.')], 'end_turn'));
    await noted.runTurn('<director_tick n="3"/>', { director: true });
    expect(noted.directorNoteText).toBeUndefined();
    expect(noted.rows[noted.rows.length - 2].summary).toBe('director note cleared');
  });

  it('costThisHour prices every call of the last hour by its model', async () => {
    client.queue.push(
      message([text('One.')], 'end_turn', {
        input_tokens: 1000,
        cache_read_input_tokens: 100_000,
        cache_creation_input_tokens: 10_000,
        output_tokens: 1000,
      }),
    );
    await plum.runTurn('first');
    // Opus 5.5: 1k x $4 + 100k x $0.20 + 10k x $5 + 1k x $20 per MTok
    expect(plum.costThisHour()).toBeCloseTo(0.004 + 0.02 + 0.05 + 0.02, 6);
    now += 61 * 60_000;
    expect(plum.costThisHour()).toBe(0);
  });

  it('gives up after MAX_ITERATIONS tool rounds in one turn', async () => {
    for (let i = 0; i < MAX_ITERATIONS; i += 1) {
      client.queue.push(message([toolUse(`tu_${i}`, 'look_at_lot', {})], 'tool_use'));
    }
    const turn = plum.runTurn('loop');
    for (let i = 0; i < MAX_ITERATIONS; i += 1) {
      await flush();
      const call = toolCalls()[i];
      plum.onModMessage({ kind: 'tool_result', request_id: call.request_id as string, ok: true, result: {} });
    }
    await turn;
    expect(client.requests).toHaveLength(MAX_ITERATIONS);
    expect(String(eventsOfKind('error')[0].text)).toContain(`${MAX_ITERATIONS}`);
  });

  it('a mod disconnect answers every pending call with an error', async () => {
    client.queue.push(message([toolUse('tu_1', 'look_at_lot', {})], 'tool_use'));
    client.queue.push(message([text('Lost it.')], 'end_turn'));
    const turn = plum.runTurn('look');
    await flush();
    plum.onModDisconnected();
    await turn;
    const results = client.requests[1].messages[2].content as Anthropic.Beta.Messages.BetaToolResultBlockParam[];
    expect(results[0].is_error).toBe(true);
    expect(results[0].content as string).toContain('disconnected');
  });

  it('runScheduledTool runs a push outside any turn, registers it, and refuses a destructive tool', async () => {
    const pushAction: PlumModToolDef = {
      ...giveMoney,
      name: 'push_action',
      input_schema: {
        type: 'object',
        properties: { sim: { type: 'string' }, action: { type: 'string' }, target: { type: ['string', 'null'] } },
        required: ['sim', 'action', 'target'],
        additionalProperties: false,
      },
    };
    plum.onModMessage({ kind: 'catalogue', tier: 'core', enabled: true, tools: [pushAction, sendHome] });
    sendModNotification.mockClear();
    const registered: { requestId: string; simId: string; action: string }[] = [];
    ctx.ext.plumPush = (requestId, push) => registered.push({ requestId, simId: push.sim_id, action: push.action });

    const pending = plum.runScheduledTool('push_action', { sim: '1', action: 'gossip', target: null }, 'trigger w1');
    await flush();
    const [call] = toolCalls();
    expect(call.name).toBe('push_action');
    expect(call.args).toEqual({ sim: '1', action: 'gossip', target: null });
    expect(plum.isRunning).toBe(false);
    plum.onModMessage({
      kind: 'tool_result',
      request_id: call.request_id as string,
      ok: true,
      result: { changed: 'pushed gossip on Bella', request_id: 'plum-1' },
    });
    const outcome = await pending;
    expect(outcome.ok).toBe(true);
    expect(outcome.summary).toBe('trigger w1: pushed gossip on Bella');
    expect(registered).toEqual([{ requestId: 'plum-1', simId: '1', action: 'gossip' }]);
    expect(plum.rows.map((row) => row.kind)).toEqual(['tool']);
    expect(plum.rows[0].summary).toBe('trigger w1: pushed gossip on Bella');
    // A trigger's row stays out of the tab
    expect(plum.rows[0].hidden).toBe(true);
    expect(eventsOfKind('tool_call_finished')).toEqual([]);
    expect(client.requests).toEqual([]);

    const refused = await plum.runScheduledTool('send_sim_home', { sim: '1', confirmed_by_player: true }, 'trigger w2');
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('destructive');
    expect(toolCalls()).toHaveLength(1);
    expect(plum.rows).toHaveLength(1);

    // Writes off: the scheduled push is refused like any other write
    ctx.settings.set(SettingsEnum.PLUM_ALLOW_WRITES, false);
    const held = await plum.runScheduledTool('push_action', { sim: '1', action: 'chat', target: null }, 'trigger w3');
    expect(held.ok).toBe(false);
    expect(held.error).toContain('Plum may change things');
    expect(toolCalls()).toHaveLength(1);
  });

  it('the live block carries the clock, lot and funds from the state cache', () => {
    ctx.simStateCache.ingest({
      type: 'state_report',
      seq: 1,
      sims: [],
      lot: {
        lot_name: 'Goth Manor',
        venue: 'Residential',
        funds: 12340,
        clock: { hour: 9, minute: 5, absolute_day: 12 },
      },
    });
    clockState.current = { paused: true };
    expect(plum.liveContextBlock()).toBe(
      '<live>\nclock: 9:05 day 12 (paused)\nlot: Goth Manor (Residential)\nfunds: §12,340\n</live>',
    );
  });

  it('the live block carries the Sims: the household one line each, needs below the band only, three wants, the rest as a count', () => {
    ctx.simStateCache.ingest({
      type: 'state_report',
      seq: 1,
      active_sim_id: '1',
      sims: [
        {
          sim_id: '1',
          sim_name: 'Corinne Stiles',
          sims: [],
          objects: [],
          self: {
            mood: 'tense',
            needs: { hunger: -40, fun: -10, energy: 20, bladder: -30 },
            wants: ['play_chess', 'tell_joke', 'cook', 'dance'],
          },
          activity: { running: 'counter_MakeFood_Staging_Basic', running_action_key: 'cook_meal' },
        },
        {
          sim_id: '2',
          sim_name: 'Duane Miles',
          sims: [],
          objects: [],
          self: { asleep: true, mood: 'fine' },
          activity: { running: 'bed_sleep' },
        },
        { sim_id: '3', sim_name: 'Seth Hairston', sims: [], objects: [], activity: { running: null } },
        {
          sim_id: '4',
          sim_name: 'Nancy Landgraab',
          sims: [],
          objects: [],
          is_household: false,
          activity: { running: 'sim_Chat' },
        },
      ],
      lot: { clock: { hour: 23, minute: 10 } },
    });
    expect(plum.liveContextBlock()).toBe(
      [
        '<live>',
        'clock: 23:10',
        'sims:',
        '- Corinne Stiles (sim 1, ACTIVE): awake, cook meal (counter_MakeFood_Staging_Basic), tense; ' +
          'low: hunger -40, bladder -30; wants: play chess, tell joke, cook',
        '- Duane Miles (sim 2): asleep (bed_sleep), fine',
        '- Seth Hairston (sim 3): awake, idle',
        'others on the lot: 1 (Nancy Landgraab)',
        '</live>',
      ].join('\n'),
    );
  });

  it('a reply whose only tools are fire-and-forget ends the turn; a chat turn carries their results at the head of its next message', async () => {
    plum.onModMessage({ kind: 'catalogue', tier: 'core', enabled: true, tools: [lookAtLot, notify] });
    sendModNotification.mockClear();
    client.queue.push(
      message([text('Will do; I will tell you when.'), toolUse('tu_1', 'notify', { text: 'hi' })], 'tool_use'),
    );
    const turn = plum.runTurn('tell me when dinner is ready');
    await flush();
    const [call] = toolCalls();
    expect(call.name).toBe('notify');
    plum.onModMessage({
      kind: 'tool_result',
      request_id: call.request_id as string,
      ok: true,
      result: { changed: 'notified' },
    });
    await turn;
    // No second model call to say "done"; the row still landed
    expect(client.requests).toHaveLength(1);
    expect(plum.rows.map((row) => row.kind)).toEqual(['player', 'plum', 'tool']);
    expect(plum.rows[2]).toMatchObject({ done: true, ok: true });
    // The thread ends on the assistant's tool_use: the result is owed to the next request
    expect(plum.messages).toHaveLength(2);
    client.queue.push(message([text('Soon.')], 'end_turn'));
    await plum.runTurn('how long?');
    const { messages } = client.requests[1];
    expect(messages).toHaveLength(3);
    const content = messages[2].content as Anthropic.Beta.Messages.BetaContentBlockParam[];
    expect(content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_1' });
    expect((content[1] as { text: string }).text.startsWith('<live>')).toBe(true);
    expect((content[2] as { text: string }).text).toBe('how long?');
    // Carried once: the turn after owes nothing
    client.queue.push(message([text('Done.')], 'end_turn'));
    await plum.runTurn('thanks');
    const last = client.requests[2].messages[4].content as Anthropic.Beta.Messages.BetaContentBlockParam[];
    expect(last[0].type).toBe('text');
  });

  it('a detached turn ending on fire-and-forget tools drops the results; calls with no words beside them keep the loop going', async () => {
    plum.onModMessage({ kind: 'catalogue', tier: 'core', enabled: true, tools: [lookAtLot, notify] });
    sendModNotification.mockClear();
    client.queue.push(message([text('Cued.'), toolUse('tu_1', 'notify', { text: 'x' })], 'tool_use'));
    let turn = plum.runTurn('<director_tick/>', { director: true });
    await flush();
    let [call] = toolCalls();
    plum.onModMessage({ kind: 'tool_result', request_id: call.request_id as string, ok: true, result: {} });
    await turn;
    expect(client.requests).toHaveLength(1);
    expect(plum.messages).toHaveLength(0);
    sendModNotification.mockClear();
    // A tool_use with no text is not the end of a turn: the model is called again, and the
    // next detached request is one user message with no tool_result in it
    client.queue.push(message([toolUse('tu_2', 'notify', { text: 'y' })], 'tool_use'));
    client.queue.push(message([text('Now a word.')], 'end_turn'));
    turn = plum.runTurn('<director_tick/>', { director: true });
    await flush();
    [call] = toolCalls();
    plum.onModMessage({ kind: 'tool_result', request_id: call.request_id as string, ok: true, result: {} });
    await turn;
    expect(client.requests).toHaveLength(3);
    expect(client.requests[1].messages).toHaveLength(1);
    const opening = client.requests[1].messages[0].content as Anthropic.Beta.Messages.BetaContentBlockParam[];
    expect(opening.every((block) => block.type === 'text')).toBe(true);
    expect(client.requests[2].messages).toHaveLength(3);
  });

  it('a roll after a fire-and-forget turn hands the summary call the results the thread still owes', async () => {
    plum.onModMessage({ kind: 'catalogue', tier: 'core', enabled: true, tools: [lookAtLot, notify] });
    sendModNotification.mockClear();
    client.queue.push(message([text('One.')], 'end_turn'));
    await plum.runTurn('first');
    client.queue.push(
      message([text('Noted.'), toolUse('tu_1', 'notify', { text: 'x' })], 'tool_use', {
        input_tokens: THREAD_ROLL_TOKENS + 1,
      }),
    );
    client.queue.push(message([text('A note to my future self.')], 'end_turn'));
    const turn = plum.runTurn('remember this');
    await flush();
    const [call] = toolCalls();
    plum.onModMessage({ kind: 'tool_result', request_id: call.request_id as string, ok: true, result: {} });
    await turn;
    expect(client.requests).toHaveLength(3);
    const summary = client.requests[2];
    expect(summary.effort).toBe('low');
    const last = summary.messages[summary.messages.length - 1]
      .content as Anthropic.Beta.Messages.BetaContentBlockParam[];
    expect(last[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_1' });
    expect((last[1] as { text: string }).text).toContain('new conversation');
    // The fresh thread owes nothing
    client.queue.push(message([text('Hi again.')], 'end_turn'));
    await plum.runTurn('hello');
    const fresh = client.requests[3].messages[0].content as Anthropic.Beta.Messages.BetaContentBlockParam[];
    expect(fresh[0].type).toBe('text');
  });

  it('a push that took points the camera at its actor with no row; a refused push or the setting off moves nothing', async () => {
    ctx.settings.set(SettingsEnum.PLUM_CAMERA_FOLLOWS, true);
    plum.onModMessage({ kind: 'catalogue', tier: 'core', enabled: true, tools: [pushActionTool, cameraFocus] });
    sendModNotification.mockClear();
    const pending = plum.runScheduledTool('push_action', { sim: '1', action: 'gossip', target: null }, 'trigger w1');
    await flush();
    const [push] = toolCalls();
    plum.onModMessage({
      kind: 'tool_result',
      request_id: push.request_id as string,
      ok: true,
      result: { changed: 'pushed' },
    });
    await pending;
    await flush();
    const calls = toolCalls();
    expect(calls.map((call) => call.name)).toEqual(['push_action', 'camera_focus']);
    expect(calls[1].args).toEqual({ sim: '1' });
    expect(calls[1].timeout_ms).toBe(CAMERA_FOCUS_TIMEOUT_MS);
    expect(plum.rows).toHaveLength(1);
    // A focus the game refuses is a log line, nothing more
    plum.onModMessage({
      kind: 'tool_result',
      request_id: calls[1].request_id as string,
      ok: false,
      error: 'no such sim',
    });
    await flush();
    expect(plum.rows).toHaveLength(1);
    expect(eventsOfKind('error')).toEqual([]);

    sendModNotification.mockClear();
    const refused = plum.runScheduledTool('push_action', { sim: '1', action: 'gossip', target: null }, 'trigger w2');
    await flush();
    plum.onModMessage({
      kind: 'tool_result',
      request_id: toolCalls()[0].request_id as string,
      ok: false,
      error: 'busy',
    });
    await refused;
    await flush();
    expect(toolCalls().map((call) => call.name)).toEqual(['push_action']);

    ctx.settings.set(SettingsEnum.PLUM_CAMERA_FOLLOWS, false);
    sendModNotification.mockClear();
    const quiet = plum.runScheduledTool('push_action', { sim: '1', action: 'gossip', target: null }, 'trigger w3');
    await flush();
    plum.onModMessage({ kind: 'tool_result', request_id: toolCalls()[0].request_id as string, ok: true, result: {} });
    await quiet;
    await flush();
    expect(toolCalls().map((call) => call.name)).toEqual(['push_action']);
  });

  it('a night turn is detached, quiet and self-contained: plumModel, one text block, no player row, hidden rows', async () => {
    ctx.settings.set(SettingsEnum.PLUM_DIRECTOR_MODEL, 'claude-haiku-5-5');
    const journal = vi.spyOn(plum.wake, 'takeJournal');
    client.queue.push(message([text('Corinne gets a story beat.')], 'end_turn'));
    await plum.runTurn('<night_call sim="Corinne Stiles">...</night_call>', { night: true });

    expect(client.requests).toHaveLength(1);
    const [request] = client.requests;
    expect(request.model).toBe('claude-opus-5-5');
    expect(request.messages).toHaveLength(1);
    const blocks = request.messages[0].content as Anthropic.Beta.Messages.BetaTextBlockParam[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text.startsWith('<night_call')).toBe(true);
    // No <live> block was built, so the director's trigger journal was not drained
    expect(journal).not.toHaveBeenCalled();
    expect(plum.messages).toEqual([]);
    expect(plum.rows).toEqual([expect.objectContaining({ kind: 'director', hidden: true })]);
    expect(eventsOfKind('assistant')).toEqual([]);
    expect(eventsOfKind('status').filter((event) => event.state === 'thinking')).toEqual([]);
  });

  it('edit_intentions is offered once the autonomy slot exists, reaches it, and ends the night turn', async () => {
    const applyEdits = vi.fn(() => ({ changed: "Corinne's list: dropped 0, rewrote 0, added 1 story row" }));
    ctx.ext.intentions = { applyEdits };
    const withAppTools = new PlumService(ctx, { clientFactory: () => client, now: () => now });
    withAppTools.onModMessage({ kind: 'catalogue', tier: 'stream', enabled: true, tools: [lookAtLot] });
    client.queue.push(
      message(
        [
          text('Corinne means to finish her chapter today.'),
          toolUse('tu_1', 'edit_intentions', {
            sim_id: '100',
            drop: [],
            rewrite: [],
            add: [
              {
                why: 'I want to finish my chapter',
                say: 'Words first, coffee second.',
                target: null,
                from_hour: null,
                to_hour: null,
              },
            ],
          }),
        ],
        'tool_use',
      ),
    );
    await withAppTools.runTurn('<night_call/>', { night: true });

    expect(client.requests[0].tools.map((tool) => tool.name)).toContain('edit_intentions');
    // Object arrays keep it non-strict (the grammar cap)
    expect(client.requests[0].tools.find((tool) => tool.name === 'edit_intentions')?.strict).toBeUndefined();
    expect(applyEdits).toHaveBeenCalledWith('100', {
      drop: [],
      rewrite: [],
      add: [{ why: 'I want to finish my chapter', say: 'Words first, coffee second.' }],
    });
    // Fire and forget: no second model call
    expect(client.requests).toHaveLength(1);
    expect(withAppTools.rows.map((row) => [row.kind, row.hidden])).toEqual([
      ['director', true],
      ['tool', true],
    ]);
    delete ctx.ext.intentions;
  });

  describe('on an external brain (plumBrain = claude-code)', () => {
    let down: string | undefined;
    let ports: { kind: string; live: string; text: string }[];

    beforeEach(() => {
      down = undefined;
      ports = [];
      ctx.settings.set(SettingsEnum.PLUM_API_KEY, '');
      ctx.settings.set(SettingsEnum.PLUM_BRAIN, 'claude-code');
      ctx.ext.plumBrain = {
        unavailable: () => down,
        runTurn: async (port) => {
          ports.push({ kind: port.kind, live: port.live, text: port.text });
          await port.runTool('look_at_lot', {});
          port.say('All quiet.');
          return {};
        },
      };
    });

    it('needs no API key, runs tools through the guarded runner and says rows', async () => {
      const turn = plum.runTurn('how is it going?');
      await flush();
      const [call] = toolCalls();
      expect(call.name).toBe('look_at_lot');
      plum.onModMessage({ kind: 'tool_result', request_id: call.request_id as string, ok: true, result: {} });
      expect(await turn).toEqual({});
      expect(client.requests).toHaveLength(0);
      expect(ports[0].kind).toBe('chat');
      expect(ports[0].live.startsWith('<live>')).toBe(true);
      expect(ports[0].text).toBe('how is it going?');
      expect(plum.rows.map((row) => row.kind)).toEqual(['player', 'tool', 'plum']);
      expect(eventsOfKind('error')).toEqual([]);
      const status = eventsOfKind('status').pop();
      expect(status?.text).toContain('via Claude Code');
    });

    it('a night turn reaches the brain as kind night, detached, with no live block', async () => {
      const seen: { kind: string; detached: boolean; live: string }[] = [];
      ctx.ext.plumBrain = {
        unavailable: () => undefined,
        runTurn: (port) => {
          seen.push({ kind: port.kind, detached: port.detached, live: port.live });
          port.say('Corinne: one story beat.');
          return Promise.resolve({});
        },
      };
      await plum.runTurn('<night_call/>', { night: true });
      expect(seen).toEqual([{ kind: 'night', detached: true, live: '' }]);
      expect(plum.rows).toEqual([expect.objectContaining({ kind: 'director', hidden: true })]);
    });

    it('while the brain is down a turn answers 503 before it builds the live block', async () => {
      down = 'Claude Code session is not running';
      const live = vi.spyOn(plum, 'liveContextBlock');
      const result = await plum.runTurn('hello?');
      expect(result.error?.status).toBe(503);
      expect(live).not.toHaveBeenCalled();
      expect(ports).toEqual([]);
      expect(plum.brainUnavailable()).toBe(down);
      expect(eventsOfKind('error').map((event) => event.text)).toEqual([down]);
    });

    it('a long thread does not roll (the session keeps its own context)', async () => {
      (plum as unknown as { thread: { contextTokens: number } }).thread.contextTokens = THREAD_ROLL_TOKENS * 2;
      const roll = vi.spyOn(plum, 'startNewThread');
      const turn = plum.runTurn('still there?');
      await flush();
      const [call] = toolCalls();
      plum.onModMessage({ kind: 'tool_result', request_id: call.request_id as string, ok: true, result: {} });
      await turn;
      expect(roll).not.toHaveBeenCalled();
    });

    it('a loose tool (typed in the terminal) is never destructive', async () => {
      const outcome = await plum.looseTool('send_sim_home', { sim: 'Bella', confirmed_by_player: true });
      expect(outcome.ok).toBe(false);
      expect(toolCalls()).toEqual([]);
    });

    it('with the setting on API the slot is ignored', async () => {
      ctx.settings.set(SettingsEnum.PLUM_BRAIN, 'api');
      ctx.settings.set(SettingsEnum.PLUM_API_KEY, 'sk-test');
      client.queue.push(message([text('API here.')], 'end_turn'));
      await plum.runTurn('hi');
      expect(ports).toEqual([]);
      expect(client.requests).toHaveLength(1);
    });
  });
});

describe('Plum tool catalogue', () => {
  it('merges mod and app tools sorted by name, strict, with the mod winning a clash', () => {
    const appTool = {
      definition: { ...lookAtLot, name: 'recent_memories', description: 'Memories.' },
      run: () => Promise.resolve([]),
    };
    const clash = { definition: { ...lookAtLot, description: 'app copy' }, run: () => Promise.resolve([]) };
    const merged = mergeCatalogue([sendHome, lookAtLot], [appTool, clash]);
    expect(merged.map((entry) => entry.definition.name)).toEqual(['look_at_lot', 'recent_memories', 'send_sim_home']);
    expect(merged[0].app).toBeUndefined();
    expect(merged[1].app).toBe(appTool);
    const api = toApiTools(merged);
    expect(api.every((tool) => tool.strict && tool.input_schema.additionalProperties === false)).toBe(true);
    // Past the API's cap only the tools that move the game stay strict, destructive first
    const many = mergeCatalogue(
      Array.from({ length: 24 }, (_, i) => ({ ...lookAtLot, name: `read_${String(i).padStart(2, '0')}` })).concat([
        giveMoney,
        sendHome,
      ]),
      [],
    );
    const strictOnes = toApiTools(many)
      .filter((tool) => tool.strict)
      .map((tool) => tool.name);
    expect(strictOnes).toHaveLength(MAX_STRICT_TOOLS);
    expect(strictOnes).toContain('send_sim_home');
    expect(strictOnes).toContain('give_money');
    expect(strictOnes).not.toContain('read_23');
    expect(catalogueFingerprint(merged)).toBe(catalogueFingerprint(mergeCatalogue([lookAtLot, sendHome], [appTool])));
  });

  it('keeps the union-typed parameters of the strict tools within the API budget, nested ones counted', () => {
    // Live 2026-10-17: 18 nullable parameters across the strict tools and the API refused every turn
    const nested = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        beats: {
          type: 'array',
          items: {
            type: 'object',
            properties: { sim: { type: 'string' }, target: { type: ['string', 'null'] } },
            required: ['sim', 'target'],
            additionalProperties: false,
          },
        },
        note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
      required: ['name', 'beats', 'note'],
      additionalProperties: false,
    };
    expect(countUnions(nested)).toBe(2);
    expect(countUnions(giveMoney.input_schema)).toBe(1);
    // Five write tools with four nullable parameters each: only the first four fit the budget,
    // and a read tool with none still gets in behind them
    const writes = Array.from({ length: 5 }, (_, i) => ({
      ...giveMoney,
      name: `write_${i}`,
      input_schema: {
        type: 'object',
        properties: Object.fromEntries(['a', 'b', 'c', 'd'].map((key) => [key, { type: ['string', 'null'] }])),
        required: ['a', 'b', 'c', 'd'],
        additionalProperties: false,
      },
    }));
    const strictOnes = toApiTools(mergeCatalogue([...writes, lookAtLot], []))
      .filter((tool) => tool.strict)
      .map((tool) => tool.name)
      .sort();
    expect(strictOnes).toEqual(['look_at_lot', 'write_0', 'write_1', 'write_2', 'write_3']);
    expect(MAX_STRICT_UNIONS).toBe(16);
    // A tool with an array of objects (plan_arc, plan_script, script) is never strict: the
    // compiled grammar has a size cap of its own (measured live 2026-10-17)
    const heavy = {
      ...giveMoney,
      name: 'plan_things',
      input_schema: {
        type: 'object',
        properties: {
          beats: {
            type: 'array',
            items: { type: 'object', properties: { sim: { type: 'string' } }, required: ['sim'] },
          },
        },
        required: ['beats'],
        additionalProperties: false,
      },
    };
    const light = toApiTools(mergeCatalogue([heavy, lookAtLot], []))
      .filter((tool) => tool.strict)
      .map((tool) => tool.name);
    expect(light).toEqual(['look_at_lot']);
  });
});
