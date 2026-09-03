import log from 'electron-log';
import { ActionOutcomeRecord, ActionOutcomeRepository } from '../db/ActionOutcomeRepository';
import { InteractionOutcomeEvent } from '../models/ActionIntent';

/**
 * How much to believe an outcome the mod reported (Phase 3.0 F5).
 *
 * The outcome channel is the only learning-from-feedback signal in the system, so a false
 * success does real damage: it becomes a permanent memory row ("tried X and it succeeded"),
 * it lifts the suppression that was keeping a doomed verb out of the offering, and it
 * invalidates any bench run it lands in. Live 2026-08-26 a wedged sim was told exactly that
 * 126 ms after dispatch, with nothing tracked in the game at all.
 *
 * - `confirmed` — the game decided. handle_outcome fired, or the finisher/sweep/watchdog saw
 *   what happened. Also every non-success dispatch verdict: preflight running the game's own
 *   tests and refusing is real evidence about the world, and it is not a success claim.
 * - `claimed` — reported at dispatch time for a verb that will never produce an outcome
 *   (sit never completes; a handler verb runs immediately). Legitimate by design, but nothing
 *   confirmed it, so the bench must be able to tell it apart from `confirmed`.
 * - `suspect` — a success the evidence contradicts. Never written to memory as a success.
 * - `unknown` — an older mod build with no provenance fields. Graded as before F5.
 */
export type OutcomeVerdict = 'confirmed' | 'claimed' | 'suspect' | 'unknown';

// An outcome plus what the app worked out about it. The extra fields are optional so a
// caller that has not graded (tests, and any path that predates F5) still type-checks.
export type GradedOutcomeEvent = InteractionOutcomeEvent & {
  verdict?: OutcomeVerdict;
  late?: boolean;
  unowned?: boolean;
  dispatch_age_ms?: number;
};

export type OutcomeGradingContext = {
  // Wall-clock ms between the dispatch and this outcome, when the dispatch is known
  dispatchAgeMs?: number;
  // The dispatcher had already closed this request when the outcome arrived
  late: boolean;
  // The head SI the mod's stuck watchdog says this sim's pushes are starving behind
  blockedBy?: string;
  instantSuccessMs: number;
};

// Where a verdict can come from and still be the game's own answer
const CONFIRMING_SOURCES = new Set(['finished', 'finishing', 'sweep', 'app_cancel', 'watchdog']);

export function verdictFor(event: InteractionOutcomeEvent, context: OutcomeGradingContext): OutcomeVerdict {
  if (!event.decided_at) {
    // Pre-F5 mod: no provenance to grade with. Behaves exactly as it did before.
    return 'unknown';
  }

  const isSuccess = event.outcome === 'success';

  if (
    isSuccess &&
    event.ran !== true &&
    context.blockedBy &&
    event.sim_running &&
    event.sim_running === context.blockedBy
  ) {
    // The sim is still wedged in the very head SI the watchdog says this push starved
    // behind. Whoever reported the success, the world disagrees with it. A push the mod
    // saw RUNNING was not starved by anything, and blocked_by is a state-report snapshot
    // that outlives the head it names: an adopted head SI that finishes naturally reports
    // itself as sim_running while the cache still says it is the blocker.
    return 'suspect';
  }

  if (
    isSuccess &&
    !event.claim &&
    context.dispatchAgeMs !== undefined &&
    context.dispatchAgeMs < context.instantSuccessMs &&
    event.ran !== true
  ) {
    // Succeeded within milliseconds of dispatch, never seen running, and with no design
    // reason to be instant. This is the 126 ms shape, and it catches it even if a future
    // path reports it as `finished`.
    return 'suspect';
  }

  if (isSuccess && context.late && event.ran === false) {
    // The app gave up on this request, and the mod then said it succeeded without it
    // ever having run. A genuine late success (a long action the app outwaited) reports
    // ran: true — that one stays confirmed.
    return 'suspect';
  }

  if (CONFIRMING_SOURCES.has(event.decided_at)) {
    return 'confirmed';
  }

  // decided_at === 'dispatch' from here
  if (!isSuccess) {
    // An ineligible/canceled verdict at dispatch is preflight reporting the game's own
    // test result. Nothing is being claimed that the world has to back up.
    return 'confirmed';
  }
  if (!event.claim) {
    return 'suspect';
  }
  return 'claimed';
}

// Whether cognition and the memory row may treat this as a success that happened
export function isTruthfulSuccess(outcome: string, verdict: OutcomeVerdict): boolean {
  return outcome === 'success' && verdict !== 'suspect';
}

// Same bound and the same reason as ai_exchange (F4): the save database is copied whole
// on every game save. Outcome rows are small, so the ceiling is generous.
const MAX_PERSISTED_OUTCOMES = 5000;
const PRUNE_EVERY = 500;

/**
 * Grades each reported outcome and writes it to the loaded save's action_outcome table.
 *
 * Recording is best-effort by design: an outcome must still reach cognition and the memory
 * row when no save is loaded (the main menu, the scenario tester, tests), so a persistence
 * failure is logged and swallowed rather than failing the request.
 */
export class OutcomeVerdictService {
  private readonly repository?: ActionOutcomeRepository;

  private insertsSincePrune = 0;

  constructor(repository?: ActionOutcomeRepository) {
    this.repository = repository;
  }

  grade(event: InteractionOutcomeEvent, context: OutcomeGradingContext): OutcomeVerdict {
    return verdictFor(event, context);
  }

  private get persistence(): ActionOutcomeRepository | undefined {
    return this.repository?.isLoaded() ? this.repository : undefined;
  }

  record(record: ActionOutcomeRecord): number | undefined {
    const repository = this.persistence;
    if (!repository) {
      return undefined;
    }
    try {
      const id = repository.insert(record);
      this.insertsSincePrune += 1;
      if (this.insertsSincePrune >= PRUNE_EVERY) {
        this.insertsSincePrune = 0;
        repository.prune(MAX_PERSISTED_OUTCOMES);
      }
      return id;
    } catch (error) {
      log.warn('[OutcomeVerdict] failed to persist an outcome row', error);
      return undefined;
    }
  }

  // Called on database load, the same moment the exchange log re-seeds its ids
  pruneOnLoad() {
    const repository = this.persistence;
    if (!repository) {
      return;
    }
    try {
      repository.prune(MAX_PERSISTED_OUTCOMES);
      this.insertsSincePrune = 0;
    } catch (error) {
      log.warn('[OutcomeVerdict] failed to prune action_outcome on load', error);
    }
  }

  list(options: { simId?: string; verdict?: OutcomeVerdict; limit?: number } = {}): ActionOutcomeRecord[] {
    const repository = this.persistence;
    if (!repository) {
      return [];
    }
    try {
      return repository.list(options);
    } catch (error) {
      log.warn('[OutcomeVerdict] failed to read action_outcome', error);
      return [];
    }
  }
}
