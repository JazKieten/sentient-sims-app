// The structured output of one cognition deliberation. Validation is strict and
// mechanical: an intent the schema can't hold, or whose targets/actions were not offered
// by the sim's perception snapshot, degrades to 'continue' — the loop fails inert, never
// wrong. EnqueueResult truthiness is NOT success; success only arrives via the outcome
// POST, and that rule lives in CognitionService's state machine, not in any prompt.

import { SimStateEntry, VenueEntry } from './SimStateReport';
import type { PieIntent, VocabularyRow } from './ActionIntent';
import {
  ROMANCE_ACTIONS,
  SOLO_TRAVEL_ACTIONS,
  TEEN_PLUS_TARGET_SOCIALS,
  isRomanceAge,
  isTeenPlus,
} from './ActionLoadout';

export type CognitionIntentKind = 'action' | 'speak' | 'continue' | 'wait';

export type CognitionIntent = {
  kind: CognitionIntentKind;
  action?: string;
  target_sim_id?: string;
  target_object_id?: string;
  speak?: {
    target_sim_id?: string;
    topic?: string;
  };
  // go_out only: the venue NAME the model chose from the report's venue directory
  // (validateIntent resolves it to zone_id; an unknown name is dropped, never fatal)
  destination?: string;
  // go_out/travel_to_zone: the resolved destination zone, passed through to the mod
  zone_id?: string;
  // One-line inner monologue — always present, becomes a 'thought' memory
  thought?: string;
  // Why, in-world — carried into the outcome memory's pre_action
  motivation?: string;
  urgency?: 'low' | 'normal' | 'emergency';
  // G-10: automatic re-dispatches the sim is willing to spend if the attempt dies to a
  // TRANSIENT cause (target left, bumped from the queue, mixer stage timeout). Set by
  // the model at choice time; default 1, cap 3; never spent on ineligible/structural
  // causes and always behind the same suppression backoff as any other close.
  retries?: number;
  // Pie vocabulary (autonomy part 2): the row id the model answered with, the option it
  // chose from a collapsed row, and the resolved click the mod runs
  row?: string;
  option?: string;
  pie?: PieIntent;
};

// Part 4 (10-19 review): the model answers "null" / "none" for an absent target and the
// string used to reach the mod as a parse error. Any such word, or an empty string, is no id.
export function cleanId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '' || ['null', 'none', 'undefined'].includes(trimmed.toLowerCase())) {
    return undefined;
  }
  return trimmed;
}

// 'r12', 'R12', '12' all name row r12; 'w1' / 'W1' the first whitelist row
function findRow(rows: VocabularyRow[], wanted: string): VocabularyRow | undefined {
  const text = wanted.trim().toLowerCase();
  if (!text) {
    return undefined;
  }
  const exact = rows.find((row) => row.id.toLowerCase() === text);
  if (exact) {
    return exact;
  }
  if (/^\d+$/.test(text)) {
    return rows.find((row) => row.id.toLowerCase() === `r${text}`);
  }
  return undefined;
}

// A pie-vocabulary answer: the row must be offered (present, not greyed, not a picker), an
// option must be one the row lists, and the result is the click the mod runs. A synthetic
// whitelist row resolves through the whitelist path (go_out keeps its destination).
function validateRowIntent(
  candidate: CognitionIntent,
  rows: VocabularyRow[],
  entry: SimStateEntry,
  lotActionKeys: string[] | undefined,
  venues: VenueEntry[] | undefined,
  thought: string | undefined,
): ValidatedIntent {
  const row = findRow(rows, String(candidate.row));
  if (!row) {
    return { ok: false, reason: `row '${String(candidate.row)}' was not offered`, fallback: fallbackContinue(thought) };
  }
  if (row.greyed) {
    return { ok: false, reason: `row ${row.id} (${row.label}) is greyed out`, fallback: fallbackContinue(thought) };
  }
  if (row.picker) {
    return { ok: false, reason: `row ${row.id} (${row.label}) opens a picker`, fallback: fallbackContinue(thought) };
  }
  if (row.source === 'whitelist') {
    return validateIntent(
      { ...candidate, action: row.key, row: undefined, option: undefined },
      entry,
      lotActionKeys,
      venues,
    );
  }
  let option: string | undefined;
  if (row.options && row.options.length > 0) {
    const wanted = cleanId(candidate.option)?.toLowerCase();
    option = row.options.find((candidateOption) => candidateOption.toLowerCase() === wanted);
    if (!option) {
      return {
        ok: false,
        reason: `row ${row.id} (${row.label}) needs one of its options`,
        fallback: fallbackContinue(thought),
      };
    }
  }
  const pie: PieIntent = {
    target_id: row.target_id || undefined,
    target_kind: row.target_kind,
    item: row.key,
    label: option ?? row.label,
    option,
  };
  return {
    ok: true,
    intent: {
      kind: 'action',
      action: row.key,
      target_sim_id: row.target_kind === 'sim' ? row.target_id : undefined,
      target_object_id: row.target_kind === 'object' || row.target_kind === 'inventory' ? row.target_id : undefined,
      row: row.id,
      option,
      pie,
      thought,
      motivation: candidate.motivation,
      urgency: candidate.urgency,
      retries: candidate.retries,
    },
  };
}

