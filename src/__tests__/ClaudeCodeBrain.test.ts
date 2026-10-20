import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import express, { json } from 'express';

const sendModNotification = vi.hoisted(() => vi.fn());

vi.mock('main/sentient-sims/websocketServer', () => ({
  sendModNotification,
  getModClockState: () => undefined,
  isWebSocketConnected: () => true,
}));

import { SettingsEnum } from 'main/sentient-sims/models/SettingsEnum';
import { ModWebsocketMessageType } from 'main/sentient-sims/models/ModWebsocketMessage';
import { PlumModToolDef } from 'main/sentient-sims/models/ModLogWebsocketMessage';
import { ApiContext } from 'main/sentient-sims/services/ApiContext';
import type { PlumTurnResult } from 'main/sentient-sims/services/PlumService';
import {
  ACK_TIMEOUT_MS,
  ClaudeCodeBrain,
  claudeCodeRoutes,
  IDLE_TIMEOUT_MS,
} from 'main/sentient-sims/services/plum/ClaudeCodeBrain';
import { mockApiContext } from './util';

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
  input_schema: { type: 'object', properties: { amount: { type: 'integer' } }, required: ['amount'] },
  risk: 'write',
  timeout_ms: 20000,
  tier: 'core',
};
const sendHome: PlumModToolDef = {
  name: 'send_sim_home',
  description: 'Home.',
  input_schema: { type: 'object', properties: { sim: { type: 'string' } }, required: ['sim'] },
  risk: 'destructive',
  timeout_ms: 20000,
  tier: 'core',
};

type Sent = { event: string; data: { turn?: string; kind?: string; content?: string } };

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

