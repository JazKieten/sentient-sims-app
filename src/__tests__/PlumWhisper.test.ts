// Plum whispers (plan merry-conjuring-dahl, 2026-10-17): the Sim's side of one whisper
// (PlumWhisper.ts), the whisper tool, the whisper script (PlumWake.planScript: freeze,
// resume, replace_from, retry once, pause, cast gone), the director-gated tools and the
// director's hard stop.
import { beforeEach, describe, expect, it, MockInstance, vi } from 'vitest';
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
import { PlumService } from 'main/sentient-sims/services/PlumService';
import { DirectorService } from 'main/sentient-sims/services/DirectorService';
import { AIService, stripToSelf } from 'main/sentient-sims/services/AIService';
import type { MemoryRepository } from 'main/sentient-sims/db/MemoryRepository';
import { PlumModelClient, PlumModelRequest } from 'main/sentient-sims/services/plum/PlumModelClient';
import { buildAppTools } from 'main/sentient-sims/services/plum/PlumAppTools';
import { describe as describeTrigger, ScriptBeat } from 'main/sentient-sims/services/plum/PlumWake';
import {
  describeOutcome,
  parseDecision,
  PlumWhisperService,
  replyTag,
  WhisperResult,
} from 'main/sentient-sims/services/plum/PlumWhisper';
import { buildWhisperSystemPrompt } from 'main/sentient-sims/pipeline/prompts/plumWhisper';
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

const clickPieMenu: PlumModToolDef = {
  name: 'click_pie_menu',
  description: 'Click.',
  input_schema: {
    type: 'object',
    properties: {
      sim: { type: 'string' },
      target: { type: ['string', 'null'] },
      item: { type: 'string' },
      source: { type: ['string', 'null'] },
    },
    required: ['sim', 'target', 'item', 'source'],
    additionalProperties: false,
  },
  risk: 'write',
  timeout_ms: 20000,
  tier: 'core',
};

function report(seq: number, running: string | null, sims: [string, string][] = [['1', 'Bella Goth']]): SimStateReport {
  return {
    type: 'state_report',
    seq,
    sims: sims.map(([sim_id, sim_name]) => ({ sim_id, sim_name, sims: [], objects: [], activity: { running } })),
    lot: { lot_id: '55' },
  };
}

function notifications(): Record<string, unknown>[] {
  return sendModNotification.mock.calls.map((call) => call[0] as Record<string, unknown>);
}

function toolCalls(): Record<string, unknown>[] {
  return notifications().filter((notification) => notification.type === ModWebsocketMessageType.PLUM_TOOL_CALL);
}

function eventsOfKind(kind: string): Record<string, unknown>[] {
  return notifications().filter((event) => event.type === ModWebsocketMessageType.PLUM_EVENT && event.kind === kind);
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

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`missing ${what}`);
  }
  return value;
}

const SNACK = { key: 'super_GrabSnack', label: 'Grab Snack', targetId: '900', targetName: 'object_Fridge' };

