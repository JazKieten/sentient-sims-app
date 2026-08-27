import { describe, expect, it } from 'vitest';
import { buildTranscriptionPrompt, correctNames, levenshtein } from '../main/sentient-sims/util/nameCorrection';

describe('STT dictionary (V-7)', () => {
  it('snaps the near-misses observed live to the real names', () => {
    const known = ['Lillie Cason', 'Mika Oshino', 'Tessa Chatman', 'Milo Calder'];
    expect(correctNames('Tell Lily I said hi', known)).toBe('Tell Lillie I said hi');
    expect(correctNames('Meika, come here', known)).toBe('Mika, come here');
    expect(correctNames("Where is Chapman's dog?", known)).toBe("Where is Chatman's dog?");
  });

  it('leaves prose and exact names alone', () => {
    const known = ['Lillie Cason', 'Milo Calder'];
    expect(correctNames('Milo, the milk is on the table', known)).toBe('Milo, the milk is on the table');
    expect(correctNames('I like this a lot', known)).toBe('I like this a lot');
    expect(correctNames('hello', [])).toBe('hello');
  });

  it('never renames the everyday words a sentence starts with', () => {
    // Live 08-27: the player's fillers were snapped to sims and the sims were addressed
    // by the wrong name — "Well" -> Wells, "Kay" -> Kai (a phonetic tie), "Hey" -> Huy
    const known = ['Marcus Wells', 'Kai Nguyen', 'Huy Tran'];
    expect(correctNames('Well, how are you today?', known)).toBe('Well, how are you today?');
    expect(correctNames("Kay let's go to the park", known)).toBe("Kay let's go to the park");
    expect(correctNames('Hey there, what are you up to?', known)).toBe('Hey there, what are you up to?');
    // The real names still resolve when they are actually spoken
    expect(correctNames('Kai, come here', known)).toBe('Kai, come here');
  });

  it('keeps sims whose names are also everyday words', () => {
    const known = ['Will Wright', 'Grace Kim'];
    expect(correctNames('Will, come here', known)).toBe('Will, come here');
    expect(correctNames('Tell Grace I said hi', known)).toBe('Tell Grace I said hi');
  });

  it('ignores placeholder names from namelessly-reported sims', () => {
    expect(correctNames('Simon says hello', ['Sim 132600080439250755'])).toBe('Simon says hello');
  });

  it('hears Wren behind the silent w', () => {
    // Whisper wrote "Ren" and "Rin" for Wren (live 08-27); wr -> r in the phonetic layer
    // brings both within tolerance
    expect(correctNames('Hi, Ren, how are you?', ['Wren Calloway'])).toBe('Hi, Wren, how are you?');
    expect(correctNames("Hi, Rin, what's up?", ['Wren Calloway'])).toBe("Hi, Wren, what's up?");
    expect(correctNames('Hey Margot, how are you?', ['Margo Calloway'])).toBe('Hey Margo, how are you?');
  });

  it('builds a name-dense prompt, tightest scope first, capped', () => {
    const prompt = buildTranscriptionPrompt([['Lillie Cason'], ['Mika Oshino', 'Lillie Cason'], []]);
    expect(prompt).toBe('Names in this scene: Lillie Cason, Mika Oshino.');
    expect(buildTranscriptionPrompt([[]])).toBeUndefined();
    const many = Array.from({ length: 200 }, (_, index) => `Person Number${index}`);
    expect(buildTranscriptionPrompt([many])!.length).toBeLessThanOrEqual(720);
  });

  it('levenshtein basics', () => {
    expect(levenshtein('lily', 'lillie')).toBe(3);
    expect(levenshtein('same', 'same')).toBe(0);
  });
});
