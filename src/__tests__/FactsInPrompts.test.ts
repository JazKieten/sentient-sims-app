import { describe, expect, it } from 'vitest';
import { buildCognitionUserPrompt } from 'main/sentient-sims/util/formatCognitionPrompt';
import { recencyScore, scoreCandidate } from 'main/sentient-sims/services/MemoryRetrievalService';
import { SimStateEntry, SimStateReport } from 'main/sentient-sims/models/SimStateReport';
import { MemoryWithIndex } from 'main/sentient-sims/db/entities/MemoryIndexEntity';

// H3: the facts block reaches the prompts, and retrieval measures time the way the sim does.
describe('facts in the tick prompt', () => {
  const entry: SimStateEntry = {
    sim_id: '100',
    sim_name: 'Travis',
    self: { mood: 'Happy' },
    sims: [],
    objects: [],
  };
  const report: SimStateReport = { type: 'state_report', seq: 1 };

  it('renders the block when there are facts', () => {
    const block = '<KNOWN_FACTS>\nAbout you:\n- you are elder\n</KNOWN_FACTS>';
    const prompt = buildCognitionUserPrompt(entry, report, undefined, [], undefined, undefined, block);
    expect(prompt).toContain(block);
  });

  it('is byte-identical to the pre-3.1 prompt when the store is empty', () => {
    // The whole point of returning '' rather than a placeholder: a save with no facts
    // yet must behave exactly as it did before this phase
    const before = buildCognitionUserPrompt(entry, report, undefined, [], undefined, undefined);
    const withEmpty = buildCognitionUserPrompt(entry, report, undefined, [], undefined, undefined, '');
    expect(withEmpty).toBe(before);
  });

  it('puts facts before memories, so a truncation drops the recollection and not the truth', () => {
    const facts = '<KNOWN_FACTS>\nAbout you:\n- you are elder\n</KNOWN_FACTS>';
    const memories = '<RELEVANT_MEMORIES>\nsomething happened\n</RELEVANT_MEMORIES>';
    const prompt = buildCognitionUserPrompt(entry, report, memories, [], undefined, undefined, facts);
    expect(prompt.indexOf(facts)).toBeLessThan(prompt.indexOf(memories));
  });
});

describe('game-day recency', () => {
  const now = new Date('2026-09-03T12:00:00Z');

  it('measures in game days when both ends are known', () => {
    // Same real timestamp, three game days apart: the older one must score lower
    const fresh = recencyScore('2026-09-03 11:00:00', now, 78, 78);
    const stale = recencyScore('2026-09-03 11:00:00', now, 75, 78);
    expect(fresh).toBeCloseTo(1, 5);
    expect(stale).toBeLessThan(fresh);
    // Half-life of about three game days
    expect(stale).toBeCloseTo(0.5, 1);
  });

  it('falls back to real time when the memory has no game day', () => {
    const withoutDay = recencyScore('2026-09-03 11:00:00', now, undefined, 78);
    const realTime = recencyScore('2026-09-03 11:00:00', now);
    expect(withoutDay).toBe(realTime);
  });

  it('falls back to real time when today is unknown', () => {
    // The scenario tester and the main menu have no state report
    expect(recencyScore('2026-09-03 11:00:00', now, 78, undefined)).toBe(recencyScore('2026-09-03 11:00:00', now));
  });

  it('clamps a memory from the future rather than scoring above 1', () => {
    // A save reloaded to an earlier day puts existing rows in the future
    expect(recencyScore('2026-09-03 11:00:00', now, 90, 78)).toBe(1);
  });

  it('beats real time in the score, so a sim week feels like a week', () => {
    // Both rows were written minutes ago in real time; only the game clock separates them
    const base = { id: '1', timestamp: '2026-09-03 11:59:00', event_type: 'observation' };
    const today = { ...base, game_day: 78 } as unknown as MemoryWithIndex;
    const lastWeek = { ...base, id: '2', game_day: 71 } as unknown as MemoryWithIndex;
    const scoredToday = scoreCandidate(today, undefined, undefined, now, 78);
    const scoredLastWeek = scoreCandidate(lastWeek, undefined, undefined, now, 78);
    expect(scoredToday.recency).toBeGreaterThan(scoredLastWeek.recency);
    expect(scoredToday.score).toBeGreaterThan(scoredLastWeek.score);
  });
});
