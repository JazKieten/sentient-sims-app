import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SettingsEnum } from 'main/sentient-sims/models/SettingsEnum';
import { defaultTwitchChatVoiceId } from 'main/sentient-sims/constants';
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
  sanitizeViewerName,
  splitIrcLines,
  stripAction,
  stripLeadingMention,
} from 'main/sentient-sims/util/twitchIrc';

import { resolveSimTarget, buildAskSentientSim } from 'main/sentient-sims/util/twitchSimTarget';

import { applySimAliasNames, setSimAliases } from 'main/sentient-sims/util/simAliases';

import { castVoicesForLines } from 'main/sentient-sims/formatter/VoiceCasting';
import { VoiceType } from 'main/sentient-sims/models/VoiceType';

import { TwitchChatService, TwitchSocketLike } from 'main/sentient-sims/services/TwitchChatService';

import { TwitchAuthService } from 'main/sentient-sims/services/TwitchAuthService';

type GenerationCall = [
  { sentient_sims: { sim_id: string; name: string; description?: string }[]; action: string; event_type: string },
  {
    playerLine: { speaker: string; text: string };
    playerLineFlavor?: string;
    playerLineDisplaySpeaker?: string;
    saveMemory?: boolean;
    speakPlayerLine?: { voiceId: string; spokenText: string };
  },
  { priority?: boolean },
];

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

  it('strips leading @mentions from Twitch replies', () => {
    expect(stripLeadingMention('@JazKieten !ask how are you')).toBe('!ask how are you');
    expect(stripLeadingMention('@a @b: !ask hi')).toBe('!ask hi');
    expect(stripLeadingMention('!ask hi @someone')).toBe('!ask hi @someone');
  });

  it('sanitizes viewer names for the display tag', () => {
    expect(sanitizeViewerName('trappedbutterfly')).toBe('trappedbutterfly');
    expect(sanitizeViewerName('bad(name)<b>{x}[y]')).toBe('badnamebxy');
    expect(sanitizeViewerName('x'.repeat(40))).toHaveLength(25);
    expect(sanitizeViewerName('()')).toBe('viewer');
  });

  it('unwraps /me ACTION messages', () => {
    expect(stripAction('\u0001ACTION !ask hi\u0001')).toBe('!ask hi');
    expect(stripAction('!ask hi')).toBe('!ask hi');
  });

  it('neutralizes markup, converts brackets, strips control chars, caps length', () => {
    expect(sanitizeQuestion('<b>hi</b>\u0000\u001f  there\n\nfriend', 200)).toBe('‹b›hi‹/b› there friend');
    expect(sanitizeQuestion('so [AI: hi] ok', 200)).toBe('so (AI: hi) ok');
    expect(sanitizeQuestion('a'.repeat(300), 200)).toHaveLength(200);
    expect(sanitizeQuestion('   ', 200)).toBe('');
  });
});

