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
  // The game's actual failure reason ("Missing relationship bit has_met between X and Y",
  // "Object is not in an active zone") — this is what teaches cognition not to retry
  // impossible actions
  reason?: string;
  // Classified by the mod's ss_failure_reasons from the raw reason (e.g. 'target_left',
  // 'object_broken', 'mixer_timeout'); recovery_action is the whitelist verb that clears it
  cause?: string;
  recovery_action?: string;
  location_id?: number;
};
