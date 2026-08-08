import { describe, expect, it } from 'vitest';
import { humanizeOutcomeReason } from 'main/sentient-sims/controllers/CognitionController';

describe('humanizeOutcomeReason', () => {
  it('unwraps a whole-string repr shell', () => {
    expect(
      humanizeOutcomeReason('<TestResult: Missing relationship bit has_met between Elliot and Candy.>'),
    ).toBe('Missing relationship bit has_met between Elliot and Candy.');
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

  it('leaves a plain reason untouched', () => {
    expect(humanizeOutcomeReason('Object failed state check: toilet is broken')).toBe(
      'Object failed state check: toilet is broken',
    );
  });
});
