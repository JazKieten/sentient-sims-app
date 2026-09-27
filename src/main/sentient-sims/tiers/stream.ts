// The STREAM tier's entry module (release 4.5): listed in tiers.json, so a build that
// strips stream deletes it and the generated index.ts never names it.
import type { TierRegistration } from './types';

export const streamTier: TierRegistration = {
  name: 'stream',
};
