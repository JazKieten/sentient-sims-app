import { isBelowChild, isRomanceAge } from '../util/simLifeStage';

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
// Mirrors the mod's whitelist categories (ss_affordance_whitelist.py — 58 pushable keys
// as of 2026-08-26 (52 from 08-15 + 6 infant/toddler) plus two documented-unsupported
// picker entries); the mod's local/audit_whitelist.py `drift()` diffs these sets
// against the whitelist.

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
  // baby care: never a personality choice — perception context-gates these (only
  // offered while a baby is on the lot), and a hungry baby is not a loadout question
  'feed_baby',
  'change_diaper',
  'soothe_baby',
  // infant care (Growing Together infants are sims, not bassinets — the three verbs
  // above stop resolving the moment a baby ages up) and the toddler social floor
  // (toddlers refuse sim_Chat, so talk/comfort are their 'chat')
  'feed_infant',
  'change_infant_diaper',
  'put_infant_to_nap',
  'talk_to_toddler',
  'comfort_toddler',
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
  'hug_toddler',
  // romance / mean
  'flirt',
  'kiss',
  'insult',
  // outings
  'go_out',
  'travel_to_zone',
  'invite_in',
  // fitness / creative / skill (G-2/G-3, 2026-08-15) — the verbs that can actually
  // advance an aspiration, career or skill goal
  'jog',
  'workout',
  'paint',
  'write',
  'practice_speech',
  'listen_to_music',
  'order_drink',
  'stargaze',
  'garden',
  'program',
  'fish',
  'play_chess',
]);

// Whitelist entries the mod documents but cannot push (the game opens a UI picker).
// Listed so the drift audit and the prompts agree they exist and are never offered.
export const KNOWN_UNSUPPORTED_ACTIONS = new Set(['play_chess_with', 'write_book']);

// Romance is gated on age at every stage: the planner never offers these keys to a
// non-adult, validate() drops them from a loadout, and the prompt never renders them
// toward a non-adult target. Observed live 2026-08-10: nothing read age anywhere, and
// the nightly planner handed 'flirt' to Mackenzie Scott — a CHILD — two days running.
export const ROMANCE_ACTIONS = new Set(['flirt', 'kiss']);

// isRomanceAge and isBelowChild are core since release 4.5 (util/simLifeStage): the
// reply and reflection paths gate on them too. Re-exported for the autonomy callers.
export { isBelowChild, isRomanceAge };

// Zone travel a sim takes on their own initiative: TEEN+ only, mirrored from the mod's
// whitelist min_age (live 2026-08-17..27: 29 of 30 logged go_outs were babies/infants/
// toddlers — an immobile infant solo-traveled to a bar). The mod's age_blocked already
// narrows these for current builds; stripping here is the skew guard for an older mod
// that reports no age_blocked entries for handler verbs. The game's TEEN+ set and the
// romance-age set coincide, so isRomanceAge doubles as the actor-age predicate.
export const SOLO_TRAVEL_ACTIONS = new Set(['go_out', 'travel_to_zone']);

export const isTeenPlus = isRomanceAge;

// Non-romance socials the game refuses when the TARGET is under teen — the age test
// rides the social's mixer, so preflight passes and the cancel only lands at execution
// ("TargetSim's age is Age.CHILD, must be one of Age.TEEN, YOUNGADULT, ADULT, ELDER",
// caught live 2026-08-11: deep_conversation dispatched at a CHILD). The game's list is
// the same TEEN+ set as romance, so isRomanceAge doubles as the target-age predicate.
export const TEEN_PLUS_TARGET_SOCIALS = new Set(['deep_conversation']);

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
    'hug_toddler',
  ],
  romance: ['flirt', 'kiss'],
  mean: ['insult'],
  outings: ['go_out', 'travel_to_zone', 'invite_in', 'order_drink'],
  fitness: ['jog', 'workout'],
  creative: ['paint', 'write', 'play_piano', 'play_guitar', 'listen_to_music'],
  skills: ['practice_speech', 'program', 'garden', 'fish', 'play_chess', 'stargaze'],
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
