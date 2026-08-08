import { describe, expect, it } from 'vitest';
import { offeredActions } from 'main/sentient-sims/models/CognitionIntent';
import { SimStateEntry } from 'main/sentient-sims/models/SimStateReport';

function entry(overrides: Partial<SimStateEntry> = {}): SimStateEntry {
  return { sim_id: '100', name: 'Atticus Dodson', ...overrides } as SimStateEntry;
}

const lotKeys = ['go_home', 'go_out', 'travel_to_zone', 'pay_bills'];

describe('offered vocabulary', () => {
  it('offers travel verbs to household sims', () => {
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
});
