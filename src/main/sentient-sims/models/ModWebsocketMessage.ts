import { MemoryEntity } from '../db/entities/MemoryEntity';

export enum ModWebsocketMessageType {
  NOTIFICATION = 'notification',
  CLEAR_SIM_CACHE = 'clear_sim_cache',
  MIGRATE_SINGLE_SLOT_SAVE = 'migrate_single_slot_save',
  MEMORY_DELETED = 'memory_deleted',
  MEMORY_EDITED = 'memory_edited',
  MEMORY_CREATED = 'memory_created',
  ADD_BUFF = 'add_buff',
  SCENE_LINE = 'scene_line',
  // The line's audio finished playing; the mod stops the speaker's mouth
  SCENE_LINE_ENDED = 'scene_line_ended',
  // More of a streamed line's word times (the first line of a scene starts playing
  // before ElevenLabs has timed all of it); replaces the line's reveal list
  SCENE_LINE_REVEAL_UPDATE = 'scene_line_reveal_update',
  // The whole conversation is over, however it ended. The mod stops watching the
  // sims in it for the walk-away that would have cut it short.
  SCENE_ENDED = 'scene_ended',
  // A conversation thread between the player (voice, chat window, Twitch) and a sim
  // closed on the sim's side; the chat window may show it
  CONVERSATION_CLOSED = 'conversation_closed',
  ENQUEUE_INTERACTION = 'enqueue_interaction',
  // Cancels a previously pushed interaction the app has given up on (cognition's
  // pending timeout) — otherwise a push queued behind a long-running activity outlives
  // the app's interest and runs anyway (three stacked showers observed live)
  CANCEL_INTERACTION = 'cancel_interaction',
  REQUEST_PERCEPTION = 'request_perception',
  // The player's transcribed mic speech; the mod injects it as the active sim's spoken
  // line (same event shape as the Chat panel's new_chat_message)
  PLAYER_VOICE_MESSAGE = 'player_voice_message',
  // Recording lifecycle so the game can show "Listening…" / mic errors while the app
  // is unfocused behind the game window
  PLAYER_VOICE_STATUS = 'player_voice_status',
  // The chords the game overlay should listen for on the app's behalf; sent on every
  // mod connect and voice setting change (VoiceHotkeyService)
  VOICE_HOTKEYS = 'voice_hotkeys',
  // Plum (Claude in the game): run one tool in the mod; the mod answers {plum: {kind: 'tool_result'}}
  PLUM_TOOL_CALL = 'plum_tool_call',
  // Plum: a row, status, history or error for the Plum tab (overlay/overlay_plum.py)
  PLUM_EVENT = 'plum_event',
  // Cognition asks the mod before a model call (interactions/ss_cognition_query.py, autonomy
  // tier): the moment predicate, or the pie-menu vocabulary. The mod answers
  // {cognition: {kind: 'query_result', request_id, ...}}
  COGNITION_QUERY = 'cognition_query',
}

export type ModWebsocketMessage = {
  type: ModWebsocketMessageType;
};

export enum ModWebsocketNotificationType {
  ERROR = 'error',
  MESSAGE = 'message',
}

export type ModWebsocketNotification = ModWebsocketMessage & {
  notification: {
    title: string;
    message: string;
    message_type: ModWebsocketNotificationType;
  };
};

// Memory ids are 64-bit game handles, sent as strings so JSON number parsing can't round them
export type ModWebsocketNotificationMemoryDeleted = ModWebsocketMessage & {
  memory_id: string;
};

export type ModWebsocketNotificationMemoryEdited = ModWebsocketMessage & {
  memory: MemoryEntity;
};

// paced means the app will stream the memory's dialogue lines one at a time as
// SCENE_LINE messages timed to voice playback, so the mod should not display the
// whole memory as one subtitle block
export type ModWebsocketNotificationMemoryCreated = ModWebsocketMessage & {
  memory: MemoryEntity;
  paced: boolean;
};

