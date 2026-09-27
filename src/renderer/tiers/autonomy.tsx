// The AUTONOMY tier's renderer entry (release 4.5): listed in tiers.json, so a build that
// strips autonomy deletes it and the generated index.tsx never names it.
import type { RendererTier } from './types';

export const autonomyRendererTier: RendererTier = {
  name: 'autonomy',
};
