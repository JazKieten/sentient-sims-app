import { extractDiaryProse } from '../services/DailyPlanService';
import { ActionOutcomeRecord } from '../db/ActionOutcomeRepository';

/**
 * Tier-0 assertions: invariants that must hold for a run to be scoreable at all.
 *
 * SentienceBench Level 1 calls a run *Invalid* (rerun, not scored) when the pipeline broke
 * underneath it — machinery text stored as a diary, a phantom success written into memory.
 * These are the executable form of that gate, kept pure so they can run over a save's rows
 * or over a single value on the write path.
 */
export type Tier0Violation = {
  assertion: 'diary_is_prose' | 'outcome_is_truthful';
  detail: string;
  memoryId?: string;
  outcomeId?: number;
};

// Machinery a diary must never contain. The planner returns a five-field JSON object and a
// parse failure used to store the whole raw completion as the diary — which then rode into
// 216 later prompt blocks as <PAST_REFLECTIONS> (live 2026-08-15, Summer Holiday).
const PLANNER_KEY = /"(diary|goals|goal_review|persona|loadout)"\s*:/;
const CODE_FENCE = /```/;
const PROMPT_TAG = /<\/?[A-Z_]{3,}>/;

/**
 * A diary entry must be prose. extractDiaryProse is the repair, never the check: running the
 * repair as the test would pass anything, because it always returns something.
 */
export function assertDiaryIsProse(text: string | undefined, memoryId?: string): Tier0Violation | null {
  const violation = (detail: string): Tier0Violation => ({ assertion: 'diary_is_prose', detail, memoryId });
  const trimmed = (text ?? '').trim();
  if (trimmed.length <= 1) {
    return violation('diary is empty');
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return violation('diary starts with a JSON object or array');
  }
  if (PLANNER_KEY.test(trimmed)) {
    return violation('diary contains planner JSON keys');
  }
  if (CODE_FENCE.test(trimmed)) {
    return violation('diary contains a code fence');
  }
  if (PROMPT_TAG.test(trimmed)) {
    return violation('diary contains prompt scaffolding tags');
  }
  return null;
}

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

// The prose a diary should have carried, for the caller that has to store something anyway
export function repairDiary(text: string): string {
  return extractDiaryProse(text);
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
