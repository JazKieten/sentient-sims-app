// Minimal Twitch IRC (over websocket) line parsing for the read-only !ask integration.
// Pure functions only — no sockets, no timers — so the whole protocol surface unit-tests
// offline. Twitch speaks RFC1459 with IRCv3 tags when the tags capability is requested;
// the parser tolerates both tagged and untagged lines.
import { neutralizeMarkup } from '../db/entities/MemoryEntity';

export type IrcMessage = {
  tags: Record<string, string>;
  prefix?: string;
  nick?: string;
  command: string;
  params: string[];
  trailing?: string;
};

// A websocket frame can carry several \r\n-terminated IRC lines
export function splitIrcLines(frame: string): string[] {
  return frame
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// IRCv3 tag values escape ; as \: and space as \s
function unescapeTagValue(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char !== '\\') {
      out += char;
    } else {
      const next = i + 1 < value.length ? value[i + 1] : '';
      if (next === ':') out += ';';
      else if (next === 's') out += ' ';
      else if (next === '\\') out += '\\';
      else if (next === 'r') out += '\r';
      else if (next === 'n') out += '\n';
      else out += next;
      i += 1;
    }
  }
  return out;
}

export function parseIrcLine(line: string): IrcMessage | undefined {
  let rest = line.trim();
  if (!rest) {
    return undefined;
  }

  const tags: Record<string, string> = {};
  if (rest.startsWith('@')) {
    const space = rest.indexOf(' ');
    if (space === -1) {
      return undefined;
    }
    rest
      .slice(1, space)
      .split(';')
      .forEach((pair) => {
        if (!pair) {
          return;
        }
        const eq = pair.indexOf('=');
        if (eq === -1) {
          tags[pair] = '';
        } else {
          tags[pair.slice(0, eq)] = unescapeTagValue(pair.slice(eq + 1));
        }
      });
    rest = rest.slice(space + 1).trimStart();
  }

  let prefix: string | undefined;
  let nick: string | undefined;
  if (rest.startsWith(':')) {
    const space = rest.indexOf(' ');
    if (space === -1) {
      return undefined;
    }
    prefix = rest.slice(1, space);
    const bang = prefix.indexOf('!');
    nick = bang === -1 ? prefix : prefix.slice(0, bang);
    rest = rest.slice(space + 1).trimStart();
  }

  let trailing: string | undefined;
  const trailingStart = rest.indexOf(' :');
  if (trailingStart !== -1) {
    trailing = rest.slice(trailingStart + 2);
    rest = rest.slice(0, trailingStart);
  }

  const parts = rest.split(' ').filter((part) => part.length > 0);
  const command = parts.shift();
  if (!command) {
    return undefined;
  }

  return { tags, prefix, nick, command: command.toUpperCase(), params: parts, trailing };
}

export type TwitchBadges = {
  mod: boolean;
  subscriber: boolean;
  broadcaster: boolean;
};

// Only meaningful when the connection requested twitch.tv/tags; without tags every flag is
// false and permission filters must treat the sender as a plain viewer.
export function parseBadges(tags: Record<string, string>): TwitchBadges {
  const badgeNames = (tags.badges || '')
    .split(',')
    .map((badge) => badge.split('/')[0])
    .filter((name) => name.length > 0);
  // The channel owner has broadcaster/1 but NOT mod=1
  const broadcaster = badgeNames.includes('broadcaster');
  return {
    broadcaster,
    mod: tags.mod === '1' || badgeNames.includes('moderator'),
    subscriber: tags.subscriber === '1' || badgeNames.includes('subscriber') || badgeNames.includes('founder'),
  };
}

// /me messages arrive wrapped as \u0001ACTION ...\u0001
export function stripAction(text: string): string {
  // eslint-disable-next-line no-control-regex
  const match = /^\u0001ACTION (.*)\u0001$/.exec(text);
  return match ? match[1] : text;
}

// '!ask what do you dream about' -> 'what do you dream about'; '!askfoo ...' must NOT match
export function extractCommand(text: string, commandWord: string): string | undefined {
  const trimmed = text.trim();
  const word = commandWord.trim();
  if (!word || trimmed.length < word.length) {
    return undefined;
  }
  if (trimmed.slice(0, word.length).toLowerCase() !== word.toLowerCase()) {
    return undefined;
  }
  const after = trimmed.slice(word.length);
  if (after && !/^\s/.test(after)) {
    return undefined;
  }
  return after.trim();
}

// Viewer text goes to the game's Flash htmlText UI (via the mod's player-voice echo and the
// scene subtitles) where a raw '<' swallows everything after it, and into an LLM prompt —
// so: control chars stripped, markup neutralized, whitespace collapsed, length capped.
export function sanitizeQuestion(raw: string, maxLength: number): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = neutralizeMarkup(raw.replace(/[\u0000-\u001f\u007f]/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, maxLength).trim();
}
