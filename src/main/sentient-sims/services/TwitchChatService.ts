import log from 'electron-log';
import { WebSocket } from 'ws';
import { SettingsEnum } from '../models/SettingsEnum';
import { ApiType } from '../models/ApiType';
import {
  twitchAnswerFallbackMs,
  twitchAnswerSettleMs,
  twitchAskQueueCap,
  twitchIdleTimeoutMs,
  twitchIrcUrl,
  twitchModRetryMs,
  twitchQuestionMaxLength,
  twitchReconnectMaxMs,
} from '../util/twitchConstants';
import { TwitchChatState, TwitchChatStatus } from '../models/TwitchChatStatus';
import { notifyTwitchStatus } from '../util/notifyRenderer';
import {
  extractCommand,
  parseBadges,
  parseIrcLine,
  sanitizeQuestion,
  sanitizeViewerName,
  splitIrcLines,
  stripAction,
  stripLeadingMention,
} from '../util/twitchIrc';
import {
  SimTargetCandidate,
  SimTargetResolution,
  TWITCH_CHAT_FLAVOR,
  TWITCH_CHAT_SPEAKER,
  buildAskSentientSim,
  buildTwitchAskEvent,
  resolveSimTarget,
} from '../util/twitchSimTarget';
import { isWebSocketConnected } from '../websocketServer';
import { ApiContext } from './ApiContext';

// Minimal surface of `ws`'s WebSocket so tests can inject a scripted fake
export type TwitchSocketLike = {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  send(data: string): void;
  close(): void;
};

export type TwitchSocketFactory = (url: string) => TwitchSocketLike;

const defaultSocketFactory: TwitchSocketFactory = (url) => new WebSocket(url);

type QueuedQuestion = {
  question: string;
  viewer: string;
};

type RosterCandidate = SimTargetCandidate & { isHousehold?: boolean; isAlias?: boolean };

// Twitch !ask: an anonymous read-only IRC connection (justinfan nick, no OAuth) watches the
// streamer's chat for the command word and feeds accepted questions one at a time into the
// existing player-voice pipeline — the active sim answers aloud as the player's persona
// ("The Voice" by default) with subtitle and memory handled downstream. Lifecycle mirrors
// VoiceInputService: constructed in main.ts, initialize/shutdown, onSettingChanged.
export class TwitchChatService {
  private readonly ctx: ApiContext;

  private readonly socketFactory: TwitchSocketFactory;

  private socket?: TwitchSocketLike;

  // Bumped on every (re)connect and captured by socket handlers so a torn-down socket's
  // close/error events cannot clobber the replacement connection's state
  private epoch = 0;

  private state: TwitchChatState = 'disabled';

  private lastEvent?: string;

  private readonly queue: QueuedQuestion[] = [];

  private inFlight = false;

  private backoffAttempt = 0;

  private lastGlobalAcceptAt = 0;

  private readonly viewerLastAcceptAt = new Map<string, number>();

  // Twitch stamps every PRIVMSG with a unique id tag; remembering recent ones makes any
  // double delivery (dev-restart overlap where old+new instance both listen, reconnect
  // echo) harmless — the duplicate is skipped instead of answered twice
  private readonly seenMessageIds: string[] = [];

  private reconnectTimer?: NodeJS.Timeout;

  private idleTimer?: NodeJS.Timeout;

  private fallbackTimer?: NodeJS.Timeout;

  private settleTimer?: NodeJS.Timeout;

  private modRetryTimer?: NodeJS.Timeout;

  private reconfigureTimer?: NodeJS.Timeout;

  constructor(ctx: ApiContext, socketFactory?: TwitchSocketFactory) {
    this.ctx = ctx;
    this.socketFactory = socketFactory ?? defaultSocketFactory;
  }

  initialize() {
    this.ctx.twitchAuth.onChanged = () => {
      this.pushStatus();
    };
    this.reconfigure();
  }

