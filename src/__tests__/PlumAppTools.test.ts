import * as fs from 'fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('main/sentient-sims/websocketServer', () => ({
  sendModNotification: vi.fn(),
  getModClockState: () => undefined,
}));

import { ApiContext } from 'main/sentient-sims/services/ApiContext';
import { SimStateReport } from 'main/sentient-sims/models/SimStateReport';
import { buildAppTools, describePoll, resolveSimId } from 'main/sentient-sims/services/plum/PlumAppTools';
import { mockApiContext } from './util';

const BELLA = '100';
const DON = '200';

function reportWith(...sims: [string, string][]): SimStateReport {
  return {
    type: 'state_report',
    seq: 1,
    sims: sims.map(([sim_id, sim_name]) => ({ sim_id, sim_name, sims: [], objects: [] })),
  };
}

function loadedContext(): ApiContext {
  const ctx = mockApiContext({ tiers: [] });
  fs.mkdirSync(ctx.directory.getSentientSimsFolder(), { recursive: true });
  ctx.db.loadDatabase({ sessionId: `plum-${Date.now()}`, saveId: '1' });
  ctx.participantRepository.updateParticipant({ id: BELLA, name: 'Bella Goth' });
  ctx.participantRepository.updateParticipant({ id: DON, name: 'Don Lothario' });
  return ctx;
}

function tool(ctx: ApiContext, name: string) {
  const found = buildAppTools(ctx).find((candidate) => candidate.definition.name === name);
  if (!found) {
    throw new Error(`no app tool ${name}`);
  }
  return found;
}

