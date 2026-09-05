// One Sim's life stage, from the freshest source that has it (J8, 2026-09-04).
//
// The state report carries `self.age` for every reported Sim and is seconds old; the
// fact store's `age_stage` is the dossier's copy and survives an app restart before the
// first report lands. Either may be missing (an older mod, a Sim off-lot, a save with
// no dossier yet), and nothing here may ever stop a Sim thinking, so every read is
// wrapped and the answer is simply undefined when nobody knows.
import { FactPredicate } from '../pipeline/facts/predicates';

type LifeStageSources = {
  simStateCache?: { getSim(simId: string): { self?: { age?: string } } | undefined };
  semanticMemory?: { getCurrentFacts(simId: string): { predicate: string; objectText?: string }[] };
};

export function lifeStageOf(ctx: LifeStageSources, simId: string): string | undefined {
  try {
    const reported = ctx.simStateCache?.getSim(simId)?.self?.age;
    if (reported && reported.trim()) {
      return reported.trim().toUpperCase();
    }
  } catch {
    // fall through to the fact store
  }
  try {
    const fact = ctx.semanticMemory
      ?.getCurrentFacts(simId)
      .find((row) => row.predicate === FactPredicate.AGE_STAGE && row.objectText);
    return fact?.objectText?.trim().toUpperCase() || undefined;
  } catch {
    return undefined;
  }
}
