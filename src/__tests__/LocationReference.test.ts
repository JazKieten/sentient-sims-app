import { LocationEntity } from 'main/sentient-sims/db/entities/LocationEntity';
import { locationReferences } from 'main/sentient-sims/util/locationReference';

// Under the Locations editor's box: what the game uses now, and the default a custom text would
// go back to

const builtIn = {
  name: 'Pectoral Fitness',
  lot_type: 'Gym',
  description: 'A gym in Willow Creek.',
  source: 'built-in',
} as const;

const lot = (overrides: Partial<LocationEntity>): LocationEntity => ({
  id: 7,
  name: 'Pectoral Fitness',
  lot_type: 'Gym',
  description: 'A gym in Willow Creek.',
  source: 'built-in',
  default: builtIn,
  ...overrides,
});

describe('locationReferences', () => {
  it('shows the default in use, marked when the box still holds it', () => {
    expect(locationReferences(lot({}), 'A gym in Willow Creek.')).toEqual([
      { kind: 'in-use', title: 'In use now: Default (built-in)', text: 'A gym in Willow Creek.', matchesBox: true },
    ]);
    expect(locationReferences(lot({}), 'A draft from Auto-Generate.')[0].matchesBox).toBe(false);
  });

  it("shows a save's own text in use and the default it would go back to", () => {
    const custom = lot({ source: 'save', description: 'My gym.' });
    expect(locationReferences(custom, 'My gym, edited.')).toEqual([
      { kind: 'in-use', title: 'In use now: Custom', text: 'My gym.', matchesBox: false },
      {
        kind: 'default',
        title: 'Default for everyone (built-in)',
        text: 'A gym in Willow Creek.',
        matchesBox: false,
      },
    ]);
    const online = lot({ source: 'generated', description: 'AI text.', default: { ...builtIn, source: 'online' } });
    expect(locationReferences(online, 'AI text.').map((ref) => ref.title)).toEqual([
      'In use now: Written by AI',
      'Default for everyone (shared online)',
    ]);
  });

  it('shows no default when there is none or the saved text is the default', () => {
    expect(locationReferences(lot({ source: 'save', default: undefined }), '')).toHaveLength(1);
    expect(locationReferences(lot({ source: 'save' }), '')).toHaveLength(1);
    expect(locationReferences(lot({ source: undefined, default: undefined }), '')[0].title).toBe(
      'In use now: the stock placeholder',
    );
    expect(locationReferences(undefined, '')).toEqual([]);
  });
});