describe('Plum app-side tools', () => {
  it('wake_me sets, describes and cancels wake-ups', async () => {
    const ctx = mockApiContext({ tiers: [] });
    ctx.simStateCache.ingest({
      type: 'state_report',
      seq: 1,
      sims: [{ sim_id: BELLA, sim_name: 'Bella Goth', sims: [], objects: [], activity: { running: 'cook' } }],
    });
    const wakeMe = tool(ctx, 'wake_me');
    const set = (await wakeMe.run({
      when: 'sim_finishes',
      sim: 'Bella',
      at: null,
      minutes: null,
      note: 'check dinner',
    })) as {
      changed: string;
      pending: number;
    };
    expect(set.changed).toBe('will wake when Bella Goth finishes "cook": check dinner');
    expect(set.pending).toBe(1);
    const timed = (await wakeMe.run({
      when: 'game_time',
      sim: null,
      at: '18:30',
      minutes: null,
      note: 'dinner time',
    })) as {
      changed: string;
    };
    expect(timed.changed).toBe('will wake at 18:30: dinner time');
    await expect(wakeMe.run({ when: 'game_time', sim: null, at: 'six', minutes: null, note: 'x' })).rejects.toThrow(
      'HH:MM',
    );
    await expect(wakeMe.run({ when: 'real_minutes', sim: null, at: null, minutes: 0, note: 'x' })).rejects.toThrow(
      'between 1 and',
    );
    await expect(
      wakeMe.run({ when: 'sim_finishes', sim: 'Mortimer', at: null, minutes: null, note: 'x' }),
    ).rejects.toThrow('no Sim called');
    await expect(wakeMe.run({ when: 'real_minutes', sim: null, at: null, minutes: 5, note: '' })).rejects.toThrow(
      'needs a note',
    );
    expect(ctx.plum.wake.list()).toHaveLength(2);
    const cancelled = (await wakeMe.run({ when: 'cancel', sim: null, at: null, minutes: null, note: '' })) as {
      changed: string;
    };
    expect(cancelled.changed).toBe('cancelled 2 wake-ups');
    expect(ctx.plum.wake.list()).toHaveLength(0);
  });

  it('set_trigger validates its Sims and action, and describes the armed trigger', async () => {
    const ctx = mockApiContext({ tiers: [] });
    ctx.simStateCache.ingest({
      type: 'state_report',
      seq: 1,
      sims: [
        { sim_id: BELLA, sim_name: 'Bella Goth', sims: [], objects: [], activity: { running: 'cook' } },
        { sim_id: DON, sim_name: 'Don Lothario', sims: [], objects: [] },
      ],
    });
    const setTrigger = tool(ctx, 'set_trigger');
    expect(setTrigger.definition.risk).toBe('write');
    const base = { when: 'sim_finishes', sim: 'Bella', doing: 'insult', after: null, at: null, note: 'adapt the arc' };
    const armed = (await setTrigger.run({
      ...base,
      then: 'push_action',
      push_sim: 'Bella',
      push_action: 'gossip',
      push_target: 'Don',
    })) as { changed: string; id: string; pending: number };
    expect(armed.changed).toBe(
      `armed ${armed.id}: when Bella Goth finishes "insult" (not started yet), then push gossip on Bella Goth (with Don Lothario)`,
    );
    expect(armed.pending).toBe(1);
    const trigger = ctx.plum.wake.list()[0];
    expect(trigger.then).toEqual({
      do: 'push_action',
      simId: BELLA,
      simName: 'Bella Goth',
      action: 'gossip',
      targetId: DON,
      targetName: 'Don Lothario',
    });
    const wake = (await setTrigger.run({
      when: 'game_time',
      sim: null,
      doing: null,
      after: null,
      at: '21:00',
      then: 'wake',
      push_sim: null,
      push_action: null,
      push_target: null,
      note: 'recap the arc',
    })) as { changed: string };
    expect(wake.changed).toContain('at 21:00: recap the arc');
    expect(ctx.plum.wake.list()[1].then).toBeUndefined();

    const noPush = { push_sim: null, push_action: null, push_target: null };
    await expect(setTrigger.run({ ...base, then: 'push_action', ...noPush })).rejects.toThrow('needs `push_sim`');
    await expect(
      setTrigger.run({ ...base, then: 'push_action', push_sim: 'Mortimer', push_action: 'gossip', push_target: null }),
    ).rejects.toThrow("no Sim called 'Mortimer'");
    await expect(
      setTrigger.run({ ...base, then: 'push_action', push_sim: 'Bella', push_action: 'gossip', push_target: 'Nobody' }),
    ).rejects.toThrow("no Sim called 'Nobody'");
    await expect(setTrigger.run({ ...base, sim: 'Mortimer', then: 'wake', ...noPush })).rejects.toThrow(
      'no Sim called',
    );
    await expect(setTrigger.run({ ...base, then: 'wake', ...noPush, note: '' })).rejects.toThrow('needs a note');
    await expect(setTrigger.run({ ...base, when: 'real_minutes', then: 'wake', ...noPush })).rejects.toThrow(
      'sim_finishes or game_time',
    );
    expect(ctx.plum.wake.list()).toHaveLength(2);
  });

  it('resolves a Sim by id, full name or first name from the state report, then the participants', () => {
    const ctx = mockApiContext({ tiers: [] });
    ctx.simStateCache.ingest(reportWith([BELLA, 'Bella Goth'], [DON, 'Don Lothario'], ['300', 'Bella Bachelor']));
    expect(resolveSimId(ctx, '200')).toBe('200');
    expect(resolveSimId(ctx, 'bella goth')).toBe(BELLA);
    expect(resolveSimId(ctx, 'Don')).toBe(DON);
    // Two Bellas: ambiguous
    expect(resolveSimId(ctx, 'Bella')).toBeUndefined();
    expect(resolveSimId(ctx, 'Mortimer')).toBeUndefined();
    expect(resolveSimId(ctx, '')).toBeUndefined();
  });

  it('recent_memories lists the newest memories, filtered to one Sim', async () => {
    const ctx = loadedContext();
    ctx.memoryRepository.createMemory({
      memory: { location_id: 1, content: 'Bella and Don talked about the weather.', action: 'chat' },
      participants: [{ id: BELLA }, { id: DON }],
    });
    ctx.memoryRepository.createMemory({
      memory: { location_id: 1, content: 'Don cooked alone.', action: 'cook' },
      participants: [{ id: DON }],
    });
    const all = (await tool(ctx, 'recent_memories').run({ n: null, sim: null })) as { memories: { text: string }[] };
    expect(all.memories.map((memory) => memory.text)).toEqual([
      'Bella and Don talked about the weather.',
      'Don cooked alone.',
    ]);
    const bella = (await tool(ctx, 'recent_memories').run({ n: 5, sim: 'Bella' })) as {
      memories: { text: string; participants: string[] }[];
    };
    expect(bella.memories).toHaveLength(1);
    expect(bella.memories[0].participants).toContain('Bella Goth');
    const one = (await tool(ctx, 'recent_memories').run({ n: 1, sim: null })) as { memories: unknown[] };
    expect(one.memories).toHaveLength(1);
  });

  it('sim_facts names the Sims in the facts and refuses an unknown Sim', async () => {
    const ctx = loadedContext();
    ctx.semanticMemory.addFact({
      subjectSimId: BELLA,
      predicate: 'likes',
      objectSimId: DON,
      source: 'told',
      confidence: 0.8,
    });
    const facts = (await tool(ctx, 'sim_facts').run({ sim: 'Bella Goth', about: null })) as {
      sim: string;
      facts: { predicate: string; object: string }[];
    };
    expect(facts.sim).toBe('Bella Goth');
    expect(facts.facts).toEqual([expect.objectContaining({ predicate: 'likes', object: 'Don Lothario' })]);
    await expect(tool(ctx, 'sim_facts').run({ sim: 'Mortimer', about: null })).rejects.toThrow('Mortimer');
  });

  it('cognition_status needs the autonomy slot and reads it when present', async () => {
    const ctx = loadedContext();
    await expect(tool(ctx, 'cognition_status').run({ sim: 'Bella' })).rejects.toThrow('Full Autonomy');
    ctx.ext.plumCognition = (simId) => ({ plan: { goals: [{ key: `goal for ${simId}` }] }, outcomes: [] });
    const status = (await tool(ctx, 'cognition_status').run({ sim: 'Bella' })) as { plan: { goals: unknown[] } };
    expect(status.plan.goals).toEqual([{ key: `goal for ${BELLA}` }]);
  });

  it('set_trigger with `after` chains onto an armed push trigger', async () => {
    const ctx = mockApiContext({ tiers: [] });
    ctx.simStateCache.ingest(reportWith([BELLA, 'Bella Goth'], [DON, 'Don Lothario']));
    const setTrigger = tool(ctx, 'set_trigger');
    const common = { when: 'sim_finishes', at: null, then: 'push_action', push_target: null, note: 'adapt' };
    const armed = (await setTrigger.run({
      ...common,
      sim: 'Bella',
      doing: 'insult',
      after: null,
      push_sim: 'Bella',
      push_action: 'gossip',
    })) as { id: string };
    // With `after` the Sim and doing come from the parent: sim and doing may be null
    const chained = (await setTrigger.run({
      ...common,
      sim: null,
      doing: null,
      after: armed.id,
      push_sim: 'Don',
      push_action: 'gossip',
    })) as { changed: string; id: string; pending: number };
    expect(chained.changed).toBe(
      `armed ${chained.id}: after ${armed.id}, when Bella Goth finishes the beat it pushes, then push gossip on Don Lothario`,
    );
    expect(chained.pending).toBe(2);
    expect(ctx.plum.wake.list()[1]).toMatchObject({ after: armed.id, simId: BELLA, simName: 'Bella Goth' });
    await expect(
      setTrigger.run({ ...common, sim: null, doing: null, after: 'wnope', push_sim: 'Don', push_action: 'gossip' }),
    ).rejects.toThrow('`after` names no armed push trigger (wnope)');
    expect(ctx.plum.wake.list()).toHaveLength(2);
  });

  it('plan_arc resolves every Sim before pushing and refuses an unknown one with nothing armed', async () => {
    const ctx = mockApiContext({ tiers: [] });
    ctx.simStateCache.ingest(reportWith([BELLA, 'Bella Goth'], [DON, 'Don Lothario']));
    const planArc = tool(ctx, 'plan_arc');
    expect(planArc.definition.risk).toBe('write');
    const { sendModNotification } = await import('main/sentient-sims/websocketServer');
    vi.mocked(sendModNotification).mockClear();
    const beats = [
      { sim: 'Bella', action: 'insult', target: 'Don' },
      { sim: 'Mortimer', action: 'gossip', target: null },
    ];
    await expect(planArc.run({ name: 'X', beats, recap_note: 'recap', beat_note: null })).rejects.toThrow(
      "beat 2: no Sim called 'Mortimer'",
    );
    await expect(
      planArc.run({
        name: 'X',
        beats: [{ sim: 'Bella', action: 'insult', target: 'Nobody' }],
        recap_note: 'r',
        beat_note: null,
      }),
    ).rejects.toThrow("beat 1: no Sim called 'Nobody'");
    await expect(planArc.run({ name: '', beats: beats.slice(0, 1), recap_note: 'r', beat_note: null })).rejects.toThrow(
      'needs a name',
    );
    await expect(planArc.run({ name: 'X', beats: [], recap_note: 'r', beat_note: null })).rejects.toThrow(
      '1 to 7 beats, not 0',
    );
    await expect(planArc.run({ name: 'X', beats: beats.slice(0, 1), recap_note: '', beat_note: null })).rejects.toThrow(
      'needs a recap_note',
    );
    // Nothing reached the game and nothing was armed
    expect(sendModNotification).not.toHaveBeenCalled();
    expect(ctx.plum.wake.list()).toHaveLength(0);
  });

  it('every app tool is strict with every property required, nested objects included', () => {
    const ctx = mockApiContext({ tiers: [] });
    type Schema = {
      type?: unknown;
      properties?: Record<string, Schema>;
      required?: string[];
      additionalProperties?: boolean;
      items?: Schema;
    };
    const expectStrict = (schema: Schema) => {
      if (schema.properties) {
        expect(schema.additionalProperties).toBe(false);
        expect([...(schema.required ?? [])].sort()).toEqual(Object.keys(schema.properties).sort());
        Object.values(schema.properties).forEach(expectStrict);
      }
      if (schema.items) {
        expectStrict(schema.items);
      }
    };
    const names = buildAppTools(ctx).map(({ definition }) => {
      expectStrict(definition.input_schema);
      return definition.name;
    });
    expect(names).toContain('plan_arc');
  });

  it('poll_chat is gated on the stream slot, asks the player first and keeps to Twitch limits', async () => {
    const ctx = mockApiContext({ tiers: [] });
    const pollChat = tool(ctx, 'poll_chat');
    expect(pollChat.onlyWith).toBe('chatPoll');
    expect(pollChat.definition.risk).toBe('destructive');
    const base = { question: 'Does Anker move in?', options: ['Move in', 'Not yet'], seconds: 0, note: 'move him' };
    await expect(pollChat.run({ ...base, confirmed_by_player: true })).rejects.toThrow('not part of this build');

    const open = vi.fn().mockResolvedValue({ id: 'poll-1', mode: 'chat', seconds: 90 });
    ctx.ext.chatPoll = { open, cancel: vi.fn(), current: () => undefined };
    await expect(pollChat.run({ ...base, confirmed_by_player: false })).rejects.toThrow('ask the player first');
    await expect(pollChat.run({ ...base, options: ['Only one'], confirmed_by_player: true })).rejects.toThrow(
      '2-5 options',
    );
    await expect(
      pollChat.run({ ...base, options: ['Move in', 'Not yet, give it a few more weeks'], confirmed_by_player: true }),
    ).rejects.toThrow('1-25 characters');
    await expect(pollChat.run({ ...base, seconds: 5, confirmed_by_player: true })).rejects.toThrow('seconds must be');

    const result = (await pollChat.run({ ...base, confirmed_by_player: true })) as { changed: string; id: string };
    expect(open).toHaveBeenCalledWith({ question: base.question, options: base.options, seconds: 0, note: 'move him' });
    expect(result.changed).toBe('opened a chat vote (!vote) for 90 s: Does Anker move in?');
  });

  it('hand_off shows the task in the game and the tab', async () => {
    const { sendModNotification } = await import('main/sentient-sims/websocketServer');
    vi.mocked(sendModNotification).mockClear();
    const ctx = mockApiContext({ tiers: [] });
    const handOff = tool(ctx, 'hand_off');
    expect(handOff.definition.risk).toBe('read');
    const result = (await handOff.run({ task: 'Move Anker into the Calloway household', why: 'no move-in tool' })) as {
      changed: string;
    };
    expect(result.changed).toBe('over to you: Move Anker into the Calloway household');
    expect(vi.mocked(sendModNotification).mock.calls[0][0]).toMatchObject({
      type: 'notification',
      notification: { title: 'Plum: over to you', message: 'Move Anker into the Calloway household' },
    });
    await expect(handOff.run({ task: ' ', why: '' })).rejects.toThrow('needs the task');
  });

  it('describePoll renders the open poll for the live block', () => {
    expect(describePoll(undefined)).toBeUndefined();
    expect(
      describePoll({
        id: 'poll-1',
        question: 'Q?',
        mode: 'chat',
        options: [
          { title: 'A', votes: 2 },
          { title: 'B', votes: 0 },
        ],
        secondsLeft: 41,
      }),
    ).toBe('"Q?" (chat vote, 41 s left): 1. A 2, 2. B 0');
  });
});
