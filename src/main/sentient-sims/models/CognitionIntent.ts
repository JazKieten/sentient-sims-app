// The structured output of one cognition deliberation. Validation is strict and
// mechanical: an intent the schema can't hold, or whose targets/actions were not offered
// by the sim's perception snapshot, degrades to 'continue' — the loop fails inert, never
// wrong. EnqueueResult truthiness is NOT success; success only arrives via the outcome
// POST, and that rule lives in CognitionService's state machine, not in any prompt.

import { SimStateEntry } from './SimStateReport';
import { ROMANCE_ACTIONS, TEEN_PLUS_TARGET_SOCIALS, isRomanceAge } from './ActionLoadout';

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
};

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
  return { objectActions, simTargets, lotActions };
}

export function validateIntent(
  candidate: CognitionIntent | undefined,
  entry: SimStateEntry,
  lotActionKeys?: string[],
): ValidatedIntent {
  if (!candidate || typeof candidate !== 'object') {
    return { ok: false, reason: 'unparseable intent', fallback: fallbackContinue() };
  }
  const thought = typeof candidate.thought === 'string' ? candidate.thought.slice(0, 300) : undefined;

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
      return {
        ok: true,
        intent: { ...candidate, action, target_object_id: undefined, target_sim_id: undefined, thought },
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
