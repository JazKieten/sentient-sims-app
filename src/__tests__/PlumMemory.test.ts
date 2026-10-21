import * as fs from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';

const sendModNotification = vi.hoisted(() => vi.fn());

vi.mock('main/sentient-sims/websocketServer', () => ({
  sendModNotification,
  getModClockState: () => undefined,
}));

import { SettingsEnum } from 'main/sentient-sims/models/SettingsEnum';
import { ModWebsocketMessageType } from 'main/sentient-sims/models/ModWebsocketMessage';
import { ApiContext } from 'main/sentient-sims/services/ApiContext';
import { HISTORY_ROWS, PlumService } from 'main/sentient-sims/services/PlumService';
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

function reply(text: string): BetaMessage {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as BetaMessage;
}

function eventsOfKind(kind: string): Record<string, unknown>[] {
  return sendModNotification.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((event) => event.type === ModWebsocketMessageType.PLUM_EVENT && event.kind === kind);
}

function loadedContext(): ApiContext {
  const ctx = mockApiContext({ tiers: [] });
  fs.mkdirSync(ctx.directory.getSentientSimsFolder(), { recursive: true });
  ctx.db.loadDatabase({ sessionId: `plum-memory-${Date.now()}-${Math.random()}`, saveId: '1' });
  ctx.settings.set(SettingsEnum.PLUM_API_KEY, 'sk-test');
  return ctx;
}

describe('PlumRepository', () => {
  it('round-trips rows and notes and returns the tail oldest first', () => {
    const ctx = loadedContext();
    const repo = ctx.plumRepository;
    for (let i = 0; i < 5; i += 1) {
      repo.appendMessage('t1', 'player', { row_id: `r${i}`, kind: 'player', text: `line ${i}` }, 10 + i);
    }
    repo.appendMessage('t2', 'plum', { row_id: 'x', kind: 'plum', text: 'other thread' });
    const tail = repo.recentRows('t1', 3);
    expect(tail.map((row) => row.content.text)).toEqual(['line 2', 'line 3', 'line 4']);
    expect(tail[0].game_day).toBe(12);
    expect(repo.lastThreadId()).toBe('t2');

    repo.addNote('note', 'The player likes Bella left alone.', ['100'], 12);
    repo.addNote('summary', 'We talked about the bills.');
    const notes = repo.notes(40);
    expect(notes.map((note) => note.kind)).toEqual(['note', 'summary']);
    expect(notes[0].sim_ids).toEqual(['100']);
    expect(notes[0].game_day).toBe(12);
    expect(notes[1].sim_ids).toEqual([]);
    expect(repo.deleteNote(notes[0].id)).toBe(true);
    expect(repo.notes(40)).toHaveLength(1);
  });

  it('replaceNote keeps one note of its kind: the newest, or none for an empty text', () => {
    const ctx = loadedContext();
    const repo = ctx.plumRepository;
    repo.addNote('note', 'Unrelated.');
    repo.replaceNote('director', 'ARC Dinner, beat 1.', [], 4);
    repo.replaceNote('director', 'ARC Dinner, beats 1-2.', [], 4);
    expect(repo.latestNote('director')).toMatchObject({
      kind: 'director',
      text: 'ARC Dinner, beats 1-2.',
      game_day: 4,
    });
    expect(repo.notes(40).map((note) => note.text)).toEqual(['Unrelated.', 'ARC Dinner, beats 1-2.']);
    expect(repo.replaceNote('director', '')).toBeUndefined();
    expect(repo.latestNote('director')).toBeUndefined();
    expect(repo.notes(40).map((note) => note.text)).toEqual(['Unrelated.']);
  });
});

