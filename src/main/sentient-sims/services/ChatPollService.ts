// Plum's chat polls (STREAM tier, behind ctx.ext.chatPoll): Twitch chat votes on a crossroads
// Plum offered and the player agreed to. 'native' opens a Twitch poll through Helix; 'chat',
// and a native poll that cannot open, counts !vote lines off the chat TwitchChatService already
// reads. One poll at a time. When it closes, the votes and the winner wake Plum with a
// <chat_poll> turn to carry out, the result is kept as a Plum note, and the game shows a
// notification at open and at close. overlay() feeds the OBS page (util/pollOverlayPage).
import log from 'electron-log';
import type { ApiContext } from './ApiContext';
import type { TwitchChatService } from './TwitchChatService';
import type { HelixResult, TwitchAuthService } from './TwitchAuthService';
import type { ChatPollMode, ChatPollOpened, ChatPollRequest, ChatPollSlot, ChatPollView } from '../tiers/types';
import { extractCommand } from '../util/twitchIrc';
import { sendModNotification } from '../websocketServer';
import { ModWebsocketMessageType, ModWebsocketNotificationType } from '../models/ModWebsocketMessage';

// Twitch closes a poll on its own clock; the result is read this long after it should have
const NATIVE_SETTLE_MS = 2000;
const NATIVE_READ_RETRY_MS = 3000;
const NATIVE_READ_ATTEMPTS = 5;

// An open Twitch poll's running votes are read at most this often, and only while the overlay asks
const NATIVE_LIVE_MS = 3000;

type OpenPoll = {
  id: string;
  question: string;
  options: string[];
  note: string;
  mode: ChatPollMode;
  seconds: number;
  endsAt: number;
  // chat mode: voter key -> option index (a later vote replaces an earlier one)
  ballots: Map<string, number>;
  nativeId?: string;
  // native: the running votes, last read from Twitch
  liveCounts?: number[];
  timer?: ReturnType<typeof setTimeout>;
};

export type PollOverlayOption = { title: string; votes: number };

export type PollOverlayOutcome = 'decided' | 'no_votes' | 'unreadable' | 'cancelled';

// What the OBS overlay shows: the open poll, and the last one's result (the page decides how
// long to keep it up). Times are this machine's epoch ms; `now` lets the page correct its clock.
export type PollOverlayState = {
  now: number;
  poll?: {
    id: string;
    question: string;
    mode: ChatPollMode;
    seconds: number;
    endsAt: number;
    options: PollOverlayOption[];
    total: number;
  };
  result?: {
    id: string;
    question: string;
    mode: ChatPollMode;
    closedAt: number;
    outcome: PollOverlayOutcome;
    options: PollOverlayOption[];
    total: number;
    winner?: number;
    tied?: number[];
  };
};

export type PollTally = {
  counts: number[];
  total: number;
  // Undefined when nobody voted
  winner?: number;
  // The options that shared the top count, when more than one did
  tied?: number[];
};

export type ChatPollDeps = {
  now?: () => number;
  random?: () => number;
  // Where the result goes (Plum's wake queue by default)
  wake?: (text: string) => void;
};

// "2", "!vote 2" or "!vote yes" -> the option's index; undefined when the line is no vote.
// An option named by words must match one option alone: its whole title, or the start of it
// from three letters on.
export function parseVote(text: string, voteCommand: string, options: string[]): number | undefined {
  const trimmed = text.trim();
  const bare = /^(\d)$/.exec(trimmed);
  const rest = bare ? bare[1] : extractCommand(trimmed, voteCommand);
  if (!rest) {
    return undefined;
  }
  const number = /^(\d+)\b/.exec(rest);
  if (number) {
    const index = Number(number[1]) - 1;
    return index >= 0 && index < options.length ? index : undefined;
  }
  const words = rest.toLowerCase();
  const exact = options.findIndex((option) => option.toLowerCase() === words);
  if (exact >= 0) {
    return exact;
  }
  if (words.length < 3) {
    return undefined;
  }
  const prefixed = options.flatMap((option, index) => (option.toLowerCase().startsWith(words) ? [index] : []));
  return prefixed.length === 1 ? prefixed[0] : undefined;
}

