import { describe, expect, it } from 'vitest';
import { cleanId, offeredActions, validateIntent } from 'main/sentient-sims/models/CognitionIntent';
import type { VocabularyRow } from 'main/sentient-sims/models/ActionIntent';
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

// The pie vocabulary (autonomy part 2, 2026-10-21): a row id binds to the mod's row and
// becomes the click; anything not offered dies here.
const ROWS: VocabularyRow[] = [
  {
    id: 'r12',
    target: 'Ruby Navarro',
    target_id: '200',
    target_kind: 'sim',
    category: 'Friendly > Small Talk',
    label: 'Ask about Day',
    key: 'mixer_social_AskAboutDay',
  },
  {
    id: 'r13',
    target: 'Ruby Navarro',
    target_id: '200',
    target_kind: 'sim',
    label: 'Insult',
    key: 'mixer_social_Insult',
    greyed: true,
    reason: 'Distance test failed',
  },
  {
    id: 'r14',
    target: 'object_fridge',
    target_id: '900',
    target_kind: 'object',
    label: 'Cook (picker)',
    key: 'fridge_Cook',
    picker: true,
  },
  {
    id: 'r20',
    target: 'object_stereo',
    target_id: '950',
    target_kind: 'object',
    label: 'Listen to Music <choice>',
    key: 'stereo_Listen',
    options: ['Pop', 'Jazz'],
  },
  { id: 'r21', target: 'the phone', target_id: '', target_kind: 'phone', label: 'Pay Bills', key: 'phone_PayBills' },
  { id: 'w1', target: 'The household', target_kind: 'self', label: 'go out', key: 'go_out', source: 'whitelist' },
];

describe('pie vocabulary rows', () => {
  it("maps a row id ('12', 'R12', 'r12') to the click", () => {
    for (const row of ['r12', 'R12', '12']) {
      const validated = validateIntent({ kind: 'action', row, thought: 'Ruby.' }, entry(), lotKeys, VENUES, ROWS);
      expect(validated.ok, row).toBe(true);
      if (validated.ok) {
        expect(validated.intent).toMatchObject({
          action: 'mixer_social_AskAboutDay',
          target_sim_id: '200',
          row: 'r12',
          pie: { target_id: '200', target_kind: 'sim', item: 'mixer_social_AskAboutDay', label: 'Ask about Day' },
        });
      }
    }
  });

  it('rejects a missing, greyed or picker row and an option the row does not list', () => {
    for (const [candidate, reason] of [
      [{ kind: 'action', row: 'r99' }, 'not offered'],
      [{ kind: 'action', row: 'r13' }, 'greyed out'],
      [{ kind: 'action', row: 'r14' }, 'opens a picker'],
      [{ kind: 'action', row: 'r20', option: 'Metal' }, 'needs one of its options'],
      [{ kind: 'action', row: 'r20' }, 'needs one of its options'],
    ] as const) {
      const validated = validateIntent(candidate, entry(), lotKeys, VENUES, ROWS);
      expect(validated.ok).toBe(false);
      if (!validated.ok) {
        expect(validated.reason).toContain(reason);
        expect(validated.fallback.kind).toBe('continue');
      }
    }
  });

  it('an option rides the click as its item label', () => {
    const validated = validateIntent({ kind: 'action', row: 'r20', option: 'jazz' }, entry(), lotKeys, VENUES, ROWS);
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.intent.pie).toEqual({
        target_id: '950',
        target_kind: 'object',
        item: 'stereo_Listen',
        label: 'Jazz',
        option: 'Jazz',
      });
      expect(validated.intent.target_object_id).toBe('950');
    }
  });

  it('a phone row carries no target', () => {
    const validated = validateIntent({ kind: 'action', row: 'r21' }, entry(), lotKeys, VENUES, ROWS);
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.intent.target_sim_id).toBeUndefined();
      expect(validated.intent.target_object_id).toBeUndefined();
      expect(validated.intent.pie?.target_kind).toBe('phone');
    }
  });

  it('a whitelist row resolves through the whitelist, destination included', () => {
    const validated = validateIntent(
      { kind: 'action', row: 'w1', destination: 'Rattlesnake Juice' },
      entry(),
      lotKeys,
      VENUES,
      ROWS,
    );
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.intent.action).toBe('go_out');
      expect(validated.intent.zone_id).toBe('77');
      expect(validated.intent.pie).toBeUndefined();
    }
  });

  it('without rows a row answer is ignored and the action decides', () => {
    const validated = validateIntent({ kind: 'action', row: 'r12', action: 'pay_bills' }, entry(), lotKeys, VENUES);
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.intent.action).toBe('pay_bills');
    }
  });
});

describe('cleanId', () => {
  it('reads the model\'s "null" words as no id', () => {
    for (const word of ['', ' ', 'null', 'None', 'UNDEFINED', 'none']) {
      expect(cleanId(word)).toBeUndefined();
    }
    expect(cleanId(' 42 ')).toBe('42');
    expect(cleanId(42)).toBeUndefined();
    const validated = validateIntent(
      { kind: 'action', action: 'pay_bills', target_object_id: 'null', target_sim_id: 'none' },
      entry(),
      lotKeys,
    );
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.intent.target_object_id).toBeUndefined();
      expect(validated.intent.target_sim_id).toBeUndefined();
    }
  });
});