  shutdown() {
    this.clearTimer('reconnectTimer');
    this.clearTimer('idleTimer');
    this.clearTimer('fallbackTimer');
    this.clearTimer('settleTimer');
    this.clearTimer('modRetryTimer');
    this.clearTimer('reconfigureTimer');
    this.closeSocket();
    this.queue.length = 0;
    this.inFlight = false;
    this.state = 'disabled';
  }

  onSettingChanged(key: string) {
    if (key === (SettingsEnum.TWITCH_CHAT_ENABLED as string) || key === (SettingsEnum.TWITCH_CHANNEL as string)) {
      // Debounced: the settings UI writes per keystroke and each channel change reconnects
      this.clearTimer('reconfigureTimer');
      this.reconfigureTimer = setTimeout(() => {
        this.reconfigure();
      }, 500);
    } else if (key.startsWith('twitch')) {
      // Cooldowns/permission/command word are read live per message; just refresh the panel
      this.pushStatus();
    }
  }

  getStatus(): TwitchChatStatus {
    return {
      state: this.state,
      channel: this.ctx.settings.twitchChannel,
      queueDepth: this.queue.length,
      lastEvent: this.lastEvent,
      auth: this.ctx.twitchAuth.getStatus(),
    };
  }

  // The /debug/twitch-message route: exercises the exact same path as a live PRIVMSG so the
  // whole pipeline can be tested end-to-end without a live stream
  handleDebugMessage(user: string, message: string, opts?: { mod?: boolean; subscriber?: boolean; userId?: string }) {
    const tags: Record<string, string> = {
      'display-name': user,
      'user-id': opts?.userId ?? '',
      'mod': opts?.mod ? '1' : '0',
      'subscriber': opts?.subscriber ? '1' : '0',
    };
    this.handleChatMessage(user, tags, message);
  }

  private reconfigure() {
    this.clearTimer('reconnectTimer');
    this.backoffAttempt = 0;
    this.closeSocket();
    const channel = this.ctx.settings.twitchChannel;
    if (!this.ctx.settings.twitchChatEnabled || !channel) {
      this.setState('disabled');
      return;
    }
    this.connect();
  }

  private connect() {
    this.epoch += 1;
    const epoch = this.epoch;
    const channel = this.ctx.settings.twitchChannel;
    this.setState(this.backoffAttempt > 0 ? 'reconnecting' : 'connecting');
    let socket: TwitchSocketLike;
    try {
      socket = this.socketFactory(twitchIrcUrl);
    } catch (err) {
      log.error('Twitch: could not open chat socket', err);
      this.scheduleReconnect(epoch);
      return;
    }
    this.socket = socket;
    socket.on('open', () => {
      if (epoch !== this.epoch) {
        return;
      }
      // Anonymous read-only login; fresh digits per attempt sidestep nick collisions.
      // Tags are requested for the mods/subs filter and the follower gate's user-id.
      const nick = `justinfan${Math.floor(10000 + Math.random() * 89999)}`;
      this.sendRaw('CAP REQ :twitch.tv/tags');
      this.sendRaw(`NICK ${nick}`);
      this.sendRaw(`JOIN #${channel}`);
      this.armIdleWatchdog(epoch);
    });
    socket.on('message', (data: unknown) => {
      if (epoch !== this.epoch) {
        return;
      }
      this.armIdleWatchdog(epoch);
      this.handleFrame(String(data));
    });
    socket.on('close', () => {
      if (epoch !== this.epoch) {
        return;
      }
      this.scheduleReconnect(epoch);
    });
    socket.on('error', (err: unknown) => {
      if (epoch !== this.epoch) {
        return;
      }
      log.error('Twitch chat socket error', err);
      // 'close' follows and schedules the reconnect
    });
  }