// The winner by count; a tie is drawn by lot so the result never waits on anyone
export function tallyVotes(counts: number[], random: () => number = Math.random): PollTally {
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total === 0) {
    return { counts, total };
  }
  const top = Math.max(...counts);
  const leaders = counts.flatMap((count, index) => (count === top ? [index] : []));
  const winner = leaders[Math.min(leaders.length - 1, Math.floor(random() * leaders.length))];
  return { counts, total, winner, ...(leaders.length > 1 ? { tied: leaders } : {}) };
}

// The <chat_poll> wake Plum gets when a vote closes
export function chatPollWakeText(
  poll: { id: string; question: string; options: string[]; note: string; seconds: number },
  tally: PollTally | undefined,
  unreadable?: string,
): string {
  const lines = [`<chat_poll id="${poll.id}">`];
  if (!tally) {
    lines.push(
      `The result of the vote on "${poll.question}" could not be read (${unreadable ?? 'unknown error'}).`,
      'Do nothing in the game: ask the player to read the result on Twitch and tell you.',
    );
  } else if (tally.winner === undefined) {
    lines.push(
      `Nobody voted on "${poll.question}" in ${poll.seconds} s.`,
      'Do nothing in the game: tell the player in one sentence and ask what they want instead.',
    );
  } else {
    const counts = poll.options.map((option, index) => `${index + 1}. ${option} ${tally.counts[index]}`).join(', ');
    lines.push(
      `Twitch chat voted on "${poll.question}" for ${poll.seconds} s (${tally.total} vote${tally.total === 1 ? '' : 's'}): ${counts}.`,
      `Winner: "${poll.options[tally.winner]}".`,
    );
    if (tally.tied) {
      lines.push(
        `It was a tie between ${tally.tied.map((index) => `"${poll.options[index]}"`).join(' and ')}; the app drew the winner by lot.`,
      );
    }
    if (poll.note) {
      lines.push(`Your note when you opened it: "${poll.note}".`);
    }
    lines.push(
      'Nobody typed this: chat has decided, so carry the winner out now. Look first, then do every part your tools can; ' +
        'for anything no tool reaches, or a tool refuses, call hand_off once with the steps left for the player. ' +
        'Then say the result in one or two sentences.',
    );
  }
  lines.push('</chat_poll>');
  return lines.join('\n');
}

function notifyGame(title: string, message: string) {
  sendModNotification({
    type: ModWebsocketMessageType.NOTIFICATION,
    notification: { title, message, message_type: ModWebsocketNotificationType.MESSAGE },
  });
}

// Why Helix refused to open a poll, in the streamer's terms
function nativeRefusal(result: HelixResult): string {
  if (result.status === 401) {
    return 'the Twitch login lacks the poll permission: reconnect the account in the Twitch tab';
  }
  if (result.status === 403) {
    return 'this channel cannot run Twitch polls (Affiliate and Partner only)';
  }
  if (result.status === 0) {
    return result.message ?? 'Twitch could not be reached';
  }
  return `Twitch refused the poll (${result.status}${result.message ? `: ${result.message}` : ''})`;
}

export class ChatPollService implements ChatPollSlot {
  private readonly ctx: ApiContext;

  private readonly twitchChat: TwitchChatService;

  private readonly twitchAuth: TwitchAuthService;

  private readonly now: () => number;

  private readonly random: () => number;

  private readonly wake: (text: string) => void;

  private poll?: OpenPoll;

  private lastResult?: PollOverlayState['result'];

  private nativeReadAt = 0;

  private sequence = 0;

  constructor(ctx: ApiContext, twitchChat: TwitchChatService, twitchAuth: TwitchAuthService, deps: ChatPollDeps = {}) {
    this.ctx = ctx;
    this.twitchChat = twitchChat;
    this.twitchAuth = twitchAuth;
    this.now = deps.now ?? (() => Date.now());
    this.random = deps.random ?? Math.random;
    this.wake =
      deps.wake ??
      ((text) => {
        ctx.plum.wake.wakeWith(text);
      });
  }

