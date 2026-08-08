// The structured output of one cognition deliberation. Validation is strict and
// mechanical: an intent the schema can't hold, or whose targets/actions were not offered
// by the sim's perception snapshot, degrades to 'continue' — the loop fails inert, never
// wrong. EnqueueResult truthiness is NOT success; success only arrives via the outcome
// POST, and that rule lives in CognitionService's state machine, not in any prompt.

import { SimStateEntry } from './SimStateReport';

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
      friendship: perceived.social?.friendship,
      romance: perceived.social?.romance,
      bits: perceived.social?.bits,
    });
  });
  return { objectActions, simTargets, lotActions: new Set(lotActionKeys ?? []) };
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
    // Chat-first: everything but 'chat' fails on strangers with a missing has_met bit.
    // Coerced in logic so the model can't waste a tick learning the rule.
    const coerced = target.hasMet ? action : 'chat';
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