  private handleFrame(frame: string) {
    splitIrcLines(frame).forEach((line) => {
      const message = parseIrcLine(line);
      if (!message) {
        return;
      }
      if (message.command === 'PING') {
        this.sendRaw(`PONG :${message.trailing ?? 'tmi.twitch.tv'}`);
        return;
      }
      if (message.command === 'RECONNECT') {
        log.info('Twitch requested a reconnect');
        this.scheduleReconnect(this.epoch);
        return;
      }
      // 366 = end of JOIN names list: we are in the channel
      if (message.command === '366') {
        this.backoffAttempt = 0;
        this.setState('connected', `Connected to #${this.ctx.settings.twitchChannel}`);
        log.info(`Twitch: connected to #${this.ctx.settings.twitchChannel}`);
        return;
      }
      if (message.command === 'NOTICE' && (message.trailing ?? '').toLowerCase().includes('login')) {
        log.warn(`Twitch NOTICE: ${message.trailing}`);
        this.scheduleReconnect(this.epoch);
        return;
      }
      if (message.command === 'PRIVMSG') {
        const viewer = message.tags['display-name'] || message.nick || 'viewer';
        this.handleChatMessage(viewer, message.tags, message.trailing ?? '');
      }
    });
  }

  private handleChatMessage(viewer: string, tags: Record<string, string>, text: string) {
    // Every received message is visible at debug level so a missing !ask is never invisible
    log.debug(`Twitch <${viewer}>: ${text}`);
    const messageId = tags.id;
    if (messageId) {
      if (this.seenMessageIds.includes(messageId)) {
        log.info(`Twitch: skipped duplicate delivery of message ${messageId} from ${viewer}`);
        return;
      }
      this.seenMessageIds.push(messageId);
      if (this.seenMessageIds.length > 100) {
        this.seenMessageIds.shift();
      }
    }
    const commandWord = this.ctx.settings.twitchCommandWord;
    // Twitch's reply feature prefixes "@username " — strip it or those asks vanish silently
    const question = extractCommand(stripLeadingMention(stripAction(text)), commandWord);
    if (question === undefined) {
      if (text.toLowerCase().includes(commandWord.toLowerCase())) {
        log.info(`Twitch: message from ${viewer} contains ${commandWord} but did not parse as a command: ${text}`);
      }
      return;
    }
    void this.handleAsk(viewer, tags, question);
  }

  private async handleAsk(viewer: string, tags: Record<string, string>, rawQuestion: string) {
    const badges = parseBadges(tags);
    const privileged = badges.mod || badges.broadcaster;

    const permission = this.ctx.settings.twitchAskPermission;
    if (permission === 'mods' && !privileged) {
      this.drop(`Dropped !ask from ${viewer}: mods only`);
      return;
    }
    if (permission === 'subs' && !privileged && !badges.subscriber) {
      this.drop(`Dropped !ask from ${viewer}: subscribers only`);
      return;
    }

    const now = Date.now();
    const globalCooldownMs = this.ctx.settings.twitchGlobalCooldownSeconds * 1000;
    if (now - this.lastGlobalAcceptAt < globalCooldownMs) {
      this.drop(`Dropped !ask from ${viewer}: global cooldown`);
      return;
    }
    const viewerKey = viewer.toLowerCase();
    const viewerCooldownMs = this.ctx.settings.twitchViewerCooldownSeconds * 1000;
    const viewerLast = this.viewerLastAcceptAt.get(viewerKey) ?? 0;
    if (now - viewerLast < viewerCooldownMs) {
      this.drop(`Dropped !ask from ${viewer}: viewer cooldown`);
      return;
    }

    const question = sanitizeQuestion(rawQuestion, twitchQuestionMaxLength);
    if (!question) {
      this.drop(`Dropped !ask from ${viewer}: empty question`);
      return;
    }

    if (this.ctx.settings.twitchFollowersOnly && !privileged) {
      if (!this.ctx.twitchAuth.getStatus().loggedIn) {
        this.drop('Follower gate is on but no Twitch account is connected (Settings, Twitch tab)');
        return;
      }
      const viewerUserId = tags['user-id'];
      if (!viewerUserId) {
        this.drop(`Dropped !ask from ${viewer}: no user id on the message`);
        return;
      }
      const follows = await this.ctx.twitchAuth.isFollower(viewerUserId);
      if (follows === undefined) {
        this.drop(`Dropped !ask from ${viewer}: follower check unavailable`);
        return;
      }
      if (!follows) {
        this.drop(`Dropped !ask from ${viewer}: not a follower`);
        return;
      }
    }

    if (this.queue.length >= twitchAskQueueCap) {
      this.drop(`Dropped !ask from ${viewer}: question queue full`);
      return;
    }

    // Stamp cooldowns only on accept so a gated ask does not burn the viewer's cooldown
    this.lastGlobalAcceptAt = now;
    this.viewerLastAcceptAt.set(viewerKey, now);
    this.pruneViewerCooldowns();

    this.queue.push({ question, viewer });
    this.setEvent(`Accepted !ask from ${viewer}`);
    log.info(`Twitch: accepted !ask from ${viewer}: ${question}`);
    this.maybeDispatch();
  }

