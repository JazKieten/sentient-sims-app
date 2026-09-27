/* eslint-disable promise/always-return */
// DEV tier (release 4.5): the 25146 websocket the dev log viewer (renderer LogViewerPage)
// reads the mod's log stream from. Extracted from websocketServer.ts; a player build opens
// no such port. Started by the dev tier's start().
import { WebSocketServer, WebSocket } from 'ws';
import log from 'electron-log';
import { rawDataToString } from './util/modWebsocketMessage';
import { RendererWebsocketMessage } from './models/RendererWebsocketMessage';
import { rendererWebsocketPort } from './constants';
import { ApiContext } from './services/ApiContext';
import { onModLog, reportRendererSocket } from './websocketServer';

let rendererWs: WebSocket | undefined;

export function startRendererLogSocket(ctx: ApiContext) {
  // Loopback only: the renderer is on this machine, nothing else should reach it
  const rendererServer = new WebSocketServer({ host: '127.0.0.1', port: rendererWebsocketPort });
  // A failed bind emits 'error'; unhandled it would crash the main process.
  rendererServer.on('error', (err) => {
    log.error(`Renderer websocket server error on port ${rendererWebsocketPort}`, err);
  });
  rendererServer.on('connection', function handleRenderer(ws: WebSocket) {
    rendererWs = ws;
    reportRendererSocket(true);
    ws.on('close', () => {
      // A replaced socket closing late must not mark the live one disconnected
      if (rendererWs !== ws) {
        return;
      }
      rendererWs = undefined;
      reportRendererSocket(false);
    });

    ws.on('error', (err) => {
      log.error(err);
    });

    ws.on('message', function message(data) {
      log.debug(`receivedRenderer: ${rawDataToString(data)}`);
    });

    ctx.logs
      .readLogs()
      .then((logs) => {
        try {
          const logMessage: RendererWebsocketMessage = {
            logs,
          };
          ws.send(JSON.stringify(logMessage));
        } catch (e) {
          log.error('Unable to send logs from logs.txt to renderer', e);
        }
      })
      .catch((err: unknown) => {
        log.error('Unable to read logs from logs.txt', err);
      });
  });

  // Every mod log line the core server accepts is streamed on to the viewer
  onModLog((message) => {
    rendererWs?.send(JSON.stringify(message));
  });
}