// Social actions ride sim_Chat + a mixer; on strangers everything except 'chat' fails the
// has_met relationship test, so target selection coerces accordingly (rule enforced in
// code, not prompt).
export const SOCIAL_ACTIONS = new Set([
  'chat',
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
  'flirt',
  'kiss',
  'insult',
]);

// What the observer knows about a present, talkable sim — the has_met gate plus the
// relationship lore the prompt renders so social picks can match the relationship
export type SimTargetInfo = {
  name?: string;
  hasMet: boolean;
  // Age of the perceived target (str(sim_info.age) minus 'Age.'), for target-side age
  // gates; absent on older mod builds, which fails age-gated socials CLOSED
  age?: string;
  // Verbs the game refuses toward this target's age (mod-reported); see PerceivedSim
  targetAgeBlocked?: string[];
  // Asleep: no social can execute toward them right now
  asleep?: boolean;
  friendship?: number;
  romance?: number;
  bits?: string[];
};

export type ValidatedIntent =
  | { ok: true; intent: CognitionIntent }
  | { ok: false; reason: string; fallback: CognitionIntent };

function fallbackContinue(thought?: string): CognitionIntent {
  return { kind: 'continue', thought };
}

// Models render whitelist keys as prose ("brush teeth", "Brush-Teeth") — observed live on
// the first playtest tick. The vocabulary is snake_case, so fold case and separators
// before lookup instead of wasting a tick degrading to 'continue'.
export function normalizeActionKey(action: string): string {
  return action
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

// Second-chance lookup for squashed keys ("paybills", observed live) — if the normalized
// form matches no known key, compare with underscores stripped from both sides. Only ever
// resolves to a key that is actually known, so it cannot widen the vocabulary.
function matchKnownKey(action: string, known: Iterable<string>): string | undefined {
  const squashed = action.replace(/_/g, '');
  for (const key of known) {
    if (key === action || key.replace(/_/g, '') === squashed) {
      return key;
    }
  }
  return undefined;
}

export function parseIntentJson(raw: string): CognitionIntent | undefined {
  // Models wrap JSON in fences or prose; take the first {...} block
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) {
    return undefined;
  }
  try {
    return JSON.parse(match[0]) as CognitionIntent;
  } catch {
    return undefined;
  }
}

// Zone travel takes the PLAYER's game through a loading screen, so it belongs only to
// household sims. Live 2026-08-07: a bar owner scored 7 on a chat scene, picked go_home,
// and the push unloaded the player's zone mid-conversation — the load never finished.
// The mod refuses these for visitors too; filtering here keeps an NPC from ever burning
// an Action Scene on a verb that cannot run.
export const HOUSEHOLD_ONLY_ACTIONS = new Set(['go_home', 'go_out', 'travel_to_zone']);