  private maybeDispatch() {
    this.clearTimer('modRetryTimer');
    if (this.inFlight || this.queue.length === 0) {
      return;
    }
    if (!isWebSocketConnected('mod')) {
      // The answer's subtitles/TTS pushes need the game — hold the queue instead of losing it
      this.setEvent('Waiting: game not connected');
      this.modRetryTimer = setTimeout(() => {
        this.maybeDispatch();
      }, twitchModRetryMs);
      return;
    }
    const roster = this.rosterCandidates();
    if (!roster.some((candidate) => !candidate.isAlias)) {
      // The game reports its sims every ~5s; before the first report there is no one to
      // ask (aliases alone don't count — unnamed asks need a real active-sim fallback)
      this.setEvent('Waiting: no sims reported yet');
      this.modRetryTimer = setTimeout(() => {
        this.maybeDispatch();
      }, twitchModRetryMs);
      return;
    }
    const item = this.queue.shift();
    if (!item) {
      return;
    }
    this.inFlight = true;
    this.dispatchAsk(item, roster);
    // Backstop only — completion is the generation promise; this releases the queue if a
    // generation hangs past the mod's own 80s abandon window
    this.fallbackTimer = setTimeout(() => {
      log.warn('Twitch: ask generation never settled within the fallback window; releasing the queue');
      this.inFlight = false;
      this.maybeDispatch();
    }, twitchAnswerFallbackMs);
  }

  // The roster from the last FULL state report. Paused heartbeats and daemon-thread
  // supplements arrive WITHOUT a sims array and still become the cache's "latest report"
  // (live 08-26 that starved the roster for 20+ minutes), so the last full roster is kept
  // here. The cache's all-time per-sim entries are NOT a substitute: they span lots and
  // saves, and live 08-26 they grew two "(active)" sims and sent every unnamed ask to a
  // sim the player no longer controlled.
  private lastRoster: RosterCandidate[] = [];

  // Sims the game currently reports (household + up to 8 on-lot NPCs), plus configured
  // aliases: sims the game reports namelessly (service NPCs like the Grim Reaper), which
  // chat may address even when they are not on the lot. Aliases never lift the roster
  // hold and never catch the active-sim fallback.
  private rosterCandidates(): RosterCandidate[] {
    try {
      const report = this.ctx.simStateCache.getReport();
      const sims = report?.sims ?? [];
      if (sims.length > 0) {
        this.lastRoster = sims.flatMap((entry) =>
          entry.sim_id && entry.sim_name
            ? [
                {
                  simId: entry.sim_id,
                  name: entry.sim_name,
                  isActive: entry.is_active,
                  isHousehold: entry.is_household,
                },
              ]
            : [],
        );
      }
      // Players switch sims while paused (they pause to type), and full reports only
      // flow unpaused — so the kept roster's active flag went stale mid-playtest
      // (live 08-27: every unnamed ask went to a sim deselected 15 minutes earlier).
      // Paused heartbeats carry the selection; follow it when it names a kept sim.
      const activeId = report?.active_sim_id;
      if (activeId && this.lastRoster.some((candidate) => candidate.simId === activeId)) {
        this.lastRoster = this.lastRoster.map((candidate) => ({
          ...candidate,
          isActive: candidate.simId === activeId,
        }));
      }
      const aliases: RosterCandidate[] = this.ctx.settings.twitchSimAliases.map((alias) => ({
        simId: alias.simId,
        name: alias.name,
        isAlias: true,
      }));
      return [...this.lastRoster, ...aliases];
    } catch {
      return this.lastRoster;
    }
  }

