import { describe, it, expect } from 'vitest';
import {
  alignmentToCharMs,
  codepoints,
  decodeBase64,
  ElevenLabsAlignment,
  emptyAlignment,
  mergeChunkAlignment,
  synthesizeWordTimes,
  wordSpans,
  wordStartsMs,
} from 'main/sentient-sims/voice/lineTiming';

// An alignment for `text` with every character 100 ms long, from `offsetSeconds`
function alignment(text: string, offsetSeconds = 0): ElevenLabsAlignment {
  const chars = codepoints(text);
  return {
    characters: chars,
    character_start_times_seconds: chars.map((_, i) => offsetSeconds + i * 0.1),
    character_end_times_seconds: chars.map((_, i) => offsetSeconds + (i + 1) * 0.1),
  };
}

describe('word spans', () => {
  it('finds whitespace-delimited words by codepoint', () => {
    expect(wordSpans('The quick  brown\tfox.')).toEqual([
      [0, 3],
      [4, 9],
      [11, 16],
      [17, 21],
    ]);
    expect(wordSpans('  lead and trail  ')).toEqual([
      [2, 6],
      [7, 10],
      [11, 16],
    ]);
    expect(wordSpans('')).toEqual([]);
    // an emoji is one codepoint, not two UTF-16 units
    expect(wordSpans('😀 hi')).toEqual([
      [0, 1],
      [2, 4],
    ]);
  });
});

describe('alignmentToCharMs', () => {
  it('returns the start of every codepoint of the line', () => {
    expect(alignmentToCharMs(alignment('Hi there'), 'Hi there', 'Hi there')).toEqual([
      0, 100, 200, 300, 400, 500, 600, 700,
    ]);
  });

  it('drops the v3/v4 audio tag prefix by matching the line as a suffix', () => {
    const sent = '[nervous] Been fishing.';
    const line = 'Been fishing.';
    const ms = alignmentToCharMs(alignment(sent), sent, line);
    expect(ms).toHaveLength(codepoints(line).length);
    // 'B' is the 11th sent character (10 before it)
    expect(ms?.[0]).toBe(1000);
  });

  it('returns a prefix while a streamed alignment stops short of the text', () => {
    const sent = '[calm] one two three';
    const partial = alignment('[calm] one tw');
    expect(alignmentToCharMs(partial, sent, 'one two three')).toEqual([700, 800, 900, 1000, 1100, 1200]);
  });

  it('refuses characters that do not match the sent text', () => {
    const wrong = alignment('Hi theer');
    expect(alignmentToCharMs(wrong, 'Hi there', 'Hi there')).toBeNull();
    expect(alignmentToCharMs(alignment('x'), 'x', 'xyz')).toBeNull();
    expect(alignmentToCharMs(null, 'x', 'x')).toBeNull();
  });

  it('never goes backwards', () => {
    const jittery = alignment('abc');
    jittery.character_start_times_seconds = [0.3, 0.1, 0.2];
    expect(alignmentToCharMs(jittery, 'abc', 'abc')).toEqual([300, 300, 300]);
  });
});

describe('mergeChunkAlignment', () => {
  it('appends absolute-timed chunks as they are', () => {
    const acc = mergeChunkAlignment(emptyAlignment(), alignment('ab'));
    mergeChunkAlignment(acc, alignment('cd', 0.2));
    expect(acc.characters).toEqual(['a', 'b', 'c', 'd']);
    acc.character_start_times_seconds.forEach((t, i) => {
      expect(t).toBeCloseTo(i * 0.1);
    });
  });

  it('shifts chunks timed from their own start', () => {
    const acc = mergeChunkAlignment(emptyAlignment(), alignment('ab'));
    mergeChunkAlignment(acc, alignment('cd'));
    acc.character_start_times_seconds.forEach((t, i) => {
      expect(t).toBeCloseTo(i * 0.1);
    });
    expect(acc.character_end_times_seconds[3]).toBeCloseTo(0.4);
  });

  it('ignores an empty chunk', () => {
    const acc = mergeChunkAlignment(emptyAlignment(), emptyAlignment());
    expect(acc.characters).toEqual([]);
  });
});

describe('wordStartsMs', () => {
  it('takes the time of each word’s first character', () => {
    const charMs = alignmentToCharMs(alignment('one two three'), 'one two three', 'one two three') as number[];
    expect(wordStartsMs('one two three', charMs)).toEqual({ word_ms: [0, 400, 800], partial: false });
  });

  it('is partial while the times stop before the last word', () => {
    expect(wordStartsMs('one two three', [0, 100, 200, 300, 400])).toEqual({ word_ms: [0, 400], partial: true });
    expect(wordStartsMs('one two', [])).toEqual({ word_ms: [], partial: true });
  });

  it('counts words on the neutralized text the same as on the original', () => {
    // neutralizeMarkup swaps < and > for single codepoints, so boundaries agree
    const original = 'a <b> c';
    const neutral = 'a ‹b› c';
    const charMs = [0, 100, 200, 300, 400, 500, 600];
    expect(wordStartsMs(neutral, charMs)).toEqual(wordStartsMs(original, charMs));
  });
});

describe('synthesizeWordTimes', () => {
  it('spreads the duration over the words, punctuation weighing more', () => {
    const times = synthesizeWordTimes('Wait, no. Go now', 4000);
    expect(times).toHaveLength(4);
    expect(times[0]).toBe(0);
    expect(times.every((t, i) => i === 0 || t >= times[i - 1])).toBe(true);
    expect(times[times.length - 1]).toBeLessThan(4000);
    const plain = synthesizeWordTimes('aaaa bbbb cccc', 3000);
    const paused = synthesizeWordTimes('aaa, bbbb cccc', 3000);
    expect(paused[1]).toBeGreaterThan(plain[1]);
    expect(synthesizeWordTimes('', 2000)).toEqual([]);
  });
});

describe('decodeBase64', () => {
  it('decodes to bytes', () => {
    expect(Array.from(decodeBase64('AQID'))).toEqual([1, 2, 3]);
  });
});
