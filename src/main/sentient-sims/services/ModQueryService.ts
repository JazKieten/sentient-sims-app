// Cognition's question channel to the mod (autonomy tier, 2026-10-21): the moment predicate
// before a model call, and the pie-menu vocabulary for the options prompt. Outside Plum on
// purpose: PlumService.callMod is Plum's and cognition must not depend on Plum being enabled.
//
//   app -> mod   {type: 'cognition_query', request_id, kind, args, timeout_ms}
//   mod -> app   {cognition: {kind: 'query_result', request_id, ok, result|error, elapsed_ms}}
//                {cognition: {kind: 'hold_released', sim_id, interaction_id, ...}}
//
// The mod side is interactions/ss_cognition_query.py. A kind an older mod does not know
// answers `ok: false, error: 'unknown kind <x>'` at once; the caller (CognitionService.gateFor)
// latches fail-open on that text so an old mod costs nothing per lane.
import log from 'electron-log';
import { randomUUID } from 'crypto';
import { ModCognitionQuery, ModWebsocketMessageType, WebsocketNotification } from '../models/ModWebsocketMessage';
import { CognitionGoalCompleted, CognitionHoldReleased, CognitionModMessage } from '../models/ModLogWebsocketMessage';
import { isWebSocketConnected, sendModNotification } from '../websocketServer';

export type ModQueryResult<T> = { ok: true; result: T } | { ok: false; error: string };

type PendingQuery = {
  kind: string;
  resolve: (result: ModQueryResult<unknown>) => void;
  timer: ReturnType<typeof setTimeout>;
  sentAt: number;
};

export const NOT_CONNECTED = 'mod websocket not connected';
export const DISCONNECTED = 'mod websocket closed before the answer';

export class ModQueryService {
  private readonly pending = new Map<string, PendingQuery>();

  private readonly holdListeners: ((event: CognitionHoldReleased) => void)[] = [];

  // The game marked a goal done (autonomy part 5; the mod's ss_goal_events)
  private readonly goalListeners: ((event: CognitionGoalCompleted) => void)[] = [];

  // Seam for tests; production sends over the mod websocket
  sendToMod(message: WebsocketNotification) {
    sendModNotification(message);
  }

  // Seam for tests (production asks the websocket server)
  isModConnected(): boolean {
    return isWebSocketConnected('mod');
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  query<T>(kind: string, args: Record<string, unknown>, timeoutMs: number): Promise<ModQueryResult<T>> {
    if (!this.isModConnected()) {
      return Promise.resolve({ ok: false, error: NOT_CONNECTED });
    }
    const requestId = `cq-${randomUUID()}`;
    const message: ModCognitionQuery = {
      type: ModWebsocketMessageType.COGNITION_QUERY,
      request_id: requestId,
      kind,
      args,
      timeout_ms: timeoutMs,
    };
    return new Promise<ModQueryResult<T>>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(requestId)) {
          log.warn(`[ModQuery] ${kind} ${requestId} timed out after ${timeoutMs}ms`);
          resolve({ ok: false, error: `${kind} query timed out after ${timeoutMs}ms` });
        }
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      this.pending.set(requestId, {
        kind,
        timer,
        sentAt: Date.now(),
        resolve: resolve as (result: ModQueryResult<unknown>) => void,
      });
      try {
        this.sendToMod(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve({ ok: false, error: `could not send ${kind} query: ${String(error)}` });
      }
    });
  }

  // True when the message was one of ours (a query answer or a hold release)
  onModMessage(message: CognitionModMessage | undefined): boolean {
    if (!message || typeof message !== 'object') {
      return false;
    }
    switch (message.kind) {
      case 'query_result': {
        const entry = this.pending.get(message.request_id);
        if (!entry) {
          log.debug(`[ModQuery] late or unknown answer ${message.request_id}`);
          return true;
        }
        this.pending.delete(message.request_id);
        clearTimeout(entry.timer);
        if (message.ok) {
          entry.resolve({ ok: true, result: message.result });
        } else {
          entry.resolve({ ok: false, error: message.error ?? 'unknown error' });
        }
        return true;
      }
      case 'hold_released':
        this.holdListeners.forEach((listener) => {
          try {
            listener(message);
          } catch (error) {
            log.warn('[ModQuery] hold listener failed', error);
          }
        });
        return true;
      case 'goal_completed':
        this.goalListeners.forEach((listener) => {
          try {
            listener(message);
          } catch (error) {
            log.warn('[ModQuery] goal listener failed', error);
          }
        });
        return true;
      default:
        // A kind a newer mod may add: not ours to drop on the floor loudly
        return false;
    }
  }

  onHoldReleased(listener: (event: CognitionHoldReleased) => void) {
    this.holdListeners.push(listener);
  }

  onGoalCompleted(listener: (event: CognitionGoalCompleted) => void) {
    this.goalListeners.push(listener);
  }

  // The websocket closed: nothing pending can be answered now
  onModDisconnected() {
    const entries = [...this.pending.entries()];
    this.pending.clear();
    entries.forEach(([, entry]) => {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, error: DISCONNECTED });
    });
  }
}
