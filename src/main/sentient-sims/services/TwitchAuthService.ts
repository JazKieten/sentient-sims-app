import log from 'electron-log';
import {
  twitchFollowerCacheTtlMs,
  twitchHelixUrl,
  twitchOAuthDeviceUrl,
  twitchOAuthTokenUrl,
} from '../util/twitchConstants';
import { TwitchAuthStatus, TwitchDeviceLoginStart } from '../models/TwitchChatStatus';
import { TwitchStoredAuth } from '../models/TwitchStoredAuth';
import { ApiContext } from './ApiContext';

// OAuth Device Code Grant against the streamer's own Twitch application (public client, no
// secret): the app shows a code, the streamer enters it at twitch.tv/activate once, and the
// stored token lets the follower gate ask "does this viewer follow me?" per !ask.
const twitchScopes = 'moderator:read:followers';

type DeviceCodeResponse = {
  device_code?: string;
  expires_in?: number;
  interval?: number;
  user_code?: string;
  verification_uri?: string;
  message?: string;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  message?: string;
};

export class TwitchAuthService {
  private readonly ctx: ApiContext;

  private pollTimer?: NodeJS.Timeout;

  private readonly followerCache = new Map<string, { isFollower: boolean; checkedAt: number }>();

  // The chat service subscribes so login/logout pushes a fresh status to the renderer
  onChanged?: () => void;

  constructor(ctx: ApiContext) {
    this.ctx = ctx;
  }

  shutdown() {
    this.stopPolling();
  }

  getStatus(): TwitchAuthStatus {
    const stored = this.ctx.settings.twitchAuth;
    return { loggedIn: Boolean(stored.accessToken && stored.broadcasterId), login: stored.login };
  }

  logout() {
    this.stopPolling();
    this.followerCache.clear();
    this.setStored({});
    log.info('Twitch account disconnected');
  }

