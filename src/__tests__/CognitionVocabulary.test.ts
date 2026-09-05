import { describe, expect, it } from 'vitest';
import { offeredActions, validateIntent } from 'main/sentient-sims/models/CognitionIntent';
import { SimStateEntry, VenueEntry } from 'main/sentient-sims/models/SimStateReport';

function entry(overrides: Partial<SimStateEntry> = {}): SimStateEntry {
  return {
    sim_id: '100',
    name: 'Atticus Dodson',
    self: { age: 'YOUNGADULT' },
    ...overrides,
  } as SimStateEntry;
}

const lotKeys = ['go_home', 'go_out', 'travel_to_zone', 'pay_bills'];

describe('offered vocabulary', () => {
  it('offers travel verbs to teen-plus household sims', () => {
    const offered = offeredActions(entry(), lotKeys);

    expect(offered.lotActions.has('go_home')).toBe(true);
    expect(offered.lotActions.has('go_out')).toBe(true);
    expect(offered.lotActions.has('travel_to_zone')).toBe(true);
  });

  it('withholds travel verbs from a visiting sim', () => {
    // Live 2026-08-07: a bar owner scored 7 on a chat scene, picked go_home, and the
    // push unloaded the player's zone mid-conversation — the load never finished
    const offered = offeredActions(entry({ is_household: false }), lotKeys);

    expect(offered.lotActions.has('go_home')).toBe(false);
    expect(offered.lotActions.has('go_out')).toBe(false);
    expect(offered.lotActions.has('travel_to_zone')).toBe(false);
    // Non-travel lot verbs are unaffected
    expect(offered.lotActions.has('pay_bills')).toBe(true);
  });

  it('withholds solo travel from minors, and from unknown ages (fail closed)', () => {
    // Live 2026-08-17..27: 29 of 30 logged go_outs were babies/infants/toddlers
    for (const age of ['INFANT', 'TODDLER', 'CHILD', undefined]) {
      const offered = offeredActions(entry({ self: { age } }), lotKeys);
      expect(offered.lotActions.has('go_out'), String(age)).toBe(false);
      expect(offered.lotActions.has('travel_to_zone'), String(age)).toBe(false);
      // go_home stays: a stranded child must still get home (rule lane, not solo travel)
      expect(offered.lotActions.has('go_home'), String(age)).toBe(true);
      expect(offered.lotActions.has('pay_bills'), String(age)).toBe(true);
    }
  });
});

const VENUES: VenueEntry[] = [
  { zone_id: '42', name: 'Willow Creek Archive', venue: 'library', world: 'Willow Creek', same_world: false },
  { zone_id: '77', name: 'Rattlesnake Juice', venue: 'bar', world: 'Oasis Springs', same_world: true },
];

describe('go_out destination resolution', () => {
  it('resolves a destination name to its zone_id, case-insensitively, after the target strip', () => {
    const validated = validateIntent(
      {
        kind: 'action',
        action: 'go_out',
        destination: 'willow creek archive',
        // Model-supplied targets on lot verbs are noise and must still be nulled
        target_object_id: 'Mailbox',
        target_sim_id: '5',
      },
      entry(),
      lotKeys,
      VENUES,
    );

    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.intent.action).toBe('go_out');
      expect(validated.intent.zone_id).toBe('42');
      expect(validated.intent.destination).toBe('Willow Creek Archive');
      expect(validated.intent.target_object_id).toBeUndefined();
      expect(validated.intent.target_sim_id).toBeUndefined();
    }
  });

  it('drops an unknown destination but keeps the intent (mod picker fallback)', () => {
    const validated = validateIntent(
      { kind: 'action', action: 'go_out', destination: 'The Moon' },
      entry(),
      lotKeys,
      VENUES,
    );

    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.intent.action).toBe('go_out');
      expect(validated.intent.zone_id).toBeUndefined();
      expect(validated.intent.destination).toBeUndefined();
    }
  });

  it('trusts a model zone_id on travel_to_zone only when the directory contains it', () => {
    const known = validateIntent({ kind: 'action', action: 'travel_to_zone', zone_id: '77' }, entry(), lotKeys, VENUES);
    expect(known.ok).toBe(true);
    if (known.ok) {
      expect(known.intent.zone_id).toBe('77');
    }

    const unknown = validateIntent(
      { kind: 'action', action: 'travel_to_zone', zone_id: '999999' },
      entry(),
      lotKeys,
      VENUES,
    );
    expect(unknown.ok).toBe(true);
    if (unknown.ok) {
      expect(unknown.intent.zone_id).toBeUndefined();
    }
  });

  it('never resolves a destination for non-travel lot verbs', () => {
    const validated = validateIntent(
      { kind: 'action', action: 'pay_bills', destination: 'Rattlesnake Juice' },
      entry(),
      lotKeys,
      VENUES,
    );
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.intent.zone_id).toBeUndefined();
    }
  });
});
