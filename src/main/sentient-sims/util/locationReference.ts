import { LocationEntity, LocationSource } from '../db/entities/LocationEntity';

// The Locations editor shows, under the description box, what the game uses for the lot right
// now and, when this save has its own text, the default it would go back to. Shared with the
// renderer.

export type LocationReference = {
  kind: 'in-use' | 'default';
  title: string;
  text: string;
  // The box holds the same text
  matchesBox: boolean;
};

const IN_USE_TITLES: Record<LocationSource, string> = {
  'save': 'In use now: Custom',
  'generated': 'In use now: Written by AI',
  'online': 'In use now: Default (shared online)',
  'built-in': 'In use now: Default (built-in)',
  'stock': 'In use now: the stock placeholder',
};

const same = (a: string, b: string) => a.trim() === b.trim();

/** The texts to show under the box for the lot as saved, given what the box holds. */
export function locationReferences(saved: LocationEntity | undefined, boxText: string): LocationReference[] {
  if (!saved) {
    return [];
  }
  const source = saved.source ?? 'stock';
  const references: LocationReference[] = [
    {
      kind: 'in-use',
      title: IN_USE_TITLES[source],
      text: saved.description,
      matchesBox: same(saved.description, boxText),
    },
  ];
  const fallback = saved.default;
  if (fallback && (source === 'save' || source === 'generated') && !same(fallback.description, saved.description)) {
    references.push({
      kind: 'default',
      title: fallback.source === 'online' ? 'Default for everyone (shared online)' : 'Default for everyone (built-in)',
      text: fallback.description,
      matchesBox: same(fallback.description, boxText),
    });
  }
  return references;
}
