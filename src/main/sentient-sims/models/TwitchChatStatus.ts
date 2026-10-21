export type TwitchChatState = 'disabled' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export type TwitchAuthStatus = {
  loggedIn: boolean;
  // Twitch login name of the connected (broadcaster) account
  login?: string;
  // The login granted the poll scope (Plum's native polls)
  pollsAllowed?: boolean;
};

// Pushed to the renderer over 'twitch-status' whenever anything changes; the settings
// panel renders the chip + last-event line straight from this.
export type TwitchChatStatus = {
  state: TwitchChatState;
  channel: string;
  queueDepth: number;
  // Human-readable "why did nothing play" line: accepted/dropped/waiting reasons
  lastEvent?: string;
  auth: TwitchAuthStatus;
};

// Result of starting a device-code login: the person enters userCode at verificationUri
export type TwitchDeviceLoginStart = {
  userCode?: string;
  verificationUri?: string;
  error?: string;
};

// The renderer bridge for the Twitch panel (tiers/ipc.ts): the stream tier's channels, gone
// with this file from the core build
declare module '../tiers/ipc' {
  interface TierInvokeChannels {
    'twitch-status-get': { args: []; result: TwitchChatStatus };
    'twitch-login-start': { args: []; result: TwitchDeviceLoginStart };
    'twitch-logout': { args: []; result: TwitchAuthStatus };
  }
  interface TierEventChannels {
    // Pushed whenever anything changes; the panel renders the chip + last-event line
    'twitch-status': TwitchChatStatus;
  }
}

// Core since release 4.5 (the settings schema stores it in every build)
export type { TwitchStoredAuth } from './TwitchStoredAuth';