// Offered vocabulary for this tick: object actions whose provider is in the snapshot,
// socials toward same-room sims. Perception vocabulary == action vocabulary — a target
// that isn't in the snapshot cannot be acted on, which kills hallucinated targets
// structurally.
export function offeredActions(
  entry: SimStateEntry,
  lotActionKeys?: string[],
): {
  objectActions: Map<string, string>; // action key -> object_id of nearest provider
  simTargets: Map<string, SimTargetInfo>; // sim_id -> relationship-aware target info
  lotActions: Set<string>; // context-gated lot verbs (pay_bills, ...); mod resolves targets
} {
  const objectActions = new Map<string, string>();
  (entry.objects ?? []).forEach((object) => {
    (object.action_keys ?? []).forEach((key) => {
      if (!objectActions.has(key)) {
        objectActions.set(key, object.object_id);
      }
    });
  });
  const simTargets = new Map<string, SimTargetInfo>();
  (entry.sims ?? []).forEach((perceived) => {
    if (perceived.tier !== 'same_room' || !perceived.sim_id) {
      return;
    }
    simTargets.set(perceived.sim_id, {
      name: perceived.name,
      hasMet: perceived.social?.has_met !== false,
      age: perceived.age,
      targetAgeBlocked: perceived.target_age_blocked,
      asleep: perceived.asleep === true,
      friendship: perceived.social?.friendship,
      romance: perceived.social?.romance,
      bits: perceived.social?.bits,
    });
  });
  const lotActions = new Set(lotActionKeys ?? []);
  if (entry.is_household === false) {
    HOUSEHOLD_ONLY_ACTIONS.forEach((action) => lotActions.delete(action));
  }
  // Solo travel is TEEN+ (mod whitelist min_age). The mod's age_blocked narrows these
  // already on current builds; this is the fail-closed skew guard — an absent/unknown
  // age strips them too, same doctrine as romance.
  if (!isTeenPlus(entry.self?.age)) {
    SOLO_TRAVEL_ACTIONS.forEach((action) => lotActions.delete(action));
  }
  return { objectActions, simTargets, lotActions };
}

// The model chooses a go_out destination by NAME (zone ids never reach the prompt);
// only a name that matches the report's venue directory resolves to a zone_id. For
// travel_to_zone a model-supplied zone_id is trusted only when the directory contains
// it. No match = no destination — the mod's picker takes over; never fatal.
function resolveDestination(
  action: string,
  candidate: CognitionIntent,
  venues?: VenueEntry[],
): { name?: string; zone_id: string } | undefined {
  if (!SOLO_TRAVEL_ACTIONS.has(action) || !venues || venues.length === 0) {
    return undefined;
  }
  const wanted = candidate.destination?.trim().toLowerCase();
  if (wanted) {
    const match = venues.find((venue) => venue.name?.trim().toLowerCase() === wanted);
    if (match?.zone_id) {
      return { name: match.name, zone_id: match.zone_id };
    }
  }
  const zoneId = candidate.zone_id;
  if (zoneId) {
    const match = venues.find((venue) => venue.zone_id === zoneId);
    if (match?.zone_id) {
      return { name: match.name, zone_id: match.zone_id };
    }
  }
  return undefined;
}

