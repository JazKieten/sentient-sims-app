import { describe, expect, it } from 'vitest';
import { assertOutcomeIsTruthful, runTier0 } from 'main/sentient-sims/bench/tier0';
import { assertDiaryIsProse, repairDiary } from 'main/sentient-sims/util/diaryProse';
import { ActionOutcomeRecord } from 'main/sentient-sims/db/ActionOutcomeRepository';

// The planner returns a five-field JSON object. A parse failure used to store the whole raw
// completion as the diary, which then rode into 216 later prompt blocks as
// <PAST_REFLECTIONS> (live 2026-08-15, Summer Holiday).
const LEAKED =
  'Today was a bit of a rollercoaster.\n{"diary": "Today was a bit of a rollercoaster.", "goals": ["cook"], "persona": "tired"}';

function outcome(overrides: Partial<ActionOutcomeRecord>): ActionOutcomeRecord {
  return {
    at: new Date().toISOString(),
    simId: '1',
    outcome: 'success',
    verdict: 'confirmed',
    late: false,
    unowned: false,
    ...overrides,
  };
}

describe('tier-0 assertions', () => {
  it('fails a diary that is or contains planner JSON', () => {
    expect(assertDiaryIsProse(LEAKED)?.detail).toBe('diary contains planner JSON keys');
    expect(assertDiaryIsProse('{"diary": "x"}')?.detail).toBe('diary starts with a JSON object or array');
    expect(assertDiaryIsProse('```json\n{}\n```')?.detail).toBe('diary contains a code fence');
    expect(assertDiaryIsProse('<PAST_REFLECTIONS>gone wrong</PAST_REFLECTIONS>')?.detail).toBe(
      'diary contains prompt scaffolding tags',
    );
    expect(assertDiaryIsProse('   ')?.detail).toBe('diary is empty');
  });

  it('passes real diary prose', () => {
    expect(assertDiaryIsProse('A quiet day at home. I finally fixed the sink.')).toBeNull();
    // Prose is allowed to mention braces and quotes without being machinery
    expect(assertDiaryIsProse('He said "we should talk" and then left.')).toBeNull();
  });

  it('accepts the repaired form of every leaked shape it rejects', () => {
    // extractDiaryProse is the repair, never the check — the assertion has to fail first
    expect(assertDiaryIsProse(LEAKED)).not.toBeNull();
    const repaired = repairDiary(LEAKED);
    expect(repaired).toBe('Today was a bit of a rollercoaster.');
    expect(assertDiaryIsProse(repaired)).toBeNull();
  });

  it('fails a success that was graded suspect', () => {
    const violation = assertOutcomeIsTruthful(
      outcome({ verdict: 'suspect', action: 'take_shower', decidedAt: 'dispatch', id: 12 }),
    );
    expect(violation?.assertion).toBe('outcome_is_truthful');
    expect(violation?.detail).toContain("'take_shower'");
    expect(violation?.outcomeId).toBe(12);
  });

  it('passes confirmed and claimed successes, and any non-success', () => {
    expect(assertOutcomeIsTruthful(outcome({ verdict: 'confirmed' }))).toBeNull();
    expect(assertOutcomeIsTruthful(outcome({ verdict: 'claimed' }))).toBeNull();
    // A suspect verdict only matters for a success — nothing else was claimed
    expect(assertOutcomeIsTruthful(outcome({ verdict: 'suspect', outcome: 'canceled' }))).toBeNull();
  });

  it('reports every violation in one pass over a save', () => {
    const violations = runTier0({
      diaries: [
        { id: '1', text: 'A quiet day at home.' },
        { id: '2', text: LEAKED },
      ],
      outcomes: [outcome({ verdict: 'confirmed' }), outcome({ verdict: 'suspect', id: 9 })],
    });

    expect(violations.map((violation) => violation.assertion)).toEqual(['diary_is_prose', 'outcome_is_truthful']);
    expect(violations[0].memoryId).toBe('2');
  });

  it('is empty for a clean save', () => {
    expect(runTier0({ diaries: [{ text: 'A good day.' }], outcomes: [outcome({})] })).toEqual([]);
  });
});
