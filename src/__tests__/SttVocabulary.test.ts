import { describe, expect, it } from 'vitest';
import {
  buildTranscriptionPrompt,
  isSilenceHallucination,
  KEYTERMS_MAX,
  keyterms,
  nameTerms,
  SIMS_WORLDS,
} from '../main/sentient-sims/util/sttVocabulary';

describe('nameTerms', () => {
  it('lists each name in full and by first name, tightest scope first', () => {
    const terms = nameTerms([['Anker Solheim'], ['Halley Calloway', 'Kado Vale']]);
    expect(terms).toEqual(['Anker Solheim', 'Anker', 'Halley Calloway', 'Halley', 'Kado Vale', 'Kado']);
  });

  it('dedupes names case-insensitively, keeps the first spelling, and drops placeholders and blanks', () => {
    const terms = nameTerms([
      ['Wren Calloway', 'wren calloway', 'Sim 132600080439250755', '', '  ', null, undefined],
      ['Wren', 'Layne'],
    ]);
    expect(terms).toEqual(['Wren Calloway', 'Wren', 'Wren', 'Layne']);
  });
});

describe('keyterms', () => {
  it('keeps list order, dedupes case-insensitively and drops terms Scribe rejects', () => {
    const terms = keyterms(
      ['Anker Solheim', 'Anker', ' anker ', '<script>', 'A name with far too many words in it to be one keyterm'],
      ['Del Sol Valley'],
      ['x'.repeat(50), 'x'.repeat(49), 'Anker Solheim'],
    );
    expect(terms).toEqual(['Anker Solheim', 'Anker', 'Del Sol Valley', 'x'.repeat(49)]);
  });

  it('every game world is a valid term', () => {
    expect(keyterms(SIMS_WORLDS)).toEqual(SIMS_WORLDS);
  });

  it('caps at the count under which a short line is billed at its real length', () => {
    const many = Array.from({ length: 300 }, (_, i) => `Person${i} Surname${i}`);
    const terms = keyterms(nameTerms([['Anker Solheim']]), SIMS_WORLDS, nameTerms([many]));
    expect(terms).toHaveLength(KEYTERMS_MAX);
    expect(KEYTERMS_MAX).toBe(100);
    expect(terms.slice(0, 2)).toEqual(['Anker Solheim', 'Anker']);
    expect(terms).toContain('Henford-on-Bagley');
    expect(terms).not.toContain('Person200 Surname200');
  });
});

describe('buildTranscriptionPrompt', () => {
  it('names the scene and dedupes', () => {
    expect(buildTranscriptionPrompt([['Lillie Chatman', 'Mika Sol'], ['lillie chatman']])).toBe(
      'Names in this scene: Lillie Chatman, Mika Sol.',
    );
  });

  it('is undefined with nothing to say', () => {
    expect(buildTranscriptionPrompt([])).toBeUndefined();
  });

  it('cuts from the tail to stay under the whisper prompt budget', () => {
    const many = Array.from({ length: 200 }, (_, i) => `Person${i} Surname${i}`);
    const prompt = buildTranscriptionPrompt([['Anker Solheim'], many]);
    expect(prompt?.length).toBeLessThanOrEqual(700);
    expect(prompt).toContain('Anker Solheim');
  });
});

describe('isSilenceHallucination', () => {
  it.each([
    'Subs by www.zeoranger.co.uk',
    'Subtitles by the Amara.org community',
    'Thank you for watching!',
    'Thanks for watching.',
    'Thank you.',
    'Please like and subscribe to my channel',
    '[BLANK_AUDIO]',
    '(laughs)',
    '',
    '   ',
  ])('drops %j', (text) => {
    expect(isSilenceHallucination(text)).toBe(true);
  });

  it.each([
    'Anker, how are you today?',
    'Thank you for the flowers, Halley.',
    'Subscribe to the newsletter, Wren, it is free.',
    'Thanks, that was nice of you.',
  ])('keeps %j', (text) => {
    expect(isSilenceHallucination(text)).toBe(false);
  });
});
