// The DEV tier's entry module (release 4.5): listed in tiers.json, so a build that
// strips dev deletes it and the generated index.ts never names it.
import type { TierRegistration } from './types';

export const devTier: TierRegistration = {
  name: 'dev',
};
