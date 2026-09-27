/* eslint-disable promise/always-return */
import { WebSocketServer, WebSocket } from 'ws';
import log from 'electron-log';
import { notifyClockState } from './util/notifyRenderer';
import { parseModMessage } from './util/modWebsocketMessage';
import { formatLog } from './util/format';
import { mirrorModLog } from './util/modLogMirror';
import { LogLevel } from './models/LogLevel';
import { WebsocketNotification } from './models/ModWebsocketMessage';
import { ModInfo, ModLogWebsocketMessage } from './models/ModLogWebsocketMessage';
import { modWebsocketPort } from './constants';
import { WebsocketStatusChange } from './models/WebsocketStatusResponse';
import { ApiContext } from './services/ApiContext';
import { getAllBrowserWindows } from './util/browserWindows';

function notifyAllWindows(message: string, ...args: unknown[]) {
  getAllBrowserWindows().forEach((wnd) => {
    if (!wnd.webContents.isDestroyed()) {
      wnd.webContents.send(message, ...args);
    }
  });
}

function notifyWebsocketStatus(status: WebsocketStatusChange) {
  log.debug(`Websocket status changed ${status.type} : ${status.status}`);
  notifyAllWindows('websocket-status-change', status);
}

let modWs: WebSocket | undefined;

let modConnected = false;
let rendererConnected = false;
// The dev tier's log viewer socket (rendererLogSocket.ts) reports itself here and listens for
// the mod's log lines; a player build has neither, and the renderer reads as disconnected
const modLogListeners: ((message: ModLogWebsocketMessage) => void)[] = [];

export function onModLog(listener: (message: ModLogWebsocketMessage) => void) {
  modLogListeners.push(listener);
}

export function reportRendererSocket(connected: boolean) {
  rendererConnected = connected;
  notifyWebsocketStatus({
    type: 'renderer',
    status: connected,
  });
}

// The last mod_info the mod sent; kept across a disconnect so a reconnect overwrites it
let lastModInfo: ModInfo | undefined;

export const startWebSocketServer = (ctx: ApiContext) => {
  const modServer = new WebSocketServer({ host: '127.0.0.1', port: modWebsocketPort });
  modServer.on('error', (err) => {
    log.error(`Mod websocket server error on port ${modWebsocketPort}`, err);
  });
  modServer.on('connection', function handleMod(ws: WebSocket) {
    modWs = ws;

    modConnected = true;
    notifyWebsocketStatus({
      type: 'mod',
      status: true,
    });
    ws.on('close', () => {
      // Cleared so sendModNotification stops writing into a closed socket
      if (modWs !== ws) {
        return;
      }
      modWs = undefined;
      modConnected = false;
      notifyWebsocketStatus({
        type: 'mod',
        status: false,
      });
    });

    ws.on('error', (err) => {
      log.error(err);
    });

    ws.on('message', function message(data) {
      const parsedData = parseModMessage(data);
      if (!parsedData) {
        return;
      }

      if (parsedData.clock_state) {
        // V-1: forwarded to the renderer's playback clock; when the feature is off the
        // renderer is told the clock runs normally so nothing ever holds playback
        const state = ctx.settings.playbackFollowsGameClock
          ? parsedData.clock_state
          : { speed: 'NORMAL', paused: false, paused_by: null };
        notifyClockState(state);
        return;
      }

      if (parsedData.mod_info) {
        // Which build connected: a core mod has no stream features, so the UI can hide them
        lastModInfo = parsedData.mod_info;
        log.info(
          `[Mod] connected: tier=${lastModInfo.tier} mod=${lastModInfo.mod_version} ` +
            `requires app ${lastModInfo.required_app_version}`,
        );
        return;
      }

      // Messages a build tier owns (stream: scene_control, the game ending a conversation)
      if (ctx.tiers.some((tier) => tier.onModMessage?.(ctx, parsedData) === true)) {
        return;
      }

      if (!parsedData.log) {
        return;
      }
      if (parsedData.log.level === (LogLevel.DEBUG as string) && !ctx.settings.debugLogs) {
        return;
      }

      // INFO and above also go to main.log, next to the app's own lines (see modLogMirror)
      mirrorModLog(parsedData.log);
      const formattedLog = formatLog(parsedData.log);
      ctx.logs.appendLog([formattedLog]).catch((e: unknown) => {
        log.error('Unable to append to logs.txt', e);
      });
      for (const listener of modLogListeners) {
        try {
          listener(parsedData);
        } catch (err) {
          log.error('Mod log listener failed', err);
        }
      }
    });
  });
};

export function sendModNotification(notification: WebsocketNotification) {
  try {
    if (modWs) {
      modWs.send(JSON.stringify(notification));
    }
  } catch (err) {
    log.error('Unable to send message to mod via websocket', err);
  }
}

export function isWebSocketConnected(type: 'renderer' | 'mod'): boolean {
  if (type === 'renderer') {
    return rendererConnected;
  }

  return modConnected;
}

export function getModInfo(): ModInfo | undefined {
  return lastModInfo;
}
