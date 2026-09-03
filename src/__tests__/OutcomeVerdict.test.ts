import { describe, expect, it } from 'vitest';
import { InteractionOutcomeEvent } from 'main/sentient-sims/models/ActionIntent';
import { OutcomeGradingContext, verdictFor } from 'main/sentient-sims/services/OutcomeVerdictService';

// F5: how much to believe an outcome. The live failure this grades against (2026-08-26):
// a sim wedged in a shower transition loop was told 'take_shower succeeded' 126ms after
// dispatch, with nothing registered in the game to ever contradict it.
describe('outcome verdicts', () => {
  const baseContext: OutcomeGradingContext = { late: false, instantSuccessMs: 1500 };

  function grade(event: Partial<InteractionOutcomeEvent>, context: Partial<OutcomeGradingContext> = {}) {
    return verdictFor(
      { sim_id: '1', outcome: 'success', ...event },
      {
        ...baseContext,
        ...context,
      },
    );
  }

  it('grades an outcome the game decided as confirmed', () => {
    expect(grade({ decided_at: 'finished', ran: true })).toBe('confirmed');
    expect(grade({ decided_at: 'finishing', ran: true })).toBe('confirmed');
    expect(grade({ decided_at: 'sweep', outcome: 'canceled' })).toBe('confirmed');
    expect(grade({ decided_at: 'app_cancel', ran: true })).toBe('confirmed');
    expect(grade({ decided_at: 'watchdog', outcome: 'canceled', ran: false })).toBe('confirmed');
  });

  it('grades a dispatch-time success with a design reason as claimed, not confirmed', () => {
    // 'sit' never completes, so the successful push IS the outcome — legitimate, but the
    // bench has to be able to tell it apart from something the game actually finished
    expect(grade({ decided_at: 'dispatch', claim: 'instant_verb' }, { dispatchAgeMs: 40 })).toBe('claimed');
    expect(grade({ decided_at: 'dispatch', claim: 'handler' }, { dispatchAgeMs: 12 })).toBe('claimed');
    expect(grade({ decided_at: 'dispatch', claim: 'merged_social' }, { dispatchAgeMs: 8 })).toBe('claimed');
    expect(grade({ decided_at: 'dispatch', claim: 'merged_food_chain' })).toBe('claimed');
    expect(grade({ decided_at: 'dispatch', claim: 'benign_failure' })).toBe('claimed');
  });

  it('grades a dispatch-time success with no claim as suspect', () => {
    // The phantom shape itself: reported at dispatch, nothing to justify it
    expect(grade({ decided_at: 'dispatch' }, { dispatchAgeMs: 126 })).toBe('suspect');
  });

  it('grades an unclaimed instant success as suspect wherever it was decided', () => {
    // Even reported as 'finished': succeeded in 126ms, never seen running, no design
    // reason to be instant
    expect(grade({ decided_at: 'finished', ran: null }, { dispatchAgeMs: 126 })).toBe('suspect');
    // ...but a push that was actually observed running is a real fast success
    expect(grade({ decided_at: 'finished', ran: true }, { dispatchAgeMs: 126 })).toBe('confirmed');
  });

  it('grades a success as suspect when the sim is still wedged in the head SI that starved it', () => {
    expect(
      grade(
        { decided_at: 'dispatch', claim: 'merged_social', sim_running: 'shower_TakeShower' },
        { blockedBy: 'shower_TakeShower' },
      ),
    ).toBe('suspect');
    // The blocked head itself finishing naturally: the mod saw it run, so blocked_by is
    // a stale snapshot, not a contradiction
    expect(
      grade(
        { decided_at: 'finished', ran: true, sim_running: 'shower_TakeShower' },
        { blockedBy: 'shower_TakeShower' },
      ),
    ).toBe('confirmed');
    // A different running SI says nothing either way
    expect(
      grade({ decided_at: 'finished', ran: true, sim_running: 'sim_Chat' }, { blockedBy: 'shower_TakeShower' }),
    ).toBe('confirmed');
  });

  it('keeps a genuinely late success confirmed and flags a late one that never ran', () => {
    // The guitar case (live 2026-08-10): the app timed out, the mod left the action
    // running and answered late with a real success
    expect(grade({ decided_at: 'app_cancel', ran: true }, { late: true, dispatchAgeMs: 95_000 })).toBe('confirmed');
    expect(grade({ decided_at: 'finished', ran: false }, { late: true, dispatchAgeMs: 95_000 })).toBe('suspect');
  });

  it('treats a non-success dispatch verdict as confirmed', () => {
    // Preflight ran the game's own tests and refused: real evidence about the world, and
    // nothing is being claimed that has to be backed up
    expect(grade({ decided_at: 'dispatch', outcome: 'ineligible' })).toBe('confirmed');
    expect(grade({ decided_at: 'dispatch', outcome: 'canceled' })).toBe('confirmed');
  });

  it('grades an outcome from a mod with no provenance as unknown', () => {
    expect(grade({ outcome: 'success' }, { dispatchAgeMs: 5 })).toBe('unknown');
  });
});