  async startDeviceLogin(): Promise<TwitchDeviceLoginStart> {
    const clientId = this.ctx.settings.twitchClientId;
    if (!clientId) {
      return { error: 'Enter your Twitch application Client ID first' };
    }
    this.stopPolling();
    try {
      const response = await fetch(twitchOAuthDeviceUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, scopes: twitchScopes }).toString(),
      });
      const data = (await response.json()) as DeviceCodeResponse;
      if (!response.ok || !data.device_code) {
        return { error: data.message ?? `Twitch device login failed (${response.status})` };
      }
      this.pollForToken(
        clientId,
        data.device_code,
        Math.max(1, data.interval ?? 5) * 1000,
        Date.now() + (data.expires_in ?? 1800) * 1000,
      );
      return { userCode: data.user_code, verificationUri: data.verification_uri };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Could not reach Twitch: ${message}` };
    }
  }

  // undefined = cannot determine (not logged in, tags missing upstream, API failure);
  // the follower gate fails closed on it with a visible reason.
  async isFollower(viewerUserId: string): Promise<boolean | undefined> {
    const cached = this.followerCache.get(viewerUserId);
    if (cached && Date.now() - cached.checkedAt < twitchFollowerCacheTtlMs) {
      return cached.isFollower;
    }
    const clientId = this.ctx.settings.twitchClientId;
    const { accessToken, broadcasterId } = this.ctx.settings.twitchAuth;
    if (!clientId || !accessToken || !broadcasterId) {
      return undefined;
    }
    let result = await this.queryFollower(clientId, accessToken, broadcasterId, viewerUserId);
    if (result === 'unauthorized') {
      const refreshedToken = await this.refresh(clientId);
      if (!refreshedToken) {
        return undefined;
      }
      result = await this.queryFollower(clientId, refreshedToken, broadcasterId, viewerUserId);
    }
    if (result === 'unauthorized' || result === undefined) {
      return undefined;
    }
    this.cacheFollower(viewerUserId, result);
    return result;
  }

  private setStored(auth: TwitchStoredAuth) {
    this.ctx.settings.twitchAuth = auth;
    this.onChanged?.();
  }

  private stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private pollForToken(clientId: string, deviceCode: string, intervalMs: number, expiresAt: number) {
    this.pollTimer = setInterval(() => {
      void (async () => {
        if (Date.now() > expiresAt) {
          this.stopPolling();
          log.info('Twitch device login expired before the code was entered');
          this.onChanged?.();
          return;
        }
        try {
          const response = await fetch(twitchOAuthTokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: clientId,
              scopes: twitchScopes,
              device_code: deviceCode,
              grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            }).toString(),
          });
          const data = (await response.json()) as TokenResponse;
          if (response.ok && data.access_token) {
            this.stopPolling();
            await this.completeLogin(clientId, data.access_token, data.refresh_token);
            return;
          }
          // 400 authorization_pending just means the code has not been entered yet
          if (data.message && data.message !== 'authorization_pending') {
            this.stopPolling();
            log.warn(`Twitch device login stopped: ${data.message}`);
            this.onChanged?.();
          }
        } catch (err) {
          log.error('Twitch device login poll failed', err);
        }
      })();
    }, intervalMs);
  }

  private async completeLogin(clientId: string, accessToken: string, refreshToken?: string) {
    try {
      const response = await fetch(`${twitchHelixUrl}/users`, {
        headers: TwitchAuthService.helixHeaders(clientId, accessToken),
      });
      const data = (await response.json()) as { data?: { id?: string; login?: string }[] };
      const user = data.data?.[0];
      if (!user?.id) {
        log.error('Twitch login: could not resolve the connected account');
        this.onChanged?.();
        return;
      }
      this.setStored({ accessToken, refreshToken, broadcasterId: user.id, login: user.login });
      log.info(`Twitch account connected: ${user.login ?? user.id}`);
    } catch (err) {
      log.error('Twitch login completion failed', err);
      this.onChanged?.();
    }
  }

  private cacheFollower(viewerUserId: string, isFollower: boolean) {
    if (this.followerCache.size > 500) {
      this.followerCache.clear();
    }
    this.followerCache.set(viewerUserId, { isFollower, checkedAt: Date.now() });
  }

  private async queryFollower(
    clientId: string,
    accessToken: string,
    broadcasterId: string,
    viewerUserId: string,
  ): Promise<boolean | 'unauthorized' | undefined> {
    try {
      const params = new URLSearchParams({ broadcaster_id: broadcasterId, user_id: viewerUserId });
      const response = await fetch(`${twitchHelixUrl}/channels/followers?${params.toString()}`, {
        headers: TwitchAuthService.helixHeaders(clientId, accessToken),
      });
      if (response.status === 401) {
        return 'unauthorized';
      }
      if (!response.ok) {
        log.warn(`Twitch follower check failed (${response.status})`);
        return undefined;
      }
      const data = (await response.json()) as { data?: unknown[] };
      return (data.data?.length ?? 0) > 0;
    } catch (err) {
      log.error('Twitch follower check failed', err);
      return undefined;
    }
  }

  private async refresh(clientId: string): Promise<string | undefined> {
    const stored = this.ctx.settings.twitchAuth;
    if (!stored.refreshToken) {
      log.warn('Twitch token expired with no refresh token; disconnecting the account');
      this.logout();
      return undefined;
    }
    try {
      const response = await fetch(twitchOAuthTokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          grant_type: 'refresh_token',
          refresh_token: stored.refreshToken,
        }).toString(),
      });
      const data = (await response.json()) as TokenResponse;
      if (!response.ok || !data.access_token) {
        log.warn('Twitch token refresh failed; disconnecting the account');
        this.logout();
        return undefined;
      }
      this.setStored({
        ...stored,
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? stored.refreshToken,
      });
      return data.access_token;
    } catch (err) {
      log.error('Twitch token refresh failed', err);
      return undefined;
    }
  }

  private static helixHeaders(clientId: string, accessToken: string): Record<string, string> {
    return { 'Authorization': `Bearer ${accessToken}`, 'Client-Id': clientId };
  }
}