  async open(request: ChatPollRequest): Promise<ChatPollOpened> {
    if (this.poll) {
      throw new Error(`a poll is already open ("${this.poll.question}"); cancel_poll first`);
    }
    const seconds = request.seconds || this.ctx.settings.twitchPollSeconds;
    this.sequence += 1;
    const poll: OpenPoll = {
      id: `poll-${this.sequence}`,
      question: request.question,
      options: request.options,
      note: request.note,
      mode: 'chat',
      seconds,
      endsAt: this.now() + seconds * 1000,
      ballots: new Map(),
    };
    let fellBack: string | undefined;
    if (this.ctx.settings.twitchPollMode === 'native') {
      const refusal = await this.openNative(poll);
      if (refusal) {
        fellBack = refusal;
        log.info(
          `[ChatPoll] native poll refused (${refusal}); counting ${this.ctx.settings.twitchVoteCommand} instead`,
        );
      }
    }
    if (poll.mode === 'chat' && !this.twitchChat.isConnected()) {
      const why = 'Twitch chat is not connected (Settings, Twitch tab)';
      throw new Error(fellBack ? `${fellBack}, and ${why}` : why);
    }
    this.poll = poll;
    if (poll.mode === 'chat') {
      this.twitchChat.voteSink = (voter, text) => this.onChatLine(voter, text);
    }
    poll.timer = setTimeout(
      () => {
        void this.close(poll);
      },
      seconds * 1000 + (poll.mode === 'native' ? NATIVE_SETTLE_MS : 0),
    );
    notifyGame('Chat vote', this.openingLine(poll));
    this.twitchChat.noteEvent(`Poll open: ${poll.question}`);
    log.info(`[ChatPoll] ${poll.id} open (${poll.mode}, ${seconds} s): ${poll.question} | ${poll.options.join(' | ')}`);
    return { id: poll.id, mode: poll.mode, seconds, ...(fellBack ? { fellBack } : {}) };
  }

  async cancel(): Promise<boolean> {
    const poll = this.poll;
    if (!poll) {
      return false;
    }
    this.finish(poll);
    this.keepResult(poll, 'cancelled', this.countsOf(poll));
    if (poll.nativeId) {
      // ARCHIVED ends it and hides the results on Twitch
      const result = await this.twitchAuth.helix('PATCH', '/polls', {
        broadcaster_id: this.ctx.settings.twitchAuth.broadcasterId,
        id: poll.nativeId,
        status: 'ARCHIVED',
      });
      if (result.status !== 200) {
        log.warn(`[ChatPoll] could not end the Twitch poll: ${nativeRefusal(result)}`);
      }
    }
    notifyGame('Chat vote', `The vote on "${poll.question}" was called off.`);
    this.twitchChat.noteEvent(`Poll cancelled: ${poll.question}`);
    log.info(`[ChatPoll] ${poll.id} cancelled`);
    return true;
  }

  current(): ChatPollView | undefined {
    const poll = this.poll;
    if (!poll) {
      return undefined;
    }
    const counts = this.countsOf(poll);
    return {
      id: poll.id,
      question: poll.question,
      mode: poll.mode,
      options: poll.options.map((title, index) => ({ title, votes: counts[index] })),
      secondsLeft: Math.max(0, Math.ceil((poll.endsAt - this.now()) / 1000)),
    };
  }

  overlay(): PollOverlayState {
    const now = this.now();
    const poll = this.poll;
    if (!poll) {
      return { now, ...(this.lastResult ? { result: this.lastResult } : {}) };
    }
    if (poll.mode === 'native' && now - this.nativeReadAt >= NATIVE_LIVE_MS) {
      this.nativeReadAt = now;
      void this.readNativeLive(poll);
    }
    const counts = this.countsOf(poll);
    return {
      now,
      poll: {
        id: poll.id,
        question: poll.question,
        mode: poll.mode,
        seconds: poll.seconds,
        endsAt: poll.endsAt,
        options: poll.options.map((title, index) => ({ title, votes: counts[index] })),
        total: counts.reduce((sum, count) => sum + count, 0),
      },
      ...(this.lastResult ? { result: this.lastResult } : {}),
    };
  }