// When each word of a line is spoken, so the mod can reveal the subtitle in time with
// the voice (mod: overlay/subtitle_reveal.py). Omitted when the line has no timing.
export type ModSceneLineReveal = {
  // Start of each whitespace-delimited word of `text`, ms after started_at_ms; one per
  // word (a prefix while partial), never decreasing
  word_ms: number[];
  // Wall clock (epoch ms) when playback started; the app and the game share a machine
  started_at_ms: number;
  // The audio rate at start (the game-speed table, playbackClock.ts)
  rate: number;
  // The app's playback follows the game clock: the mod freezes the reveal under the
  // player's pause and follows the speed; false = the audio runs regardless
  follows_clock: boolean;
  // More word times follow in a scene_line_reveal_update
  partial: boolean;
  source: 'elevenlabs' | 'estimate';
};

export type ModSceneLine = ModWebsocketMessage & {
  speaker: string;
  text: string;
  reveal?: ModSceneLineReveal;
  // The scene's driving action, shown above each line's subtitle section in-game
  preamble?: string;
  // false when no audio plays for the line; omitted means voiced (older senders)
  voiced?: boolean;
  // Which conversation this line belongs to, and who is in it. The mod follows the
  // participants and ends the scene when they stop being together (walked into
  // another room, left the lot). Sim ids are strings: they are 64-bit game handles.
  // Absent on solo lines and from older app versions, which are simply not watched.
  scene_id?: string;
  speaker_sim_id?: string;
  // More of the same line follows after a breath (a long reply aired in chunks)
  continues?: boolean;
  participant_sim_ids?: string[];
};

export type ModSceneLineEnded = ModWebsocketMessage & {
  speaker: string;
  scene_id?: string;
  // More of the same line follows (a long reply aired in chunks): the mouth stays open
  continues?: boolean;
};

export type ModSceneLineRevealUpdate = ModWebsocketMessage & {
  speaker: string;
  // The line's text as the scene_line carried it: the mod matches on it
  text: string;
  scene_id?: string;
  reveal: Pick<ModSceneLineReveal, 'word_ms' | 'partial'>;
};

export type ModConversationClosed = ModWebsocketMessage & {
  sim_ids: string[];
  sim_names: string[];
  speaker: string;
  reason: string;
};

export type SceneEndedReason = 'finished' | 'stopped' | 'dropped';

export type ModSceneEnded = ModWebsocketMessage & {
  scene_id: string;
  reason: SceneEndedReason;
};

// A Sentient Moodlet for one sim. `mood` is one of the mod's 15 emotions;
// `intensity` picks the buff tier (+1/+2/+3, absent = 1); `duration_minutes` is
// written onto the buff's timer (absent = the tuning's 240). The scene appraisal
// sends these when a conversation closes; the chat window's older path sends the
// bare three fields.
export type ModAddBuff = ModWebsocketMessage & {
  sim_id: string;
  mood: string;
  buff_description: string;
  intensity?: 1 | 2 | 3;
  duration_minutes?: number;
  scene_id?: string;
  source?: 'scene' | 'chat';
};

// A pie-menu row the options stage offered (the mod's cognition vocabulary), sent back on the
// push so the mod clicks that item instead of resolving a whitelist verb
// (interactions/ss_cognition_click.py). `item` is the row's tuning key, `option` the label
// chosen from a collapsed row's options (stereo channels, snacks). Core-owned: the push message
// carries it in every build; only the autonomy tier ever fills it.
export type PieIntent = {
  target_id?: string;
  // 'find' (autonomy part 5): an intention row with no target of its own; the mod resolves a Sim
  // id in target_id or the nearest object providing one of the candidates; 'kind' (renovation
  // R3): target_id is an object kind, the nearest such object (a story row's click)
  target_kind: 'self' | 'sim' | 'object' | 'inventory' | 'phone' | 'find' | 'kind';
  item: string;
  label?: string;
  option?: string;
  // Tuning names tried in order on the built menu; the first runnable one is clicked
  candidates?: string[];
};