export function validateIntent(
  candidate: CognitionIntent | undefined,
  entry: SimStateEntry,
  lotActionKeys?: string[],
  venues?: VenueEntry[],
  // The pie vocabulary this tick offered; a candidate naming a `row` resolves against it
  rows?: VocabularyRow[],
): ValidatedIntent {
  if (!candidate || typeof candidate !== 'object') {
    return { ok: false, reason: 'unparseable intent', fallback: fallbackContinue() };
  }
  const thought = typeof candidate.thought === 'string' ? candidate.thought.slice(0, 300) : undefined;
  // "null" targets are no targets (part 4), before anything reads them
  if (candidate.target_sim_id !== undefined || candidate.target_object_id !== undefined) {
    candidate = {
      ...candidate,
      target_sim_id: cleanId(candidate.target_sim_id),
      target_object_id: cleanId(candidate.target_object_id),
    };
  }
  if (rows && candidate.row !== undefined && candidate.row.trim() !== '') {
    return validateRowIntent(candidate, rows, entry, lotActionKeys, venues, thought);
  }

  if (candidate.kind === 'continue' || candidate.kind === 'wait') {
    return { ok: true, intent: { ...candidate, thought } };
  }

  // 'speak' is sugar for a social toward a present sim; normalize into an action so a
  // single dispatch path handles both
  if (candidate.kind === 'speak') {
    const targetSimId = candidate.speak?.target_sim_id ?? candidate.target_sim_id;
    if (!targetSimId) {
      return { ok: false, reason: 'speak without target_sim_id', fallback: fallbackContinue(thought) };
    }
    const target = offeredActions(entry).simTargets.get(targetSimId);
    if (!target) {
      return { ok: false, reason: `speak target ${targetSimId} is not present`, fallback: fallbackContinue(thought) };
    }
    return {
      ok: true,
      intent: {
        kind: 'action',
        action: 'chat',
        target_sim_id: targetSimId,
        thought,
        motivation: candidate.speak?.topic ?? candidate.motivation,
        urgency: candidate.urgency,
      },
    };
  }

  if (candidate.kind !== 'action' || !candidate.action) {
    return { ok: false, reason: `unknown kind '${String(candidate.kind)}'`, fallback: fallbackContinue(thought) };
  }

  const offered = offeredActions(entry, lotActionKeys);
  const normalized = normalizeActionKey(candidate.action);
  const action =
    matchKnownKey(normalized, [...SOCIAL_ACTIONS, ...offered.objectActions.keys(), ...offered.lotActions]) ??
    normalized;

  if (SOCIAL_ACTIONS.has(action)) {
    if (!candidate.target_sim_id) {
      return { ok: false, reason: `social '${action}' without target_sim_id`, fallback: fallbackContinue(thought) };
    }
    const target = offered.simTargets.get(candidate.target_sim_id);
    if (!target) {
      return {
        ok: false,
        reason: `social target ${candidate.target_sim_id} is not in the snapshot`,
        fallback: fallbackContinue(thought),
      };
    }
    // A sleeping target can't be talked to at all. The mod refuses these at resolve time
    // with cause 'target_asleep', but a dispatch that never happens is a tick saved and a
    // failure memory not written (live 2026-08-16: Travis re-formed 'chat' at a napping
    // Mackenzie three ticks running because nothing told him she was asleep).
    if (target.asleep) {
      return {
        ok: false,
        reason: `social target ${candidate.target_sim_id} is asleep`,
        fallback: fallbackContinue(thought),
      };
    }
    // Chat-first: everything but 'chat' fails on strangers with a missing has_met bit.
    // Coerced in logic so the model can't waste a tick learning the rule.
    //
    // Age gate, belt-and-braces: the prompt no longer offers romance across an age line,
    // but a stage that names one anyway must never dispatch it. Coerced rather than
    // rejected so the tick still spends on something. TEEN_PLUS_TARGET_SOCIALS ride the
    // same TEEN+ rule: the game cancels them at execution when the target is a child
    // (deep_conversation, caught live 2026-08-11), so they must die here first.
    const teenPlusGated = ROMANCE_ACTIONS.has(action) || TEEN_PLUS_TARGET_SOCIALS.has(action);
    const ageBlocked =
      (teenPlusGated && !(isRomanceAge(entry.self?.age) && isRomanceAge(target.age))) ||
      // The mod reads the mixer's TargetSim age test itself (P-8); when it says the
      // target's age is refused, believe it over the hand-kept sets
      (target.targetAgeBlocked ?? []).includes(action);
    const coerced = target.hasMet && !ageBlocked ? action : 'chat';
    return {
      ok: true,
      intent: { ...candidate, action: coerced, thought },
    };
  }

  const providerObjectId = offered.objectActions.get(action);
  if (!providerObjectId) {
    // Lot verbs (pay_bills, hire_repair_service, ...) have no snapshot provider — the
    // mod resolves mailbox/phone/fallbacks itself, so any model-supplied target is
    // noise (observed live: target_object_id: "Mailbox" crashed int() mod-side)
    if (offered.lotActions.has(action)) {
      // Destination is attached AFTER the target strip, or it would vanish with them
      const resolved = resolveDestination(action, candidate, venues);
      return {
        ok: true,
        intent: {
          ...candidate,
          action,
          target_object_id: undefined,
          target_sim_id: undefined,
          destination: resolved?.name,
          zone_id: resolved?.zone_id,
          thought,
        },
      };
    }
    // A social by any other name: an unknown verb aimed at a PRESENT sim is a social —
    // coerce to chat instead of losing the tick (observed live: 'talk' at Social -100
    // in a full bar degraded to continue while she brushed her teeth again)
    if (candidate.target_sim_id && offered.simTargets.has(candidate.target_sim_id)) {
      return {
        ok: true,
        intent: { ...candidate, action: 'chat', target_object_id: undefined, thought },
      };
    }
    return {
      ok: false,
      reason: `action '${action}' has no provider in the snapshot`,
      fallback: fallbackContinue(thought),
    };
  }
  // Only trust a model-supplied object id that the snapshot actually contains;
  // anything else ("Mailbox", a remembered id from another lot) falls back to the
  // nearest offered provider
  const offeredObjectIds = new Set((entry.objects ?? []).map((object) => object.object_id));
  const targetObjectId =
    candidate.target_object_id && offeredObjectIds.has(candidate.target_object_id)
      ? candidate.target_object_id
      : providerObjectId;
  return {
    ok: true,
    intent: {
      ...candidate,
      action,
      target_object_id: targetObjectId,
      thought,
    },
  };
}