  shutdown() {
    if (this.poll) {
      this.finish(this.poll);
    }
  }

  private async openNative(poll: OpenPoll): Promise<string | undefined> {
    const { broadcasterId } = this.ctx.settings.twitchAuth;
    if (!this.twitchAuth.getStatus().loggedIn || !broadcasterId) {
      return 'no Twitch account is connected (Settings, Twitch tab)';
    }
    if (!this.twitchAuth.pollsAllowed()) {
      return 'the Twitch login predates the poll permission: reconnect the account in the Twitch tab';
    }
    const result = await this.twitchAuth.helix('POST', '/polls', {
      broadcaster_id: broadcasterId,
      title: poll.question,
      choices: poll.options.map((title) => ({ title })),
      duration: poll.seconds,
    });
    const created = Array.isArray(result.data) ? (result.data[0] as { id?: string } | undefined) : undefined;
    if (result.status !== 200 || !created?.id) {
      return nativeRefusal(result);
    }
    poll.mode = 'native';
    poll.nativeId = created.id;
    return undefined;
  }

  private onChatLine(voter: { key: string; name: string }, text: string): boolean {
    const poll = this.poll;
    if (!poll || poll.mode !== 'chat') {
      return false;
    }
    const index = parseVote(text, this.ctx.settings.twitchVoteCommand, poll.options);
    if (index === undefined) {
      return false;
    }
    poll.ballots.set(voter.key, index);
    log.debug(`[ChatPoll] ${voter.name} voted ${index + 1} (${poll.options[index]})`);
    return true;
  }

  // Chat: the ballots. Native: Twitch's running votes, zeros until the overlay has read them.
  private countsOf(poll: OpenPoll): number[] {
    if (poll.mode === 'native') {
      return poll.liveCounts ?? poll.options.map(() => 0);
    }
    const counts = poll.options.map(() => 0);
    for (const index of poll.ballots.values()) {
      counts[index] += 1;
    }
    return counts;
  }

  private async readNativeLive(poll: OpenPoll) {
    const params = new URLSearchParams({
      broadcaster_id: this.ctx.settings.twitchAuth.broadcasterId ?? '',
      id: poll.nativeId ?? '',
    });
    const result = await this.twitchAuth.helix('GET', `/polls?${params.toString()}`);
    const found = Array.isArray(result.data)
      ? (result.data[0] as { choices?: { votes?: number }[] } | undefined)
      : undefined;
    if (result.status !== 200 || !found?.choices || this.poll !== poll) {
      return;
    }
    poll.liveCounts = poll.options.map((_, index) => {
      const votes = found.choices?.[index]?.votes;
      return typeof votes === 'number' ? votes : 0;
    });
  }

  private keepResult(poll: OpenPoll, outcome: PollOverlayOutcome, counts: number[], tally?: PollTally) {
    this.lastResult = {
      id: poll.id,
      question: poll.question,
      mode: poll.mode,
      closedAt: this.now(),
      outcome,
      options: poll.options.map((title, index) => ({ title, votes: counts[index] ?? 0 })),
      total: counts.reduce((sum, count) => sum + count, 0),
      ...(tally?.winner !== undefined ? { winner: tally.winner } : {}),
      ...(tally?.tied ? { tied: tally.tied } : {}),
    };
  }

  private async close(poll: OpenPoll) {
    if (this.poll !== poll) {
      return;
    }
    let tally: PollTally | undefined;
    let unreadable: string | undefined;
    if (poll.mode === 'native') {
      const counts = await this.readNative(poll);
      if (this.poll !== poll) {
        return;
      }
      if (Array.isArray(counts)) {
        tally = tallyVotes(counts, this.random);
      } else {
        unreadable = counts;
      }
    } else {
      tally = tallyVotes(this.countsOf(poll), this.random);
    }
    this.finish(poll);
    this.announce(poll, tally, unreadable);
    this.wake(chatPollWakeText(poll, tally, unreadable));
  }