describe('resolveSimTarget', () => {
  const candidates = [
    { simId: '111', name: 'Lillie Smith' },
    { simId: '222', name: 'Bella Goth' },
  ];

  it('matches a leading first name and strips it from the question', () => {
    expect(resolveSimTarget('lillie how are you', candidates)).toEqual({
      simId: '111',
      name: 'Lillie Smith',
      question: 'how are you',
    });
  });

  it('fuzzy-matches misspellings like lilly', () => {
    expect(resolveSimTarget('lilly how are you', candidates)?.simId).toBe('111');
  });

  it('matches a full name', () => {
    expect(resolveSimTarget('bella goth are you ok', candidates)).toEqual({
      simId: '222',
      name: 'Bella Goth',
      question: 'are you ok',
    });
  });

  it('returns undefined for no match, a bare name, or an ambiguous first name', () => {
    expect(resolveSimTarget('how are you', candidates)).toBeUndefined();
    expect(resolveSimTarget('lillie', candidates)).toBeUndefined();
    const twins = [
      { simId: '1', name: 'Lillie Smith' },
      { simId: '2', name: 'Lillie Jones' },
    ];
    expect(resolveSimTarget('lillie hi there', twins)).toBeUndefined();
    expect(resolveSimTarget('lillie smith hi there', twins)?.simId).toBe('1');
  });

  it('never snaps short question words to names', () => {
    expect(resolveSimTarget('how is everyone', [{ simId: '9', name: 'Hope Day' }])).toBeUndefined();
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

type RosterEntry = { sim_id: string; sim_name: string; is_household?: boolean; is_active?: boolean };

function defaultRoster(): RosterEntry[] {
  return [
    { sim_id: '111', sim_name: 'Lillie Smith', is_household: true },
    { sim_id: '222', sim_name: 'Bella Goth', is_household: true, is_active: true },
    { sim_id: '333', sim_name: 'Milo Greene', is_household: false },
  ];
}

function twitchContext(options?: { followersOnly?: boolean; loggedIn?: boolean; roster?: RosterEntry[] }) {
  const { settingsService } = mockEnvironment();
  settingsService.set(SettingsEnum.TWITCH_CHAT_ENABLED, true);
  settingsService.set(SettingsEnum.TWITCH_CHANNEL, 'streamer');
  settingsService.set(SettingsEnum.TWITCH_FOLLOWERS_ONLY, options?.followersOnly ?? false);
  const isFollower = vi.fn();
  const twitchAuth = {
    getStatus: vi.fn(() => ({ loggedIn: options?.loggedIn ?? true })),
    isFollower,
  } as unknown as TwitchAuthService;
  const rosterRef: { sims: RosterEntry[]; reportSims?: RosterEntry[] } = { sims: options?.roster ?? defaultRoster() };
  const runDirectedGeneration = vi.fn().mockResolvedValue({ status: 'generated' });
  const ctx = {
    settings: settingsService,
    twitchAuth,
    simStateCache: {
      // reportSims simulates a supplement/paused report without a sims array; the per-sim
      // entry accessors below still serve the accumulated roster
      getReport: () => ({ type: 'state_report', seq: 1, sims: rosterRef.reportSims ?? rosterRef.sims }),
      getSim: (id: string) => rosterRef.sims.find((entry) => entry.sim_id === id),
      getSimIds: () => rosterRef.sims.map((entry) => entry.sim_id),
    },
    generationQueue: { runSpeech: (fn: () => Promise<unknown>) => fn() },
    ai: { runDirectedGeneration },
    sceneService: { getCurrentScene: () => ({ locationId: 7 }) },
    participantRepository: { getParticipant: () => ({ id: '111', description: 'a sweet fairy artist' }) },
  } as unknown as ApiContext;
  const sockets: FakeSocket[] = [];
  const service = new TwitchChatService(ctx, () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  });
  service.initialize();
  return { settingsService, service, sockets, isFollower, runDirectedGeneration, rosterRef };
}

function connectSocket(socket: FakeSocket) {
  socket.emit('open');
  socket.emit('message', ':tmi.twitch.tv 366 justinfan123 #streamer :End of /NAMES list\r\n');
}

function privmsg(socket: FakeSocket, text: string, tagsPrefix = '', viewer = 'nova') {
  socket.emit('message', `${tagsPrefix}:${viewer}!${viewer}@${viewer}.tmi.twitch.tv PRIVMSG #streamer :${text}\r\n`);
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

  it('answers as the ACTIVE sim via app-side generation, never the mod round trip', () => {
    const { sockets, service, runDirectedGeneration } = twitchContext();
    connectSocket(sockets[0]);

    privmsg(sockets[0], 'unrelated chatter');
    expect(runDirectedGeneration).not.toHaveBeenCalled();

    privmsg(sockets[0], '!ask how is <your> day?');
    expect(notifyMocks.sendPlayerVoiceMessageToMod).not.toHaveBeenCalled();
    expect(runDirectedGeneration).toHaveBeenCalledTimes(1);
    const [event, options, playback] = runDirectedGeneration.mock.calls[0] as GenerationCall;
    expect(event.sentient_sims).toHaveLength(1);
    expect(event.sentient_sims[0].sim_id).toBe('222');
    expect(event.sentient_sims[0].name).toBe('Bella Goth');
    expect(event.event_type).toBe('chat');
    expect(options.playerLine).toEqual({ speaker: 'Chat', text: 'how is ‹your› day?' });
    expect(options.playerLineFlavor).toContain('crowd');
    // Viewer credit is display-only: the model's playerLine stays plain "Chat"
    expect(options.playerLineDisplaySpeaker).toBe('Chat (nova)');
    expect(options.saveMemory).toBe(true);
    expect(playback.priority).toBe(true);
    service.shutdown();
  });

  it('speaks the viewer question in the configured chat voice when ElevenLabs TTS is on', () => {
    const { settingsService, sockets, service, runDirectedGeneration } = twitchContext();
    settingsService.set(SettingsEnum.TTS_ENABLED, true);
    settingsService.set(SettingsEnum.TTS_API_TYPE, 'elevenlabs');
    settingsService.set(SettingsEnum.TWITCH_CHAT_VOICE_ID, 'voice-123');
    connectSocket(sockets[0]);

    privmsg(sockets[0], '!ask how is <your> day?');
    const [, options] = runDirectedGeneration.mock.calls[0] as GenerationCall;
    // The spoken text carries the viewer credit; the subtitle/memory keep the raw question
    expect(options.speakPlayerLine).toEqual({ voiceId: 'voice-123', spokenText: 'nova asks: how is ‹your› day?' });
    service.shutdown();
  });

  it('falls back to the built-in chat voice when none is configured', () => {
    const { settingsService, sockets, service, runDirectedGeneration } = twitchContext();
    settingsService.set(SettingsEnum.TTS_ENABLED, true);
    settingsService.set(SettingsEnum.TTS_API_TYPE, 'elevenlabs');
    connectSocket(sockets[0]);

    privmsg(sockets[0], '!ask hi');
    const [, options] = runDirectedGeneration.mock.calls[0] as GenerationCall;
    expect(options.speakPlayerLine?.voiceId).toBe(defaultTwitchChatVoiceId);
    service.shutdown();
  });

  it('does not speak the question when the toggle is off or TTS is not ElevenLabs', async () => {
    const { settingsService, sockets, service, runDirectedGeneration } = twitchContext();
    settingsService.set(SettingsEnum.TTS_ENABLED, true);
    settingsService.set(SettingsEnum.TTS_API_TYPE, 'elevenlabs');
    settingsService.set(SettingsEnum.TWITCH_SPEAK_QUESTIONS, false);
    connectSocket(sockets[0]);

    privmsg(sockets[0], '!ask hi');
    const [, disabled] = runDirectedGeneration.mock.calls[0] as GenerationCall;
    expect(disabled.speakPlayerLine).toBeUndefined();

    settingsService.set(SettingsEnum.TWITCH_SPEAK_QUESTIONS, true);
    settingsService.set(SettingsEnum.TTS_API_TYPE, 'sentientsimsai');
    await flushAsync();
    vi.advanceTimersByTime(1001);
    privmsg(sockets[0], '!ask hello again', '', 'other');
    const [, wrongEngine] = runDirectedGeneration.mock.calls[1] as GenerationCall;
    expect(wrongEngine.speakPlayerLine).toBeUndefined();
    service.shutdown();
  });

  it('skips duplicate deliveries of the same Twitch message id', () => {
    const { sockets, service, runDirectedGeneration } = twitchContext();
    connectSocket(sockets[0]);

    privmsg(sockets[0], '!ask do you love jonah?', '@id=abc-123 ');
    privmsg(sockets[0], '!ask do you love jonah?', '@id=abc-123 ');

    expect(runDirectedGeneration).toHaveBeenCalledTimes(1);
    expect(service.getStatus().queueDepth).toBe(0);
    service.shutdown();
  });

  it('targets a named sim, including on-lot NPCs', () => {
    const { sockets, service, runDirectedGeneration } = twitchContext();
    connectSocket(sockets[0]);

    privmsg(sockets[0], '!ask lillie what do you dream about?');
    const [event] = runDirectedGeneration.mock.calls[0] as GenerationCall;
    expect(event.sentient_sims[0].sim_id).toBe('111');
    expect(event.sentient_sims[0].description).toBe('a sweet fairy artist');
    const [, options] = runDirectedGeneration.mock.calls[0] as GenerationCall;
    expect(options.playerLine.text).toBe('what do you dream about?');
    // Targeted asks credit the target sim in the display tag; the model still sees "Chat"
    expect(options.playerLine.speaker).toBe('Chat');
    expect(options.playerLineDisplaySpeaker).toBe('Chat (nova, to Lillie)');

    service.shutdown();
  });

  it('targets an NPC on the lot and falls back to the active sim on ambiguity', async () => {
    const roster = [...defaultRoster(), { sim_id: '444', sim_name: 'Milo Waters', is_household: false }];
    const { sockets, service, runDirectedGeneration } = twitchContext({ roster });
    connectSocket(sockets[0]);

    // Two Milos: ambiguous first name falls back to the active sim with the FULL question
    privmsg(sockets[0], '!ask milo how are you?');
    const [event, options] = runDirectedGeneration.mock.calls[0] as GenerationCall;
    expect(event.sentient_sims[0].sim_id).toBe('222');
    expect(options.playerLine.text).toBe('milo how are you?');

    // Full name resolves the ambiguity
    await flushAsync();
    vi.advanceTimersByTime(1001);
    privmsg(sockets[0], '!ask milo greene how are you?', '', 'other');
    const [event2] = runDirectedGeneration.mock.calls[1] as GenerationCall;
    expect(event2.sentient_sims[0].sim_id).toBe('333');
    service.shutdown();
  });

  it('parses asks hidden behind Twitch reply @mentions', () => {
    const { sockets, service, runDirectedGeneration } = twitchContext();
    connectSocket(sockets[0]);

    privmsg(sockets[0], '@JazKieten !ask hi there');
    expect(runDirectedGeneration).toHaveBeenCalledTimes(1);
    const [, options] = runDirectedGeneration.mock.calls[0] as GenerationCall;
    expect(options.playerLine.text).toBe('hi there');
    service.shutdown();
  });

  it('plays strictly FIFO: next question dispatches after the generation settles', async () => {
    const { sockets, service, runDirectedGeneration } = twitchContext();
    connectSocket(sockets[0]);

    privmsg(sockets[0], '!ask first?');
    privmsg(sockets[0], '!ask second?', '', 'other');
    expect(runDirectedGeneration).toHaveBeenCalledTimes(1);
    expect(service.getStatus().queueDepth).toBe(1);

    await flushAsync();
    vi.advanceTimersByTime(1001);
    expect(runDirectedGeneration).toHaveBeenCalledTimes(2);
    const [, options] = runDirectedGeneration.mock.calls[1] as GenerationCall;
    expect(options.playerLine.text).toBe('second?');
    service.shutdown();
  });

  it('releases the queue on the fallback timer when a generation hangs', () => {
    const { sockets, service, runDirectedGeneration } = twitchContext();
    runDirectedGeneration.mockImplementation(() => new Promise(() => {}));
    connectSocket(sockets[0]);

    privmsg(sockets[0], '!ask first?');
    privmsg(sockets[0], '!ask second?', '', 'other');
    expect(runDirectedGeneration).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60001);
    expect(runDirectedGeneration).toHaveBeenCalledTimes(2);
    service.shutdown();
  });

  it('has no cooldowns by default but still enforces them when configured', async () => {
    const { settingsService, sockets, service, runDirectedGeneration } = twitchContext();
    connectSocket(sockets[0]);

    // Defaults: same viewer twice in a row both accepted
    privmsg(sockets[0], '!ask one?');
    await flushAsync();
    vi.advanceTimersByTime(1001);
    privmsg(sockets[0], '!ask two?');
    expect(runDirectedGeneration).toHaveBeenCalledTimes(2);

    // Explicit cooldowns still work (advance past the window so 'three?' opens it fresh)
    settingsService.set(SettingsEnum.TWITCH_VIEWER_COOLDOWN_SECONDS, 60);
    await flushAsync();
    vi.advanceTimersByTime(61000);
    privmsg(sockets[0], '!ask three?');
    privmsg(sockets[0], '!ask four?');
    expect(runDirectedGeneration).toHaveBeenCalledTimes(3);
    expect(service.getStatus().lastEvent).toContain('cooldown');
    service.shutdown();
  });

  it('queues up to 25 questions', () => {
    const { sockets, service, runDirectedGeneration } = twitchContext();
    connectSocket(sockets[0]);

    for (let index = 0; index < 27; index += 1) {
      privmsg(sockets[0], `!ask question ${index}?`, '', `viewer${index}`);
    }

    // 1 in flight + 25 queued; the 27th dropped
    expect(runDirectedGeneration).toHaveBeenCalledTimes(1);
    expect(service.getStatus().queueDepth).toBe(25);
    expect(service.getStatus().lastEvent).toContain('queue full');
    service.shutdown();
  });

  it('holds the queue while the game is disconnected', () => {
    websocketMocks.isWebSocketConnected.mockReturnValue(false);
    const { sockets, service, runDirectedGeneration } = twitchContext();
    connectSocket(sockets[0]);

    privmsg(sockets[0], '!ask anyone home?');
    expect(runDirectedGeneration).not.toHaveBeenCalled();
    expect(service.getStatus().lastEvent).toContain('game not connected');

    websocketMocks.isWebSocketConnected.mockReturnValue(true);
    vi.advanceTimersByTime(5001);
    expect(runDirectedGeneration).toHaveBeenCalledTimes(1);
    service.shutdown();
  });

  it('keeps dispatching from the last full roster when supplements without sims arrive', async () => {
    const { sockets, service, runDirectedGeneration, rosterRef } = twitchContext();
    connectSocket(sockets[0]);

    // First ask sees a full report and snapshots the roster
    privmsg(sockets[0], '!ask lillie can you fly?');
    expect(runDirectedGeneration).toHaveBeenCalledTimes(1);
    const [event] = runDirectedGeneration.mock.calls[0] as GenerationCall;
    expect(event.sentient_sims[0].sim_id).toBe('111');

    // Latest report becomes a paused heartbeat/supplement without a sims array — the last
    // full roster still serves targeting instead of holding the queue hostage
    rosterRef.reportSims = [];
    await flushAsync();
    vi.advanceTimersByTime(1001);
    privmsg(sockets[0], '!ask milo are you ok?', '', 'other');
    expect(runDirectedGeneration).toHaveBeenCalledTimes(2);
    const [event2] = runDirectedGeneration.mock.calls[1] as GenerationCall;
    expect(event2.sentient_sims[0].sim_id).toBe('333');
    service.shutdown();
  });

  it('holds the queue until the game reports its sims', () => {
    const { sockets, service, runDirectedGeneration, rosterRef } = twitchContext({ roster: [] });
    connectSocket(sockets[0]);

    privmsg(sockets[0], '!ask hello?');
    expect(runDirectedGeneration).not.toHaveBeenCalled();
    expect(service.getStatus().lastEvent).toContain('no sims reported');

    rosterRef.sims = defaultRoster();
    vi.advanceTimersByTime(5001);
    expect(runDirectedGeneration).toHaveBeenCalledTimes(1);
    service.shutdown();
  });

  it('applies the mods-only permission filter from tags', () => {
    const { settingsService, sockets, service, runDirectedGeneration } = twitchContext();
    settingsService.set(SettingsEnum.TWITCH_ASK_PERMISSION, 'mods');
    connectSocket(sockets[0]);

    privmsg(sockets[0], '!ask plain viewer?');
    expect(runDirectedGeneration).not.toHaveBeenCalled();

    privmsg(sockets[0], '!ask mod here?', '@badges=moderator/1;mod=1 ');
    expect(runDirectedGeneration).toHaveBeenCalledTimes(1);
    service.shutdown();
  });

  it('drops follower-gated questions when no account is connected', async () => {
    const { sockets, service, runDirectedGeneration } = twitchContext({ followersOnly: true, loggedIn: false });
    connectSocket(sockets[0]);

    privmsg(sockets[0], '!ask hi?', '@user-id=42 ');
    await flushAsync();

    expect(runDirectedGeneration).not.toHaveBeenCalled();
    expect(service.getStatus().lastEvent).toContain('no Twitch account');
    service.shutdown();
  });

  it('enforces the follower gate and lets mods bypass it', async () => {
    const { sockets, service, isFollower, runDirectedGeneration } = twitchContext({
      followersOnly: true,
      loggedIn: true,
    });
    connectSocket(sockets[0]);

    isFollower.mockResolvedValue(false);
    privmsg(sockets[0], '!ask not following?', '@user-id=42 ');
    await flushAsync();
    expect(runDirectedGeneration).not.toHaveBeenCalled();
    expect(service.getStatus().lastEvent).toContain('not a follower');

    isFollower.mockResolvedValue(true);
    privmsg(sockets[0], '!ask following now?', '@user-id=42 ');
    await flushAsync();
    expect(runDirectedGeneration).toHaveBeenCalledTimes(1);

    isFollower.mockClear();
    await flushAsync();
    vi.advanceTimersByTime(1001);
    privmsg(sockets[0], '!ask mod question?', '@badges=broadcaster/1 ');
    await flushAsync();
    expect(isFollower).not.toHaveBeenCalled();
    expect(runDirectedGeneration).toHaveBeenCalledTimes(2);
    service.shutdown();
  });

  it('supports the debug injection path', () => {
    const { service, runDirectedGeneration } = twitchContext();
    service.handleDebugMessage('viewer1', '!ask debug question?');
    expect(runDirectedGeneration).toHaveBeenCalledTimes(1);
    const [, options] = runDirectedGeneration.mock.calls[0] as GenerationCall;
    expect(options.playerLine.text).toBe('debug question?');
    service.shutdown();
  });

  it('lets chat target alias sims like the Grim Reaper, even off the lot', () => {
    const { settingsService, sockets, service, runDirectedGeneration } = twitchContext();
    settingsService.set(SettingsEnum.TWITCH_SIM_ALIASES, 'Grim Reaper=999\nDeath=999');
    connectSocket(sockets[0]);

    privmsg(sockets[0], '!ask grim when are you coming for maisie?');
    expect(runDirectedGeneration).toHaveBeenCalledTimes(1);
    const [event, options] = runDirectedGeneration.mock.calls[0] as GenerationCall;
    expect(event.sentient_sims[0].sim_id).toBe('999');
    expect(event.sentient_sims[0].name).toBe('Grim Reaper');
    expect(options.playerLine.text).toBe('when are you coming for maisie?');
    service.shutdown();
  });

  it('never routes unnamed asks to an alias, and aliases alone do not lift the roster hold', () => {
    const { settingsService, sockets, service, runDirectedGeneration, rosterRef } = twitchContext({ roster: [] });
    settingsService.set(SettingsEnum.TWITCH_SIM_ALIASES, 'Death=999');
    connectSocket(sockets[0]);

    privmsg(sockets[0], '!ask hello there?');
    expect(runDirectedGeneration).not.toHaveBeenCalled();
    expect(service.getStatus().lastEvent).toContain('no sims reported');

    rosterRef.sims = defaultRoster();
    vi.advanceTimersByTime(5001);
    expect(runDirectedGeneration).toHaveBeenCalledTimes(1);
    const [event] = runDirectedGeneration.mock.calls[0] as GenerationCall;
    expect(event.sentient_sims[0].sim_id).toBe('222');
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

describe('applySimAliasNames', () => {
  it('renames placeholder-named sims and never real ones', () => {
    setSimAliases([{ name: 'Grim Reaper', simId: '153' }]);
    const sims = [
      buildAskSentientSim({ simId: '153', name: 'Sim 153' }),
      buildAskSentientSim({ simId: '222', name: 'Blair Birch' }),
    ];
    const renamed = applySimAliasNames(sims);
    expect(renamed[0].name).toBe('Grim Reaper');
    expect(renamed[1].name).toBe('Blair Birch');
    setSimAliases([]);
  });
});

describe('alias voice casting', () => {
  it('applies a pinned voice when the model labels the line with the alias name', () => {
    setSimAliases([{ name: 'Grim Reaper', simId: '153' }]);
    const grim = buildAskSentientSim({ simId: '153', name: 'Sim 153' });
    const overrides = new Map([['153', 'pinned-voice']]);

    const cast = castVoicesForLines([{ speaker: 'Grim Reaper', text: 'Yes.' }], [grim], VoiceType.ElevenLabs, overrides);
    expect(cast[0].voiceId).toBe('pinned-voice');

    // Narrator lines stay uncast, alias or not
    const narration = castVoicesForLines(
      [{ speaker: 'Narrator', text: 'Meanwhile...' }],
      [grim],
      VoiceType.ElevenLabs,
      overrides,
    );
    expect(narration[0].voiceId).toBeUndefined();
    setSimAliases([]);
  });
});

describe('twitch settings', () => {
  it('has working defaults', () => {
    const { settingsService } = mockEnvironment();
    expect(settingsService.twitchChatEnabled).toBe(false);
    expect(settingsService.twitchChannel).toBe('');
    expect(settingsService.twitchCommandWord).toBe('!ask');
    expect(settingsService.twitchViewerCooldownSeconds).toBe(0);
    expect(settingsService.twitchGlobalCooldownSeconds).toBe(0);
    expect(settingsService.twitchAskPermission).toBe('everyone');
    expect(settingsService.twitchFollowersOnly).toBe(true);
    expect(settingsService.twitchAuth).toEqual({});
  });

  it('parses sim aliases and skips malformed lines', () => {
    const { settingsService } = mockEnvironment();
    expect(settingsService.twitchSimAliases).toEqual([]);
    settingsService.set(SettingsEnum.TWITCH_SIM_ALIASES, 'Grim Reaper=123\nbad line\nDeath=notdigits, Guard=45');
    expect(settingsService.twitchSimAliases).toEqual([
      { name: 'Grim Reaper', simId: '123' },
      { name: 'Guard', simId: '45' },
    ]);
  });

  it('normalizes the channel and falls back on an empty command word', () => {
    const { settingsService } = mockEnvironment();
    settingsService.set(SettingsEnum.TWITCH_CHANNEL, ' #MyChannel ');
    expect(settingsService.twitchChannel).toBe('mychannel');
    settingsService.set(SettingsEnum.TWITCH_COMMAND_WORD, '   ');
    expect(settingsService.twitchCommandWord).toBe('!ask');
  });
});
