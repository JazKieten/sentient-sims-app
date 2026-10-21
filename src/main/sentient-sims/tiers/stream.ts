// The STREAM tier's entry module (release 4.5): Twitch !ask, Plum's chat polls
// (ChatPollService, and their OBS overlay at /overlay/poll), the moodlet a closed scene leaves (SceneMoodletService), the game ending
// a conversation when its sims walk apart (scene_control), and the AI exchange log persisted
// in the save (decision 16). Listed in
// tiers.json, so the core build deletes it and the generated index.ts never names it.
import type { Express, Request, Response } from 'express';
import type { IpcMain } from 'electron';
import log from 'electron-log';
import type { ApiContext } from '../services/ApiContext';
import type { TierRegistration } from './types';
import { handleTierInvoke } from './ipc';
import { TwitchAuthService } from '../services/TwitchAuthService';
import { TwitchChatService } from '../services/TwitchChatService';
import { ChatPollService } from '../services/ChatPollService';
import { POLL_OVERLAY_HTML } from '../util/pollOverlayPage';
import { SceneMoodletService } from '../services/SceneMoodletService';
import { AIExchangeRepository } from '../db/AIExchangeRepository';
import type { SceneControl } from '../models/ModLogWebsocketMessage';

export interface StreamServices {
  twitchAuth: TwitchAuthService;
  twitchChat: TwitchChatService;
  chatPoll: ChatPollService;
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
  // Built here, connected only by start() (the main process): tests build contexts too
  const twitchChat = new TwitchChatService(ctx, twitchAuth);
  const stream: StreamServices = {
    twitchAuth,
    twitchChat,
    chatPoll: new ChatPollService(ctx, twitchChat, twitchAuth),
    sceneMoodlets: new SceneMoodletService(ctx),
    aiExchangeRepository: new AIExchangeRepository(ctx.db),
  };
  services.set(ctx, stream);
  ctx.ext.chatPoll = stream.chatPoll;
  // F4: the exchange log persists in the loaded save (the dev tier reads it back)
  ctx.aiExchangeLog.attachPersistence(stream.aiExchangeRepository);
}

// E2E test for the Twitch !ask pipeline without a live stream: injects a fake chat
// message through the exact same path as a real PRIVMSG.
// curl -X POST /debug/twitch-message -d '{"user":"viewer1","message":"!say ..."}'
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

// A chat poll without Plum (the result still wakes Plum): open, read or cancel it.
// curl -X POST /debug/twitch-poll -d '{"question":"...","options":["A","B"],"seconds":30}'
function debugPoll(ctx: ApiContext) {
  return async (req: Request, res: Response) => {
    const { chatPoll } = streamOf(ctx);
    const body = req.body as {
      question?: string;
      options?: string[];
      seconds?: number;
      note?: string;
      cancel?: boolean;
    };
    try {
      if (body.cancel) {
        res.json({ cancelled: await chatPoll.cancel() });
        return;
      }
      if (body.question && Array.isArray(body.options)) {
        const opened = await chatPoll.open({
          question: body.question,
          options: body.options,
          seconds: body.seconds ?? 0,
          note: body.note ?? '',
        });
        res.json({ opened, current: chatPoll.current() });
        return;
      }
      res.json({ current: chatPoll.current() ?? null });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  };
}

function routes(app: Express, ctx: ApiContext) {
  app.post('/debug/twitch-message', injectTwitchMessage(ctx));
  app.post('/debug/twitch-poll', debugPoll(ctx));

  // The OBS Browser Source for Plum's polls, and the state it reads twice a second
  app.get('/overlay/poll', (_req: Request, res: Response) => {
    res.type('html').send(POLL_OVERLAY_HTML);
  });
  app.get('/overlay/poll/state', (_req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store').json(streamOf(ctx).chatPoll.overlay());
  });
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
  shutdown: (ctx) => {
    streamOf(ctx).chatPoll.shutdown();
    streamOf(ctx).twitchChat.shutdown();
  },
};