  private dispatchAsk(item: QueuedQuestion, roster: RosterCandidate[]) {
    const resolved = resolveSimTarget(item.question, roster);
    if (!resolved && item.question.trim().split(/\s+/).length >= 2) {
      // Diagnosability: last time targeting "didn't work" the fallback was silent
      log.info(
        `Twitch: no sim name matched; the active sim answers. Roster: ${roster
          .map((candidate) => candidate.name + (candidate.isActive ? ' (active)' : ''))
          .join(', ')}`,
      );
    }
    // Unnamed asks always go to a REAL reported sim (the hold above guarantees one exists);
    // an alias must never absorb them
    const realSims = roster.filter((candidate) => !candidate.isAlias);
    const fallback =
      realSims.find((candidate) => candidate.isActive) ??
      realSims.find((candidate) => candidate.isHousehold !== false) ??
      realSims[0];
    const target = resolved ?? { simId: fallback.simId, name: fallback.name, question: item.question };
    // Display credit: "(viewer)" for the active sim, "(viewer, to Jonah)" when the viewer
    // named a sim. The mod's speaker-tag regex allows at most 40 non-paren chars, and a
    // failed match demotes the whole line to narration — hence the hard cap.
    const viewerTag = sanitizeViewerName(item.viewer);
    const displayTag = resolved
      ? `${viewerTag}, to ${target.name.trim().split(/\s+/)[0]}`.slice(0, 40).trim()
      : viewerTag;
    this.setEvent(`Asking ${target.name} (from ${item.viewer})`);
    log.info(`Twitch: asking ${target.name}${resolved ? ' (named)' : ''} (from ${item.viewer}): ${target.question}`);
    void this.ctx.generationQueue
      .runSpeech(() => this.runAsk(target, displayTag, viewerTag))
      .catch((err: unknown) => {
        log.error('Twitch: ask generation failed', err);
        this.setEvent(`Asking ${target.name} failed; see logs`);
      })
      .finally(() => {
        this.handleAnswerComplete();
      });
  }

  // App-built solo chat event: answers Voice-style no matter what conversation is running,
  // plays next (priority), and the "Chat: <question>" action row gives viewers their own
  // section in the in-game memories window
  private async runAsk(target: SimTargetResolution, displayTag: string, viewerTag: string) {
    let description: string | undefined;
    try {
      description = this.ctx.participantRepository.getParticipant({
        id: target.simId,
        fullName: target.name,
      }).description;
    } catch {
      // no save loaded yet: the name and memories still carry the scene
    }
    const entry = this.ctx.simStateCache.getSim(target.simId);
    const sim = buildAskSentientSim({
      simId: target.simId,
      name: target.name,
      description,
      isActive: entry?.is_active,
    });
    const locationId = this.ctx.sceneService.getCurrentScene()?.locationId ?? 0;
    const event = buildTwitchAskEvent(sim, target.question, locationId);
    // Chat's own voice: only when the renderer's TTS engine is ElevenLabs — gating here
    // keeps the chat line away from other engines and the TTS-off reading-hold entirely
    const { settings } = this.ctx;
    const speakQuestion =
      settings.twitchSpeakQuestions && settings.ttsEnabled && settings.ttsApiType === ApiType.ElevenLabs;
    // saveMemory: no mod round trip exists on this path to persist the exchange.
    // The display speaker credits the asking viewer in-game ("Chat (viewer): ...") while
    // the model and the stored memory row only ever see plain "Chat".
    await this.ctx.ai.runDirectedGeneration(
      event,
      {
        playerLine: { speaker: TWITCH_CHAT_SPEAKER, text: target.question },
        playerLineFlavor: TWITCH_CHAT_FLAVOR,
        playerLineDisplaySpeaker: `${TWITCH_CHAT_SPEAKER} (${displayTag})`,
        saveMemory: true,
        ...(speakQuestion
          ? {
              speakPlayerLine: {
                voiceId: settings.twitchChatVoiceId,
                spokenText: `${viewerTag} asks: ${target.question}`,
              },
            }
          : {}),
      },
      { priority: true },
    );
  }