// Pushes a whitelisted action into a sim's interaction queue. The mod resolves the action key
// via its affordance whitelist (ss_affordance_whitelist.py) and reports what happened back to
// POST /cognition/outcome with the same request_id.
export type ModEnqueueInteraction = ModWebsocketMessage & {
  request_id: string;
  sim_id: string;
  action: string;
  target_sim_id?: string;
  target_object_id?: string;
  priority?: 'high' | 'low' | 'critical';
  insert_strategy?: 'next' | 'last';
  clear_queue?: boolean;
  // Cancel the sim's queued AND running interactions before pushing (an accepted
  // player ask replaces the current plan; the mod spares hidden system SIs)
  preempt?: boolean;
  // go_out/travel_to_zone: destination zone (string — the ids are 64-bit); the mod
  // validates it against its venue directory and falls back to its own picker
  zone_id?: string;
  source: string;
  // A pie-menu click instead of a whitelist verb (autonomy part 2, 2026-10-21)
  pie?: PieIntent;
  // The intention row this push fires (autonomy part 5); rides the outcome body for the log
  row_id?: string;
};

// Asks the mod for one sim's perception snapshot; the mod replies by POSTing the
// snapshot to /cognition/perception with the same request_id
export type ModRequestPerception = ModWebsocketMessage & {
  request_id: string;
  sim_id: string;
};

// Cancels the pushed interaction registered under request_id (firewalled mod-side to
// the mod's own push registry — never touches player-queued interactions)
export type ModCancelInteraction = ModWebsocketMessage & {
  request_id: string;
};

export type ModPlayerVoiceMessage = ModWebsocketMessage & {
  text: string;
};

export type ModPlayerVoiceStatus = ModWebsocketMessage & {
  status: 'listening' | 'transcribing' | 'cancelled' | 'error';
  detail?: string;
  // V-3: the persona label the player speaks as (byte-identical to the reply's speaker)
  speaker?: string;
  // V-8: 'command' = the utterance is an order the sim will act on, not talk
  mode?: 'chat' | 'command';
};

// Chord strings as the settings spell them ("Ctrl+Space", "F13"); '' clears a binding
export type ModVoiceHotkeys = ModWebsocketMessage & {
  talk: string;
  command: string;
};

export type ModPlumToolCall = ModWebsocketMessage & {
  request_id: string;
  name: string;
  args: Record<string, unknown>;
  timeout_ms: number;
};

// kind: assistant | player | tool_call_started | tool_call_finished | director | status | whisper | reply |
// history | error; the rest of the fields depend on the kind (PlumService emits them)
export type ModPlumEvent = ModWebsocketMessage & {
  kind: string;
  [field: string]: unknown;
};

// One question for the mod's cognition query listener; args depend on the kind
// ('moment': {sim_id, target_sim_id?, lane}; 'vocabulary': {sim_id, target_sim_id?})
export type ModCognitionQuery = ModWebsocketMessage & {
  request_id: string;
  kind: string;
  args: Record<string, unknown>;
  timeout_ms: number;
};

export type WebsocketNotification =
  | ModWebsocketMessage
  | ModCognitionQuery
  | ModPlumToolCall
  | ModPlumEvent
  | ModVoiceHotkeys
  | ModWebsocketNotification
  | ModWebsocketNotificationMemoryEdited
  | ModWebsocketNotificationMemoryDeleted
  | ModWebsocketNotificationMemoryCreated
  | ModAddBuff
  | ModSceneLine
  | ModSceneLineEnded
  | ModSceneLineRevealUpdate
  | ModSceneEnded
  | ModConversationClosed
  | ModEnqueueInteraction
  | ModRequestPerception
  | ModCancelInteraction
  | ModPlayerVoiceMessage
  | ModPlayerVoiceStatus;
