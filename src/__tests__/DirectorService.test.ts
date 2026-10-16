import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';

const sendModNotification = vi.hoisted(() => vi.fn());
const clockState = vi.hoisted(() => ({
  current: undefined as { paused: boolean; paused_by: string | null } | undefined,
}));

vi.mock('main/sentient-sims/websocketServer', () => ({
  sendModNotification,
  getModClockState: () => clockState.current,
  isWebSocketConnected: () => true,
}));

import { SettingsEnum } from 'main/sentient-sims/models/SettingsEnum';
import { ModWebsocketMessageType } from 'main/sentient-sims/models/ModWebsocketMessage';
import { PlumModToolDef } from 'main/sentient-sims/models/ModLogWebsocketMessage';
import { SimStateReport } from 'main/sentient-sims/models/SimStateReport';
import { ApiContext } from 'main/sentient-sims/services/ApiContext';
import { DirectorService, TICK_MS } from 'main/sentient-sims/services/DirectorService';
import { PlumService } from 'main/sentient-sims/services/PlumService';
import { PlumModelClient, PlumModelRequest } from 'main/sentient-sims/services/plum/PlumModelClient';
import { mockApiContext } from './util';

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;

class FakeModelClient implements PlumModelClient {
  requests: PlumModelRequest[] = [];

  queue: BetaMessage[] = [];

