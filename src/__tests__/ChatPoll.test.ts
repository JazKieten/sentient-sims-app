import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const websocketMocks = vi.hoisted(() => ({
  sendModNotification: vi.fn(),
  isWebSocketConnected: vi.fn(() => true),
  getModClockState: () => undefined,
}));

vi.mock('main/sentient-sims/websocketServer', () => websocketMocks);

import { SettingsEnum } from 'main/sentient-sims/models/SettingsEnum';
import { ApiContext } from 'main/sentient-sims/services/ApiContext';
import { ChatPollService, chatPollWakeText, parseVote, tallyVotes } from 'main/sentient-sims/services/ChatPollService';
import type { TwitchChatService } from 'main/sentient-sims/services/TwitchChatService';
import type { HelixResult, TwitchAuthService } from 'main/sentient-sims/services/TwitchAuthService';
import { POLL_OVERLAY_HTML } from 'main/sentient-sims/util/pollOverlayPage';
import { mockEnvironment } from './util';

const OPTIONS = ['Move in', 'Not yet'];

describe('parseVote', () => {
  it('reads a number, the command with a number, and the command with words', () => {
    expect(parseVote('2', '!vote', OPTIONS)).toBe(1);
    expect(parseVote('!vote 1', '!vote', OPTIONS)).toBe(0);
    expect(parseVote('!VOTE 2 for sure', '!vote', OPTIONS)).toBe(1);
    expect(parseVote('!vote not yet', '!vote', OPTIONS)).toBe(1);
    expect(parseVote('!vote move', '!vote', OPTIONS)).toBe(0);
  });

  it('ignores chatter, out-of-range numbers and ambiguous words', () => {
    expect(parseVote('I think 2 is better', '!vote', OPTIONS)).toBeUndefined();
    expect(parseVote('3', '!vote', OPTIONS)).toBeUndefined();
    expect(parseVote('!vote 0', '!vote', OPTIONS)).toBeUndefined();
    expect(parseVote('!vote', '!vote', OPTIONS)).toBeUndefined();
    expect(parseVote('!voter 1', '!vote', OPTIONS)).toBeUndefined();
    expect(parseVote('!vote no', '!vote', OPTIONS)).toBeUndefined();
    expect(parseVote('!vote mo', '!vote', ['Move in', 'Move out'])).toBeUndefined();
  });
});

describe('tallyVotes', () => {
  it('picks the top count, draws a tie by lot, and has no winner without votes', () => {
    expect(tallyVotes([3, 5])).toMatchObject({ total: 8, winner: 1 });
    expect(tallyVotes([0, 0])).toEqual({ counts: [0, 0], total: 0 });
    const tie = tallyVotes([4, 1, 4], () => 0.9);
    expect(tie.winner).toBe(2);
    expect(tie.tied).toEqual([0, 2]);
  });
});

describe('chatPollWakeText', () => {
  const poll = { id: 'poll-1', question: 'Does Anker move in?', options: OPTIONS, note: 'move him in', seconds: 60 };

  it('tells Plum the winner and to carry it out', () => {
    const text = chatPollWakeText(poll, tallyVotes([7, 2]));
    expect(text).toContain('<chat_poll id="poll-1">');
    expect(text).toContain('1. Move in 7, 2. Not yet 2');
    expect(text).toContain('Winner: "Move in"');
    expect(text).toContain('Your note when you opened it: "move him in"');
    expect(text).toContain('hand_off');
  });

  it('tells Plum to do nothing when nobody voted or the result is unreadable', () => {
    expect(chatPollWakeText(poll, tallyVotes([0, 0]))).toContain('Nobody voted');
    expect(chatPollWakeText(poll, undefined, 'Twitch could not be reached')).toContain('could not be read');
  });
});

type FakeChat = { isConnected: () => boolean; voteSink?: TwitchChatService['voteSink']; noteEvent: () => void };

