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

export type ModWebsocketNotificationMemoryDeleted = ModWebsocketMessage & {
  memory_id: number;
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

export type ModSceneLine = ModWebsocketMessage & {
  speaker: string;
  text: string;
  // The scene's driving action, shown above each line's subtitle section in-game
  preamble?: string;
};

export type ModAddBuff = ModWebsocketMessage & {
  sim_id: string;
  mood: string;
  buff_description: string;
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
  source: string;
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
  status: 'listening' | 'transcribing' | 'error';
  detail?: string;
  // V-3: the persona label the player speaks as (byte-identical to the reply's speaker)
  speaker?: string;
  // V-8: 'command' = the utterance is an order the sim will act on, not talk
  mode?: 'chat' | 'command';
};

export type WebsocketNotification =
  | ModWebsocketMessage
  | ModWebsocketNotification
  | ModWebsocketNotificationMemoryEdited
  | ModWebsocketNotificationMemoryDeleted
  | ModWebsocketNotificationMemoryCreated
  | ModAddBuff
  | ModSceneLine
  | ModEnqueueInteraction
  | ModRequestPerception
  | ModCancelInteraction
  | ModPlayerVoiceMessage
  | ModPlayerVoiceStatus;