  // The closed Twitch poll's votes, or why they could not be read
  private async readNative(poll: OpenPoll): Promise<number[] | string> {
    const params = new URLSearchParams({
      broadcaster_id: this.ctx.settings.twitchAuth.broadcasterId ?? '',
      id: poll.nativeId ?? '',
    });
    let why = 'the poll was still open';
    for (let attempt = 0; attempt < NATIVE_READ_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await new Promise((resolve) => {
          setTimeout(resolve, NATIVE_READ_RETRY_MS);
        });
      }
      const result = await this.twitchAuth.helix('GET', `/polls?${params.toString()}`);
      const found = Array.isArray(result.data)
        ? (result.data[0] as { status?: string; choices?: { title?: string; votes?: number }[] } | undefined)
        : undefined;
      if (result.status !== 200 || !found) {
        why = nativeRefusal(result);
      } else if (found.status !== 'ACTIVE') {
        return poll.options.map((title, index) => {
          const choice = found.choices?.[index];
          return typeof choice?.votes === 'number' ? choice.votes : 0;
        });
      }
    }
    return why;
  }

  private finish(poll: OpenPoll) {
    if (poll.timer) {
      clearTimeout(poll.timer);
    }
    if (this.poll === poll) {
      this.poll = undefined;
    }
    if (poll.mode === 'chat') {
      this.twitchChat.voteSink = undefined;
    }
  }

  private openingLine(poll: OpenPoll): string {
    if (poll.mode === 'native') {
      return `${poll.question} Vote in the Twitch poll (${poll.seconds} s).`;
    }
    const command = this.ctx.settings.twitchVoteCommand;
    const choices = poll.options.map((option, index) => `${command} ${index + 1} = ${option}`).join(', ');
    return `${poll.question} Type ${choices} (${poll.seconds} s).`;
  }

  private announce(poll: OpenPoll, tally: PollTally | undefined, unreadable: string | undefined) {
    let message: string;
    if (!tally) {
      this.keepResult(poll, 'unreadable', this.countsOf(poll));
      message = `The vote on "${poll.question}" closed, but its result could not be read.`;
      log.warn(`[ChatPoll] ${poll.id} closed unreadable: ${unreadable}`);
    } else if (tally.winner === undefined) {
      this.keepResult(poll, 'no_votes', tally.counts, tally);
      message = `Nobody voted on "${poll.question}".`;
      log.info(`[ChatPoll] ${poll.id} closed with no votes`);
    } else {
      this.keepResult(poll, 'decided', tally.counts, tally);
      const winner = poll.options[tally.winner];
      const votes = tally.counts[tally.winner];
      message = `Chat picked "${winner}" (${votes} of ${tally.total} vote${tally.total === 1 ? '' : 's'}${tally.tied ? ', a tie drawn by lot' : ''}).`;
      log.info(`[ChatPoll] ${poll.id} closed: ${winner} ${tally.counts.join('/')}`);
      this.keepNote(poll, winner, votes, tally.total);
    }
    notifyGame('Chat vote', message);
    this.twitchChat.noteEvent(message);
  }

  // The result outlives the conversation: Plum's notes come back at the start of every thread
  private keepNote(poll: OpenPoll, winner: string, votes: number, total: number) {
    try {
      if (!this.ctx.plumRepository.isLoaded()) {
        return;
      }
      const day = this.ctx.simStateCache.getReport()?.lot?.clock?.absolute_day;
      this.ctx.plumRepository.addNote(
        'chat_poll',
        `Chat voted on "${poll.question}": "${winner}" (${votes} of ${total}; options ${poll.options.join(' / ')})`,
        [],
        day,
      );
    } catch (error) {
      log.warn('[ChatPoll] could not keep the result as a note', error);
    }
  }
}
