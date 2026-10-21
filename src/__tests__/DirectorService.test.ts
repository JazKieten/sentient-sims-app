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
import { buildAppTools } from 'main/sentient-sims/services/plum/PlumAppTools';
import { mockApiContext } from './util';

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;

class FakeModelClient implements PlumModelClient {
  requests: PlumModelRequest[] = [];

  queue: BetaMessage[] = [];

  // The next call rejects with this (an SDK error carries `status`)
  failWith: Error | undefined;

  create(request: PlumModelRequest): Promise<BetaMessage> {
    this.requests.push({ ...request, messages: request.messages.map((entry) => ({ ...entry })) });
    if (this.failWith !== undefined) {
      const failure = this.failWith;
      this.failWith = undefined;
      return Promise.reject(failure);
    }
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

// Each seq is a new activity too: the digest ignores seq, so a report that moves nothing a
// Sim does is "nothing changed"
function report(seq: number, extra: Partial<NonNullable<SimStateReport['lot']>> = {}): SimStateReport {
  return {
    type: 'state_report',
    seq,
    sims: [{ sim_id: '1', sim_name: 'Bella Goth', sims: [], objects: [], activity: { running: `act${seq}` } }],
    lot: { ...extra },
  };
}

function asleepReport(seq: number, asleep = true): SimStateReport {
  return {
    type: 'state_report',
    seq,
    sims: [
      { sim_id: '1', sim_name: 'Bella Goth', sims: [], objects: [], self: { asleep }, activity: { running: 'sleep' } },
      {
        sim_id: '2',
        sim_name: 'Mortimer Goth',
        sims: [],
        objects: [],
        self: { asleep: true },
        activity: { running: 'sleep' },
      },
    ],
    lot: { clock: { hour: 23, minute: 0 } },
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

  it('start runs a detached planning tick at medium effort, reads the arc, and the push is one beat', async () => {
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
    // One effort for every director request (roadmap C1): planning included
    expect(client.requests[0].effort).toBe('medium');
    const first = client.requests[0].messages[0].content as Anthropic.Beta.Messages.BetaTextBlockParam[];
    expect(first[first.length - 1].text).toContain('<director_tick n="1">');
    expect(first[first.length - 1].text).toContain('something tense');
    // One response a tick, the cast from <live> (roadmap C2), the note last
    expect(first[first.length - 1].text).toContain('ONE response');
    expect(first[first.length - 1].text).toContain('director_note last');
    expect(first[first.length - 1].text).toContain('The <live> block has the cast');
    expect(first[first.length - 1].text).not.toContain('Survey the lot');
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
    // Narration is hidden director rows in the thread; the tab hears nothing of the tick
    expect(plum.rows.map((row) => `${row.kind}:${row.hidden}`)).toEqual([
      'director:true',
      'tool:true',
      'director:true',
    ]);
    expect(plum.rows.map((row) => row.text)).toEqual([
      'ARC: The Cold Shoulder\n1. Bella insults Don',
      '',
      'Beat one is cued.',
    ]);
    for (const kind of ['director', 'assistant', 'player', 'tool_call_started', 'tool_call_finished']) {
      expect(eventsOfKind(kind)).toEqual([]);
    }
    expect(eventsOfKind('status').map((event) => event.state)).not.toContain('thinking');
    expect(eventsOfKind('player')).toEqual([]);
    expect(plum.rows.map((row) => row.kind)).toEqual(['director', 'tool', 'director']);
    // Detached: the tick's two requests grew a local array, and the chat thread holds nothing
    expect(client.requests[1].messages).toHaveLength(3);
    expect(plum.messages).toEqual([]);
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

  it('a fired wake-up runs a tick at once with the wake text, even with nothing changed', async () => {
    // Bella is cooking when the show starts
    const cooking: SimStateReport = {
      ...report(1),
      sims: [{ sim_id: '1', sim_name: 'Bella Goth', sims: [], objects: [], activity: { running: 'cook' } }],
    };
    ctx.simStateCache.ingest(cooking);
    client.queue.push(message([text('ARC: Waiting Game')], 'end_turn'));
    director.start();
    await flush();
    expect(client.requests).toHaveLength(1);
    // Plum asks to be woken when she finishes
    plum.wake.set({ kind: 'sim_finishes', simId: '1', simName: 'Bella Goth', note: 'see how dinner went' });
    // Same digest (same seq, memories, outcomes), still cooking: no tick
    now += TICK_MS;
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(client.requests).toHaveLength(1);
    // She stops: the wake fires and the tick runs with the wake inside the director block
    client.queue.push(message([text('Dinner is on the table.')], 'end_turn'));
    ctx.simStateCache.ingest({
      ...cooking,
      sims: [{ sim_id: '1', sim_name: 'Bella Goth', sims: [], objects: [], activity: { running: null } }],
    });
    await flush();
    expect(client.requests).toHaveLength(2);
    const last = client.requests[1].messages[client.requests[1].messages.length - 1]
      .content as Anthropic.Beta.Messages.BetaTextBlockParam[];
    const tickText = last[last.length - 1].text;
    expect(tickText).toContain('<director_tick n="2">');
    expect(tickText).toContain('<wake ');
    expect(tickText).toContain('Bella Goth finished "cook", now idle');
    expect(tickText).toContain('see how dinner went');
    expect(plum.wake.list()).toHaveLength(0);
    expect(eventsOfKind('player')).toEqual([]);
  });

  it('with a trigger armed the interval tick holds even when the digest moved; a wake still runs', async () => {
    client.queue.push(message([text('ARC: Chained')], 'end_turn'));
    director.start();
    await flush();
    expect(client.requests).toHaveLength(1);
    const first = client.requests[0].messages[0].content as Anthropic.Beta.Messages.BetaTextBlockParam[];
    expect(first[first.length - 1].text).toContain('plan_script ONCE');
    // Plum armed the next beat as a trigger
    plum.wake.set({
      kind: 'sim_finishes',
      simId: '1',
      simName: 'Bella Goth',
      doing: 'insult',
      note: 'adapt',
      then: { do: 'push_action', simId: '1', simName: 'Bella Goth', action: 'gossip' },
    });
    // The digest moves (a new report), the minute passes: no turn, the arc runs itself
    ctx.simStateCache.ingest(report(2));
    now += TICK_MS;
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(client.requests).toHaveLength(1);
    expect(director.status().active).toBe(true);
    // The status says the director is on and nothing of what it is doing
    plum.emitStatus('idle');
    const status = eventsOfKind('status').pop() as { text?: string; director_active: boolean };
    expect(status.director_active).toBe(true);
    expect(status.text).toBeUndefined();
    // The beat is cancelled: the trigger wakes the director, which runs at once
    client.queue.push(message([text('Bella walked away; re-planning.')], 'end_turn'));
    plum.onModMessage({
      kind: 'interaction_ended',
      interaction_id: '5',
      sim_id: '1',
      name: 'mixer_social_Insult',
      outcome: 'canceled',
    });
    await flush();
    expect(client.requests).toHaveLength(2);
    expect(toolCalls()).toHaveLength(0);
    const last = client.requests[1].messages[client.requests[1].messages.length - 1]
      .content as Anthropic.Beta.Messages.BetaTextBlockParam[];
    expect(last[last.length - 1].text).toContain('ended canceled, so the push it was to send');
    // Nothing armed any more and the digest moved: the stall fallback ticks again
    ctx.simStateCache.ingest(report(3));
    client.queue.push(message([text('Picking it back up.')], 'end_turn'));
    now += TICK_MS;
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(client.requests).toHaveLength(3);
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

  it("plan_arc is the planning turn's one push: it names the arc, arms the chain, and a push after it is held", async () => {
    // A PlumService with the app tools, so plan_arc is in the catalogue
    const chained: PlumService = new PlumService(ctx, {
      clientFactory: () => client,
      now: () => now,
      appTools: buildAppTools(ctx, () => chained.wake),
    });
    chained.onModMessage({ kind: 'catalogue', tier: 'core', enabled: true, tools: [pushAction] });
    const chainedDirector = new DirectorService(ctx, { now: () => now, plum: chained });
    ctx.ext.director = chainedDirector;
    ctx.simStateCache.ingest({
      type: 'state_report',
      seq: 2,
      sims: [
        { sim_id: '1', sim_name: 'Bella Goth', sims: [], objects: [] },
        { sim_id: '2', sim_name: 'Don Lothario', sims: [], objects: [] },
      ],
      lot: {},
    });
    sendModNotification.mockClear();
    client.queue.push(
      message(
        [
          text('Two beats, chained.'),
          toolUse('tu_1', 'plan_arc', {
            name: 'Chained',
            beats: [
              { sim: 'Bella', action: 'insult', target: 'Don' },
              { sim: 'Don', action: 'gossip', target: 'Bella' },
            ],
            recap_note: 'recap and plan the next arc',
            beat_note: null,
          }),
          toolUse('tu_2', 'push_action', { sim: 'Don', action: 'chat', target: 'Bella', preempt: null }),
        ],
        'tool_use',
      ),
    );
    client.queue.push(message([text('Armed.')], 'end_turn'));
    chainedDirector.start();
    await flush();
    expect(client.requests[0].tools.some((tool) => tool.name === 'plan_arc')).toBe(true);
    const first = client.requests[0].messages[0].content as Anthropic.Beta.Messages.BetaTextBlockParam[];
    expect(first[first.length - 1].text).toContain('call plan_script ONCE');
    // Beat 1 is the only call the game sees
    expect(toolCalls()).toHaveLength(1);
    const [call] = toolCalls();
    expect(call.name).toBe('push_action');
    expect(call.args).toEqual({ sim: '1', action: 'insult', target: '2', preempt: false });
    chained.onModMessage({
      kind: 'tool_result',
      request_id: call.request_id as string,
      ok: true,
      result: {
        changed: 'pushed insult on Bella Goth (with Don Lothario)',
        interaction_id: '7',
        interaction: 'mixer_social_Insult',
        request_id: 'plum-abc',
      },
    });
    await flush();
    await flush();
    await flush();
    expect(toolCalls()).toHaveLength(1);
    expect(registered).toEqual([{ requestId: 'plum-abc', action: 'insult' }]);
    expect(chainedDirector.status()).toMatchObject({ active: true, arc: 'Chained', ticks: 1 });
    const [w2, w3] = chained.wake.list();
    expect(chained.wake.list()).toHaveLength(2);
    expect(w2).toMatchObject({ doingId: '7', simId: '1' });
    expect(w2.then).toMatchObject({ simId: '2', action: 'gossip', targetId: '1' });
    expect(w3).toMatchObject({ after: w2.id });
    // The push_action after plan_arc in the same turn was held by the one-beat cap
    const results = client.requests[1].messages[2].content as Anthropic.Beta.Messages.BetaToolResultBlockParam[];
    expect(results).toHaveLength(2);
    expect(results[0].is_error).toBeUndefined();
    const planned = JSON.parse(results[0].content as string) as { changed: string; arc: string };
    expect(planned.arc).toBe('Chained');
    expect(planned.changed).toContain(
      'ARC "Chained": pushed beat 1 (pushed insult on Bella Goth (with Don Lothario)); armed',
    );
    expect(results[1].is_error).toBe(true);
    expect(results[1].content as string).toContain('one beat per tick');
    // The tab rows: narration, the plan_arc row, beat 1's own row, the held push, narration
    expect(chained.rows.map((row) => `${row.kind}${row.name ? `:${row.name}` : ''}`)).toEqual([
      'director',
      'tool:plan_arc',
      'tool:push_action',
      'tool:push_action',
      'director',
    ]);
    expect(chained.rows[2].summary).toBe('arc "Chained" beat 1: pushed insult on Bella Goth (with Don Lothario)');
    // The follow-up (wake) tick tells Plum where the truth about its triggers is
    expect(chainedDirector.tickText(false, '<wake/>')).toContain('The <live> block is the truth about your triggers');
    expect(chainedDirector.tickText(true)).not.toContain('The <live> block is the truth');
  });

  it('only triggers that can fire hold the tick: a chained `after` beat alone does not', async () => {
    client.queue.push(message([text('ARC: Chain')], 'end_turn'));
    director.start();
    await flush();
    expect(client.requests).toHaveLength(1);
    const parent = plum.wake.set({
      kind: 'sim_finishes',
      simId: '1',
      simName: 'Bella Goth',
      doing: 'insult',
      note: 'beat 2',
      then: { do: 'push_action', simId: '1', simName: 'Bella Goth', action: 'gossip' },
    });
    const child = plum.wake.set({ kind: 'sim_finishes', note: 'beat 3', after: parent.id });
    expect(plum.wake.list({ live: true }).map((trigger) => trigger.id)).toEqual([parent.id]);
    // Both armed: the interval holds even though the digest moved
    ctx.simStateCache.ingest(report(2));
    now += TICK_MS;
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(client.requests).toHaveLength(1);
    expect(child.after).toBe(parent.id);
    // Nothing live any more (the arc was cancelled): the next change runs a tick instead of
    // holding forever
    plum.wake.cancelAll();
    client.queue.push(message([text('Re-planning.')], 'end_turn'));
    ctx.simStateCache.ingest(report(3));
    now += TICK_MS;
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(client.requests).toHaveLength(2);
  });

  it('a sleeping cast arms one morning wake and holds until it fires', async () => {
    client.queue.push(message([text('ARC: Night')], 'end_turn'));
    director.start();
    await flush();
    expect(client.requests).toHaveLength(1);
    ctx.simStateCache.ingest(asleepReport(2));
    now += TICK_MS;
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(client.requests).toHaveLength(1);
    const armed = plum.wake.list();
    expect(armed).toHaveLength(1);
    expect(armed[0]).toMatchObject({ kind: 'game_time', hour: 6, minute: 30 });
    // Another night report: still one wake, still no turn
    ctx.simStateCache.ingest(asleepReport(3));
    now += TICK_MS;
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(client.requests).toHaveLength(1);
    expect(plum.wake.list()).toHaveLength(1);
    // Morning: the clock reaches 06:30, the wake fires and the tick runs with its note
    client.queue.push(message([text('Good morning, Goths.')], 'end_turn'));
    ctx.simStateCache.ingest({
      type: 'state_report',
      seq: 4,
      sims: [{ sim_id: '1', sim_name: 'Bella Goth', sims: [], objects: [], activity: { running: 'stretch' } }],
      lot: { clock: { hour: 6, minute: 31 } },
    });
    await flush();
    expect(client.requests).toHaveLength(2);
    expect(plum.wake.list()).toHaveLength(0);
    const last = client.requests[1].messages[client.requests[1].messages.length - 1]
      .content as Anthropic.Beta.Messages.BetaTextBlockParam[];
    expect(last[last.length - 1].text).toContain('The household is waking up');
  });

  it('an API 400 on a director turn backs the tick off ten minutes', async () => {
    client.queue.push(message([text('ARC: Refused')], 'end_turn'));
    director.start();
    await flush();
    expect(client.requests).toHaveLength(1);
    client.failWith = Object.assign(new Error('tools.3.input_schema: oneOf is not supported'), { status: 400 });
    ctx.simStateCache.ingest(report(2));
    now += TICK_MS;
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(client.requests).toHaveLength(2);
    // Nine minutes of changed reports: no call
    for (let minute = 0; minute < 9; minute += 1) {
      ctx.simStateCache.ingest(report(10 + minute));
      now += TICK_MS;
      await vi.advanceTimersByTimeAsync(TICK_MS);
    }
    expect(client.requests).toHaveLength(2);
    expect(director.status().suspended).toContain('refused by the API');
    // Past the back-off the tick runs again
    client.queue.push(message([text('Back.')], 'end_turn'));
    ctx.simStateCache.ingest(report(30));
    now += 2 * TICK_MS;
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(client.requests).toHaveLength(3);
  });

  describe('on the Claude Code brain', () => {
    let down: string | undefined;
    let results: { error?: { status?: number; message: string } }[];
    let turns: number;

    beforeEach(() => {
      down = undefined;
      results = [];
      turns = 0;
      ctx.settings.set(SettingsEnum.PLUM_BRAIN, 'claude-code');
      ctx.ext.plumBrain = {
        unavailable: () => down,
        runTurn: (port) => {
          turns += 1;
          port.say('ARC: Brainy');
          return Promise.resolve(results.shift() ?? {});
        },
      };
    });

    it('holds the tick while the brain is down, without an error row', async () => {
      down = 'Claude Code session is not running';
      director.start();
      await flush();
      expect(turns).toBe(0);
      expect(director.status().suspended).toContain('not running');
      expect(eventsOfKind('error')).toEqual([]);
      down = undefined;
      ctx.simStateCache.ingest(report(2));
      now += TICK_MS;
      await vi.advanceTimersByTimeAsync(TICK_MS);
      expect(turns).toBe(1);
      expect(client.requests).toHaveLength(0);
    });

    it('a plan limit (429) holds ten minutes, a lost session (503) one', async () => {
      results.push({ error: { status: 429, message: 'Claude plan limit reached' } });
      director.start();
      await flush();
      expect(turns).toBe(1);
      for (let minute = 0; minute < 9; minute += 1) {
        ctx.simStateCache.ingest(report(10 + minute));
        now += TICK_MS;
        await vi.advanceTimersByTimeAsync(TICK_MS);
      }
      expect(turns).toBe(1);
      expect(director.status().suspended).toContain('plan limit');
      results.push({ error: { status: 503, message: 'the Claude Code session closed mid-turn' } });
      ctx.simStateCache.ingest(report(30));
      now += 2 * TICK_MS;
      await vi.advanceTimersByTimeAsync(TICK_MS);
      expect(turns).toBe(2);
      // One minute later it runs again
      ctx.simStateCache.ingest(report(31));
      now += TICK_MS + 1;
      await vi.advanceTimersByTimeAsync(TICK_MS);
      expect(turns).toBe(3);
    });
  });
});
