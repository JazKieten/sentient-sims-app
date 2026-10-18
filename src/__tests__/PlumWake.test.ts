import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';

const sendModNotification = vi.hoisted(() => vi.fn());

vi.mock('main/sentient-sims/websocketServer', () => ({
  sendModNotification,
  getModClockState: () => undefined,
  isWebSocketConnected: () => true,
}));

import { SettingsEnum } from 'main/sentient-sims/models/SettingsEnum';
import { ModWebsocketMessageType } from 'main/sentient-sims/models/ModWebsocketMessage';
import { SimStateReport } from 'main/sentient-sims/models/SimStateReport';
import { ApiContext } from 'main/sentient-sims/services/ApiContext';
import { PlumService } from 'main/sentient-sims/services/PlumService';
import { PlumModelClient, PlumModelRequest } from 'main/sentient-sims/services/plum/PlumModelClient';
import { buildAppTools } from 'main/sentient-sims/services/plum/PlumAppTools';
import { PlumModToolDef } from 'main/sentient-sims/models/ModLogWebsocketMessage';
import {
  describe as describeTrigger,
  MAX_TRIGGERS,
  sameInteraction,
  TRIGGER_TTL_MS,
} from 'main/sentient-sims/services/plum/PlumWake';
import { mockApiContext } from './util';

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

function toolCalls(): Record<string, unknown>[] {
  return sendModNotification.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((notification) => notification.type === ModWebsocketMessageType.PLUM_TOOL_CALL);
}

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;

class FakeModelClient implements PlumModelClient {
  requests: PlumModelRequest[] = [];

  queue: BetaMessage[] = [];

  gate?: Promise<void>;

