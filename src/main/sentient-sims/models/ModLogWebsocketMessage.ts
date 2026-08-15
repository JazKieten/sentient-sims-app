import { LogMessage } from './LogMessage';

export type ModLogWebsocketMessage = {
  log?: LogMessage;
  // V-1: game clock speed changes (see ss_clock.broadcast_clock_state)
  clock_state?: ClockState;
};

export type ClockState = {
  speed: string;
  paused: boolean;
  // 'user' = the player (or the game) paused; 'mod' = a pause the mod itself pushed
  // (pause_on_generation, voice hold, error dialog) which must never gate playback
  paused_by?: 'user' | 'mod' | null;
};
