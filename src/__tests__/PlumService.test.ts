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
import { MAX_ITERATIONS, PlumService } from 'main/sentient-sims/services/PlumService';
import { PlumModelClient, PlumModelRequest } from 'main/sentient-sims/services/plum/PlumModelClient';
import { catalogueFingerprint, mergeCatalogue, toApiTools } from 'main/sentient-sims/services/plum/PlumTools';
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

function message(content: Anthropic.Beta.Messages.BetaContentBlock[], stop: BetaMessage['stop_reason']): BetaMessage {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
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
    plum = new PlumService(ctx, { clientFactory: () => client, now: () => now });
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
    client.queue.push(message([], 'refusal'));
    await plum.runTurn('again');
    expect(toolCalls()).toEqual([]);
    expect(String(eventsOfKind('error')[0].text)).toContain('declined');
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
    expect(catalogueFingerprint(merged)).toBe(catalogueFingerprint(mergeCatalogue([lookAtLot, sendHome], [appTool])));
  });
});
