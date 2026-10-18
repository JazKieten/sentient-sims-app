import { LogMessage } from './LogMessage';

export type ModLogWebsocketMessage = {
  log?: LogMessage;
  // V-1: game clock speed changes (see ss_clock.broadcast_clock_state)
  clock_state?: ClockState;
  // The game ending a conversation the app is airing (see scene/ss_scene_watch.py):
  // the sims in it walked apart, or one of them left the lot.
  scene_control?: SceneControl;
  // Which build just connected, sent once per websocket open (ss_version_service.announce_mod_info)
  mod_info?: ModInfo;
  // The overlay heard a bound voice chord go down or up (overlay/overlay_voice_hotkey.py)
  voice_key?: VoiceKeyEvent;
  // Plum, Claude in the game (plum/ss_plum_listener.py -> PlumService)
  plum?: PlumModMessage;
};

// One tool as the mod's registry describes it (plum/ss_plum_tools.py catalogue())
export type PlumModToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  risk: 'read' | 'write' | 'destructive';
  timeout_ms: number;
  tier: string;
};

// Sent on every websocket open: what this build of the mod lets Plum do
export type PlumModCatalogue = {
  kind: 'catalogue';
  tier?: string;
  enabled?: boolean;
  tools?: PlumModToolDef[];
};

// The player's line from the Plum tab
export type PlumModSay = {
  kind: 'say';
  text: string;
  thread_id?: string;
};

// The answer to a plum_tool_call, same request_id
export type PlumModToolResult = {
  kind: 'tool_result';
  request_id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  elapsed_ms?: number;
};

export type PlumModControl = {
  kind: 'control';
  // open | new_thread | start_director | stop_director
  action: string;
  brief?: string;
};

// An interaction Plum started (click_pie_menu, push_action) left the Sim's queue and si_state
// (plum/ss_plum_watch.py): the exact end a wake-up trigger waits for
export type PlumModInteractionEnded = {
  kind: 'interaction_ended';
  interaction_id: string;
  sim_id: string;
  sim_name?: string;
  name: string;
  outcome: 'finished' | 'canceled';
  source?: string;
};

export type PlumModMessage =
  | PlumModCatalogue
  | PlumModSay
  | PlumModToolResult
  | PlumModControl
  | PlumModInteractionEnded;

export type VoiceKeyEvent = {
  // 'talk' = speak to the sim; 'command' (V-8) = an order
  id: 'talk' | 'command';
  down: boolean;
};

export type ModInfo = {
  // 'core' | 'stream' for a packaged build, 'dev' for the loose tree (ss_tier.mod_tier)
  tier: string;
  mod_version: string;
  required_app_version: string;
};

export type SceneControl = {
  // 'stop' ends the named scene; 'stop_all' ends everything (the lot is going away)
  action: 'stop' | 'stop_all';
  // 'soft' lets the line already playing finish; 'hard' cuts it off now
  mode: 'soft' | 'hard';
  scene_id?: string;
  reason: 'walked_away' | 'left_lot' | 'zone_unload' | 'cheat';
  // Who ended it, and how far away they had got
  sim_id?: string | null;
  distance_m?: number | null;
};

export type ClockState = {
  speed: string;
  paused: boolean;
  // 'user' = the player (or the game) paused; 'mod' = a pause the mod itself pushed
  // (pause_on_generation, voice hold, error dialog) which must never gate playback
  paused_by?: 'user' | 'mod' | null;
};
