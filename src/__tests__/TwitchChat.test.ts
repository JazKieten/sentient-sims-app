import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SettingsEnum } from 'main/sentient-sims/models/SettingsEnum';
import { ApiContext } from 'main/sentient-sims/services/ApiContext';
import { mockEnvironment } from './util';

const notifyMocks = vi.hoisted(() => ({
  sendPlayerVoiceMessageToMod: vi.fn(),
  notifyTwitchStatus: vi.fn(),
}));

vi.mock('main/sentient-sims/util/notifyRenderer', () => notifyMocks);

const websocketMocks = vi.hoisted(() => ({
  isWebSocketConnected: vi.fn(() => true),
}));

vi.mock('main/sentient-sims/websocketServer', () => websocketMocks);

// Imports resolve the mocks above

import {
  extractCommand,
  parseBadges,
  parseIrcLine,
  sanitizeQuestion,
  splitIrcLines,
  stripAction,
} from 'main/sentient-sims/util/twitchIrc';

import { emitPlayerVoiceAnswerComplete } from 'main/sentient-sims/util/playerVoiceSignal';

import { TwitchChatService, TwitchSocketLike } from 'main/sentient-sims/services/TwitchChatService';

import { TwitchAuthService } from 'main/sentient-sims/services/TwitchAuthService';

describe('parseIrcLine', () => {
  it('parses an untagged PRIVMSG', () => {
    const message = parseIrcLine(':nova!nova@nova.tmi.twitch.tv PRIVMSG #streamer :hello there');
    expect(message).toMatchObject({
      nick: 'nova',
      command: 'PRIVMSG',
      params: ['#streamer'],
      trailing: 'hello there',
      tags: {},
    });
  });

  it('parses a tagged PRIVMSG and unescapes tag values', () => {
    const message = parseIrcLine(
      '@badges=moderator/1,subscriber/12;display-name=Nova\\sPrime;mod=1;subscriber=1;user-id=1234 ' +
        ':nova!nova@nova.tmi.twitch.tv PRIVMSG #streamer :!ask hi',
    );
    expect(message?.tags['display-name']).toBe('Nova Prime');
    expect(message?.tags['user-id']).toBe('1234');
    expect(message?.trailing).toBe('!ask hi');
    expect(parseBadges(message?.tags ?? {})).toEqual({ mod: true, subscriber: true, broadcaster: false });
  });

  it('parses PING, RECONNECT and numerics', () => {
    expect(parseIrcLine('PING :tmi.twitch.tv')).toMatchObject({ command: 'PING', trailing: 'tmi.twitch.tv' });
    expect(parseIrcLine(':tmi.twitch.tv RECONNECT')).toMatchObject({ command: 'RECONNECT' });
    expect(parseIrcLine(':tmi.twitch.tv 366 justinfan123 #streamer :End of /NAMES list')).toMatchObject({
      command: '366',
    });
  });

  it('splits multi-line frames and rejects garbage', () => {
    expect(splitIrcLines('PING :a\r\nPING :b\r\n')).toEqual(['PING :a', 'PING :b']);
    expect(parseIrcLine('')).toBeUndefined();
    expect(parseIrcLine('@tags-with-no-command')).toBeUndefined();
  });
});

describe('parseBadges', () => {
  it('detects the broadcaster without mod=1 and founders as subscribers', () => {
    expect(parseBadges({ badges: 'broadcaster/1', mod: '0' })).toMatchObject({ broadcaster: true, mod: false });
    expect(parseBadges({ badges: 'founder/0' }).subscriber).toBe(true);
    expect(parseBadges({})).toEqual({ mod: false, subscriber: false, broadcaster: false });
  });
});

describe('command parsing and sanitation', () => {
  it('extracts the question case-insensitively and rejects prefix collisions', () => {
    expect(extractCommand('!ask how are you?', '!ask')).toBe('how are you?');
    expect(extractCommand('  !ASK how are you?  ', '!ask')).toBe('how are you?');
    expect(extractCommand('!askfoo how are you?', '!ask')).toBeUndefined();
    expect(extractCommand('hello !ask x', '!ask')).toBeUndefined();
    expect(extractCommand('!ask', '!ask')).toBe('');
  });

  it('unwraps /me ACTION messages', () => {
    expect(stripAction('\u0001ACTION !ask hi\u0001')).toBe('!ask hi');
    expect(stripAction('!ask hi')).toBe('!ask hi');
  });

  it('neutralizes markup, strips control chars, collapses whitespace, caps length', () => {
    expect(sanitizeQuestion('<b>hi</b>\u0000\u001f  there\n\nfriend', 200)).toBe('‹b›hi‹/b› there friend');
    expect(sanitizeQuestion('a'.repeat(300), 200)).toHaveLength(200);
    expect(sanitizeQuestion('   ', 200)).toBe('');
  });
});

