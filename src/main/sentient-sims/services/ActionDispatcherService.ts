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

// A dispatch the dispatcher has already let go of, kept just long enough to grade an
// outcome that arrives afterwards (F5). Without it a late outcome is indistinguishable
// from an outcome for a dispatch that never existed: both look up as undefined, so the
// controller cannot say how old the claim is or whether anything was still waiting on it.
export type ClosedDispatch = PendingDispatch & {
  closedAt: number;
  closedBy: 'outcome' | 'release' | 'expire';
};

// Interactions that get canceled before ever running produce no outcome from the mod, so
// pending dispatches are dropped after this long rather than accumulating forever
const PENDING_TTL_MS = 10 * 60 * 1000;

// How many closed dispatches to remember. Outcomes land within seconds of their close in
// every observed case, so this is a small ring, not a log.
const CLOSED_MEMORY = 200;

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

  // Insertion-ordered, capped at CLOSED_MEMORY (F5)
  private readonly recentlyClosed = new Map<string, ClosedDispatch>();

  getInFlight(simId: string): PendingDispatch | undefined {
    const requestId = this.inFlightBySim.get(simId);
    return requestId ? this.pending.get(requestId) : undefined;
  }

  // The dispatch behind a request id whether or not it is still in flight. An outcome
  // that arrives after the pending timeout released the request still has a dispatch to
  // be graded against; resolve() alone answers undefined for it and loses that.
  lookup(requestId: string | undefined): PendingDispatch | ClosedDispatch | undefined {
    if (!requestId) {
      return undefined;
    }
    return this.pending.get(requestId) ?? this.recentlyClosed.get(requestId);
  }

  // True when the request was already closed before this outcome arrived — the honest
  // definition of 'late'. The old one ('the sim's runtime is not PENDING_OUTCOME') also
  // fired for every ask and debug dispatch, which the runtime never owned in the first
  // place.
  wasClosed(requestId: string | undefined): boolean {
    return requestId !== undefined && this.recentlyClosed.has(requestId);
  }

  private remember(entry: PendingDispatch, closedBy: ClosedDispatch['closedBy']) {
    this.recentlyClosed.set(entry.requestId, { ...entry, closedAt: Date.now(), closedBy });
    while (this.recentlyClosed.size > CLOSED_MEMORY) {
      const oldest = this.recentlyClosed.keys().next();
      if (oldest.done) {
        break;
      }
      this.recentlyClosed.delete(oldest.value);
    }
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
      pie: intent.pie,
      row_id: intent.row_id,
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
      pie_item: intent.pie?.item,
      option: intent.pie?.option,
      row_id: intent.row_id,
    });
    return requestId;
  }

  // A push the mod ran on someone else's behalf (Plum's push_action, request ids
  // 'plum-...'): registered after the fact so the outcome the mod reports grades it like
  // one of cognition's. Never blocks a sim's in-flight slot: Plum is the player asking.
  registerExternal(requestId: string, intent: ActionIntent) {
    this.prune();
    this.pending.set(requestId, { requestId, intent, dispatchedAt: Date.now() });
    pushdiag(requestId, 'dispatch', {
      sim_id: intent.sim_id,
      action: intent.action,
      source: intent.source ?? 'external',
    });
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
    this.resolve(requestId, 'release');
  }

  // Claims the pending dispatch for an arriving outcome. Removes it, so a duplicate outcome
  // report for the same request_id comes back undefined — but the dispatch is remembered
  // in recentlyClosed so a late outcome can still be graded against it.
  resolve(
    requestId: string | undefined,
    closedBy: ClosedDispatch['closedBy'] = 'outcome',
  ): PendingDispatch | undefined {
    if (!requestId) {
      return undefined;
    }
    const entry = this.pending.get(requestId);
    if (entry) {
      this.pending.delete(requestId);
      if (this.inFlightBySim.get(entry.intent.sim_id) === requestId) {
        this.inFlightBySim.delete(entry.intent.sim_id);
      }
      this.remember(entry, closedBy);
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
        pushdiag(id, 'expire', {
          sim_id: entry.intent.sim_id,
          action: entry.intent.action,
          ttl_s: PENDING_TTL_MS / 1000,
        });
        this.pending.delete(id);
        if (this.inFlightBySim.get(entry.intent.sim_id) === id) {
          this.inFlightBySim.delete(entry.intent.sim_id);
        }
        this.remember(entry, 'expire');
      }
    });
  }
}
