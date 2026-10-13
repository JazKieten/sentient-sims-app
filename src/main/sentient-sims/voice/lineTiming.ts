// Word timing for a spoken line, so the mod can reveal the words as the voice says them.
//
// ElevenLabs returns character timestamps next to the audio on its `with-timestamps`
// endpoints (alignment: one entry per character of the text that was SENT, which on v3/v4
// carries a `[tag] ` prefix the line itself does not). Kokoro returns nothing, so a line's
// timing is synthesized from its audio duration. Either way the mod gets ONE shape per
// line (ModSceneLine.reveal): the start time of every whitespace-delimited word in ms from
// the moment playback started. Pure functions, no DOM, no Electron.
//
// The mod tokenizes the same way (overlay/subtitle_reveal.py tokenize): a word is a
// maximal run of non-whitespace; neutralizeMarkup is one-to-one per codepoint, so the
// word boundaries computed here on the renderer's text match the text the mod shows.

export type ElevenLabsAlignment = {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
};

export type WordTiming = {
  // Start of each word in ms from playback start, one per word of the text (a prefix
  // when partial), never decreasing
  word_ms: number[];
  // True while the times cover only the first words (a line still streaming in)
  partial: boolean;
};

// Weights of the synthesized timing: a letter 1, a space 0.6, a short pause 3, a sentence
// end 6. Mirrors the mod's estimate_word_times (used by its cheats).
const WEIGHT_SPACE = 0.6;
const WEIGHT_SHORT_PAUSE = 3;
const WEIGHT_SENTENCE_END = 6;
const SHORT_PAUSE_CHARS = ',;:';
const SENTENCE_END_CHARS = '.?!…';

export function codepoints(text: string): string[] {
  return Array.from(text);
}

function isSpace(char: string): boolean {
  return /\s/u.test(char);
}

// [start, end) codepoint spans of the whitespace-delimited words of text, in order
export function wordSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  const chars = codepoints(text);
  let start = -1;
  chars.forEach((char, index) => {
    if (isSpace(char)) {
      if (start >= 0) {
        spans.push([start, index]);
        start = -1;
      }
    } else if (start < 0) {
      start = index;
    }
  });
  if (start >= 0) {
    spans.push([start, chars.length]);
  }
  return spans;
}

export function emptyAlignment(): ElevenLabsAlignment {
  return { characters: [], character_start_times_seconds: [], character_end_times_seconds: [] };
}

export function isAlignment(value: unknown): value is ElevenLabsAlignment {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ElevenLabsAlignment>;
  return (
    Array.isArray(candidate.characters) &&
    Array.isArray(candidate.character_start_times_seconds) &&
    Array.isArray(candidate.character_end_times_seconds)
  );
}

/**
 * Appends a streamed chunk's alignment to the accumulator. The streamed endpoints time
 * each chunk either from the start of the whole utterance or from the start of the chunk;
 * a chunk whose first time falls below what the accumulator already reached is relative
 * and is shifted by the last end time. Returns the accumulator.
 */
export function mergeChunkAlignment(acc: ElevenLabsAlignment, chunk: ElevenLabsAlignment): ElevenLabsAlignment {
  const count = Math.min(
    chunk.characters.length,
    chunk.character_start_times_seconds.length,
    chunk.character_end_times_seconds.length,
  );
  if (count === 0) return acc;
  const lastEnd = acc.character_end_times_seconds.length
    ? acc.character_end_times_seconds[acc.character_end_times_seconds.length - 1]
    : 0;
  const base = chunk.character_start_times_seconds[0] < lastEnd - 0.001 ? lastEnd : 0;
  for (let i = 0; i < count; i += 1) {
    acc.characters.push(chunk.characters[i]);
    acc.character_start_times_seconds.push(chunk.character_start_times_seconds[i] + base);
    acc.character_end_times_seconds.push(chunk.character_end_times_seconds[i] + base);
  }
  return acc;
}

/**
 * The start time (ms) of every codepoint of `lineText` the alignment covers, in order.
 * `sentText` is what went to ElevenLabs: `lineText`, or `[tag] ` + `lineText` on v3/v4,
 * so the line is matched as a SUFFIX of it by codepoint count. The alignment's characters
 * are checked against the sent text where both exist; a mismatch (the API normalized
 * something) returns null rather than times that belong to the wrong letters. A result
 * shorter than the line is a streamed prefix.
 */
export function alignmentToCharMs(
  alignment: ElevenLabsAlignment | null | undefined,
  sentText: string,
  lineText: string,
): number[] | null {
  if (!alignment || !isAlignment(alignment)) return null;
  const sent = codepoints(sentText);
  const line = codepoints(lineText);
  const offset = sent.length - line.length;
  if (offset < 0) return null;
  for (let i = 0; i < line.length; i += 1) {
    if (sent[offset + i] !== line[i]) return null;
  }
  const chars = alignment.characters;
  const starts = alignment.character_start_times_seconds;
  const available = Math.min(chars.length, starts.length);
  // Only compare where both exist: the API may chunk a multi-byte character oddly, and a
  // streamed prefix is shorter than the text by design
  const compared = Math.min(available, sent.length);
  for (let i = 0; i < compared; i += 1) {
    if (chars[i] !== sent[i]) return null;
  }
  const covered = Math.max(0, Math.min(available, sent.length) - offset);
  const out: number[] = [];
  let floor = 0;
  for (let i = 0; i < covered; i += 1) {
    const ms = Math.max(0, starts[offset + i] * 1000);
    floor = Math.max(floor, ms);
    out.push(Math.round(floor));
  }
  return out;
}

/**
 * Word start times from per-codepoint start times (a prefix of the text's codepoints):
 * the time of each word's first character. Partial while the times stop short of the
 * last word.
 */
export function wordStartsMs(text: string, charMs: number[]): WordTiming {
  const spans = wordSpans(text);
  const word_ms: number[] = [];
  let floor = 0;
  for (const [start] of spans) {
    if (start >= charMs.length) break;
    floor = Math.max(floor, charMs[start]);
    word_ms.push(Math.round(floor));
  }
  return { word_ms, partial: word_ms.length < spans.length };
}

/**
 * Word start times for a line with no timestamps: the audio's duration shared out over
 * the words by weight, punctuation taking longer. The last word's slot ends at the
 * duration.
 */
export function synthesizeWordTimes(text: string, durationMs: number): number[] {
  const spans = wordSpans(text);
  if (spans.length === 0) return [];
  const chars = codepoints(text);
  const weights = spans.map(([start, end]) => {
    let weight = 0;
    for (let i = start; i < end; i += 1) {
      if (SENTENCE_END_CHARS.includes(chars[i])) weight += WEIGHT_SENTENCE_END;
      else if (SHORT_PAUSE_CHARS.includes(chars[i])) weight += WEIGHT_SHORT_PAUSE;
      else weight += 1;
    }
    return weight + WEIGHT_SPACE;
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const scale = Math.max(0, durationMs) / total;
  const times: number[] = [];
  let elapsed = 0;
  weights.forEach((weight) => {
    times.push(Math.round(elapsed * scale));
    elapsed += weight;
  });
  return times;
}

// Always a view over its own ArrayBuffer (never Node's shared Buffer pool), so the
// bytes can be handed to a Blob as they are.
export function decodeBase64(data: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(data, 'base64'));
  }
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
