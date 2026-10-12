// Is a directed scene still about what is happening on screen?
//
// Every interaction event becomes a voiced scene, and generating one takes 10-20 s per
// round at concurrency 1. On a busy lot the queue grows and scenes air minutes after the
// game moved on: on the 2026-10-11 stream, fans at a celebrity's VIP rope came one after
// another and a GetToKnow scene with the previous fan was still on its third round while
// the celebrity was already talking to the next one. Nothing in the pipeline asked how
// old the event was or whether its sims were still together.
//
// This is that question. It knows, per sim, the latest game event they were in (and with
// whom) and whether the game reported them gone, and judges a scene against the time of
// the event it came from:
//   (a) the event is older than sceneEventMaxAgeMs (round 1 only: once the opening aired
//       fresh, the mod's proximity watch and the rules below decide whether the
//       conversation goes on);
//   (b) a participant has since been in an event with somebody else, clearly later than
//       this one (Augustus now with Dirk supersedes Augustus + Travis; a later event for
//       the same pair, or a bigger group that still contains the pair, does not). Only
//       judged before a scene starts generating: on a lot with several sims the game
//       fires side socials constantly, and a scene handed to the player was killed 0.3 s
//       later by one (live 2026-10-12, Augustus + Halley dropped for a Marcus mixer);
//   (c) a participant left the lot after the event.
//
// Departures come from the mod's scene watch (scene_control left_lot/absent with the
// sim's id, sent on a real despawn) and are cleared by a later event naming the sim, or
// by a state report that lists them on the lot again, once the report is new enough to
// postdate the departure.
import log from 'electron-log';
import type { SimStateReport } from '../models/SimStateReport';

export type SimRef = { simId: string; name?: string };

export type PendingScene = { sceneId: string; participantSimIds: string[]; eventAt?: number };

export type SceneFreshnessDeps = {
  maxAgeMs: () => number;
  // Scenes already handed to the renderer but not yet started: a new event makes the
  // stale ones among them stop before they play (ScenePlaybackRegistry.stopPending)
  stopPending?: (judge: (scene: PendingScene) => string | undefined) => void;
};

type SimEvent = { at: number; partners: Set<string> };

// The state reporter posts from a daemon thread every 5 s, so a report built just before
// a despawn can land after the stop that announced it. A report only clears a departure
// once it is clearly newer than the mark.
export const REPORT_CLEAR_GRACE_MS = 6_000;

// A later event with somebody else counts as "moved on" only when it is this much newer
// than the scene's own event: the game fires a social with the next sim over within
// seconds of the last one while everyone is still standing together.
export const MOVED_ON_GAP_MS = 15_000;

export type FreshnessJudgement = {
  // Rule (a): opening rounds only
  judgeAge: boolean;
  // Rule (b): before generation only; defaults on
  judgeMovedOn?: boolean;
};

export class SceneFreshness {
  private readonly latestBySim = new Map<string, SimEvent>();

  private readonly departed = new Map<string, number>();

  private readonly names = new Map<string, string>();

  constructor(private readonly deps: SceneFreshnessDeps) {}

  /** A game event arrived for these sims (together). */
  recordEvent(sims: SimRef[], at = Date.now()) {
    const partners = new Set(sims.map((sim) => sim.simId));
    sims.forEach((sim) => {
      this.latestBySim.set(sim.simId, { at, partners });
      if (sim.name) {
        this.names.set(sim.simId, sim.name);
      }
      // Whoever is in a game interaction here is here
      this.departed.delete(sim.simId);
    });
    // A scene the renderer holds but has not started: dropped only on the hard signals
    // (its event is too old, or one of its sims is gone), never on this event itself
    this.deps.stopPending?.((scene) =>
      scene.eventAt === undefined
        ? undefined
        : this.staleReason(
            scene.participantSimIds.map((simId) => ({ simId })),
            scene.eventAt,
            { judgeAge: true, judgeMovedOn: false },
            at,
          ),
    );
  }

  /** The game says this sim is gone from the lot. */
  markDeparted(simId: string, at = Date.now()) {
    this.departed.set(simId, at);
  }

  /** A state report: whoever it lists on the lot is back, if the report postdates the mark. */
  onStateReport(report: SimStateReport, now = Date.now()) {
    (report.sims ?? []).forEach((entry) => {
      if (!entry.sim_id || entry.self?.on_active_lot === false) {
        return;
      }
      const departedAt = this.departed.get(entry.sim_id);
      if (departedAt !== undefined && now - departedAt > REPORT_CLEAR_GRACE_MS) {
        this.departed.delete(entry.sim_id);
      }
    });
  }

  isDeparted(simId: string): boolean {
    return this.departed.has(simId);
  }

  /**
   * Why a scene from an event at `eventAt` between `participants` should not air now,
   * or undefined while it still describes the world.
   */
  staleReason(participants: SimRef[], eventAt: number, opts: FreshnessJudgement, now = Date.now()): string | undefined {
    if (opts.judgeAge) {
      const age = now - eventAt;
      const max = this.deps.maxAgeMs();
      if (age > max) {
        return `event is ${Math.round(age / 1000)}s old (max ${Math.round(max / 1000)}s)`;
      }
    }
    const ids = participants.map((sim) => sim.simId);
    for (const sim of participants) {
      const latest = this.latestBySim.get(sim.simId);
      if (
        opts.judgeMovedOn !== false &&
        latest &&
        latest.at - eventAt > MOVED_ON_GAP_MS &&
        !ids.every((id) => latest.partners.has(id))
      ) {
        const others = [...latest.partners].filter((id) => id !== sim.simId).map((id) => this.nameOf(id));
        return `${this.nameOf(sim.simId, sim.name)} has moved on (now with ${others.length ? others.join(', ') : 'nobody'})`;
      }
      const departedAt = this.departed.get(sim.simId);
      if (departedAt !== undefined && departedAt > eventAt) {
        return `${this.nameOf(sim.simId, sim.name)} left the lot`;
      }
    }
    return undefined;
  }

  /** The lot changed: nobody from the old one is "departed" from the new one. */
  clearDepartures() {
    this.departed.clear();
  }

  /** The mod disconnected: the next game session starts from nothing. */
  reset() {
    this.latestBySim.clear();
    this.departed.clear();
    this.names.clear();
    log.debug('[SceneFreshness] reset');
  }

  private nameOf(simId: string, fallback?: string): string {
    return fallback ?? this.names.get(simId) ?? simId;
  }
}