  private handleAnswerComplete() {
    if (!this.inFlight) {
      return;
    }
    this.clearTimer('fallbackTimer');
    this.clearTimer('settleTimer');
    // Short breather so this answer's subtitle/TTS starts before the next question lands
    this.settleTimer = setTimeout(() => {
      this.inFlight = false;
      this.maybeDispatch();
    }, twitchAnswerSettleMs);
  }

  private scheduleReconnect(epoch: number) {
    if (epoch !== this.epoch) {
      return;
    }
    this.closeSocket();
    this.clearTimer('idleTimer');
    if (!this.ctx.settings.twitchChatEnabled || !this.ctx.settings.twitchChannel) {
      this.setState('disabled');
      return;
    }
    this.backoffAttempt += 1;
    const delay = Math.min(1000 * 2 ** (this.backoffAttempt - 1), twitchReconnectMaxMs) + Math.random() * 1000;
    this.setState('reconnecting', `Reconnecting to Twitch (attempt ${this.backoffAttempt})`);
    this.clearTimer('reconnectTimer');
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  // Twitch pings roughly every 5 minutes; a silent socket is half-open (sleep/wake)
  private armIdleWatchdog(epoch: number) {
    this.clearTimer('idleTimer');
    this.idleTimer = setTimeout(() => {
      if (epoch !== this.epoch) {
        return;
      }
      log.warn('Twitch chat socket went silent; reconnecting');
      this.scheduleReconnect(epoch);
    }, twitchIdleTimeoutMs);
  }

  private pruneViewerCooldowns() {
    if (this.viewerLastAcceptAt.size <= 500) {
      return;
    }
    const cutoff = Date.now() - this.ctx.settings.twitchViewerCooldownSeconds * 1000;
    [...this.viewerLastAcceptAt.entries()].forEach(([key, acceptedAt]) => {
      if (acceptedAt < cutoff) {
        this.viewerLastAcceptAt.delete(key);
      }
    });
  }

  private sendRaw(line: string) {
    try {
      this.socket?.send(`${line}\r\n`);
    } catch (err) {
      log.error('Twitch: could not send to chat socket', err);
    }
  }

  private closeSocket() {
    const socket = this.socket;
    this.socket = undefined;
    // Orphan the old socket's events before closing so its 'close' cannot re-schedule
    this.epoch += 1;
    if (socket) {
      try {
        socket.close();
      } catch {
        // already closed
      }
    }
  }

  private drop(reason: string) {
    log.info(`Twitch: ${reason}`);
    this.setEvent(reason);
  }

  private setEvent(event: string) {
    this.lastEvent = event;
    this.pushStatus();
  }

  private setState(state: TwitchChatState, event?: string) {
    this.state = state;
    if (event) {
      this.lastEvent = event;
    }
    this.pushStatus();
  }

  private pushStatus() {
    notifyTwitchStatus(this.getStatus());
  }

  private clearTimer(
    name: 'reconnectTimer' | 'idleTimer' | 'fallbackTimer' | 'settleTimer' | 'modRetryTimer' | 'reconfigureTimer',
  ) {
    const timer = this[name];
    if (timer) {
      clearTimeout(timer);
      this[name] = undefined;
    }
  }
}