function harness(
  options: {
    mode?: 'chat' | 'native';
    connected?: boolean;
    helix?: (method: string, path: string) => HelixResult;
  } = {},
) {
  const { settingsService } = mockEnvironment();
  settingsService.set(SettingsEnum.TWITCH_POLL_MODE, options.mode ?? 'chat');
  settingsService.set(SettingsEnum.TWITCH_POLL_SECONDS, 60);
  settingsService.twitchAuth = { accessToken: 'token', broadcasterId: '42', scopes: ['channel:manage:polls'] };
  const addNote = vi.fn();
  const ctx = {
    settings: settingsService,
    plumRepository: { isLoaded: () => true, addNote },
    simStateCache: { getReport: () => ({ lot: { clock: { absolute_day: 12 } } }) },
  } as unknown as ApiContext;
  const chat: FakeChat = { isConnected: () => options.connected ?? true, noteEvent: vi.fn() };
  const helix = vi.fn((method: string, path: string) =>
    Promise.resolve(options.helix ? options.helix(method, path) : { status: 0 }),
  );
  const auth = {
    getStatus: () => ({ loggedIn: true }),
    pollsAllowed: () => true,
    helix,
  } as unknown as TwitchAuthService;
  const wake = vi.fn();
  const service = new ChatPollService(ctx, chat as unknown as TwitchChatService, auth, { wake, random: () => 0 });
  const vote = (key: string, text: string) => chat.voteSink?.({ key, name: key }, text) ?? false;
  return { service, chat, helix, wake, addNote, vote };
}

