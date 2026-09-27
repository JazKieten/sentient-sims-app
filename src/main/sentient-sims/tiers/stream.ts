// The STREAM tier's entry module (release 4.5): Twitch !ask, the moodlet a closed scene
// leaves (SceneMoodletService), the game ending a conversation when its sims walk apart
// (scene_control), and the AI exchange log persisted in the save (decision 16). Listed in
// tiers.json, so the core build deletes it and the generated index.ts never names it.
import type { Express, Request, Response } from 'express';
import type { IpcMain } from 'electron';
import log from 'electron-log';
import type { ApiContext } from '../services/ApiContext';
import type { TierRegistration } from './types';
import { handleTierInvoke } from './ipc';
import { TwitchAuthService } from '../services/TwitchAuthService';
import { TwitchChatService } from '../services/TwitchChatService';
import { SceneMoodletService } from '../services/SceneMoodletService';
import { AIExchangeRepository } from '../db/AIExchangeRepository';
import type { SceneControl } from '../models/ModLogWebsocketMessage';

export interface StreamServices {
  twitchAuth: TwitchAuthService;
  twitchChat: TwitchChatService;
  sceneMoodlets: SceneMoodletService;
  aiExchangeRepository: AIExchangeRepository;
}

const services = new WeakMap<ApiContext, StreamServices>();

export function streamOf(ctx: ApiContext): StreamServices {
  const found = services.get(ctx);
  if (!found) {
    throw new Error('the stream tier is not registered on this context');
  }
  return found;
}

function construct(ctx: ApiContext) {
  const twitchAuth = new TwitchAuthService(ctx);
  const stream: StreamServices = {
    twitchAuth,
    // Built here, connected only by start() (the main process): tests build contexts too
    twitchChat: new TwitchChatService(ctx, twitchAuth),
    sceneMoodlets: new SceneMoodletService(ctx),
    aiExchangeRepository: new AIExchangeRepository(ctx.db),
  };
  services.set(ctx, stream);
  // F4: the exchange log persists in the loaded save (the dev tier reads it back)
  ctx.aiExchangeLog.attachPersistence(stream.aiExchangeRepository);
}

// E2E test for the Twitch !ask pipeline without a live stream: injects a fake chat
// message through the exact same path as a real PRIVMSG.
// curl -X POST /debug/twitch-message -d '{"user":"viewer1","message":"!ask ..."}'
function injectTwitchMessage(ctx: ApiContext) {
  return (req: Request, res: Response) => {
    const { user, message, mod, subscriber, userId } = req.body as {
      user?: string;
      message?: string;
      mod?: boolean;
      subscriber?: boolean;
      userId?: string;
    };
    if (!message) {
      res.status(400).json({ error: 'Must include message in request body' });
      return;
    }
    const { twitchChat } = streamOf(ctx);
    twitchChat.handleDebugMessage(user ?? 'debugviewer', message, { mod, subscriber, userId });
    res.json(twitchChat.getStatus());
  };
}

function routes(app: Express, ctx: ApiContext) {
  app.post('/debug/twitch-message', injectTwitchMessage(ctx));
}

function ipc(ipcMain: IpcMain, ctx: ApiContext) {
  const { twitchAuth, twitchChat } = streamOf(ctx);
  // Twitch !ask: settings panel status seed + account login (device code flow)
  handleTierInvoke(ipcMain, 'twitch-status-get', () => twitchChat.getStatus());
  handleTierInvoke(ipcMain, 'twitch-login-start', () => twitchAuth.startDeviceLogin());
  handleTierInvoke(ipcMain, 'twitch-logout', () => {
    twitchAuth.logout();
    return twitchAuth.getStatus();
  });
}

// The game ending a conversation the app is airing: the sims in it walked apart, or one of
// them left the lot. See the mod's scene/ss_scene_watch.py.
function onSceneControl(ctx: ApiContext, control: SceneControl) {
  const where = control.distance_m != null ? ` at ${control.distance_m}m` : '';
  log.info(`[Scene] the game ended ${control.scene_id ?? 'every scene'} (${control.mode}): ${control.reason}${where}`);
  if (control.action === 'stop_all') {
    ctx.scenePlayback.stopAll(control.reason);
  } else if (control.scene_id) {
    ctx.scenePlayback.stop(control.scene_id, control.reason, control.mode);
  }
}

export const streamTier: TierRegistration = {
  name: 'stream',
  construct,
  routes,
  ipc,
  start: (ctx) => {
    streamOf(ctx).twitchChat.initialize();
  },
  onSettingChanged: (ctx, key) => {
    streamOf(ctx).twitchChat.onSettingChanged(key);
  },
  onSceneClosed: (ctx, closed) => {
    // A conversation that closed is weighed for the moodlet it leaves on each sim
    void streamOf(ctx).sceneMoodlets.appraise(closed);
  },
  onModMessage: (ctx, message) => {
    if (!message.scene_control) {
      return false;
    }
    onSceneControl(ctx, message.scene_control);
    return true;
  },
  shutdown: (ctx) => {
    streamOf(ctx).twitchChat.shutdown();
  },
};