describe('PlumWhisperService', () => {
  let ctx: ApiContext;
  let client: FakeModelClient;
  let plum: PlumService;
  let now: number;
  let answer: string;
  let oneShot: MockInstance<AIService['runOneShot']>;
  let played: MockInstance<AIService['playTtsLines']>;
  let stored: MockInstance<MemoryRepository['createMemory']>;

  beforeEach(() => {
    vi.useFakeTimers();
    sendModNotification.mockClear();
    clockState.current = { paused: false, paused_by: null };
    now = 1_000_000;
    ctx = mockApiContext({ tiers: [] });
    ctx.settings.set(SettingsEnum.PLUM_API_KEY, 'sk-test');
    client = new FakeModelClient();
    plum = new PlumService(ctx, {
      clientFactory: () => client,
      now: () => now,
      appTools: buildAppTools(
        ctx,
        () => plum.wake,
        () => plum.whisper,
      ),
    });
    plum.onModMessage({ kind: 'catalogue', tier: 'core', enabled: true, tools: [clickPieMenu] });
    ctx.simStateCache.ingest(report(1, 'cook'));
    answer = '{"willing": true, "reply": "Fine, I could eat.", "thought": "A snack would hit the spot."}';
    oneShot = vi
      .spyOn(ctx.ai, 'runOneShot')
      .mockImplementation(() => Promise.resolve({ text: answer, exchange: {} as never }));
    played = vi.spyOn(ctx.ai, 'playTtsLines').mockReturnValue(undefined);
    vi.spyOn(ctx.participantRepository, 'getParticipants').mockReturnValue([]);
    stored = vi.spyOn(ctx.memoryRepository, 'createMemory').mockReturnValue(undefined);
    sendModNotification.mockClear();
  });

  // The mod answers the click the whisper made
  async function answerClick(ok: boolean, result: Record<string, unknown> | string) {
    await flush();
    const calls = toolCalls().filter((call) => call.name === 'click_pie_menu');
    const call = calls[calls.length - 1];
    expect(call).toBeDefined();
    plum.onModMessage({
      kind: 'tool_result',
      request_id: call.request_id as string,
      ok,
      ...(ok ? { result: result } : { error: result as string }),
    });
    await flush();
  }

  it('an agreed nudge clicks the item as a whisper, airs the thought, and makes two tab rows', async () => {
    const pending = plum.whisper.whisper({
      simId: '1',
      simName: 'Bella Goth',
      line: 'You look peckish.',
      item: SNACK,
      origin: 'chat',
    });
    await flush();
    // The Sim answered from her status, the thread and the nudge
    expect(oneShot).toHaveBeenCalledTimes(1);
    const [label, system, user] = oneShot.mock.calls[0] as unknown as [string, string, string];
    expect(label).toBe('Plum whisper: Bella Goth');
    expect(system).toContain('You are playing Bella Goth');
    expect(system).toContain('quiet voice inside you');
    expect(system).not.toContain('Plum');
    expect(user).toBe(
      'The voice says: "You look peckish."\nIt is nudging you to: Grab Snack (with object_Fridge).\n\nAnswer as Bella Goth.',
    );
    // The click went to the mod as HER choice
    const [call] = toolCalls();
    expect(call.name).toBe('click_pie_menu');
    expect(call.args).toEqual({ sim: '1', target: '900', item: 'super_GrabSnack', source: 'whisper' });
    await answerClick(true, {
      changed: 'clicked "Grab Snack" on object_Fridge for Bella Goth',
      key: 'super_GrabSnack',
      interaction_id: '4242',
    });
    const result = await pending;
    expect(result).toMatchObject({
      accepted: true,
      reply: 'Fine, I could eat.',
      thought: 'A snack would hit the spot.',
      clicked: {
        changed: 'clicked "Grab Snack" on object_Fridge for Bella Goth',
        key: 'super_GrabSnack',
        interaction_id: '4242',
      },
      delivered: true,
    });
    expect(result.refused).toBeUndefined();
    // The thought: a monologue memory of hers (no action heading it) and a voiced (to self) line
    expect(stored).toHaveBeenCalledTimes(1);
    const [request] = stored.mock.calls[0] as unknown as [
      { memory: Record<string, unknown>; index: { owner: string } },
    ];
    expect(request.memory).toEqual({
      content: 'Bella Goth (to self): A snack would hit the spot.',
      location_id: 55,
      event_type: 'monologue',
    });
    expect(request.index.owner).toBe('1');
    expect(played).toHaveBeenCalledTimes(1);
    const [lines, , options] = played.mock.calls[0] as unknown as [
      { speaker: string; text: string; simId?: string }[],
      unknown,
      { paced: boolean; pacedText: string },
    ];
    expect(lines).toEqual([{ speaker: 'Bella Goth (to self)', text: 'A snack would hit the spot.', simId: '1' }]);
    expect(options).toEqual({ paced: true, pacedText: 'Bella Goth (to self): A snack would hit the spot.' });
    // Two rows, each sent to the tab as an event of its kind, both persisted by kind
    expect(plum.rows.map((row) => `${row.kind}:${row.name}:${row.text}`)).toEqual([
      'whisper:Bella Goth:You look peckish.',
      'reply:Bella Goth:Fine, I could eat.',
    ]);
    expect(plum.rows[1]).toMatchObject({ ok: true, summary: 'agreed' });
    expect(eventsOfKind('whisper')).toHaveLength(1);
    expect((eventsOfKind('reply')[0].row as { summary: string }).summary).toBe('agreed');
    // No model turn of Plum's: agreement never wakes it
    expect(client.requests).toHaveLength(0);
    // The journal / log line
    expect(
      describeOutcome(
        { simId: '1', simName: 'Bella Goth', line: 'You look peckish.', item: SNACK, origin: 'chat' },
        result,
      ),
    ).toBe(
      'you told Bella Goth "You look peckish."; Bella Goth: "Fine, I could eat." -> agreed, clicked "Grab Snack" on object_Fridge for Bella Goth',
    );
    // The mod watches the interaction: a `doing` trigger by id waits for its exact end
    plum.wake.set({
      kind: 'sim_finishes',
      simId: '1',
      simName: 'Bella Goth',
      doing: 'super_GrabSnack',
      note: 'snack done',
    });
    ctx.simStateCache.ingest(report(2, 'super_GrabSnack'));
    ctx.simStateCache.ingest(report(3, null));
    await flush();
    expect(client.requests).toHaveLength(0);
  });

  it('a click that took points the camera at the Sim (when the mod has camera_focus)', async () => {
    const cameraFocus: PlumModToolDef = {
      ...clickPieMenu,
      name: 'camera_focus',
      input_schema: {
        type: 'object',
        properties: { sim: { type: 'string' } },
        required: ['sim'],
        additionalProperties: false,
      },
    };
    plum.onModMessage({ kind: 'catalogue', tier: 'core', enabled: true, tools: [clickPieMenu, cameraFocus] });
    sendModNotification.mockClear();
    const pending = plum.whisper.whisper({
      simId: '1',
      simName: 'Bella Goth',
      line: 'Snack?',
      item: SNACK,
      origin: 'chat',
    });
    await answerClick(true, { changed: 'clicked', key: 'super_GrabSnack', interaction_id: '4242' });
    await pending;
    await flush();
    expect(toolCalls().map((call) => call.name)).toEqual(['click_pie_menu', 'camera_focus']);
    expect(toolCalls()[1].args).toEqual({ sim: '1' });
    // The camera is not a row of the conversation
    expect(plum.rows.map((row) => row.kind)).toEqual(['whisper', 'reply']);
  });

  it('a decline runs nothing, stores nothing and airs nothing; an unusable answer counts as a decline', async () => {
    answer = '{"willing": false, "reply": "I am not hungry, and I do not take orders."}';
    const result = await plum.whisper.whisper({
      simId: '1',
      simName: 'Bella Goth',
      line: 'Eat something.',
      item: SNACK,
      origin: 'chat',
    });
    expect(result).toEqual({ accepted: false, reply: 'I am not hungry, and I do not take orders.' });
    expect(toolCalls()).toHaveLength(0);
    expect(stored).not.toHaveBeenCalled();
    expect(played).not.toHaveBeenCalled();
    expect(plum.rows[1]).toMatchObject({ kind: 'reply', ok: false, summary: 'declined' });
    answer = 'Sure, whatever you say.';
    const calls = oneShot.mock.calls.length;
    const garbled = await plum.whisper.whisper({
      simId: '1',
      simName: 'Bella Goth',
      line: 'Eat.',
      item: SNACK,
      origin: 'chat',
    });
    expect(garbled).toEqual({ accepted: false, reply: '(no usable answer)' });
    // Asked twice before giving up, and the tab says it was a glitch, not a refusal
    expect(oneShot.mock.calls.length - calls).toBe(2);
    expect(plum.rows[plum.rows.length - 1].summary).toBe('no usable answer');
    expect(toolCalls()).toHaveLength(0);
    // The reply with the prose unquoted still parses (the loose block)
    answer = '{"willing": true, "reply": Alright then, "thought": I was heading to the fridge anyway}';
    const loose = plum.whisper.whisper({
      simId: '1',
      simName: 'Bella Goth',
      line: 'Eat.',
      item: SNACK,
      origin: 'chat',
    });
    await answerClick(true, { changed: 'clicked', key: 'super_GrabSnack' });
    expect(await loose).toMatchObject({
      accepted: true,
      reply: 'Alright then',
      thought: 'I was heading to the fridge anyway',
    });
  });

  it('an agreed click the world refuses keeps the agreement, airs no thought, and says why', async () => {
    const pending = plum.whisper.whisper({
      simId: '1',
      simName: 'Bella Goth',
      line: 'Snack?',
      item: SNACK,
      origin: 'chat',
    });
    await answerClick(
      false,
      'player_directed_interaction_pending: Bella Goth is doing something the player clicked (sim_Chat)',
    );
    const result = await pending;
    expect(result.accepted).toBe(true);
    expect(result.clicked).toBeUndefined();
    expect(result.refused).toBe(
      'player_directed_interaction_pending: Bella Goth is doing something the player clicked (sim_Chat)',
    );
    expect(result.delivered).toBeUndefined();
    expect(stored).not.toHaveBeenCalled();
    expect(played).not.toHaveBeenCalled();
    expect(plum.rows[1]).toMatchObject({ kind: 'reply', ok: false });
    expect((plum.rows[1].summary ?? '').startsWith('agreed, but player_directed_interaction_pending')).toBe(true);
    // Writes off: no click is even tried
    ctx.settings.set(SettingsEnum.PLUM_ALLOW_WRITES, false);
    sendModNotification.mockClear();
    const held = await plum.whisper.whisper({
      simId: '1',
      simName: 'Bella Goth',
      line: 'Snack?',
      item: SNACK,
      origin: 'chat',
    });
    expect(toolCalls()).toHaveLength(0);
    expect(held.refused).toContain('Plum may change things');
  });

  it('a whisper with no item is talk: nothing runs whatever the Sim says', async () => {
    answer = '{"willing": true, "reply": "Yes, it has been a long day."}';
    const result = await plum.whisper.whisper({ simId: '1', simName: 'Bella Goth', line: 'Long day?', origin: 'chat' });
    expect(result).toEqual({ accepted: true, reply: 'Yes, it has been a long day.' });
    expect(toolCalls()).toHaveLength(0);
    expect(stored).not.toHaveBeenCalled();
    expect(plum.rows[1].summary).toBe('');
    expect(
      replyTag(
        { simId: '1', simName: 'Bella Goth', line: 'x', origin: 'chat' },
        { accepted: false, reply: '(no usable answer)' },
      ),
    ).toBe('no usable answer');
    // The next whisper to her carries the thread
    await plum.whisper.whisper({ simId: '1', simName: 'Bella Goth', line: 'Rest then.', origin: 'chat' });
    const system = (oneShot.mock.calls[1] as unknown as [string, string])[1];
    expect(system).toContain('Earlier the voice said: "Long day?"');
    expect(system).toContain('You answered: "Yes, it has been a long day." (and went along with it)');
  });

  it('with the voice setting off the thought is shown, not spoken', async () => {
    ctx.settings.set(SettingsEnum.PLUM_WHISPER_VOICED, false);
    const pending = plum.whisper.whisper({
      simId: '1',
      simName: 'Bella Goth',
      line: 'Snack?',
      item: SNACK,
      origin: 'chat',
    });
    await answerClick(true, { changed: 'clicked', key: 'super_GrabSnack' });
    expect((await pending).delivered).toBe(true);
    expect(played).not.toHaveBeenCalled();
    const line = notifications().find((notification) => notification.type === ModWebsocketMessageType.SCENE_LINE);
    expect(line).toMatchObject({
      speaker: 'Bella Goth (to self)',
      text: 'A snack would hit the spot.',
      voiced: false,
      speaker_sim_id: '1',
    });
  });

  it("the whisper tool: resolves the Sim and the target, reports the reply, and is the turn's one push", async () => {
    client.queue.push(
      message(
        [
          text('Let me ask her.'),
          toolUse('tu_1', 'whisper', { sim: 'Bella', line: 'Grab a bite.', item: 'Grab Snack', target: 'fridge' }),
          toolUse('tu_2', 'whisper', { sim: 'Bella', line: 'And a nap.', item: 'Nap', target: null }),
        ],
        'tool_use',
      ),
    );
    client.queue.push(message([text('She agreed.')], 'end_turn'));
    const turn = plum.runTurn('tell Bella to eat', { maxPushes: 1 });
    await answerClick(true, {
      changed: 'clicked "Grab Snack" on object_Fridge for Bella Goth',
      key: 'super_GrabSnack',
      interaction_id: '7',
    });
    await turn;
    const [call] = toolCalls();
    expect(call.args).toEqual({ sim: '1', target: 'fridge', item: 'Grab Snack', source: 'whisper' });
    const results = client.requests[1].messages[2].content as Anthropic.Beta.Messages.BetaToolResultBlockParam[];
    expect(results[0].is_error).toBeUndefined();
    const content = JSON.parse(results[0].content as string) as Record<string, unknown>;
    expect(content.changed).toBe('Bella Goth agreed: clicked "Grab Snack" on object_Fridge for Bella Goth');
    expect(content).toMatchObject({
      accepted: true,
      reply: 'Fine, I could eat.',
      key: 'super_GrabSnack',
      interaction_id: '7',
    });
    // The second whisper in the same turn was held by the one-beat cap
    expect(results[1].is_error).toBe(true);
    expect(results[1].content as string).toContain('one beat per tick');
    expect(toolCalls()).toHaveLength(1);
    // Rows: the player, Plum, the tool row, then the whisper pair inside it, the held tool, Plum
    expect(plum.rows.map((row) => row.kind)).toEqual(['player', 'plum', 'tool', 'whisper', 'reply', 'tool', 'plum']);
    expect(plum.rows[2].summary).toBe('Bella Goth agreed: clicked "Grab Snack" on object_Fridge for Bella Goth');
    expect(plum.rows[5].summary).toBe('whisper held: one beat per tick');
    // The seed of the next thread renders the pair
    expect(plum.renderSeed([], plum.rows.slice(3, 5))).toContain('[you, to Bella Goth] Grab a bite.');
    expect(plum.renderSeed([], plum.rows.slice(3, 5))).toContain('[Bella Goth] Fine, I could eat. (agreed)');
  });

  it('plan_script and script are offered only with the director slot; whisper always', async () => {
    client.queue.push(message([text('Hi.')], 'end_turn'));
    await plum.runTurn('hi');
    const without = client.requests[0].tools.map((tool) => tool.name);
    expect(without).toContain('whisper');
    expect(without).not.toContain('plan_script');
    expect(without).not.toContain('script');
    ctx.ext.director = { start() {}, stop() {}, status: () => ({ active: false }), wake: () => false };
    plum.onModMessage({ kind: 'catalogue', tier: 'core', enabled: true, tools: [clickPieMenu] });
    client.queue.push(message([text('Hi again.')], 'end_turn'));
    await plum.runTurn('hi');
    const withDirector = client.requests[1].tools.map((tool) => tool.name);
    expect(withDirector).toContain('plan_script');
    expect(withDirector).toContain('script');
  });

  it('the parse repairs the shapes the cheap model sends: a lost quote, a lost comma, a cut-off thought', () => {
    // Live 2026-10-17: the reply never closed before "thought"
    expect(
      parseDecision(
        `{"willing": true, "reply": "I should probably drink some water before bed, it's been a long day, "thought": "I'm getting a bit dehydrated"}`,
      ),
    ).toEqual({
      willing: true,
      reply: "I should probably drink some water before bed, it's been a long day",
      thought: "I'm getting a bit dehydrated",
    });
    // Live 2026-10-17: no comma between the strings
    expect(
      parseDecision(`{"willing": true, "reply": "I'm so done with his antics, " "thought": "I need to let him know"}`),
    ).toEqual({ willing: true, reply: "I'm so done with his antics", thought: 'I need to let him know' });
    // A thought cut off by the token budget still yields the decision
    expect(parseDecision('{"willing": false, "reply": "No thanks.", "thought": "I was')).toEqual({
      willing: false,
      reply: 'No thanks.',
      thought: 'I was',
    });
    expect(parseDecision('{"willing": true, "reply": "Fine."}')).toEqual({ willing: true, reply: 'Fine.' });
    expect(parseDecision('Sure, whatever.')).toBeUndefined();
    expect(parseDecision('{"willing": "yes", "reply": "Fine."}')).toBeUndefined();
  });

  it('a "(to self)" speaker strips to the Sim', () => {
    expect(stripToSelf('Bella Goth (to self)')).toBe('Bella Goth');
    expect(stripToSelf('Bella Goth')).toBe('Bella Goth');
    expect(buildWhisperSystemPrompt({ simName: 'Bella Goth' })).not.toContain('\n\n\n');
  });
});

