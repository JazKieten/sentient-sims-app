import { describe, expect, it, vi } from 'vitest';
import { MOVED_ON_GAP_MS, REPORT_CLEAR_GRACE_MS, SceneFreshness } from 'main/sentient-sims/services/SceneFreshness';
import { SimStateReport } from 'main/sentient-sims/models/SimStateReport';

const AUGUSTUS = { simId: '1', name: 'Augustus' };
const TRAVIS = { simId: '2', name: 'Travis' };
const DIRK = { simId: '3', name: 'Dirk' };
const PAIR = [AUGUSTUS, TRAVIS];

function build(maxAgeMs = 60_000) {
  const stopPending = vi.fn();
  const freshness = new SceneFreshness({ maxAgeMs: () => maxAgeMs, stopPending });
  return { freshness, stopPending };
}

function report(simIds: string[], onLot = true): SimStateReport {
  return {
    type: 'state_report',
    seq: 1,
    sims: simIds.map((simId) => ({ sim_id: simId, self: { on_active_lot: onLot } })) as SimStateReport['sims'],
  };
}

describe('SceneFreshness', () => {
  it('is fresh for a young event nobody has moved on from', () => {
    const { freshness } = build();
    freshness.recordEvent(PAIR, 1_000);
    expect(freshness.staleReason(PAIR, 1_000, { judgeAge: true }, 20_000)).toBeUndefined();
  });

  it('is stale once the event is older than the maximum age', () => {
    const { freshness } = build(60_000);
    expect(freshness.staleReason(PAIR, 1_000, { judgeAge: true }, 61_001)).toMatch(/60s old/);
    // Later rounds are not judged on age: the opening aired fresh
    expect(freshness.staleReason(PAIR, 1_000, { judgeAge: false }, 61_001)).toBeUndefined();
  });

  it('is stale when a participant has since been with somebody else', () => {
    const { freshness } = build();
    freshness.recordEvent(PAIR, 1_000);
    freshness.recordEvent([AUGUSTUS, DIRK], 1_000 + MOVED_ON_GAP_MS + 1);
    expect(freshness.staleReason(PAIR, 1_000, { judgeAge: false }, 6_000)).toBe(
      'Augustus has moved on (now with Dirk)',
    );
  });

  it('is not moved on by a side social moments after the scene event', () => {
    // Live 2026-10-12: the Halley scene was handed to the player and a Marcus mixer
    // arrived 0.3 s later; everyone was still standing together
    const { freshness } = build();
    freshness.recordEvent(PAIR, 1_000);
    freshness.recordEvent([AUGUSTUS, DIRK], 1_000 + MOVED_ON_GAP_MS);
    expect(freshness.staleReason(PAIR, 1_000, { judgeAge: false }, 60_000)).toBeUndefined();
  });

  it('never judges moved-on when told not to', () => {
    const { freshness } = build();
    freshness.recordEvent([AUGUSTUS, DIRK], 1_000 + MOVED_ON_GAP_MS + 1);
    expect(freshness.staleReason(PAIR, 1_000, { judgeAge: false, judgeMovedOn: false }, 60_000)).toBeUndefined();
  });

  it('is stale when a participant has since been alone', () => {
    const { freshness } = build();
    freshness.recordEvent([AUGUSTUS], 1_000 + MOVED_ON_GAP_MS + 1);
    expect(freshness.staleReason(PAIR, 1_000, { judgeAge: false }, 6_000)).toBe(
      'Augustus has moved on (now with nobody)',
    );
  });

  it('is not superseded by a later event for the same pair', () => {
    const { freshness } = build();
    freshness.recordEvent(PAIR, 50_000);
    expect(freshness.staleReason(PAIR, 1_000, { judgeAge: false }, 6_000)).toBeUndefined();
  });

  it('is not superseded by a bigger group that still holds the pair', () => {
    const { freshness } = build();
    freshness.recordEvent([AUGUSTUS, TRAVIS, DIRK], 50_000);
    expect(freshness.staleReason(PAIR, 1_000, { judgeAge: false }, 6_000)).toBeUndefined();
  });

  it('ignores events older than the scene', () => {
    const { freshness } = build();
    freshness.recordEvent([AUGUSTUS, DIRK], 500);
    expect(freshness.staleReason(PAIR, 1_000, { judgeAge: false }, 6_000)).toBeUndefined();
  });

  it('is stale when a participant left the lot after the event', () => {
    const { freshness } = build();
    freshness.markDeparted('2', 3_000);
    expect(freshness.staleReason(PAIR, 1_000, { judgeAge: false }, 6_000)).toBe('Travis left the lot');
    // ...but not when they left before it: the event is the game saying they are here
    expect(freshness.staleReason(PAIR, 4_000, { judgeAge: false }, 6_000)).toBeUndefined();
  });

  it('forgets a departure when the sim is in a new game event', () => {
    const { freshness } = build();
    freshness.markDeparted('2', 3_000);
    freshness.recordEvent(PAIR, 4_000);
    expect(freshness.isDeparted('2')).toBe(false);
  });

  it('forgets a departure only on a state report clearly newer than the mark', () => {
    const { freshness } = build();
    freshness.markDeparted('2', 3_000);
    // A report built before the despawn can land after the stop that announced it
    freshness.onStateReport(report(['2']), 3_000 + REPORT_CLEAR_GRACE_MS);
    expect(freshness.isDeparted('2')).toBe(true);
    freshness.onStateReport(report(['2'], false), 3_000 + REPORT_CLEAR_GRACE_MS + 1);
    expect(freshness.isDeparted('2')).toBe(true);
    freshness.onStateReport(report(['2']), 3_000 + REPORT_CLEAR_GRACE_MS + 1);
    expect(freshness.isDeparted('2')).toBe(false);
  });

  it('asks pending scenes to stop only on the hard signals', () => {
    const { freshness, stopPending } = build(60_000);
    freshness.markDeparted('4', 90_000);
    freshness.recordEvent([AUGUSTUS, DIRK], 100_000);
    const judge = stopPending.mock.calls[0][0] as (scene: {
      sceneId: string;
      participantSimIds: string[];
      eventAt?: number;
    }) => string | undefined;
    // Too old to still describe the world
    expect(judge({ sceneId: 'old', participantSimIds: ['1', '2'], eventAt: 30_000 })).toMatch(/old/);
    // One of its sims left after its event
    expect(judge({ sceneId: 'gone', participantSimIds: ['1', '4'], eventAt: 80_000 })).toMatch(/left the lot/);
    // Fresh and everyone here: the new event with somebody else is NOT enough on its own
    expect(judge({ sceneId: 'fresh', participantSimIds: ['1', '2'], eventAt: 70_000 })).toBeUndefined();
    expect(judge({ sceneId: 'new', participantSimIds: ['1', '3'], eventAt: 100_000 })).toBeUndefined();
    // A scene with no event time (chat window, bench) is never judged
    expect(judge({ sceneId: 'chat', participantSimIds: ['1', '2'] })).toBeUndefined();
  });

  it('clears departures when the lot changes and everything on reset', () => {
    const { freshness } = build();
    freshness.markDeparted('2', 3_000);
    freshness.clearDepartures();
    expect(freshness.isDeparted('2')).toBe(false);
    freshness.recordEvent([AUGUSTUS, DIRK], 50_000);
    freshness.reset();
    expect(freshness.staleReason(PAIR, 1_000, { judgeAge: false }, 60_000)).toBeUndefined();
  });
});
