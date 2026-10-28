import log from 'electron-log';
import { DecodeToken, isTokenExpired } from './tokenVerifier';
import { notifyRefreshAuth } from '../util/notifyRenderer';

const tokenRefreshWaitMs = 10000;
const tokenRefreshPollMs = 250;

// After a refresh request goes unanswered (user logged out, renderer gone), don't stall
// every subsequent request on another doomed wait
const tokenRefreshRetryCooldownMs = 60000;

let lastFailedRefreshAt = 0;

type TokenSettings = { accessToken: string };

// Undecodable tokens (empty, or a CustomAI server's non-JWT key) are left alone;
// only a real JWT can be expired and renewed
export function tokenIsExpired(token: string): boolean {
  try {
    return isTokenExpired(DecodeToken(token));
  } catch {
    return false;
  }
}

export function hasDecodableToken(token: string): boolean {
  try {
    DecodeToken(token);
    return true;
  } catch {
    return false;
  }
}

// The renderer owns the Cognito session, so an expired token can only be renewed by
// asking it to refresh and waiting for the new token to land in settings. The renderer
// only refreshes on a 15 minute timer otherwise, and a token can expire between ticks.
// `rejectedToken` is one the server refused while it still decodes as valid (revoked):
// the wait ends as soon as settings hold any other token.
export async function waitForFreshToken(settings: TokenSettings, rejectedToken?: string): Promise<void> {
  const staleToken = rejectedToken ?? settings.accessToken;
  const isFresh = () =>
    rejectedToken !== undefined ? settings.accessToken !== staleToken : !tokenIsExpired(settings.accessToken);
  if (isFresh()) {
    return;
  }
  if (Date.now() - lastFailedRefreshAt < tokenRefreshRetryCooldownMs) {
    return;
  }

  log.info('Sentient Sims AI access token is expired, asking the renderer to refresh it');
  notifyRefreshAuth();

  const waitUntil = Date.now() + tokenRefreshWaitMs;
  while (Date.now() < waitUntil) {
    await new Promise((resolve) => {
      setTimeout(resolve, tokenRefreshPollMs);
    });
    if (isFresh() || settings.accessToken !== staleToken) {
      lastFailedRefreshAt = 0;
      return;
    }
  }
  lastFailedRefreshAt = Date.now();
  log.error('Access token is still expired after waiting for a refresh');
}
