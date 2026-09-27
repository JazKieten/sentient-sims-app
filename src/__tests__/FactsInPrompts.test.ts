import { describe, expect, it } from 'vitest';
import { buildCognitionUserPrompt } from 'main/sentient-sims/util/formatCognitionPrompt';
import { SimStateEntry, SimStateReport } from 'main/sentient-sims/models/SimStateReport';

// H3: the facts block reaches the tick prompt (autonomy). Retrieval's game-day recency, the
// core half of H3, is GameDayRecency.test.ts.
describe('facts in the tick prompt', () => {
  const entry: SimStateEntry = {
    sim_id: '100',
    sim_name: 'Travis',
    self: { mood: 'Happy' },
    sims: [],
    objects: [],
  };
  const report: SimStateReport = { type: 'state_report', seq: 1 };

  it('renders the block when there are facts', () => {
    const block = '<KNOWN_FACTS>\nAbout you:\n- you are elder\n</KNOWN_FACTS>';
    const prompt = buildCognitionUserPrompt(entry, report, undefined, [], undefined, undefined, block);
    expect(prompt).toContain(block);
  });

  it('is byte-identical to the pre-3.1 prompt when the store is empty', () => {
    // The whole point of returning '' rather than a placeholder: a save with no facts
    // yet must behave exactly as it did before this phase
    const before = buildCognitionUserPrompt(entry, report, undefined, [], undefined, undefined);
    const withEmpty = buildCognitionUserPrompt(entry, report, undefined, [], undefined, undefined, '');
    expect(withEmpty).toBe(before);
  });

  it('puts facts before memories, so a truncation drops the recollection and not the truth', () => {
    const facts = '<KNOWN_FACTS>\nAbout you:\n- you are elder\n</KNOWN_FACTS>';
    const memories = '<RELEVANT_MEMORIES>\nsomething happened\n</RELEVANT_MEMORIES>';
    const prompt = buildCognitionUserPrompt(entry, report, memories, [], undefined, undefined, facts);
    expect(prompt.indexOf(facts)).toBeLessThan(prompt.indexOf(memories));
  });
});
