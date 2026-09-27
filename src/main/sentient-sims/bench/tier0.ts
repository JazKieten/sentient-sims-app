import { assertDiaryIsProse, Tier0Violation } from '../util/diaryProse';
import { ActionOutcomeRecord } from '../db/ActionOutcomeRepository';

/**
 * Tier-0 assertions: invariants that must hold for a run to be scoreable at all.
 *
 * SentienceBench Level 1 calls a run *Invalid* (rerun, not scored) when the pipeline broke
 * underneath it — machinery text stored as a diary, a phantom success written into memory.
 * These are the executable form of that gate, kept pure so they can run over a save's rows
 * or over a single value on the write path.
 */

// The diary check and its repair are core (util/diaryProse): every reflection runs them
export { assertDiaryIsProse, repairDiary } from '../util/diaryProse';
export type { Tier0Violation } from '../util/diaryProse';

/**
 * The act -> observe loop is only evidence if its outcomes are true. A success the app graded
 * suspect must never have been written as one.
 */
export function assertOutcomeIsTruthful(record: ActionOutcomeRecord): Tier0Violation | null {
  if (record.outcome === 'success' && record.verdict === 'suspect') {
    return {
      assertion: 'outcome_is_truthful',
      detail: `'${record.action ?? 'an action'}' for sim ${record.simId} reported success (${record.decidedAt ?? 'unknown source'}) with nothing confirming it`,
      outcomeId: record.id,
      memoryId: record.memoryId,
    };
  }
  return null;
}

export type Tier0Input = {
  diaries: { id?: string; text?: string }[];
  outcomes: ActionOutcomeRecord[];
};

export function runTier0(input: Tier0Input): Tier0Violation[] {
  const violations: Tier0Violation[] = [];
  input.diaries.forEach((diary) => {
    const violation = assertDiaryIsProse(diary.text, diary.id);
    if (violation) {
      violations.push(violation);
    }
  });
  input.outcomes.forEach((outcome) => {
    const violation = assertOutcomeIsTruthful(outcome);
    if (violation) {
      violations.push(violation);
    }
  });
  return violations;
}
