import log from 'electron-log';
import { randomUUID } from 'crypto';
import { ActionIntent } from '../models/ActionIntent';
import {
  ModCancelInteraction,
  ModEnqueueInteraction,
  ModWebsocketMessageType,
  WebsocketNotification,
} from '../models/ModWebsocketMessage';
import { isWebSocketConnected, sendModNotification } from '../websocketServer';

export type PendingDispatch = {
  requestId: string;
  intent: ActionIntent;
  dispatchedAt: number;
};

// Interactions that get canceled before ever running produce no outcome from the mod, so
// pending dispatches are dropped after this long rather than accumulating forever
const PENDING_TTL_MS = 10 * 60 * 1000;

// One greppable line per decision point on the dispatch path, mirroring the mod's
// `PUSHDIAG rid=<id> stage=... k=v` lines (ss_interaction_push.pushdiag). Grep both logs
// on the request id and the whole life of a push reads in order.
// Stages here: dispatch | release | expire | timeout | outcome.
export function pushdiag(requestId: string | undefined, stage: string, fields: Record<string, unknown> = {}) {
  const parts = [`PUSHDIAG rid=${requestId ?? 'none'} stage=${stage}`];
  Object.entries(fields).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') {
      return;
    }
    let text = typeof value === 'string' ? value : JSON.stringify(value);
    text = text.replace(/\n/g, ' ');
    if (text.length > 200) {
      text = `${text.slice(0, 200)}...`;
    }
    parts.push(`${key}=${text}`);
  });
  log.info(parts.join(' '));
}

export class ActionDispatcherService {
  private readonly pending = new Map<string, PendingDispatch>();

  // One in-flight action per sim: re-pushing while a sim routes cancels the walk and
  // resets it from zero (the Adrian/DJ-booth hour). The state machine checks this before
  // deliberating, but the dispatcher enforces it as the last line of defense.
  private readonly inFlightBySim = new Map<string, string>();

  getInFlight(simId: string): PendingDispatch | undefined {
    const requestId = this.inFlightBySim.get(simId);
    return requestId ? this.pending.get(requestId) : undefined;
  }

  dispatch(intent: ActionIntent): string {
    this.prune();
    // sendModNotification silently drops when no client is attached (observed live: a
    // dispatch sent while the mod was reconnecting became a phantom in-flight entry that
    // blocked the sim for the full TTL). Fail fast so the caller cools down and retries.
    if (!this.isModConnected()) {
      throw new Error(`mod websocket not connected; dropping dispatch for sim ${intent.sim_id}`);
    }
    const existing = this.getInFlight(intent.sim_id);
    if (existing && intent.source === 'cognition') {
      throw new Error(`sim ${intent.sim_id} already has '${existing.intent.action}' in flight (${existing.requestId})`);
    }
    const requestId = randomUUID();
    const message: ModEnqueueInteraction = {
      type: ModWebsocketMessageType.ENQUEUE_INTERACTION,
      request_id: requestId,
      sim_id: intent.sim_id,
      action: intent.action,
      target_sim_id: intent.target_sim_id,
      target_object_id: intent.target_object_id,
      priority: intent.priority,
      insert_strategy: intent.insert_strategy,
      clear_queue: intent.clear_queue,
      preempt: intent.preempt,
      zone_id: intent.zone_id,
      source: intent.source ?? 'cognition',
    };
    this.pending.set(requestId, { requestId, intent, dispatchedAt: Date.now() });
    this.inFlightBySim.set(intent.sim_id, requestId);
    this.sendToMod(message);
    log.debug(`[ActionDispatcher] dispatched ${requestId}: sim ${intent.sim_id} -> ${intent.action}`);
    pushdiag(requestId, 'dispatch', {
      sim_id: intent.sim_id,
      action: intent.action,
      target_sim_id: intent.target_sim_id,
      target_object_id: intent.target_object_id,
      zone_id: intent.zone_id,
      priority: intent.priority,
      source: intent.source ?? 'cognition',
    });
    return requestId;
  }

  // Seam for tests; production sends over the mod websocket. Also used by other
  // cognition traffic (e.g. perception requests) so tests can intercept one place.
  sendToMod(message: WebsocketNotification) {
    sendModNotification(message);
  }

  // Seam for tests (production asks the websocket server)
  isModConnected(): boolean {
    return isWebSocketConnected('mod');
  }

  // Abandons an in-flight dispatch whose outcome the caller has given up on (cognition's
  // pending timeout). Keeps the dispatcher's view aligned with the state machine instead
  // of blocking the sim until the 10-minute TTL, and tells the mod to cancel the game-side
  // interaction: a push queued behind a long-running activity otherwise outlives the app's
  // interest and runs anyway (three stacked showers observed live).
  release(requestId: string | undefined): void {
    if (!requestId) {
      return;
    }
    const entry = this.pending.get(requestId);
    if (entry) {
      log.debug(`[ActionDispatcher] releasing abandoned dispatch ${requestId} (${entry.intent.action})`);
      pushdiag(requestId, 'release', {
        sim_id: entry.intent.sim_id,
        action: entry.intent.action,
        age_s: Math.round((Date.now() - entry.dispatchedAt) / 1000),
        cancel_sent: this.isModConnected(),
      });
      if (this.isModConnected()) {
        const cancel: ModCancelInteraction = {
          type: ModWebsocketMessageType.CANCEL_INTERACTION,
          request_id: requestId,
        };
        this.sendToMod(cancel);
      }
    }
    this.resolve(requestId);
  }

  // Claims the pending dispatch for an arriving outcome. Removes it, so a duplicate outcome
  // report for the same request_id comes back undefined.
  resolve(requestId: string | undefined): PendingDispatch | undefined {
    if (!requestId) {
      return undefined;
    }
    const entry = this.pending.get(requestId);
    if (entry) {
      this.pending.delete(requestId);
      if (this.inFlightBySim.get(entry.intent.sim_id) === requestId) {
        this.inFlightBySim.delete(entry.intent.sim_id);
      }
    }
    return entry;
  }

  get pendingCount(): number {
    this.prune();
    return this.pending.size;
  }

  private prune() {
    const cutoff = Date.now() - PENDING_TTL_MS;
    this.pending.forEach((entry, id) => {
      if (entry.dispatchedAt < cutoff) {
        log.debug(`[ActionDispatcher] expiring dispatch ${id} (${entry.intent.action}) with no outcome`);
        pushdiag(id, 'expire', { sim_id: entry.intent.sim_id, action: entry.intent.action, ttl_s: PENDING_TTL_MS / 1000 });
        this.pending.delete(id);
        if (this.inFlightBySim.get(entry.intent.sim_id) === id) {
          this.inFlightBySim.delete(entry.intent.sim_id);
        }
      }
    });
  }
}