describe('the whisper script (PlumWake)', () => {
  let ctx: ApiContext;
  let client: FakeModelClient;
  let plum: PlumService;
  let now: number;
  let whispers: MockInstance<PlumWhisperService['whisper']>;
  let answers: WhisperResult[];

  const agreed = (id: string, key = 'super_GrabSnack'): WhisperResult => ({
    accepted: true,
    reply: 'Sure.',
    thought: 'Why not.',
    clicked: { changed: `clicked ${key}`, key, interaction_id: id },
    delivered: true,
  });
  const declined: WhisperResult = { accepted: false, reply: 'No. I would rather not.' };

  function beat(simId: string, simName: string, line: string, key: string): ScriptBeat {
    return { simId, simName, line, item: { key, label: key } };
  }

  const BEATS = [
    beat('1', 'Bella Goth', 'Grab a snack.', 'super_GrabSnack'),
    beat('2', 'Don Lothario', 'Go flirt with Bella.', 'mixer_social_Flirt'),
    beat('1', 'Bella Goth', 'Tell him off.', 'mixer_social_Insult'),
  ];

  beforeEach(() => {
    vi.useFakeTimers();
    sendModNotification.mockClear();
    clockState.current = { paused: false, paused_by: null };
    now = 1_000_000;
    ctx = mockApiContext({ tiers: [] });
    ctx.settings.set(SettingsEnum.PLUM_API_KEY, 'sk-test');
    client = new FakeModelClient();
    plum = new PlumService(ctx, {
      clientFactory: () => client,
      now: () => now,
      appTools: buildAppTools(
        ctx,
        () => plum.wake,
        () => plum.whisper,
      ),
    });
    plum.onModMessage({ kind: 'catalogue', tier: 'core', enabled: true, tools: [clickPieMenu] });
    ctx.simStateCache.ingest(
      report(1, 'cook', [
        ['1', 'Bella Goth'],
        ['2', 'Don Lothario'],
      ]),
    );
    answers = [];
    whispers = vi.spyOn(plum.whisper, 'whisper').mockImplementation(() => {
      const next = answers.shift();
      if (!next) {
        throw new Error('no scripted whisper answer left');
      }
      // The real service notes the watch for an accepted click
      if (next.clicked?.interaction_id) {
        plum.wake.noteWatched('1', next.clicked.interaction_id, next.clicked.key);
      }
      return Promise.resolve(next);
    });
    sendModNotification.mockClear();
  });

  function whisperedLines(): string[] {
    return whispers.mock.calls.map((call) => (call[0] as { line: string; beatLabel?: string }).line);
  }

  it('planScript whispers beat 1, chains the rest by interaction id, and never wakes Plum while Sims agree', async () => {
    answers.push(agreed('100'), agreed('200', 'mixer_social_Flirt'), agreed('300', 'mixer_social_Insult'));
    const planned = await plum.wake.planScript({ name: 'Snack Fight', beats: BEATS, recapNote: 'recap it' });
    expect(whisperedLines()).toEqual(['Grab a snack.']);
    expect((whispers.mock.calls[0][0] as { beatLabel: string }).beatLabel).toBe('script "Snack Fight" beat 1');
    expect(planned.frozen).toBeUndefined();
    expect(planned.changed).toContain(
      'SCRIPT "Snack Fight": whispered beat 1 (you told Bella Goth "Grab a snack."; Bella Goth: "Sure." -> agreed, clicked super_GrabSnack)',
    );
    expect(planned.beats.map((row) => `${row.n}:${row.sim}:${row.item}`)).toEqual([
      '1:Bella Goth:super_GrabSnack',
      '2:Don Lothario:mixer_social_Flirt',
      '3:Bella Goth:mixer_social_Insult',
    ]);
    const [w2, w3, wake] = plum.wake.list();
    expect(w2).toMatchObject({ script: 'Snack Fight', beat: 2, doingId: '100', simId: '1' });
    expect(w2.fromWhisper).toMatchObject({ simId: '1', item: { key: 'super_GrabSnack' }, retried: false });
    expect(w3).toMatchObject({ beat: 3, after: w2.id });
    expect(wake).toMatchObject({ closing: true, after: w3.id, note: 'recap it' });
    expect(describeTrigger(w2)).toBe(
      'when Bella Goth finishes "super_GrabSnack" (not started yet), then whisper to Don Lothario "Go flirt with Bella.", nudging mixer_social_Flirt',
    );
    expect(plum.wake.describeScript()).toEqual([
      `beat 2: ${w2.id} ${describeTrigger(w2)}`,
      `beat 3: ${w3.id} ${describeTrigger(w3)}`,
      `after the last beat: ${wake.id} wakes you (recap it)`,
    ]);
    // Beat 1 ends well: beat 2 is whispered, beat 3 now waits on its click
    plum.onModMessage({
      kind: 'interaction_ended',
      interaction_id: '100',
      sim_id: '1',
      name: 'super_GrabSnack',
      outcome: 'finished',
    });
    await flush();
    expect(whisperedLines()).toEqual(['Grab a snack.', 'Go flirt with Bella.']);
    expect(w3.after).toBeUndefined();
    expect(w3).toMatchObject({ doingId: '200', simId: '2', simName: 'Don Lothario' });
    expect(client.requests).toHaveLength(0);
    // Beat 2 ends well: beat 3; then the closing wake fires on beat 3's end
    plum.onModMessage({
      kind: 'interaction_ended',
      interaction_id: '200',
      sim_id: '2',
      name: 'mixer_social_Flirt',
      outcome: 'finished',
    });
    await flush();
    expect(whisperedLines()).toHaveLength(3);
    expect(client.requests).toHaveLength(0);
    const journal = plum.wake.takeJournal();
    expect(
      journal.some((line) =>
        line.includes('you told Don Lothario "Go flirt with Bella."; Don Lothario: "Sure." -> agreed'),
      ),
    ).toBe(true);
    client.queue.push(message([text('That was the scene.')], 'end_turn'));
    plum.onModMessage({
      kind: 'interaction_ended',
      interaction_id: '300',
      sim_id: '1',
      name: 'mixer_social_Insult',
      outcome: 'finished',
    });
    await flush();
    expect(client.requests).toHaveLength(1);
    expect(lastUserText(client.requests[0])).toContain('recap it');
    expect(plum.wake.list()).toHaveLength(0);
  });

  it('a decline freezes the script with one wake, keeps the chain, ignores ends while frozen, and resume goes on from the next beat', async () => {
    answers.push(agreed('100'), declined);
    await plum.wake.planScript({ name: 'Snack Fight', beats: BEATS, recapNote: 'recap it' });
    const [w2, w3, wake] = plum.wake.list();
    client.queue.push(message([text('Don said no; thinking.')], 'end_turn'));
    plum.onModMessage({
      kind: 'interaction_ended',
      interaction_id: '100',
      sim_id: '1',
      name: 'super_GrabSnack',
      outcome: 'finished',
    });
    await flush();
    await flush();
    expect(whisperedLines()).toEqual(['Grab a snack.', 'Go flirt with Bella.']);
    // Frozen: nothing dropped, exactly one wake carrying the reply
    expect(plum.wake.isFrozen()).toBe(true);
    expect(plum.wake.frozenReason()).toBe('Don Lothario declined beat 2: "No. I would rather not."');
    expect(plum.wake.list()).toEqual([w3, wake]);
    expect(client.requests).toHaveLength(1);
    const text1 = lastUserText(client.requests[0]);
    expect(text1).toContain(`<wake id="${w2.id}"`);
    expect(text1).toContain('Don Lothario: "No. I would rather not." -> declined');
    expect(text1).toContain('The script is frozen');
    expect(plum.wake.status()).toBe('script frozen: Don Lothario declined beat 2: "No. I would rather not."');
    expect(plum.wake.describeScript()[0]).toContain('FROZEN: Don Lothario declined beat 2');
    // While frozen an end on the cast does nothing, and a plain wake_me still fires
    answers.push(agreed('999'));
    plum.wake.set({ kind: 'sim_finishes', simId: '1', simName: 'Bella Goth', note: 'plain wake' });
    client.queue.push(message([text('Bella moved.')], 'end_turn'));
    ctx.simStateCache.ingest(
      report(2, null, [
        ['1', 'Bella Goth'],
        ['2', 'Don Lothario'],
      ]),
    );
    plum.onModMessage({
      kind: 'interaction_ended',
      interaction_id: '200',
      sim_id: '2',
      name: 'mixer_social_Flirt',
      outcome: 'finished',
    });
    await flush();
    await flush();
    expect(whisperedLines()).toHaveLength(2);
    expect(client.requests).toHaveLength(2);
    expect(lastUserText(client.requests[1])).toContain('plain wake');
    // Frozen time does not expire the script
    now += 3 * 3_600_000;
    ctx.simStateCache.ingest(
      report(3, null, [
        ['1', 'Bella Goth'],
        ['2', 'Don Lothario'],
      ]),
    );
    await flush();
    expect(plum.wake.list()).toEqual([w3, wake]);
    // Resume: beat 3 waits for Don (who froze it) to finish what he is doing now
    ctx.simStateCache.ingest(
      report(4, 'sim_Chat', [
        ['1', 'Bella Goth'],
        ['2', 'Don Lothario'],
      ]),
    );
    const resumed = plum.wake.resume();
    expect(resumed).toContain(`resumed; now waiting on ${w3.id}`);
    expect(plum.wake.isFrozen()).toBe(false);
    expect(w3).toMatchObject({ simId: '2', simName: 'Don Lothario', baseline: 'sim_Chat' });
    expect(w3.after).toBeUndefined();
    expect(w3.doingId).toBeUndefined();
    // ...and whispers beat 3 when he does
    ctx.simStateCache.ingest(
      report(5, null, [
        ['1', 'Bella Goth'],
        ['2', 'Don Lothario'],
      ]),
    );
    await flush();
    expect(whisperedLines()).toEqual(['Grab a snack.', 'Go flirt with Bella.', 'Tell him off.']);
    expect(wake).toMatchObject({ doingId: '999' });
  });

  it('replace_from drops the beats from n on and chains the new ones; cancel drops everything', async () => {
    answers.push(agreed('100'), declined);
    await plum.wake.planScript({ name: 'Snack Fight', beats: BEATS, recapNote: 'recap it' });
    const [, w3] = plum.wake.list();
    client.queue.push(message([text('no')], 'end_turn'));
    plum.onModMessage({
      kind: 'interaction_ended',
      interaction_id: '100',
      sim_id: '1',
      name: 'super_GrabSnack',
      outcome: 'finished',
    });
    await flush();
    await flush();
    expect(plum.wake.isFrozen()).toBe(true);
    // Beat 2 is spent, so the new beat 2 is whispered now and beat 3 chains on it
    answers.push(agreed('500', 'mixer_social_Chat'));
    const rewritten = await plum.wake.replaceFrom(
      2,
      [
        beat('2', 'Don Lothario', 'Just say hi then.', 'mixer_social_Chat'),
        beat('1', 'Bella Goth', 'Be kind.', 'mixer_social_Compliment'),
      ],
      'recap the softer take',
    );
    expect(plum.wake.isFrozen()).toBe(false);
    expect(plum.wake.list().includes(w3)).toBe(false);
    expect(whisperedLines().at(-1)).toBe('Just say hi then.');
    expect(rewritten.beats.map((row) => `${row.n}:${row.item}`)).toEqual([
      '2:mixer_social_Chat',
      '3:mixer_social_Compliment',
    ]);
    const [n3, wake] = plum.wake.list();
    expect(n3).toMatchObject({ beat: 3, doingId: '500', simId: '2' });
    expect(wake).toMatchObject({ closing: true, after: n3.id, note: 'recap the softer take' });
    // Rewriting from a beat whose predecessor is still armed chains after it instead
    const later = await plum.wake.replaceFrom(4, [beat('2', 'Don Lothario', 'Leave.', 'super_Leave')], 'done');
    expect(whisperedLines()).toHaveLength(3);
    expect(later.changed).toContain(`beats 4.. rewritten after ${n3.id}`);
    expect(plum.wake.list().map((trigger) => trigger.beat ?? 'wake')).toEqual([3, 4, 'wake']);
    expect(plum.wake.cancelAll()).toBe(3);
    expect(plum.wake.describeScript()).toEqual([]);
  });

  it('an accepted beat that ends canceled is clicked again once; a second cancel or a refused retry freezes', async () => {
    answers.push(agreed('100'), agreed('200', 'mixer_social_Flirt'));
    await plum.wake.planScript({ name: 'Snack Fight', beats: BEATS, recapNote: 'recap it' });
    const [w2] = plum.wake.list();
    plum.onModMessage({
      kind: 'interaction_ended',
      interaction_id: '100',
      sim_id: '1',
      name: 'super_GrabSnack',
      outcome: 'canceled',
    });
    await flush();
    // The same click again, no new decision
    expect(whisperedLines()).toHaveLength(1);
    const [retry] = toolCalls();
    expect(retry.name).toBe('click_pie_menu');
    expect(retry.args).toEqual({ sim: '1', target: null, item: 'super_GrabSnack', source: 'whisper' });
    plum.onModMessage({
      kind: 'tool_result',
      request_id: retry.request_id as string,
      ok: true,
      result: { changed: 'clicked again', interaction_id: '101' },
    });
    await flush();
    expect(plum.wake.isFrozen()).toBe(false);
    expect(w2).toMatchObject({ doingId: '101' });
    expect(w2.fromWhisper?.retried).toBe(true);
    expect(client.requests).toHaveLength(0);
    // The retry ends canceled too: freeze, one wake, beat 2 still armed for resume
    client.queue.push(message([text('Bella keeps dropping it.')], 'end_turn'));
    plum.onModMessage({
      kind: 'interaction_ended',
      interaction_id: '101',
      sim_id: '1',
      name: 'super_GrabSnack',
      outcome: 'canceled',
    });
    await flush();
    await flush();
    expect(plum.wake.isFrozen()).toBe(true);
    expect(plum.wake.frozenReason()).toContain('clicked again once already');
    expect(plum.wake.list().includes(w2)).toBe(true);
    expect(client.requests).toHaveLength(1);
    expect(lastUserText(client.requests[0])).toContain('was not made. The script is frozen');
    expect(whisperedLines()).toHaveLength(1);
  });

  it("the player's pause defers a beat to the unpause; a cast Sim gone from the lot is a hard stop", async () => {
    answers.push(agreed('100'));
    await plum.wake.planScript({ name: 'Snack Fight', beats: BEATS, recapNote: 'recap it' });
    const [w2] = plum.wake.list();
    clockState.current = { paused: true, paused_by: 'user' };
    plum.onModMessage({
      kind: 'interaction_ended',
      interaction_id: '100',
      sim_id: '1',
      name: 'super_GrabSnack',
      outcome: 'finished',
    });
    await flush();
    expect(whisperedLines()).toEqual(['Grab a snack.']);
    expect(plum.wake.isFrozen()).toBe(false);
    expect(plum.wake.describeScript()[0]).toBe(
      `beat 2: ${w2.id} whisper to Don Lothario "Go flirt with Bella.", nudging mixer_social_Flirt (waits for the unpause)`,
    );
    // Unpaused: the next report whispers it
    answers.push(agreed('200', 'mixer_social_Flirt'));
    clockState.current = { paused: false, paused_by: null };
    ctx.simStateCache.ingest(
      report(2, null, [
        ['1', 'Bella Goth'],
        ['2', 'Don Lothario'],
      ]),
    );
    await flush();
    expect(whisperedLines()).toEqual(['Grab a snack.', 'Go flirt with Bella.']);
    expect(client.requests).toHaveLength(0);
    // Bella (beat 3's Sim) leaves the lot: frozen without Plum's say, one wake
    client.queue.push(message([text('Bella left.')], 'end_turn'));
    ctx.simStateCache.ingest(report(3, null, [['2', 'Don Lothario']]));
    await flush();
    await flush();
    expect(plum.wake.isFrozen()).toBe(true);
    expect(plum.wake.frozenReason()).toBe('Bella Goth is no longer on the lot (beat 3 was theirs)');
    expect(client.requests).toHaveLength(1);
    expect(lastUserText(client.requests[0])).toContain('Bella Goth is no longer on the lot');
    expect(plum.wake.list()).toHaveLength(2);
  });

  it('plan_script through the tool resolves the Sims and items; the director freezes the script on an emergency', async () => {
    const director = new DirectorService(ctx, { now: () => now, plum });
    ctx.ext.director = director;
    plum.onModMessage({ kind: 'catalogue', tier: 'core', enabled: true, tools: [clickPieMenu] });
    const planScript = buildAppTools(
      ctx,
      () => plum.wake,
      () => plum.whisper,
    ).find((tool) => tool.definition.name === 'plan_script');
    expect(must(planScript, 'plan_script').onlyWith).toBe('director');
    answers.push(agreed('100'));
    const planned = (await must(planScript, 'plan_script').run({
      name: 'Snack Fight',
      beats: [
        { sim: 'Bella', line: 'Grab a snack.', item: 'Grab Snack', target: 'fridge' },
        { sim: 'Don', line: 'Flirt with Bella.', item: 'Flirt', target: 'Bella' },
      ],
      recap_note: 'recap',
    })) as { script: string; beats: { sim: string }[] };
    expect(planned.script).toBe('Snack Fight');
    expect(planned.beats.map((row) => row.sim)).toEqual(['Bella Goth', 'Don Lothario']);
    const request = whispers.mock.calls[0][0] as { item: { key: string; targetId?: string; targetName?: string } };
    expect(request.item).toEqual({ key: 'Grab Snack', label: 'Grab Snack', targetId: 'fridge', targetName: 'fridge' });
    const [w2] = plum.wake.list();
    expect(w2.then).toMatchObject({
      do: 'whisper',
      simId: '2',
      item: { key: 'Flirt', targetId: '1', targetName: 'Bella Goth' },
    });
    await expect(
      must(planScript, 'plan_script').run({
        name: 'x',
        beats: [{ sim: 'Bella', line: 'hi', item: '', target: '' }],
        recap_note: 'r',
      }),
    ).rejects.toThrow('beat 1 needs `item`');
    // A fire on the lot while the director runs: frozen once, held, and thawed by the script tool
    client.queue.push(message([text('ARC: Snack Fight')], 'end_turn'));
    director.start();
    await flush();
    ctx.simStateCache.ingest({
      ...report(2, null, [
        ['1', 'Bella Goth'],
        ['2', 'Don Lothario'],
      ]),
      lot: { action_keys: ['call_firefighter'] },
    });
    await director.tick();
    expect(director.status().suspended).toContain('emergency');
    expect(plum.wake.isFrozen()).toBe(true);
    expect(plum.wake.frozenReason()).toContain('emergency');
    const script = buildAppTools(
      ctx,
      () => plum.wake,
      () => plum.whisper,
    ).find((tool) => tool.definition.name === 'script');
    const shown = (await must(script, 'script').run({ do: 'show', from_beat: 0, beats: [], recap_note: '' })) as {
      script: string[];
    };
    expect(shown.script[0]).toContain('FROZEN: an emergency');
    const resumed = (await must(script, 'script').run({ do: 'resume', from_beat: 0, beats: [], recap_note: '' })) as {
      changed: string;
    };
    expect(resumed.changed).toBe('script resumed');
    expect(plum.wake.isFrozen()).toBe(false);
    director.stop();
  });
});