describe('Plum memory across sessions', () => {
  beforeEach(() => {
    sendModNotification.mockClear();
  });

  it('stores every row, replays the last conversation on load, and seeds the next turn with it', async () => {
    const ctx = loadedContext();
    const client = new FakeModelClient();
    const plum = new PlumService(ctx, { clientFactory: () => client, appTools: [] });
    plum.onModMessage({ kind: 'catalogue', tier: 'core', enabled: true, tools: [] });
    client.queue.push(reply('Hello there.'));
    await plum.runTurn('hello plum');
    ctx.plumRepository.addNote('note', 'Scott likes the lights off at night.', [], 3);

    // A second service over the same save, as the next app session would build
    const later = new PlumService(ctx, { clientFactory: () => client, appTools: [] });
    later.onModMessage({ kind: 'catalogue', tier: 'core', enabled: true, tools: [] });
    sendModNotification.mockClear();
    later.onDatabaseLoaded();
    expect(later.threadId).toBe(plum.threadId);
    const [history] = eventsOfKind('history');
    expect((history.rows as { kind: string; text: string }[]).map((row) => `${row.kind}:${row.text}`)).toEqual([
      'player:hello plum',
      'plum:Hello there.',
    ]);

    client.requests = [];
    client.queue.push(reply('Welcome back.'));
    await later.runTurn('remember me?');
    const blocks = client.requests[0].messages[0].content as Anthropic.Beta.Messages.BetaTextBlockParam[];
    expect(blocks).toHaveLength(3);
    expect(blocks[1].text).toContain('[note (day 3)] Scott likes the lights off at night.');
    expect(blocks[1].text).toContain('[player] hello plum');
    expect(blocks[1].text).toContain('[plum] Hello there.');
    expect(blocks[2].text).toBe('remember me?');
    // The seed rides only the first turn of a thread
    client.queue.push(reply('Still here.'));
    await later.runTurn('and now?');
    const second = client.requests[1].messages;
    const lastUser = second[second.length - 1].content as Anthropic.Beta.Messages.BetaTextBlockParam[];
    expect(lastUser).toHaveLength(2);
  });

  it("the director's note survives an app restart and never rides the chat seed", async () => {
    const ctx = loadedContext();
    const client = new FakeModelClient();
    const plum = new PlumService(ctx, { clientFactory: () => client, appTools: [] });
    plum.onModMessage({ kind: 'catalogue', tier: 'core', enabled: true, tools: [] });
    ctx.plumRepository.addNote('note', 'Scott likes the lights off at night.', [], 3);
    plum.setDirectorNote('ARC Dinner: Bella cooks for Don. Beat 1 landed.');
    plum.setDirectorNote('ARC Dinner: Bella cooks for Don. Beats 1-2 landed.');
    expect(ctx.plumRepository.notes(40).filter((note) => note.kind === 'director')).toHaveLength(1);

    // The next app session over the same save
    const later = new PlumService(ctx, { clientFactory: () => client, appTools: [] });
    later.onModMessage({ kind: 'catalogue', tier: 'core', enabled: true, tools: [] });
    expect(later.directorNoteText).toBeUndefined();
    later.onDatabaseLoaded();
    expect(later.directorNoteText).toBe('ARC Dinner: Bella cooks for Don. Beats 1-2 landed.');

    // A director tick picks the show back up from the note
    client.queue.push(reply('Watching.'));
    await later.runTurn('<director_tick n="1"/>', { director: true });
    const tick = client.requests[0].messages[0].content as Anthropic.Beta.Messages.BetaTextBlockParam[];
    expect(tick.map((block) => block.text.split('\n')[0])).toEqual([
      '<live>',
      '<director_note>',
      '<director_tick n="1"/>',
    ]);

    // The chat's seed carries Plum's notes, not the director's
    client.queue.push(reply('Welcome back.'));
    await later.runTurn('remember me?');
    const chat = client.requests[1].messages[0].content as Anthropic.Beta.Messages.BetaTextBlockParam[];
    expect(chat[1].text).toContain('[note (day 3)] Scott likes the lights off at night.');
    expect(chat[1].text).not.toContain('[director');
    expect(chat[1].text).not.toContain('ARC Dinner');
  });

  it('a new conversation writes one summary note at low effort and seeds the next thread', async () => {
    const ctx = loadedContext();
    const client = new FakeModelClient();
    const plum = new PlumService(ctx, { clientFactory: () => client, appTools: [] });
    plum.onModMessage({ kind: 'catalogue', tier: 'core', enabled: true, tools: [] });
    client.queue.push(reply('One.'));
    await plum.runTurn('first');
    client.queue.push(reply('Two.'));
    await plum.runTurn('second');
    const before = plum.threadId;

    client.requests = [];
    client.queue.push(reply('We talked twice; nothing changed in the game.'));
    await plum.startNewThread();
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0].effort).toBe('low');
    expect(client.requests[0].messages).toHaveLength(5);
    expect(plum.threadId).not.toBe(before);
    expect(plum.rows).toEqual([]);
    const notes = ctx.plumRepository.notes(40);
    expect(notes.map((note) => [note.kind, note.text])).toEqual([
      ['summary', 'We talked twice; nothing changed in the game.'],
    ]);

    client.requests = [];
    client.queue.push(reply('Fresh start.'));
    await plum.runTurn('hi again');
    const blocks = client.requests[0].messages[0].content as Anthropic.Beta.Messages.BetaTextBlockParam[];
    expect(blocks[1].text).toContain('[summary] We talked twice');
    expect(blocks[1].text).toContain('[plum] Two.');
  });

  it('a short conversation gets no summary call', async () => {
    const ctx = loadedContext();
    const client = new FakeModelClient();
    const plum = new PlumService(ctx, { clientFactory: () => client, appTools: [] });
    plum.onModMessage({ kind: 'catalogue', tier: 'core', enabled: true, tools: [] });
    client.queue.push(reply('One.'));
    await plum.runTurn('first');
    client.requests = [];
    await plum.startNewThread();
    expect(client.requests).toEqual([]);
    expect(ctx.plumRepository.notes(40)).toEqual([]);
  });

  it('the history replay is capped', async () => {
    const ctx = loadedContext();
    const client = new FakeModelClient();
    const plum = new PlumService(ctx, { clientFactory: () => client, appTools: [] });
    plum.onModMessage({ kind: 'catalogue', tier: 'core', enabled: true, tools: [] });
    for (let i = 0; i < HISTORY_ROWS; i += 1) {
      client.queue.push(reply(`reply ${i}`));
      await plum.runTurn(`line ${i}`);
    }
    sendModNotification.mockClear();
    plum.onModMessage({ kind: 'control', action: 'open' });
    const [history] = eventsOfKind('history');
    expect((history.rows as unknown[]).length).toBe(HISTORY_ROWS);
    const again = new PlumService(ctx, { clientFactory: () => client, appTools: [] });
    sendModNotification.mockClear();
    again.onDatabaseLoaded();
    expect((eventsOfKind('history')[0].rows as unknown[]).length).toBe(HISTORY_ROWS);
  });

  it('without a database Plum still talks and simply remembers nothing', async () => {
    const ctx = mockApiContext({ tiers: [] });
    ctx.settings.set(SettingsEnum.PLUM_API_KEY, 'sk-test');
    const client = new FakeModelClient();
    const plum = new PlumService(ctx, { clientFactory: () => client, appTools: [] });
    plum.onModMessage({ kind: 'catalogue', tier: 'core', enabled: true, tools: [] });
    client.queue.push(reply('Hi.'));
    await plum.runTurn('hello');
    expect(eventsOfKind('assistant')).toHaveLength(1);
    plum.onDatabaseLoaded();
    expect(plum.rows).toHaveLength(2);
  });
});