class FakeSocket implements TwitchSocketLike {
  sent: string[] = [];

  closed = 0;

  private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();

  on(event: string, listener: (...args: unknown[]) => void) {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
    return this;
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed += 1;
  }

  emit(event: string, ...args: unknown[]) {
    (this.listeners.get(event) ?? []).forEach((listener) => {
      listener(...args);
    });
  }
}

function twitchContext(options?: { followersOnly?: boolean; loggedIn?: boolean }) {
  const { settingsService } = mockEnvironment();
  settingsService.set(SettingsEnum.TWITCH_CHAT_ENABLED, true);
  settingsService.set(SettingsEnum.TWITCH_CHANNEL, 'streamer');
  settingsService.set(SettingsEnum.TWITCH_FOLLOWERS_ONLY, options?.followersOnly ?? false);
  settingsService.set(SettingsEnum.TWITCH_VIEWER_COOLDOWN_SECONDS, 0);
  settingsService.set(SettingsEnum.TWITCH_GLOBAL_COOLDOWN_SECONDS, 0);
  const isFollower = vi.fn();
  const twitchAuth = {
    getStatus: vi.fn(() => ({ loggedIn: options?.loggedIn ?? true })),
    isFollower,
  } as unknown as TwitchAuthService;
  const ctx = { settings: settingsService, twitchAuth } as unknown as ApiContext;
  const sockets: FakeSocket[] = [];
  const service = new TwitchChatService(ctx, () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  });
  service.initialize();
  return { settingsService, service, sockets, isFollower };
}

function connectSocket(socket: FakeSocket) {
  socket.emit('open');
  socket.emit('message', ':tmi.twitch.tv 366 justinfan123 #streamer :End of /NAMES list\r\n');
}