  create(request: PlumModelRequest): Promise<BetaMessage> {
    this.requests.push({ ...request, messages: request.messages.map((entry) => ({ ...entry })) });
    const next = this.queue.shift();
    if (!next) {
      return Promise.reject(new Error('FakeModelClient: no scripted reply left'));
    }
    return Promise.resolve(next);
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

const pushAction: PlumModToolDef = {
  name: 'push_action',
  description: 'Push.',
  input_schema: {
    type: 'object',
    properties: {
      sim: { type: 'string' },
      action: { type: 'string' },
      target: { type: ['string', 'null'] },
      preempt: { type: ['boolean', 'null'] },
    },
    required: ['sim', 'action', 'target', 'preempt'],
    additionalProperties: false,
  },
  risk: 'write',
  timeout_ms: 20000,
  tier: 'core',
};

function report(seq: number, extra: Partial<NonNullable<SimStateReport['lot']>> = {}): SimStateReport {
  return {
    type: 'state_report',
    seq,
    sims: [{ sim_id: '1', sim_name: 'Bella Goth', sims: [], objects: [] }],
    lot: { ...extra },
  };
}

function toolCalls(): Record<string, unknown>[] {
  return sendModNotification.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((notification) => notification.type === ModWebsocketMessageType.PLUM_TOOL_CALL);
}

function eventsOfKind(kind: string): Record<string, unknown>[] {
  return sendModNotification.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((event) => event.type === ModWebsocketMessageType.PLUM_EVENT && event.kind === kind);
}

async function flush() {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

describe('DirectorService', () => {
  let ctx: ApiContext;
  let client: FakeModelClient;
  let plum: PlumService;
  let director: DirectorService;
  let now: number;
  let registered: { requestId: string; action: string }[];

  beforeEach(() => {
    vi.useFakeTimers();
    sendModNotification.mockClear();
    clockState.current = { paused: false, paused_by: null };
    now = 1_000_000;
    ctx = mockApiContext({ tiers: [] });
    ctx.settings.set(SettingsEnum.PLUM_API_KEY, 'sk-test');
    ctx.settings.set(SettingsEnum.PLUM_DIRECTOR_MAX_TICKS_PER_HOUR, 3);
    client = new FakeModelClient();
    plum = new PlumService(ctx, { clientFactory: () => client, now: () => now, appTools: [] });
    plum.onModMessage({ kind: 'catalogue', tier: 'core', enabled: true, tools: [pushAction] });
    // The real one is the autonomy tier's; the service only needs the slot
    director = new DirectorService(ctx, { now: () => now, plum });
    ctx.ext.director = director;
    registered = [];
    ctx.ext.plumPush = (requestId, push) => registered.push({ requestId, action: push.action });
    ctx.simStateCache.ingest(report(1));
    sendModNotification.mockClear();
  });

  it('start runs a planning tick at high effort, reads the arc, and the push is one beat', async () => {
    client.queue.push(
      message(
        [
          text('ARC: The Cold Shoulder\n1. Bella insults Don'),
          toolUse('tu_1', 'push_action', { sim: 'Bella', action: 'insult', target: 'Don', preempt: null }),
        ],
        'tool_use',
      ),
    );
    client.queue.push(message([text('Beat one is cued.')], 'end_turn'));
    director.start('something tense');
    await flush();
    expect(client.requests[0].effort).toBe('high');
    const first = client.requests[0].messages[0].content as Anthropic.Beta.Messages.BetaTextBlockParam[];
    expect(first[first.length - 1].text).toContain('<director_tick n="1">');
    expect(first[first.length - 1].text).toContain('something tense');
    const [call] = toolCalls();
    expect(call.name).toBe('push_action');
    plum.onModMessage({
      kind: 'tool_result',
      request_id: call.request_id as string,
      ok: true,
      result: { changed: 'pushed insult', request_id: 'plum-abc' },
    });
    await flush();
    await flush();
    expect(registered).toEqual([{ requestId: 'plum-abc', action: 'insult' }]);
    expect(director.status()).toMatchObject({ active: true, arc: 'The Cold Shoulder', ticks: 1 });
    // Narration is director rows, not player or plum rows
    expect(eventsOfKind('director').map((event) => (event.row as { text: string }).text)).toEqual([
      'ARC: The Cold Shoulder\n1. Bella insults Don',
      'Beat one is cued.',
    ]);
    expect(eventsOfKind('player')).toEqual([]);
    expect(plum.rows.map((row) => row.kind)).toEqual(['director', 'tool', 'director']);
  });

  it('a second push in one tick is refused without a send', async () => {
    client.queue.push(
      message(
        [
          toolUse('tu_1', 'push_action', { sim: 'Bella', action: 'chat', target: 'Don', preempt: null }),
          toolUse('tu_2', 'push_action', { sim: 'Don', action: 'chat', target: 'Bella', preempt: null }),
        ],
        'tool_use',
      ),
    );
    client.queue.push(message([text('ARC: Two Chats')], 'end_turn'));
    director.start();
    await flush();
    expect(toolCalls()).toHaveLength(1);
    plum.onModMessage({ kind: 'tool_result', request_id: toolCalls()[0].request_id as string, ok: true, result: {} });
    await flush();
    await flush();
    const results = client.requests[1].messages[2].content as Anthropic.Beta.Messages.BetaToolResultBlockParam[];
    expect(results).toHaveLength(2);
    expect(results[1].is_error).toBe(true);
    expect(results[1].content as string).toContain('one beat per tick');
  });

  it('does not tick while the player paused, while the report is stale, or while nothing changed', async () => {
    client.queue.push(message([text('ARC: Quiet')], 'end_turn'));
    director.start();
    await flush();
    expect(client.requests).toHaveLength(1);

    // Unchanged digest: the minute passes, no call
    now += TICK_MS;
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(client.requests).toHaveLength(1);

    // A new report but the player's pause: still no call
    ctx.simStateCache.ingest(report(2));
    clockState.current = { paused: true, paused_by: 'user' };
    now += TICK_MS;
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(client.requests).toHaveLength(1);
    expect(director.status().suspended).toContain('paused');

    // Unpaused: the tick runs at medium effort
    clockState.current = { paused: false, paused_by: null };
    client.queue.push(message([text('Still quiet.')], 'end_turn'));
    now += TICK_MS;
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(client.requests).toHaveLength(2);
    expect(client.requests[1].effort).toBe('medium');
    expect(director.status().suspended).toBeUndefined();

    // A loading screen: the cache is reset and reads as stale, so no call
    ctx.simStateCache.reset();
    now += TICK_MS;
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(client.requests).toHaveLength(2);
    expect(director.status().suspended).toContain('stale');
  });

  it('a fire suspends the show and the hourly cap holds it', async () => {
    client.queue.push(message([text('ARC: Dinner')], 'end_turn'));
    director.start();
    await flush();
    ctx.simStateCache.ingest(report(2, { action_keys: ['call_firefighter'] }));
    now += TICK_MS;
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(client.requests).toHaveLength(1);
    expect(director.status().suspended).toContain('emergency');

    // Fire out: two more ticks are the cap of three in the hour; the fourth holds
    ctx.simStateCache.ingest(report(3));
    client.queue.push(message([text('Back on.')], 'end_turn'));
    now += TICK_MS;
    await vi.advanceTimersByTimeAsync(TICK_MS);
    ctx.simStateCache.ingest(report(4));
    client.queue.push(message([text('Third.')], 'end_turn'));
    now += TICK_MS;
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(client.requests).toHaveLength(3);
    ctx.simStateCache.ingest(report(5));
    now += TICK_MS;
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(client.requests).toHaveLength(3);
    expect(director.status().suspended).toContain('hourly cap');
  });

  it('stop clears the loop and the Plum controls route start and stop', async () => {
    client.queue.push(message([text('ARC: Short')], 'end_turn'));
    plum.onModMessage({ kind: 'control', action: 'start_director', brief: 'a quiet evening' });
    await flush();
    expect(director.status().active).toBe(true);
    expect(client.requests).toHaveLength(1);
    plum.onModMessage({ kind: 'control', action: 'stop_director' });
    expect(director.status().active).toBe(false);
    ctx.simStateCache.ingest(report(2));
    now += TICK_MS;
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(client.requests).toHaveLength(1);
    const status = eventsOfKind('status').pop() as { director_available: boolean; director_active: boolean };
    expect(status.director_available).toBe(true);
    expect(status.director_active).toBe(false);
  });
});