describe('ChatPollService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    websocketMocks.sendModNotification.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts chat votes, one per viewer, and wakes Plum with the winner', async () => {
    const { service, chat, wake, addNote, vote } = harness();
    const opened = await service.open({ question: 'Does Anker move in?', options: OPTIONS, seconds: 0, note: '' });
    expect(opened).toEqual({ id: 'poll-1', mode: 'chat', seconds: 60 });
    const [shown] = websocketMocks.sendModNotification.mock.calls[0] as unknown as [
      { notification: { message: string } },
    ];
    expect(shown.notification.message).toContain('!vote 1 = Move in');

    expect(vote('a', '!vote 1')).toBe(true);
    expect(vote('b', '2')).toBe(true);
    expect(vote('c', '!vote 2')).toBe(true);
    expect(vote('a', '!vote 2')).toBe(true);
    expect(vote('d', 'lol')).toBe(false);
    expect(service.current()?.options).toEqual([
      { title: 'Move in', votes: 0 },
      { title: 'Not yet', votes: 3 },
    ]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(wake).toHaveBeenCalledOnce();
    expect(wake.mock.calls[0][0]).toContain('Winner: "Not yet"');
    expect(chat.voteSink).toBeUndefined();
    expect(service.current()).toBeUndefined();
    expect(addNote.mock.calls[0][0]).toBe('chat_poll');
    expect(addNote.mock.calls[0][1]).toContain('"Not yet" (3 of 3');
  });

  it('refuses a second poll and a poll with chat disconnected', async () => {
    const { service } = harness();
    await service.open({ question: 'Q?', options: OPTIONS, seconds: 30, note: '' });
    await expect(service.open({ question: 'Again?', options: OPTIONS, seconds: 30, note: '' })).rejects.toThrow(
      'already open',
    );
    const offline = harness({ connected: false });
    await expect(offline.service.open({ question: 'Q?', options: OPTIONS, seconds: 30, note: '' })).rejects.toThrow(
      'not connected',
    );
  });

  it('a cancelled poll wakes nobody and stops counting', async () => {
    const { service, chat, wake } = harness();
    await service.open({ question: 'Q?', options: OPTIONS, seconds: 30, note: '' });
    expect(await service.cancel()).toBe(true);
    expect(chat.voteSink).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wake).not.toHaveBeenCalled();
    expect(await service.cancel()).toBe(false);
  });

  it('opens a native Twitch poll and reads its votes when it closes', async () => {
    const { service, chat, helix, wake } = harness({
      mode: 'native',
      helix: (method) =>
        method === 'POST'
          ? { status: 200, data: [{ id: 'tw-1' }] }
          : { status: 200, data: [{ status: 'COMPLETED', choices: [{ votes: 9 }, { votes: 4 }] }] },
    });
    const opened = await service.open({ question: 'Does Anker move in?', options: OPTIONS, seconds: 45, note: '' });
    expect(opened.mode).toBe('native');
    expect(chat.voteSink).toBeUndefined();
    expect(helix.mock.calls[0][0]).toBe('POST');

    await vi.advanceTimersByTimeAsync(47_000);
    expect(helix.mock.calls[1][1]).toContain('id=tw-1');
    expect(wake.mock.calls[0][0]).toContain('1. Move in 9, 2. Not yet 4');
  });

  it('a native poll Twitch refuses becomes a chat vote and says why', async () => {
    const { service, chat } = harness({ mode: 'native', helix: () => ({ status: 403 }) });
    const opened = await service.open({ question: 'Q?', options: OPTIONS, seconds: 30, note: '' });
    expect(opened.mode).toBe('chat');
    expect(opened.fellBack).toContain('Affiliate and Partner only');
    expect(chat.voteSink).toBeDefined();
  });

  it('shows the overlay the open poll, then the result it closed with', async () => {
    const { service, vote } = harness();
    expect(service.overlay().poll).toBeUndefined();
    await service.open({ question: 'Does Anker move in?', options: OPTIONS, seconds: 30, note: '' });
    vote('a', '1');
    vote('b', '2');
    vote('c', '2');
    const open = service.overlay();
    expect(open.poll).toMatchObject({
      id: 'poll-1',
      mode: 'chat',
      seconds: 30,
      endsAt: open.now + 30_000,
      total: 3,
      options: [
        { title: 'Move in', votes: 1 },
        { title: 'Not yet', votes: 2 },
      ],
    });

    await vi.advanceTimersByTimeAsync(30_000);
    const closed = service.overlay();
    expect(closed.poll).toBeUndefined();
    expect(closed.result).toMatchObject({ id: 'poll-1', outcome: 'decided', winner: 1, total: 3 });
    expect(closed.result?.closedAt).toBe(closed.now);
  });

  it('shows a cancelled poll and one nobody voted on as such', async () => {
    const { service, vote } = harness();
    await service.open({ question: 'Q?', options: OPTIONS, seconds: 30, note: '' });
    vote('a', '1');
    await service.cancel();
    expect(service.overlay().result).toMatchObject({ outcome: 'cancelled', total: 1 });

    await service.open({ question: 'Again?', options: OPTIONS, seconds: 30, note: '' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(service.overlay().result).toMatchObject({ id: 'poll-2', outcome: 'no_votes', total: 0 });
    expect(service.overlay().result?.winner).toBeUndefined();
  });

  it("reads a Twitch poll's running votes for the overlay, at most every 3 s", async () => {
    const { service, helix } = harness({
      mode: 'native',
      helix: (method) =>
        method === 'POST'
          ? { status: 200, data: [{ id: 'tw-1' }] }
          : { status: 200, data: [{ status: 'ACTIVE', choices: [{ votes: 3 }, { votes: 1 }] }] },
    });
    await service.open({ question: 'Q?', options: OPTIONS, seconds: 45, note: '' });
    expect(service.overlay().poll?.total).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(service.overlay().poll?.options.map((option) => option.votes)).toEqual([3, 1]);
    expect(helix).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(3000);
    service.overlay();
    expect(helix).toHaveBeenCalledTimes(3);
  });
});

describe('POLL_OVERLAY_HTML', () => {
  it('carries a script that parses', () => {
    const script = /<script>([\s\S]*)<\/script>/.exec(POLL_OVERLAY_HTML)?.[1];
    expect(script).toBeTruthy();
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    expect(() => new Function(script ?? '')).not.toThrow();
  });
});