  async create(request: PlumModelRequest): Promise<BetaMessage> {
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

function report(seq: number, running: string | null, clock?: { hour: number; minute: number }): SimStateReport {
  return {
    type: 'state_report',
    seq,
    sims: [{ sim_id: '1', sim_name: 'Bella Goth', sims: [], objects: [], activity: { running } }],
    lot: clock ? { clock } : {},
  };
}

function eventsOfKind(kind: string): Record<string, unknown>[] {
  return sendModNotification.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((event) => event.type === ModWebsocketMessageType.PLUM_EVENT && event.kind === kind);
}

function lastUserText(request: PlumModelRequest): string {
  const last = request.messages[request.messages.length - 1].content as Anthropic.Beta.Messages.BetaTextBlockParam[];
  return last[last.length - 1].text;
}

async function flush() {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

describe('PlumWakeService', () => {
  let ctx: ApiContext;
  let client: FakeModelClient;
  let plum: PlumService;
  let now: number;

  beforeEach(() => {
    vi.useFakeTimers();
    sendModNotification.mockClear();
    now = 1_000_000;
    ctx = mockApiContext({ tiers: [] });
    ctx.settings.set(SettingsEnum.PLUM_API_KEY, 'sk-test');
    client = new FakeModelClient();
    // The tools' wake_me must set triggers on THIS service, not the context's own PlumService
    plum = new PlumService(ctx, {
      clientFactory: () => client,
      now: () => now,
      appTools: buildAppTools(ctx, () => plum.wake),
    });
    plum.onModMessage({ kind: 'catalogue', tier: 'core', enabled: true, tools: [pushAction] });
    ctx.simStateCache.ingest(report(1, 'cook'));
    sendModNotification.mockClear();
  });

  // A trigger that pushes gossip on Bella (with Don) when she finishes insulting him
  function armGossip() {
    return plum.wake.set({
      kind: 'sim_finishes',
      simId: '1',
      simName: 'Bella Goth',
      doing: 'insult',
      note: 'beat two fell through; adapt the arc',
      then: {
        do: 'push_action',
        simId: '1',
        simName: 'Bella Goth',
        action: 'gossip',
        targetId: '2',
        targetName: 'Don',
      },
    });
  }

  it('a then=push_action trigger pushes the stored action itself when the beat ends well, with no model turn', async () => {
    const registered: { requestId: string; action: string }[] = [];
    ctx.ext.plumPush = (requestId, push) => registered.push({ requestId, action: push.action });
    const trigger = armGossip();
    expect(trigger.then?.do).toBe('push_action');
    ctx.simStateCache.ingest(report(2, 'mixer_social_Insult_targeted'));
    await flush();
    expect(toolCalls()).toHaveLength(0);
    // The insult ends and she goes idle: the push goes out at once
    ctx.simStateCache.ingest(report(3, null));
    await flush();
    const calls = toolCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('push_action');
    expect(calls[0].args).toEqual({ sim: '1', action: 'gossip', target: '2', preempt: false });
    const started = eventsOfKind('tool_call_started')[0].row as { summary: string; name: string };
    expect(started.summary).toBe(`trigger ${trigger.id}: push_action`);
    plum.onModMessage({
      kind: 'tool_result',
      request_id: calls[0].request_id as string,
      ok: true,
      result: { changed: 'pushed gossip on Bella Goth (with Don)', request_id: 'plum-xyz' },
    });
    await flush();
    expect(client.requests).toHaveLength(0);
    expect(registered).toEqual([{ requestId: 'plum-xyz', action: 'gossip' }]);
    const finished = eventsOfKind('tool_call_finished')[0] as { ok: boolean; summary: string };
    expect(finished.ok).toBe(true);
    expect(finished.summary).toBe(`trigger ${trigger.id}: pushed gossip on Bella Goth (with Don)`);
    expect(plum.rows.map((row) => row.kind)).toEqual(['tool']);
    expect(plum.wake.list()).toHaveLength(0);
    const journal = plum.wake.takeJournal();
    expect(journal).toHaveLength(1);
    expect(journal[0]).toContain(`${trigger.id} fired (Bella Goth finished "insult", now idle)`);
    expect(journal[0]).toContain('pushed gossip on Bella Goth (with Don)');
    expect(plum.wake.takeJournal()).toEqual([]);
  });

  it('a then=push_action trigger whose beat ended canceled wakes Plum instead of pushing', async () => {
    const trigger = armGossip();
    client.queue.push(message([text('Bella walked off; rethinking.')], 'end_turn'));
    plum.onModMessage({
      kind: 'interaction_ended',
      interaction_id: '77',
      sim_id: '1',
      name: 'mixer_social_Insult_targeted',
      outcome: 'canceled',
    });
    await flush();
    expect(toolCalls()).toHaveLength(0);
    expect(client.requests).toHaveLength(1);
    const wake = lastUserText(client.requests[0]);
    expect(wake).toContain(`<wake id="${trigger.id}"`);
    expect(wake).toContain(
      'ended canceled, so the push it was to send (push gossip on Bella Goth (with Don)) was not sent',
    );
    expect(wake).toContain('beat two fell through; adapt the arc');
    // The outcome route's failure is bad too; its success is good
    plum.wake.set({
      kind: 'sim_finishes',
      simId: '1',
      simName: 'Bella Goth',
      note: 'n',
      then: { do: 'push_action', simId: '1', simName: 'Bella Goth', action: 'chat' },
    });
    client.queue.push(message([text('Failed.')], 'end_turn'));
    plum.wake.onOutcome({
      sim_id: '1',
      interaction_name: 'mixer_social_Insult',
      outcome: 'failure',
      reason: 'target left',
    });
    await flush();
    expect(toolCalls()).toHaveLength(0);
    expect(client.requests).toHaveLength(2);
    expect(lastUserText(client.requests[1])).toContain('ended failure');
    plum.wake.set({
      kind: 'sim_finishes',
      simId: '1',
      simName: 'Bella Goth',
      note: 'n',
      then: { do: 'push_action', simId: '1', simName: 'Bella Goth', action: 'chat' },
    });
    plum.wake.onOutcome({ sim_id: '1', interaction_name: 'mixer_social_Insult', outcome: 'success' });
    await flush();
    expect(toolCalls()).toHaveLength(1);
    expect(toolCalls()[0].args).toEqual({ sim: '1', action: 'chat', target: null, preempt: false });
    expect(client.requests).toHaveLength(2);
  });

  it('a push the mod refuses wakes Plum with the error', async () => {
    const trigger = armGossip();
    ctx.simStateCache.ingest(report(2, 'mixer_social_Insult_targeted'));
    ctx.simStateCache.ingest(report(3, null));
    await flush();
    const [call] = toolCalls();
    client.queue.push(message([text('The push was refused.')], 'end_turn'));
    plum.onModMessage({
      kind: 'tool_result',
      request_id: call.request_id as string,
      ok: false,
      error: 'Don is asleep',
    });
    await flush();
    await flush();
    expect(client.requests).toHaveLength(1);
    const wake = lastUserText(client.requests[0]);
    expect(wake).toContain(`<wake id="${trigger.id}"`);
    expect(wake).toContain('was refused: Don is asleep');
    expect(wake).toContain('beat two fell through; adapt the arc');
    const toolRow = plum.rows.find((row) => row.kind === 'tool');
    expect(toolRow?.ok).toBe(false);
    expect(toolRow?.summary).toBe(`trigger ${trigger.id}: push_action failed: Don is asleep`);
  });

  it("the next turn's live block lists the armed triggers and the journal, then the journal is cleared", async () => {
    const gossip = armGossip();
    const dinner = plum.wake.set({ kind: 'game_time', at: '18:00', note: 'dinner' });
    ctx.simStateCache.ingest(report(2, 'mixer_social_Insult_targeted'));
    ctx.simStateCache.ingest(report(3, null));
    await flush();
    const [call] = toolCalls();
    plum.onModMessage({
      kind: 'tool_result',
      request_id: call.request_id as string,
      ok: true,
      result: { changed: 'pushed gossip on Bella Goth' },
    });
    await flush();
    client.queue.push(message([text('Gossip is under way.')], 'end_turn'));
    await plum.runTurn('how is it going?');
    const blocks = client.requests[0].messages[0].content as Anthropic.Beta.Messages.BetaTextBlockParam[];
    const live = blocks[0].text;
    expect(live).toContain('triggers:');
    expect(live).toContain(`- ${dinner.id} at 18:00`);
    expect(live).not.toContain(`${gossip.id} when`);
    expect(live).toContain('since your last turn:');
    expect(live).toContain(
      `- ${gossip.id} fired (Bella Goth finished "insult", now idle): trigger ${gossip.id}: pushed gossip on Bella Goth`,
    );
    client.queue.push(message([text('Still going.')], 'end_turn'));
    await plum.runTurn('and now?');
    const next = (client.requests[1].messages[2].content as Anthropic.Beta.Messages.BetaTextBlockParam[])[0].text;
    expect(next).toContain('triggers:');
    expect(next).not.toContain('since your last turn:');
    // describe renders the then clause
    expect(describeTrigger(armGossip())).toBe(
      'when Bella Goth finishes "insult" (not started yet), then push gossip on Bella Goth (with Don)',
    );
  });

  it('sim_finishes wakes Plum with a <wake> turn and no player row when the Sim stops', async () => {
    plum.wake.set({ kind: 'sim_finishes', simId: '1', simName: 'Bella Goth', note: 'tell the player how dinner went' });
    expect(plum.wake.list()[0].baseline).toBe('cook');
    // Still cooking: nothing
    ctx.simStateCache.ingest(report(2, 'cook'));
    await flush();
    expect(client.requests).toHaveLength(0);
    // Eating now: the wake
    client.queue.push(message([text('Dinner is served.')], 'end_turn'));
    ctx.simStateCache.ingest(report(3, 'eat'));
    await flush();
    expect(client.requests).toHaveLength(1);
    const wake = lastUserText(client.requests[0]);
    expect(wake).toContain('<wake id="w');
    expect(wake).toContain('trigger="sim_finishes"');
    expect(wake).toContain('Bella Goth finished "cook", now "eat"');
    expect(wake).toContain('tell the player how dinner went');
    expect(eventsOfKind('player')).toEqual([]);
    expect(plum.rows.map((row) => row.kind)).toEqual(['plum']);
    expect(eventsOfKind('assistant').map((event) => (event.row as { text: string }).text)).toEqual([
      'Dinner is served.',
    ]);
    // Fired once and gone
    expect(plum.wake.list()).toHaveLength(0);
    ctx.simStateCache.ingest(report(4, null));
    await flush();
    expect(client.requests).toHaveLength(1);
  });

  it('sim_finishes with `doing` waits for the queued action to start and then to end', async () => {
    // Bella is chatting (seated); Plum clicked Solo_Stargazing, which queued behind the chat
    ctx.simStateCache.ingest(report(2, 'seating_Sit'));
    const trigger = plum.wake.set({
      kind: 'sim_finishes',
      simId: '1',
      simName: 'Bella Goth',
      doing: 'Solo_Stargazing',
      note: 'how was the sky',
    });
    expect(trigger.started).toBe(false);
    // The chat ends and she goes idle: not what we wait for
    ctx.simStateCache.ingest(report(3, null));
    await flush();
    expect(client.requests).toHaveLength(0);
    // Stargazing starts (the report names the running mixer, not the super): still waiting
    ctx.simStateCache.ingest(report(4, 'mixer_solo_stargaze'));
    await flush();
    expect(client.requests).toHaveLength(0);
    expect(plum.wake.list()[0].started).toBe(true);
    // ...and ends
    client.queue.push(message([text('She saw a shooting star.')], 'end_turn'));
    ctx.simStateCache.ingest(report(5, 'seating_Sit'));
    await flush();
    expect(client.requests).toHaveLength(1);
    expect(lastUserText(client.requests[0])).toContain('Bella Goth finished "Solo_Stargazing", now "seating_Sit"');
    // An outcome for another interaction does not fire a `doing` trigger; the right one does
    plum.wake.set({ kind: 'sim_finishes', simId: '1', simName: 'Bella Goth', doing: 'mixer_social_Insult', note: 'x' });
    plum.wake.onOutcome({ sim_id: '1', interaction_name: 'sim_Chat', outcome: 'success' });
    await flush();
    expect(client.requests).toHaveLength(1);
    client.queue.push(message([text('Ouch.')], 'end_turn'));
    plum.wake.onOutcome({ sim_id: '1', interaction_name: 'mixer_social_Insult_targeted', outcome: 'success' });
    await flush();
    expect(client.requests).toHaveLength(2);
  });

  it('the wake_me tool sets a real-minutes timer through the turn, and the timer wakes Plum', async () => {
    client.queue.push(
      message(
        [
          toolUse('tu_1', 'wake_me', {
            when: 'real_minutes',
            sim: null,
            at: null,
            minutes: 2,
            note: 'check the stove',
          }),
        ],
        'tool_use',
      ),
    );
    client.queue.push(message([text('I will check in two minutes.')], 'end_turn'));
    await plum.runTurn('watch the stove for me');
    const results = client.requests[1].messages[2].content as Anthropic.Beta.Messages.BetaToolResultBlockParam[];
    expect(results[0].is_error).toBeUndefined();
    expect(results[0].content as string).toContain('will wake in 2 real minutes: check the stove');
    const toolRow = plum.rows.find((row) => row.kind === 'tool');
    expect(toolRow?.summary).toBe('will wake in 2 real minutes: check the stove');
    expect(plum.wake.list()).toHaveLength(1);

    client.queue.push(message([text('The stove is fine.')], 'end_turn'));
    now += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.requests).toHaveLength(2);
    now += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(client.requests).toHaveLength(3);
    expect(lastUserText(client.requests[2])).toContain('2 real minutes have passed');
    expect(plum.rows.filter((row) => row.kind === 'player')).toHaveLength(1);
  });

  it('game_time fires when the lot clock reaches the time, cancel drops everything', async () => {
    plum.wake.set({ kind: 'game_time', at: '18:00', note: 'dinner' });
    ctx.simStateCache.ingest(report(2, 'cook', { hour: 17, minute: 30 }));
    await flush();
    expect(client.requests).toHaveLength(0);
    client.queue.push(message([text('Six o clock.')], 'end_turn'));
    ctx.simStateCache.ingest(report(3, 'cook', { hour: 18, minute: 5 }));
    await flush();
    expect(client.requests).toHaveLength(1);
    expect(lastUserText(client.requests[0])).toContain('the clock reached 18:00');

    plum.wake.set({ kind: 'game_time', at: '20:00', note: 'bed' });
    plum.wake.set({ kind: 'sim_finishes', simId: '1', simName: 'Bella Goth', note: 'x' });
    expect(plum.wake.cancelAll()).toBe(2);
    ctx.simStateCache.ingest(report(4, null, { hour: 20, minute: 1 }));
    await flush();
    expect(client.requests).toHaveLength(1);
  });

  it('a wake that fires mid-turn waits for the turn, and the trigger cap holds', async () => {
    let release: () => void = () => {};
    client.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    client.queue.push(message([text('Thinking...')], 'end_turn'));
    const turn = plum.runTurn('hello');
    await flush();
    plum.wake.set({ kind: 'sim_finishes', simId: '1', simName: 'Bella Goth', note: 'x' });
    ctx.simStateCache.ingest(report(2, null));
    await flush();
    // Fired, but Plum is mid-turn: held
    expect(client.requests).toHaveLength(1);
    expect(plum.wake.list()).toHaveLength(0);
    release();
    client.gate = undefined;
    await turn;
    client.queue.push(message([text('Bella is done.')], 'end_turn'));
    ctx.simStateCache.ingest(report(3, null));
    await flush();
    expect(client.requests).toHaveLength(2);
    expect(lastUserText(client.requests[1])).toContain('<wake');

    for (let i = 0; i < MAX_TRIGGERS; i += 1) {
      plum.wake.set({ kind: 'real_minutes', minutes: 10 + i, note: `n${i}` });
    }
    expect(() => plum.wake.set({ kind: 'real_minutes', minutes: 5, note: 'one too many' })).toThrow(
      'cancel some first',
    );
  });

  it('the mod reporting a watched interaction ended wakes the matching trigger', async () => {
    ctx.simStateCache.ingest(report(2, 'seating_Sit'));
    plum.wake.set({ kind: 'sim_finishes', simId: '1', simName: 'Bella Goth', doing: 'Solo_Stargazing', note: 'sky' });
    plum.wake.set({ kind: 'sim_finishes', simId: '1', simName: 'Bella Goth', doing: '9001', note: 'by id' });
    // Another interaction of hers ending: neither fires
    plum.onModMessage({
      kind: 'interaction_ended',
      interaction_id: '7',
      sim_id: '1',
      name: 'sim_Chat',
      outcome: 'finished',
    });
    await flush();
    expect(client.requests).toHaveLength(0);
    client.queue.push(message([text('Stars.')], 'end_turn'));
    plum.onModMessage({
      kind: 'interaction_ended',
      interaction_id: '9001',
      sim_id: '1',
      name: 'Solo_Stargazing',
      outcome: 'canceled',
    });
    await flush();
    // Both match (by name and by id) and fold into one turn plus one queued
    expect(client.requests.length).toBeGreaterThanOrEqual(1);
    expect(lastUserText(client.requests[0])).toContain('Bella Goth\'s "Solo_Stargazing" ended: canceled');
    expect(plum.wake.list()).toHaveLength(0);
  });

  it('a running mixer is still the super the trigger waits on: no fire until idle or another super', async () => {
    // Live 2026-10-17: a chat's TellJoke mixer took the head and the trigger fired at once
    const trigger = plum.wake.set({
      kind: 'sim_finishes',
      simId: '1',
      simName: 'Bella Goth',
      doing: 'sim_Chat',
      note: 'joke over',
      then: { do: 'push_action', simId: '1', simName: 'Bella Goth', action: 'gossip' },
    });
    ctx.simStateCache.ingest(report(2, 'sim_Chat'));
    await flush();
    expect(trigger.started).toBe(true);
    ctx.simStateCache.ingest(report(3, 'mixer_socials_TellJoke_group_Funny_alwaysOn'));
    await flush();
    expect(toolCalls()).toHaveLength(0);
    expect(plum.wake.list()).toHaveLength(1);
    ctx.simStateCache.ingest(report(4, 'mixer_social_Gossip'));
    await flush();
    expect(toolCalls()).toHaveLength(0);
    // Another super (cooking) ends it
    ctx.simStateCache.ingest(report(5, 'fridge_Cook'));
    await flush();
    expect(toolCalls()).toHaveLength(1);
    expect(plum.wake.list()).toHaveLength(0);
  });

  it("a `doing` trigger on an interaction the mod watches ignores the report and waits for the mod's end", async () => {
    // Plum pushed the chat: the result carried the interaction id and name, so it is watched
    client.queue.push(
      message(
        [toolUse('tu_1', 'push_action', { sim: 'Bella Goth', action: 'tell_joke', target: null, preempt: null })],
        'tool_use',
      ),
    );
    client.queue.push(message([text('Joke is cued.')], 'end_turn'));
    const turn = plum.runTurn('make bella tell a joke');
    await flush();
    const [call] = toolCalls();
    plum.onModMessage({
      kind: 'tool_result',
      request_id: call.request_id as string,
      ok: true,
      result: { changed: 'pushed tell_joke on Bella Goth', interaction_id: '4242', interaction: 'sim_Chat' },
    });
    await turn;
    const trigger = plum.wake.set({
      kind: 'sim_finishes',
      simId: '1',
      simName: 'Bella Goth',
      doing: 'sim_Chat',
      note: 'next beat',
      then: { do: 'push_action', simId: '1', simName: 'Bella Goth', action: 'gossip' },
    });
    // The report path is ignored entirely, idle included
    ctx.simStateCache.ingest(report(2, 'sim_Chat'));
    ctx.simStateCache.ingest(report(3, null));
    ctx.simStateCache.ingest(report(4, 'fridge_Cook'));
    await flush();
    expect(toolCalls()).toHaveLength(1);
    expect(plum.wake.list()).toEqual([trigger]);
    // The mod's exact end fires it
    plum.onModMessage({
      kind: 'interaction_ended',
      interaction_id: '4242',
      sim_id: '1',
      name: 'sim_Chat',
      outcome: 'finished',
    });
    await flush();
    expect(toolCalls()).toHaveLength(2);
    expect(toolCalls()[1].args).toMatchObject({ action: 'gossip' });
    expect(plum.wake.list()).toHaveLength(0);
    // Once ended it is no longer watched: a later trigger on the same name uses the report again
    plum.wake.set({ kind: 'sim_finishes', simId: '1', simName: 'Bella Goth', doing: 'sim_Chat', note: 'again' });
    ctx.simStateCache.ingest(report(5, 'sim_Chat'));
    client.queue.push(message([text('Chat over.')], 'end_turn'));
    ctx.simStateCache.ingest(report(6, null));
    await flush();
    expect(plum.wake.list()).toHaveLength(0);
  });

  it('matches interaction names loosely: mixers of a super, whitelist words, stems', () => {
    expect(sameInteraction('mixer_solo_stargaze', 'Solo_Stargazing')).toBe(true);
    expect(sameInteraction('mixer_social_Insult_targeted_mean', 'insult')).toBe(true);
    expect(sameInteraction('fridge_Cook', 'cook')).toBe(true);
    expect(sameInteraction('mixer_social_Argue', 'mixer_social_AskAboutDay')).toBe(false);
    expect(sameInteraction('seating_Sit', 'Solo_Stargazing')).toBe(false);
    expect(sameInteraction(null, 'x')).toBe(false);
  });

  it('an outcome report wakes a sim_finishes trigger with how the action went', async () => {
    plum.wake.set({ kind: 'sim_finishes', simId: '1', simName: 'Bella Goth', note: 'did the insult land' });
    client.queue.push(message([text('It landed.')], 'end_turn'));
    plum.wake.onOutcome({
      request_id: 'plum-abc',
      sim_id: '1',
      interaction_name: 'mixer_social_Insult',
      outcome: 'success',
    });
    await flush();
    expect(client.requests).toHaveLength(1);
    expect(lastUserText(client.requests[0])).toContain('Bella Goth\'s "mixer_social_Insult" ended: success');
    // Another Sim's outcome never fires it
    plum.wake.set({ kind: 'sim_finishes', simId: '1', simName: 'Bella Goth', note: 'y' });
    plum.wake.onOutcome({ sim_id: '2', outcome: 'canceled', reason: 'target left' });
    await flush();
    expect(client.requests).toHaveLength(1);
    expect(plum.wake.list()).toHaveLength(1);
  });

  // --- chains by reference (`after`) -------------------------------------------------------

  function result(call: Record<string, unknown>, fields: Record<string, unknown>) {
    plum.onModMessage({ kind: 'tool_result', request_id: call.request_id as string, ok: true, result: fields });
  }

  it("a chain by reference runs in order on each beat's exact end, with no model turn", async () => {
    const w1 = armGossip();
    const w2 = plum.wake.set({
      kind: 'sim_finishes',
      note: 'beat 3 fell through',
      after: w1.id,
      then: { do: 'push_action', simId: '1', simName: 'Bella Goth', action: 'tell_joke' },
    });
    const w3 = plum.wake.set({ kind: 'sim_finishes', note: 'recap', after: w2.id });
    expect(w2).toMatchObject({ after: w1.id, simId: '1', simName: 'Bella Goth' });
    expect(w2.doing).toBeUndefined();
    expect(describeTrigger(w2)).toBe(
      `after ${w1.id}, when Bella Goth finishes the beat it pushes, then push tell_joke on Bella Goth`,
    );
    // A pending `after` trigger is inert: reports, ends and outcomes on its Sim do nothing
    ctx.simStateCache.ingest(report(2, null));
    plum.wake.onOutcome({ sim_id: '1', interaction_name: 'mixer_social_TellJoke', outcome: 'success' });
    plum.onModMessage({
      kind: 'interaction_ended',
      interaction_id: '1',
      sim_id: '1',
      name: 'sim_Chat',
      outcome: 'finished',
    });
    await flush();
    expect(toolCalls()).toHaveLength(0);
    expect(plum.wake.list()).toHaveLength(3);
    // w1 fires on the report and pushes gossip; its result resolves w2 to that interaction
    ctx.simStateCache.ingest(report(3, 'mixer_social_Insult_targeted'));
    ctx.simStateCache.ingest(report(4, null));
    await flush();
    expect(toolCalls()).toHaveLength(1);
    expect(toolCalls()[0].args).toMatchObject({ action: 'gossip' });
    result(toolCalls()[0], {
      changed: 'pushed gossip on Bella Goth (with Don)',
      interaction_id: '4242',
      interaction: 'sim_Chat',
      request_id: 'plum-a',
    });
    await flush();
    expect(w2.after).toBeUndefined();
    expect(w2).toMatchObject({ simId: '1', doing: 'sim_Chat', doingId: '4242', requestId: 'plum-a' });
    expect(w3.after).toBe(w2.id);
    expect(describeTrigger(w2)).toContain('when Bella Goth finishes "sim_Chat"');
    // Watched: the report's idle does not fire it
    ctx.simStateCache.ingest(report(5, 'sim_Chat'));
    ctx.simStateCache.ingest(report(6, null));
    await flush();
    expect(toolCalls()).toHaveLength(1);
    // Another interaction of the same name on the same Sim (the target's side of the social) does not
    plum.onModMessage({
      kind: 'interaction_ended',
      interaction_id: '5555',
      sim_id: '1',
      name: 'sim_Chat',
      outcome: 'finished',
    });
    await flush();
    expect(toolCalls()).toHaveLength(1);
    expect(plum.wake.list()).toEqual([w2, w3]);
    // The exact id fires it: the joke goes out and w3 resolves from that result
    plum.onModMessage({
      kind: 'interaction_ended',
      interaction_id: '4242',
      sim_id: '1',
      name: 'sim_Chat',
      outcome: 'finished',
    });
    await flush();
    expect(toolCalls()).toHaveLength(2);
    expect(toolCalls()[1].args).toEqual({ sim: '1', action: 'tell_joke', target: null, preempt: false });
    result(toolCalls()[1], {
      changed: 'pushed tell_joke on Bella Goth',
      interaction_id: '4300',
      interaction: 'sim_Chat',
    });
    await flush();
    expect(w3.after).toBeUndefined();
    expect(w3).toMatchObject({ doingId: '4300', doing: 'sim_Chat' });
    expect(w3.then).toBeUndefined();
    expect(plum.wake.list()).toEqual([w3]);
    expect(client.requests).toHaveLength(0);
    const journal = plum.wake.takeJournal();
    expect(journal).toHaveLength(2);
    expect(journal[1]).toContain(`${w2.id} fired (Bella Goth's "sim_Chat" ended: finished)`);
  });

  it('a canceled beat wakes Plum and drops every trigger chained below it', async () => {
    const w1 = armGossip();
    const w2 = plum.wake.set({
      kind: 'sim_finishes',
      note: 'n',
      after: w1.id,
      then: { do: 'push_action', simId: '1', simName: 'Bella Goth', action: 'tell_joke' },
    });
    const w3 = plum.wake.set({ kind: 'sim_finishes', note: 'recap', after: w2.id });
    client.queue.push(message([text('Bella walked off; re-planning.')], 'end_turn'));
    plum.onModMessage({
      kind: 'interaction_ended',
      interaction_id: '77',
      sim_id: '1',
      name: 'mixer_social_Insult_targeted',
      outcome: 'canceled',
    });
    await flush();
    expect(toolCalls()).toHaveLength(0);
    expect(plum.wake.list()).toHaveLength(0);
    expect(client.requests).toHaveLength(1);
    const wake = lastUserText(client.requests[0]);
    expect(wake).toContain(`<wake id="${w1.id}"`);
    expect(wake).toContain(
      'ended canceled, so the push it was to send (push gossip on Bella Goth (with Don)) was not sent',
    );
    expect(wake).toContain(`its dependents (${w2.id}, ${w3.id}) were dropped, so re-plan the rest`);
    // The journal was folded into that wake's live block
    const live = (client.requests[0].messages[0].content as Anthropic.Beta.Messages.BetaTextBlockParam[])[0].text;
    expect(live).toContain(`- ${w2.id}, ${w3.id} dropped: ${w1.id} did not run`);
    expect(live).not.toContain('triggers:');
  });

  it('a refused push drops its dependents the same way', async () => {
    const w1 = armGossip();
    const w2 = plum.wake.set({ kind: 'sim_finishes', note: 'recap', after: w1.id });
    ctx.simStateCache.ingest(report(2, 'mixer_social_Insult_targeted'));
    ctx.simStateCache.ingest(report(3, null));
    await flush();
    const [call] = toolCalls();
    client.queue.push(message([text('Refused.')], 'end_turn'));
    plum.onModMessage({
      kind: 'tool_result',
      request_id: call.request_id as string,
      ok: false,
      error: 'Don is asleep',
    });
    await flush();
    await flush();
    expect(plum.wake.list()).toHaveLength(0);
    const wake = lastUserText(client.requests[0]);
    expect(wake).toContain('was refused: Don is asleep');
    expect(wake).toContain(`its dependents (${w2.id}) were dropped`);
  });

  it('an expired parent drops its dependents', () => {
    const w1 = armGossip();
    const w2 = plum.wake.set({ kind: 'sim_finishes', note: 'recap', after: w1.id });
    now += TRIGGER_TTL_MS + 1;
    expect(plum.wake.status()).toBeUndefined();
    expect(plum.wake.list()).toHaveLength(0);
    const journal = plum.wake.takeJournal();
    expect(journal[0]).toContain(`${w1.id} expired unfired`);
    expect(journal[1]).toBe(`${w2.id} dropped: ${w1.id} did not run`);
    expect(journal).toHaveLength(2);
  });

  it('a resolved trigger with a request id fires only on that outcome report', async () => {
    const w1 = armGossip();
    const w2 = plum.wake.set({
      kind: 'sim_finishes',
      note: 'n',
      after: w1.id,
      then: { do: 'push_action', simId: '1', simName: 'Bella Goth', action: 'chat' },
    });
    ctx.simStateCache.ingest(report(2, 'mixer_social_Insult_targeted'));
    ctx.simStateCache.ingest(report(3, null));
    await flush();
    // No interaction_id: the push created no interaction object, so the name is the fallback
    result(toolCalls()[0], { changed: 'pushed gossip', interaction: 'sim_Chat', request_id: 'plum-a' });
    await flush();
    expect(w2).toMatchObject({ doing: 'sim_Chat', requestId: 'plum-a' });
    expect(w2.doingId).toBeUndefined();
    plum.wake.onOutcome({ request_id: 'plum-b', sim_id: '1', interaction_name: 'sim_Chat', outcome: 'success' });
    await flush();
    expect(toolCalls()).toHaveLength(1);
    plum.wake.onOutcome({ request_id: 'plum-a', sim_id: '1', interaction_name: 'sim_Chat', outcome: 'success' });
    await flush();
    expect(toolCalls()).toHaveLength(2);
    expect(toolCalls()[1].args).toMatchObject({ action: 'chat' });
  });

  it('set rejects `after` naming an unknown id, a wake trigger, or a kind other than sim_finishes', () => {
    expect(() => plum.wake.set({ kind: 'sim_finishes', note: 'n', after: 'wnope' })).toThrow(
      '`after` names no armed push trigger (wnope)',
    );
    const dinner = plum.wake.set({ kind: 'game_time', at: '18:00', note: 'dinner' });
    expect(() => plum.wake.set({ kind: 'sim_finishes', note: 'n', after: dinner.id })).toThrow(
      'names no armed push trigger',
    );
    const gossip = armGossip();
    expect(() => plum.wake.set({ kind: 'game_time', at: '19:00', note: 'n', after: gossip.id })).toThrow(
      'only works with sim_finishes',
    );
    expect(plum.wake.list()).toHaveLength(2);
  });

  it('planArc pushes beat 1 and arms the chain; a refused beat 1 or too many beats arms nothing', async () => {
    const bella = { simId: '1', simName: 'Bella Goth' };
    const don = { simId: '2', simName: 'Don Lothario' };
    const pending = plum.wake.planArc({
      name: 'The Cold Shoulder',
      beats: [
        { ...bella, action: 'insult', targetId: '2', targetName: 'Don Lothario' },
        { ...don, action: 'gossip', targetId: '1', targetName: 'Bella Goth' },
        { ...bella, action: 'apologize', targetId: '2', targetName: 'Don Lothario' },
      ],
      recapNote: 'recap and plan the next arc',
    });
    await flush();
    expect(toolCalls()).toHaveLength(1);
    expect(toolCalls()[0].args).toEqual({ sim: '1', action: 'insult', target: '2', preempt: false });
    const started = eventsOfKind('tool_call_started')[0].row as { summary: string };
    expect(started.summary).toBe('arc "The Cold Shoulder" beat 1: push_action');
    result(toolCalls()[0], {
      changed: 'pushed insult on Bella Goth (with Don Lothario)',
      interaction_id: '4242',
      interaction: 'mixer_social_Insult',
      request_id: 'plum-a',
    });
    const arc = await pending;
    const [w2, w3, w4] = plum.wake.list();
    expect(plum.wake.list()).toHaveLength(3);
    expect(arc.changed).toBe(
      `ARC "The Cold Shoulder": pushed beat 1 (pushed insult on Bella Goth (with Don Lothario)); armed ${w2.id}, ${w3.id} for beats 2..3; wake ${w4.id} after beat 3`,
    );
    expect(arc.beats).toEqual([
      { n: 1, sim: 'Bella Goth', action: 'insult', target: 'Don Lothario' },
      { n: 2, sim: 'Don Lothario', action: 'gossip', target: 'Bella Goth', trigger_id: w2.id },
      { n: 3, sim: 'Bella Goth', action: 'apologize', target: 'Don Lothario', trigger_id: w3.id },
    ]);
    expect(arc.pending).toBe(3);
    // Beat 2's trigger is already resolved from beat 1's push; the rest wait by reference
    expect(w2.after).toBeUndefined();
    expect(w2).toMatchObject({ simId: '1', doing: 'mixer_social_Insult', doingId: '4242', requestId: 'plum-a' });
    expect(w2.then).toEqual({
      do: 'push_action',
      simId: '2',
      simName: 'Don Lothario',
      action: 'gossip',
      targetId: '1',
      targetName: 'Bella Goth',
    });
    expect(w2.note).toBe('beat 2 of "The Cold Shoulder" did not run; adapt the arc');
    expect(w3).toMatchObject({ after: w2.id, simId: '2', simName: 'Don Lothario' });
    expect(w3.then).toMatchObject({ simId: '1', action: 'apologize' });
    expect(w4).toMatchObject({ after: w3.id, note: 'recap and plan the next arc' });
    expect(w4.then).toBeUndefined();
    expect(client.requests).toHaveLength(0);
    expect(plum.rows.map((row) => row.kind)).toEqual(['tool']);

    // A refused beat 1 throws and arms nothing more
    const refused = plum.wake.planArc({ name: 'Flop', beats: [{ ...bella, action: 'chat' }], recapNote: 'r' });
    await flush();
    expect(toolCalls()).toHaveLength(2);
    plum.onModMessage({
      kind: 'tool_result',
      request_id: toolCalls()[1].request_id as string,
      ok: false,
      error: 'Bella is asleep',
    });
    await expect(refused).rejects.toThrow(
      'beat 1 (push chat on Bella Goth) was refused, so nothing was armed: Bella is asleep',
    );
    expect(plum.wake.list()).toHaveLength(3);
    // Eight beats reject before any push
    const eight = Array.from({ length: 8 }, () => ({ ...bella, action: 'chat' }));
    await expect(plum.wake.planArc({ name: 'Long', beats: eight, recapNote: 'r' })).rejects.toThrow(
      '1 to 7 beats, not 8',
    );
    expect(toolCalls()).toHaveLength(2);
    // A one-beat arc is the push plus the closing wake, resolved at once
    const single = plum.wake.planArc({ name: 'Solo', beats: [{ ...bella, action: 'chat' }], recapNote: 'done' });
    await flush();
    result(toolCalls()[2], { changed: 'pushed chat', interaction_id: '9', interaction: 'sim_Chat' });
    const solo = await single;
    const w5 = plum.wake.list()[3];
    expect(solo.changed).toBe(`ARC "Solo": pushed beat 1 (pushed chat); wake ${w5.id} after beat 1`);
    expect(w5).toMatchObject({ doingId: '9', note: 'done' });
    expect(w5.after).toBeUndefined();
  });
});
