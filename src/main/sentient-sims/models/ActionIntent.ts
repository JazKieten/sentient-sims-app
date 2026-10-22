import type { PieIntent } from './ModWebsocketMessage';

export type { PieIntent } from './ModWebsocketMessage';

// One row of the mod's pie-menu vocabulary (interactions/ss_cognition_query.py, kind
// `vocabulary`): what the actor could click on `target` right now. `source: 'whitelist'` marks
// a synthetic row the app adds for a kept whitelist verb (util/formatVocabulary.ts).
export type VocabularyRow = {
  id: string;
  target: string;
  target_id?: string;
  target_kind: 'self' | 'sim' | 'object' | 'inventory' | 'phone';
  category?: string;
  label: string;
  key: string;
  picker?: boolean;
  options?: string[];
  greyed?: boolean;
  reason?: string;
  source?: 'pie' | 'whitelist';
};

export type VocabularyResult = {
  rows: VocabularyRow[];
  cannot_start_now?: { reason?: string; why?: string };
  interrupts?: string;
  targets?: { target: string; target_id?: string; kind: string; rows: number }[];
  ms?: number;
  truncated?: boolean;
};

// An action the app wants a sim to take, expressed in the mod's whitelisted action
// vocabulary (ss_affordance_whitelist.py). Dispatched over the mod websocket as an
// ENQUEUE_INTERACTION message; the mod reports the result to POST /cognition/outcome.
export type ActionIntent = {
  sim_id: string;
  action: string;
  target_sim_id?: string;
  target_object_id?: string;
  priority?: 'high' | 'low' | 'critical';
  insert_strategy?: 'next' | 'last';
  clear_queue?: boolean;
  // Cancel whatever the sim has queued or running before pushing this — set by
  // accepted ask-actions so the sim drops the old plan instead of finishing it first
  preempt?: boolean;
  source?: string;
  // go_out/travel_to_zone: destination zone resolved from the report's venue directory
  zone_id?: string;
  // The thought that motivated the action; carried into the outcome memory's pre_action so
  // future cognition ticks can see why the action was attempted
  motivation?: string;
  // A pie-menu row instead of a whitelist verb: the mod clicks this item
  pie?: PieIntent;
};

// What the mod reports back after a dispatched interaction finishes
export type InteractionOutcomeEvent = {
  request_id?: string;
  sim_id: string;
  sim_name?: string;
  target_sim_id?: string;
  target_sim_name?: string;
  action?: string;
  interaction_name?: string;
  // 'ineligible' = the mod's preflight ran the game's own tests and the intent cannot
  // execute right now (broken fix object, departed target) — nothing was ever pushed
  outcome: 'success' | 'failure' | 'canceled' | 'ineligible';
  // The pie-menu label the click was made by ("Ask about Day"), when the push was a click
  label?: string;
  // The game's actual failure reason ("Missing relationship bit has_met between X and Y",
  // "Object is not in an active zone") — this is what teaches cognition not to retry
  // impossible actions
  reason?: string;
  // Classified by the mod's ss_failure_reasons from the raw reason (e.g. 'target_left',
  // 'object_broken', 'mixer_timeout'); recovery_action is the whitelist verb that clears it
  cause?: string;
  recovery_action?: string;
  location_id?: number;

  // --- F5 provenance (ss_interaction_push._stamp_provenance). All optional: an older
  // mod build sends none of them, and an outcome with none is graded 'unknown', which
  // behaves exactly as before F5.

  // Where the verdict was made. Only 'dispatch' is a claim; everything else means the
  // game (or a mod watcher of it) decided.
  decided_at?: 'dispatch' | 'finished' | 'finishing' | 'sweep' | 'app_cancel' | 'watchdog';
  // Why a dispatch-time report is entitled to claim what it claims. A dispatch-time
  // SUCCESS with no claim is the phantom shape (live 2026-08-26).
  claim?: 'instant_verb' | 'handler' | 'benign_failure' | 'merged_social' | 'merged_food_chain';
  // The mod's push-registry key. Null means nothing was ever tracked in the game.
  push_id?: string | null;
  // Whether the interaction is known to have reached RUNNING. Null = never observed.
  ran?: boolean | null;
  // FinishingType the game reported, when a finisher saw it
  finishing?: string;
  // The SI the sim was actually running when the outcome was reported. Compared against
  // the state report's activity.blocked_by: a success reported while the sim is still
  // wedged in the head SI that starved the push is not a success.
  sim_running?: string;
  game_clock?: { absolute_day?: number; hour?: number; minute?: number };
};
