import { describe, expect, it } from 'vitest';
import { countEvasive, isQuestionOnly } from 'main/sentient-sims/bench/playerThreadFixtures';

// The player-thread bench's evasiveness metric (DEV tier, release 4.5). Moved out of
// PlayerFacingReplies.test.ts, whose reply-prompt tests are core.
describe('the evasiveness metric', () => {
  it('counts the phrases the logs were full of', () => {
    const counts = countEvasive([
      "That's not the point right now",
      "That's easy for you to say",
      "I don't know",
      'What do you mean by that?',
      'Zoe. She listens, and I have not felt heard in months.',
    ]);
    expect(counts["that's not the point"]).toBe(1);
    expect(counts['easy for you to say']).toBe(1);
    expect(counts["bare i don't know"]).toBe(1);
    expect(counts['what do you mean']).toBe(1);
    expect(counts['question only']).toBe(1);
  });

  it('does not count a question asked after an answer', () => {
    expect(isQuestionOnly('Zoe, honestly. Would you tell Alex for me?')).toBe(false);
    expect(isQuestionOnly('Why would I?')).toBe(true);
  });
});
