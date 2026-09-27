// Twitch !ask integration: viewer chat questions ride the player-voice pipeline (STREAM tier, release 4.5;
// the two defaults the settings schema needs stay in constants.ts)
export const twitchIrcUrl = 'wss://irc-ws.chat.twitch.tv:443';
export const twitchOAuthDeviceUrl = 'https://id.twitch.tv/oauth2/device';
export const twitchOAuthTokenUrl = 'https://id.twitch.tv/oauth2/token';
export const twitchHelixUrl = 'https://api.twitch.tv/helix';
export const twitchQuestionMaxLength = 200;
// Deep on purpose: no ask is ever dropped for a busy queue short of a genuine chat flood
export const twitchAskQueueCap = 25;
// Backstop only: completion is the app-side generation promise; this releases the queue
// if a generation hangs past the mod's own 80s abandon window
export const twitchAnswerFallbackMs = 60000;
// Breather after an answer completes so its subtitle/TTS starts before the next question
export const twitchAnswerSettleMs = 1000;
// Reconnect backoff cap; base is 1s doubling per attempt, with jitter
export const twitchReconnectMaxMs = 60000;
// Twitch pings roughly every 5 minutes; a socket silent longer than this is half-open
// (sleep/wake) and gets torn down and reconnected
export const twitchIdleTimeoutMs = 360000;
// While the mod is disconnected the queue holds and re-checks on this cadence
export const twitchModRetryMs = 5000;
export const twitchFollowerCacheTtlMs = 600000;
