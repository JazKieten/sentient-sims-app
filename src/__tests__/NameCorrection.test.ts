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