function privmsg(socket: FakeSocket, text: string, tagsPrefix = '') {
  socket.emit('message', `${tagsPrefix}:nova!nova@nova.tmi.twitch.tv PRIVMSG #streamer :${text}\r\n`);
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('TwitchChatService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    notifyMocks.sendPlayerVoiceMessageToMod.mockReset();
    notifyMocks.notifyTwitchStatus.mockReset();
    websocketMocks.isWebSocketConnected.mockReset().mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('performs the anonymous handshake with tags', () => {
    const { sockets, service } = twitchContext();
    const socket = sockets[0];
    socket.emit('open');

    expect(socket.sent[0]).toBe('CAP REQ :twitch.tv/tags\r\n');
    expect(socket.sent[1]).toMatch(/^NICK justinfan\d+\r\n$/);
    expect(socket.sent[2]).toBe('JOIN #streamer\r\n');

    socket.emit('message', ':tmi.twitch.tv 366 justinfan123 #streamer :End of /NAMES list\r\n');
    expect(service.getStatus().state).toBe('connected');
    service.shutdown();
  });

  it('answers PING with PONG', () => {
    const { sockets, service } = twitchContext();
    connectSocket(sockets[0]);
    sockets[0].emit('message', 'PING :tmi.twitch.tv\r\n');
    expect(sockets[0].sent).toContain('PONG :tmi.twitch.tv\r\n');
    service.shutdown();
  });

  it('sends an accepted !ask to the game through the player-voice pipeline', () => {
    const { sockets, service } = twitchContext();
    connectSocket(sockets[0]);

    privmsg(sockets[0], 'unrelated chatter');
    expect(notifyMocks.sendPlayerVoiceMessageToMod).not.toHaveBeenCalled();

    privmsg(sockets[0], '!ask what do <you> dream about?');
    expect(notifyMocks.sendPlayerVoiceMessageToMod).toHaveBeenCalledWith('what do ‹you› dream about?');
    service.shutdown();
  });

  it('queues questions and paces them on the answer-complete signal', () => {
    const { sockets, service } = twitchContext();
    connectSocket(sockets[0]);

    privmsg(sockets[0], '!ask first?');
    privmsg(sockets[0], '!ask second?');
    expect(notifyMocks.sendPlayerVoiceMessageToMod).toHaveBeenCalledTimes(1);
    expect(service.getStatus().queueDepth).toBe(1);

    emitPlayerVoiceAnswerComplete();
    vi.advanceTimersByTime(3001);
    expect(notifyMocks.sendPlayerVoiceMessageToMod).toHaveBeenCalledTimes(2);
    expect(notifyMocks.sendPlayerVoiceMessageToMod).toHaveBeenLastCalledWith('second?');
    service.shutdown();
  });

  it('releases the queue on the fallback timer when no answer signal arrives', () => {
    const { sockets, service } = twitchContext();
    connectSocket(sockets[0]);

    privmsg(sockets[0], '!ask first?');
    privmsg(sockets[0], '!ask second?');
    expect(notifyMocks.sendPlayerVoiceMessageToMod).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60001);
    expect(notifyMocks.sendPlayerVoiceMessageToMod).toHaveBeenCalledTimes(2);
    service.shutdown();
  });

  it('enforces viewer and global cooldowns', () => {
    const { settingsService, sockets, service } = twitchContext();
    settingsService.set(SettingsEnum.TWITCH_VIEWER_COOLDOWN_SECONDS, 60);
    settingsService.set(SettingsEnum.TWITCH_GLOBAL_COOLDOWN_SECONDS, 15);
    connectSocket(sockets[0]);

    privmsg(sockets[0], '!ask one?');
    privmsg(sockets[0], '!ask two?');
    expect(notifyMocks.sendPlayerVoiceMessageToMod).toHaveBeenCalledTimes(1);
    expect(service.getStatus().lastEvent).toContain('cooldown');

    // A different viewer inside the global window is also dropped
    sockets[0].emit('message', ':other!other@other.tmi.twitch.tv PRIVMSG #streamer :!ask three?\r\n');
    expect(notifyMocks.sendPlayerVoiceMessageToMod).toHaveBeenCalledTimes(1);

    // After the global window a different viewer is accepted
    vi.advanceTimersByTime(16000);
    sockets[0].emit('message', ':other!other@other.tmi.twitch.tv PRIVMSG #streamer :!ask four?\r\n');
    expect(service.getStatus().queueDepth).toBe(1);
    service.shutdown();
  });

  it('caps the question queue', () => {
    const { sockets, service } = twitchContext();
    connectSocket(sockets[0]);

    ['a', 'b', 'c', 'd', 'e'].forEach((viewer, index) => {
      sockets[0].emit(
        'message',
        `:${viewer}!${viewer}@${viewer}.tmi.twitch.tv PRIVMSG #streamer :!ask question ${index}?\r\n`,
      );
    });

    // 1 in flight + 3 queued; the 5th dropped
    expect(notifyMocks.sendPlayerVoiceMessageToMod).toHaveBeenCalledTimes(1);
    expect(service.getStatus().queueDepth).toBe(3);
    expect(service.getStatus().lastEvent).toContain('queue full');
    service.shutdown();
  });

  it('holds the queue while the game is disconnected', () => {
    websocketMocks.isWebSocketConnected.mockReturnValue(false);
    const { sockets, service } = twitchContext();
    connectSocket(sockets[0]);

    privmsg(sockets[0], '!ask anyone home?');
    expect(notifyMocks.sendPlayerVoiceMessageToMod).not.toHaveBeenCalled();
    expect(service.getStatus().lastEvent).toContain('game not connected');

    websocketMocks.isWebSocketConnected.mockReturnValue(true);
    vi.advanceTimersByTime(5001);
    expect(notifyMocks.sendPlayerVoiceMessageToMod).toHaveBeenCalledWith('anyone home?');
    service.shutdown();
  });

  it('applies the mods-only permission filter from tags', () => {
    const { settingsService, sockets, service } = twitchContext();
    settingsService.set(SettingsEnum.TWITCH_ASK_PERMISSION, 'mods');
    connectSocket(sockets[0]);

    privmsg(sockets[0], '!ask plain viewer?');
    expect(notifyMocks.sendPlayerVoiceMessageToMod).not.toHaveBeenCalled();

    privmsg(sockets[0], '!ask mod here?', '@badges=moderator/1;mod=1 ');
    expect(notifyMocks.sendPlayerVoiceMessageToMod).toHaveBeenCalledWith('mod here?');
    service.shutdown();
  });

  it('drops follower-gated questions when no account is connected', async () => {
    const { sockets, service } = twitchContext({ followersOnly: true, loggedIn: false });
    connectSocket(sockets[0]);

    privmsg(sockets[0], '!ask hi?', '@user-id=42 ');
    await flushAsync();

    expect(notifyMocks.sendPlayerVoiceMessageToMod).not.toHaveBeenCalled();
    expect(service.getStatus().lastEvent).toContain('no Twitch account');
    service.shutdown();
  });

  it('enforces the follower gate and lets mods bypass it', async () => {
    const { sockets, service, isFollower } = twitchContext({ followersOnly: true, loggedIn: true });
    connectSocket(sockets[0]);

    isFollower.mockResolvedValue(false);
    privmsg(sockets[0], '!ask not following?', '@user-id=42 ');
    await flushAsync();
    expect(notifyMocks.sendPlayerVoiceMessageToMod).not.toHaveBeenCalled();
    expect(service.getStatus().lastEvent).toContain('not a follower');

    isFollower.mockResolvedValue(true);
    privmsg(sockets[0], '!ask following now?', '@user-id=42 ');
    await flushAsync();
    expect(notifyMocks.sendPlayerVoiceMessageToMod).toHaveBeenCalledWith('following now?');

    isFollower.mockClear();
    emitPlayerVoiceAnswerComplete();
    vi.advanceTimersByTime(3001);
    privmsg(sockets[0], '!ask mod question?', '@badges=broadcaster/1 ');
    await flushAsync();
    expect(isFollower).not.toHaveBeenCalled();
    expect(notifyMocks.sendPlayerVoiceMessageToMod).toHaveBeenLastCalledWith('mod question?');
    service.shutdown();
  });

  it('supports the debug injection path', () => {
    const { service } = twitchContext();
    service.handleDebugMessage('viewer1', '!ask debug question?');
    expect(notifyMocks.sendPlayerVoiceMessageToMod).toHaveBeenCalledWith('debug question?');
    service.shutdown();
  });

  it('reconnects with backoff after a close', () => {
    const { sockets, service } = twitchContext();
    connectSocket(sockets[0]);

    sockets[0].emit('close');
    expect(service.getStatus().state).toBe('reconnecting');

    vi.advanceTimersByTime(3000);
    expect(sockets).toHaveLength(2);
    service.shutdown();
  });

  it('disconnects when the feature is turned off', () => {
    const { settingsService, sockets, service } = twitchContext();
    connectSocket(sockets[0]);

    settingsService.set(SettingsEnum.TWITCH_CHAT_ENABLED, false);
    service.onSettingChanged(SettingsEnum.TWITCH_CHAT_ENABLED);
    vi.advanceTimersByTime(501);

    expect(sockets[0].closed).toBeGreaterThan(0);
    expect(service.getStatus().state).toBe('disabled');
    service.shutdown();
  });
});

describe('twitch settings', () => {
  it('has working defaults', () => {
    const { settingsService } = mockEnvironment();
    expect(settingsService.twitchChatEnabled).toBe(false);
    expect(settingsService.twitchChannel).toBe('');
    expect(settingsService.twitchCommandWord).toBe('!ask');
    expect(settingsService.twitchViewerCooldownSeconds).toBe(60);
    expect(settingsService.twitchGlobalCooldownSeconds).toBe(15);
    expect(settingsService.twitchAskPermission).toBe('everyone');
    expect(settingsService.twitchFollowersOnly).toBe(true);
    expect(settingsService.twitchAuth).toEqual({});
  });

  it('normalizes the channel and falls back on an empty command word', () => {
    const { settingsService } = mockEnvironment();
    settingsService.set(SettingsEnum.TWITCH_CHANNEL, ' #MyChannel ');
    expect(settingsService.twitchChannel).toBe('mychannel');
    settingsService.set(SettingsEnum.TWITCH_COMMAND_WORD, '   ');
    expect(settingsService.twitchCommandWord).toBe('!ask');
  });
});
