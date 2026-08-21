import { describe, expect, it } from 'vitest';
import { humanizeOutcomeReason, outcomeObservation } from 'main/sentient-sims/controllers/CognitionController';

describe('humanizeOutcomeReason', () => {
  it('unwraps a whole-string repr shell', () => {
    expect(humanizeOutcomeReason('<TestResult: Missing relationship bit has_met between Elliot and Candy.>')).toBe(
      'Missing relationship bit has_met between Elliot and Candy.',
    );
  });

  it('keeps the inner explanation when the repr is prefixed', () => {
    // Observed live 2026-08-07: the whole-string-only unwrap never fired past the
    // "clean push refused: " prefix, so the repr-strip deleted the entire why and the
    // permanent memory read just "clean push refused:"
    const raw =
      "clean push refused: <EnqueueResult: object_Food_Crackers:0x0e6016f68c3e0f12's current states do not match the WhiteBlackList that has been defined. <ExecuteResult: False: (None)>>";
    expect(humanizeOutcomeReason(raw)).toBe(
      "clean push refused: object_Food_Crackers:0x0e6016f68c3e0f12's current states do not match the WhiteBlackList that has been defined.",
    );
  });

  it('drops nested result plumbing but keeps the sentence', () => {
    const raw =
      '<EnqueueResult: Bills: Interaction requires a utility that is shut off. <ExecuteResult: False: (None)>>';
    expect(humanizeOutcomeReason(raw)).toBe('Bills: Interaction requires a utility that is shut off.');
  });

  it('never leaves emptied slots in the memory (P-9)', () => {
    // Playtest DB: "Missing relationship bit () between and ." x4, "Sim [] either has
    // no household funds manager, or doesn't have enough funds.:" x1
    expect(humanizeOutcomeReason('Missing relationship bit <Bit> between <Sim 1> and <Sim 2>.')).toBe(
      'Missing relationship bit between the two of them.',
    );
    expect(
      humanizeOutcomeReason("Sim [] either has no household funds manager, or doesn't have enough funds.:"),
    ).toBe("the sim either has no household funds manager, or doesn't have enough funds.");
  });

  it('leaves a plain reason untouched', () => {
    expect(humanizeOutcomeReason('Object failed state check: toilet is broken')).toBe(
      'Object failed state check: toilet is broken',
    );
  });
});

describe('outcomeObservation', () => {
  it('names the recovery verb the mod attached to a failure', () => {
    // T5 (night watch 2026-08-18): a broken shower closed take_shower with no hint and
    // the repair service was never dispatched
    expect(
      outcomeObservation("Travis tried 'take_shower'", 'ineligible', 'Object failed state check', 'hire_repair_service'),
    ).toBe(
      "Travis tried 'take_shower' and it was canceled (Object failed state check). Doing 'hire_repair_service' first would clear this.",
    );
  });

  it('never appends a fix to a success or when the mod sent none', () => {
    expect(outcomeObservation("Travis tried 'take_shower'", 'success', undefined, 'hire_repair_service')).toBe(
      "Travis tried 'take_shower' and it succeeded.",
    );
    expect(outcomeObservation("Travis tried 'take_shower'", 'canceled', 'bumped')).toBe(
      "Travis tried 'take_shower' and it was canceled (bumped).",
    );
  });
});
