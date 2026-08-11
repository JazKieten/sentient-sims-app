// The daily action loadout ("spell prep"): each night a sim picks a handful of
// DISCRETIONARY actions that define who they are tomorrow; everything else in that set
// simply does not exist for them that day (absent from prompts, rejected at validation).
//
// ALWAYS_AVAILABLE is never filtered: survival (need), chat (the one social that always
// works), idle/control, emergencies, the context-gated maintenance verbs (locking those
// behind a loadout would recreate the "utilities shut off and the loop can never fix it"
// failure class), and the rule-lane travel verbs the safety lanes dispatch. The loadout
// is a personality filter, not a capability system.
//
// Mirrors the mod's 38-key whitelist categories (ss_affordance_whitelist.py); drift is
// guarded by whitelist_version riding every state report.

export const ALWAYS_AVAILABLE_ACTIONS = new Set([
  // need
  'grab_snack',
  'cook_meal',
  'sleep',
  'nap',
  'take_shower',
  'use_toilet',
  'brush_teeth',
  // social floor
  'chat',
  // idle / control / emergency
  'sit',
  'cancel_current',
  'call_firefighter',
  // context-gated maintenance (only offered when bills due / broken / dirty)
  'pay_bills',
  'hire_repair_service',
  'clean_up',
  // rule-lane travel (exhaustion walks you home whether or not you prepped it)
  'go_home',
  'enter_lot',
]);

// What the nightly planner picks from. Off-loadout keys in this set are removed from
// every offering channel for the day and rejected if a stage names one anyway.
export const DISCRETIONARY_ACTIONS = new Set([
  // fun
  'watch_tv',
  'read_book',
  'browse_web',
  'play_piano',
  'play_guitar',
  'dance',
  // socials beyond chat
  'ask_about_day',
  'ask_about_career',
  'get_to_know',
  'deep_conversation',
  'compliment_outfit',
  'gossip',
  'apologize',
  'tell_joke',
  'tell_funny_story',
  'hug',
  // romance / mean
  'flirt',
  'kiss',
  'insult',
  // outings
  'go_out',
  'travel_to_zone',
  'invite_in',
]);

// Grouped view of DISCRETIONARY_ACTIONS for planner prompts — same keys, human order
export const DISCRETIONARY_GROUPS: Record<string, string[]> = {
  fun: ['watch_tv', 'read_book', 'browse_web', 'play_piano', 'play_guitar', 'dance'],
  socials: [
    'ask_about_day',
    'ask_about_career',
    'get_to_know',
    'deep_conversation',
    'compliment_outfit',
    'gossip',
    'apologize',
    'tell_joke',
    'tell_funny_story',
    'hug',
  ],
  romance: ['flirt', 'kiss'],
  mean: ['insult'],
  outings: ['go_out', 'travel_to_zone', 'invite_in'],
};

// The keys a given loadout removes for the day: discretionary minus the prepped set.
// An absent/empty loadout filters nothing (fail open).
export function offLoadoutActions(loadout: string[] | undefined): Set<string> {
  if (!loadout || loadout.length === 0) {
    return new Set();
  }
  const prepped = new Set(loadout);
  const off = new Set<string>();
  DISCRETIONARY_ACTIONS.forEach((action) => {
    if (!prepped.has(action)) {
      off.add(action);
    }
  });
  return off;
}