describe('ClaudeCodeBrain', () => {
  let ctx: ApiContext;
  let brain: ClaudeCodeBrain;
  let sent: Sent[];
  let now: number;

  const sink = {
    send: (event: string, data: unknown) => {
      sent.push({ event, data: data as Sent['data'] });
    },
  };
  const turns = () => sent.filter((entry) => entry.event === 'turn').map((entry) => entry.data);
  const lastTurn = () => {
    const all = turns();
    return all[all.length - 1];
  };

  // Starts a Plum turn and returns its id once the brain sent it
  async function startTurn(
    text: string,
    options: { director?: boolean } = {},
  ): Promise<{ id: string; done: Promise<PlumTurnResult> }> {
    const before = turns().length;
    const done = ctx.plum.runTurn(text, options);
    await flush();
    const all = turns();
    return { id: all.length > before ? (all[all.length - 1].turn ?? '') : '', done };
  }

  function submit(promptId: string, id?: string) {
    brain.onHook({
      hook_event_name: 'UserPromptSubmit',
      prompt_id: promptId,
      prompt: id ? `<channel source="plum" turn="${id}">[plum turn ${id} kind=chat]\nhi</channel>` : 'typed by hand',
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    sendModNotification.mockClear();
    now = 1_000_000;
    ctx = mockApiContext({ tiers: [] });
    ctx.settings.set(SettingsEnum.PLUM_BRAIN, 'claude-code');
    brain = new ClaudeCodeBrain(ctx, { now: () => now });
    ctx.ext.plumBrain = brain;
    ctx.plum.onModMessage({ kind: 'catalogue', tier: 'core', enabled: true, tools: [lookAtLot, giveMoney, sendHome] });
    sent = [];
    brain.addSink(sink);
    sendModNotification.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('an ack binds the turn and only its own Stop ends it', async () => {
    const { id, done } = await startTurn('hi');
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(lastTurn().content?.startsWith(`[plum turn ${id} kind=chat]`)).toBe(true);
    expect(lastTurn().content).toContain('<live>');
    submit('p1', id);
    expect(brain.reply(id, 'Hello there.').ok).toBe(true);
    let settled = false;
    void done.then(() => {
      settled = true;
      return settled;
    });
    brain.onHook({ hook_event_name: 'Stop', prompt_id: 'someone-else' });
    await flush();
    expect(settled).toBe(false);
    brain.onHook({ hook_event_name: 'Stop', prompt_id: 'p1' });
    expect(await done).toEqual({});
    expect(ctx.plum.rows.map((row) => row.kind)).toEqual(['player', 'plum']);
    expect(eventsOfKind('assistant').map((event) => (event.row as { text: string }).text)).toEqual(['Hello there.']);
  });

  it('a late Stop of an abandoned turn never ends the next one', async () => {
    const first = await startTurn('one');
    submit('p1', first.id);
    now += IDLE_TIMEOUT_MS;
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    const result = await first.done;
    expect(result.error?.message).toContain('went quiet');
    // The abandoned turn, still running in the session, may look but not write
    const refused = await brain.callTool('give_money', { amount: 5 });
    expect(refused.ok).toBe(false);
    expect(refused.content).toContain('given up');
    // p1 never stopped; once it has been quiet for a while the next turn goes
    now += 3 * 60_000;
    const second = await startTurn('two');
    expect(second.id).not.toBe('');
    submit('p2', second.id);
    let settled = false;
    void second.done.then(() => {
      settled = true;
      return settled;
    });
    brain.onHook({ hook_event_name: 'Stop', prompt_id: 'p1' });
    await flush();
    expect(settled).toBe(false);
    brain.onHook({ hook_event_name: 'Stop', prompt_id: 'p2' });
    expect(await second.done).toEqual({});
  });

  it('never pushes a turn while the session is busy with another prompt', async () => {
    submit('typed');
    const { id, done } = await startTurn('hi');
    expect(id).toBe('');
    expect(turns()).toHaveLength(0);
    brain.onHook({ hook_event_name: 'Stop', prompt_id: 'typed' });
    await flush();
    expect(turns()).toHaveLength(1);
    const sentId = lastTurn().turn ?? '';
    submit('p1', sentId);
    brain.onHook({ hook_event_name: 'Stop', prompt_id: 'p1' });
    expect(await done).toEqual({});
  });

  it('no ack in 20 s: "not registered" until any hook arrives', async () => {
    const { done } = await startTurn('hi');
    now += ACK_TIMEOUT_MS;
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS);
    const result = await done;
    expect(result.error?.status).toBe(503);
    expect(brain.unavailable()).toContain('not registered');
    expect(ctx.plum.brainUnavailable()).toContain('not registered');
    expect(eventsOfKind('error').length).toBeGreaterThan(0);
    brain.onHook({ hook_event_name: 'SessionStart', source: 'startup' });
    expect(brain.unavailable()).toBeUndefined();
  });

  it('StopFailure rate_limit answers 429 and holds the brain', async () => {
    const { id, done } = await startTurn('hi');
    submit('p1', id);
    brain.onHook({ hook_event_name: 'StopFailure', prompt_id: 'p1', error: 'rate_limit' });
    const result = await done;
    expect(result.error?.status).toBe(429);
    expect(brain.unavailable()).toContain('plan limit');
    expect(eventsOfKind('error').map((event) => event.text)).toContain(result.error?.message);
    // A turn while held is refused before it is sent
    const next = await ctx.plum.runTurn('again');
    expect(next.error?.status).toBe(503);
    expect(turns()).toHaveLength(1);
  });

  it('replies are rows of the turn kind', async () => {
    const { id, done } = await startTurn('tick', { director: true });
    submit('p1', id);
    brain.reply(id, 'ARC: Rivals');
    brain.onHook({ hook_event_name: 'Stop', prompt_id: 'p1' });
    await done;
    expect(ctx.plum.rows.map((row) => row.kind)).toEqual(['director']);
    expect(eventsOfKind('director')).toHaveLength(1);
    // A reply to a turn that is over reaches nobody
    expect(brain.reply(id, 'late').ok).toBe(false);
  });

  it('a tool call outside any turn goes through looseTool: no destructive tools', async () => {
    const loose = vi.spyOn(ctx.plum, 'looseTool');
    const outcome = await brain.callTool('send_sim_home', { sim: 'Bella' });
    expect(loose).toHaveBeenCalledWith('send_sim_home', { sim: 'Bella' });
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toContain('destructive');
  });

  it('a tool call inside a turn runs through the turn (the row, the guards)', async () => {
    ctx.settings.set(SettingsEnum.PLUM_ALLOW_WRITES, false);
    const { id, done } = await startTurn('give them money');
    submit('p1', id);
    const outcome = await brain.callTool('give_money', { amount: 5 });
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toContain('Plum may change things');
    brain.onHook({ hook_event_name: 'Stop', prompt_id: 'p1' });
    await done;
    expect(ctx.plum.rows.map((row) => row.kind)).toEqual(['player', 'tool']);
  });

  it('the seed rides only the first acked turn of a conversation', async () => {
    const first = await startTurn('hello');
    submit('p1', first.id);
    brain.reply(first.id, 'Hi!');
    brain.onHook({ hook_event_name: 'Stop', prompt_id: 'p1' });
    await first.done;
    brain.onThreadReset();
    const second = await startTurn('again');
    expect(lastTurn().content).toContain('<earlier_conversation>');
    expect(lastTurn().content).toContain('[plum] Hi!');
    // The turn's own line is not in its seed
    expect(lastTurn().content?.split('again')).toHaveLength(2);
    submit('p2', second.id);
    brain.onHook({ hook_event_name: 'Stop', prompt_id: 'p2' });
    await second.done;
    await startTurn('third');
    expect(lastTurn().content).not.toContain('<earlier_conversation>');
  });

  it('a closed session ends the turn and makes the brain unavailable', async () => {
    const { id, done } = await startTurn('hi');
    submit('p1', id);
    brain.removeSink(sink);
    expect((await done).error?.message).toContain('closed');
    expect(brain.unavailable()).toContain('not running');
  });

  it('the routes need the token', async () => {
    vi.useRealTimers();
    brain.token = 'secret';
    const app = express();
    app.use(json());
    claudeCodeRoutes(app, brain);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as { port: number };
    try {
      const bare = await fetch(`http://127.0.0.1:${port}/plum/cc/persona`);
      expect(bare.status).toBe(401);
      const wrong = await fetch(`http://127.0.0.1:${port}/plum/cc/tool`, {
        method: 'POST',
        headers: { 'x-plum-token': 'nope', 'content-type': 'application/json' },
        body: '{}',
      });
      expect(wrong.status).toBe(401);
      const good = await fetch(`http://127.0.0.1:${port}/plum/cc/catalogue`, { headers: { 'x-plum-token': 'secret' } });
      expect(good.status).toBe(200);
      const body = (await good.json()) as { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] };
      const names = body.tools.map((tool) => tool.name);
      expect(names).toContain('look_at_lot');
      expect(names).toContain('reply');
      expect(body.tools.find((tool) => tool.name === 'look_at_lot')?.annotations?.readOnlyHint).toBe(true);
      const persona = await fetch(`http://127.0.0.1:${port}/plum/cc/persona`, {
        headers: { 'x-plum-token': 'secret' },
      });
      expect(await persona.text()).toContain('mcp__plum__reply');
    } finally {
      server.close();
    }
  });
});
