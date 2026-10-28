// The budget gate (autonomy renovation R3, 2026-10-24; autonomy tier): SOFAI's real-time rule
// for the rows that still need a model call by day (scene and conversation impulses, and a story
// row the night call wrote with no click). `expCost = expTime / remTime > 1` means never start
// the call: on 10-22 a story row's pick took 4.5 real minutes at speed 3 and came back after its
// window. So a deliberate row may fire only when the p90 of recent deliberations fits in the real
// seconds left in its window at the current clock speed. At speed 3 the gate is nearly always
// shut, which is intended; at speed 1 it is nearly always open (test-time compute wins there).
import type { SimStateReport } from '../../models/SimStateReport';
import { IntentionRow, clockMinutes } from '../../models/IntentionRow';

export const LATENCY_SAMPLES = 20;
export const LATENCY_SEED_MS = 60_000;
export const LATENCY_MIN_SAMPLES = 5;
// A deliberation shorter than this never reached a model (a gate, an empty answer)
export const LATENCY_MIN_MS = 2_000;
// Report gaps longer than this (a pause, a load) say nothing about the clock's pace
const PACE_MAX_GAP_MS = 120_000;
const PACE_SMOOTHING = 0.3;

export type BudgetVerdict = { ok: true } | { ok: false; needSeconds: number; haveSeconds: number };

export class BudgetGate {
  private readonly latencies: number[] = [];

  private last: { at: number; minutes: number } | undefined;

  // Real seconds per game minute, smoothed; undefined until two reports moved the clock
  private paceSeconds: number | undefined;

  // The seed until enough deliberations ran; the Jev day lowers it (a decision is ~0.3 s)
  private seedMs = LATENCY_SEED_MS;

  // `minMs`: a deliberation shorter than this never reached a model, unless the caller says
  // otherwise (a Jev hands call is a model call and finishes well under the 2 s floor)
  recordLatency(ms: number, minMs = LATENCY_MIN_MS) {
    if (!Number.isFinite(ms) || ms < minMs) {
      return;
    }
    this.latencies.push(ms);
    if (this.latencies.length > LATENCY_SAMPLES) {
      this.latencies.shift();
    }
  }

  seed(ms: number) {
    if (Number.isFinite(ms) && ms > 0) {
      this.seedMs = ms;
    }
  }

  // The p90 of the last LATENCY_SAMPLES model deliberations, the seed until enough ran
  p90Ms(): number {
    if (this.latencies.length < LATENCY_MIN_SAMPLES) {
      return this.seedMs;
    }
    const sorted = [...this.latencies].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(0.9 * sorted.length) - 1)];
  }

  // Every state report: how many real seconds a game minute takes right now
  observe(report: SimStateReport, now = Date.now()) {
    const minutes = clockMinutes(report);
    if (minutes === undefined || report.paused || report.lot?.clock?.paused) {
      this.last = undefined;
      return;
    }
    const previous = this.last;
    this.last = { at: now, minutes };
    if (!previous) {
      return;
    }
    const realMs = now - previous.at;
    const gameMinutes = minutes - previous.minutes;
    if (gameMinutes <= 0 || realMs <= 0 || realMs > PACE_MAX_GAP_MS) {
      return;
    }
    const sample = realMs / 1000 / gameMinutes;
    this.paceSeconds =
      this.paceSeconds === undefined ? sample : this.paceSeconds + PACE_SMOOTHING * (sample - this.paceSeconds);
  }

  get pace(): number | undefined {
    return this.paceSeconds;
  }

  // The last game minute the row may fire in: its until, else its window, else the day's end
  static windowEnd(row: IntentionRow, nowMinutes: number): number {
    if (row.until.kind === 'game_time') {
      return row.until.at;
    }
    const window = row.preconditions.find((condition) => condition.kind === 'game_time');
    if (window?.kind === 'game_time') {
      return window.to;
    }
    return Math.floor(nowMinutes / 1440) * 1440 + 1439;
  }

  // Whether a deliberate row's model call can finish in its window at this speed. Open while
  // the pace is unknown (the first reports after a load), so missing data never starves a row.
  allows(row: IntentionRow, nowMinutes: number): BudgetVerdict {
    if (row.what.kind !== 'deliberate' || this.paceSeconds === undefined) {
      return { ok: true };
    }
    const haveSeconds = Math.max(0, BudgetGate.windowEnd(row, nowMinutes) - nowMinutes) * this.paceSeconds;
    const needSeconds = this.p90Ms() / 1000;
    return needSeconds < haveSeconds ? { ok: true } : { ok: false, needSeconds, haveSeconds };
  }
}
