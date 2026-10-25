import * as fs from 'fs';
import { describe, expect, it } from 'vitest';
import { mockApiContext } from './util';
import { ExperienceRepository } from 'main/sentient-sims/db/ExperienceRepository';
import { RowMemoryRepository } from 'main/sentient-sims/db/RowMemoryRepository';
import { ExperienceService } from 'main/sentient-sims/services/intentions/ExperienceService';
import {
  Experience,
  IMPORTANCE,
  experienceLine,
  factImportance,
  fold,
  interactionImportance,
  rank,
  recency,
  relevance,
  verbFamily,
} from 'main/sentient-sims/services/intentions/Experience';
import { buildNightText } from 'main/sentient-sims/services/intentions/NightCall';
import { FactPredicate } from 'main/sentient-sims/pipeline/facts/predicates';
import { SimDossier } from 'main/sentient-sims/models/SimDossier';

// Renovation R5a: experiences built by code from the household log, the memories and the game
// facts that changed, importance from game signals, ranked the Generative Agents way (recency
// since last access, importance, relevance; min-max, weights 1) in place of the last 25 memories.

function experience(overrides: Partial<Experience> = {}): Experience {
  return {
    holder: '100',
    day: 40,
    minute: 600,
    kind: 'did',
    participants: [],
    importance: 2,
    source: 'interaction',
    sourceId: String(Math.random()),
    ...overrides,
  };
}

describe('Experience (pure)', () => {
  it('importance comes from the game: a Sim, a failure, a bit, a life event', () => {
    expect(interactionImportance({ withSim: false, ran: true })).toBe(IMPORTANCE.ordinary);
    expect(interactionImportance({ withSim: true, ran: true })).toBe(IMPORTANCE.withSim);
    expect(interactionImportance({ withSim: true, ran: true, userCanceled: true })).toBe(5);
    expect(factImportance(FactPredicate.REL_BIT, true)).toBe(9);
    expect(factImportance(FactPredicate.REL_BIT, false)).toBe(8);
    expect(factImportance(FactPredicate.SPOUSE, true)).toBe(10);
    expect(factImportance(FactPredicate.JOB, true)).toBe(9);
    expect(factImportance(FactPredicate.KNOWS, true)).toBe(5);
    expect(factImportance(FactPredicate.SKILL, true)).toBeUndefined();
    expect(factImportance(FactPredicate.KNOWS_TRAIT, true)).toBeUndefined();
  });

  it('verb families strip the tuning prefixes', () => {
    expect(verbFamily('mixer_social_TellJoke_targeted_Friendly')).toBe('telljoke');
    expect(verbFamily('sim_Chat')).toBe('chat');
    expect(verbFamily('Stargaze')).toBe('stargaze');
    expect(verbFamily(undefined)).toBeUndefined();
  });

  it('recency decays 0.995 an hour since the later of when it happened and when it was shown', () => {
    const item = experience({ day: 40, minute: 0 });
    expect(recency(item, 40 * 1440)).toBe(1);
    expect(recency(item, 40 * 1440 + 600)).toBeCloseTo(0.995 ** 10);
    expect(recency({ ...item, lastAccess: 40 * 1440 + 600 }, 40 * 1440 + 600)).toBe(1);
  });

  it('relevance is overlap with who, what kind of thing and where tomorrow holds', () => {
    const item = experience({ participants: ['200'], verbFamily: 'chat', zone: '1' });
    expect(relevance(item, { sims: new Set(['200']), verbs: new Set(['chat']), zone: '1' })).toBe(3);
    expect(relevance(item, { sims: new Set(), verbs: new Set(), zone: '2' })).toBe(0);
  });

  it('folds a repeated interaction on one day and ranks by the three terms', () => {
    // three sits on three different chairs are one experience, counted
    const sits = [1, 2, 3].map((index) => experience({ verb: 'sit', minute: 600 + index, target: `chair${index}` }));
    const folded = fold([...sits, experience({ source: 'memory', verb: 'sit' })]);
    expect(folded.map((item) => item.count)).toEqual([3, 1]);
    const bit = experience({
      kind: 'fact',
      source: 'fact',
      importance: 9,
      participants: ['200'],
      text: 'now: x',
      minute: undefined,
    });
    const chat = experience({ participants: ['200'], verbFamily: 'chat', importance: 3, minute: 700 });
    const ranked = rank([...sits, bit, chat], 41 * 1440, { sims: new Set(['200']), verbs: new Set(), zone: '1' }, 2);
    // the top two by score (the sits lose), shown oldest first
    expect(ranked.map((item) => item.importance)).toEqual([3, 9]);
    expect(experienceLine(ranked[1], 41)).toBe('- yesterday [fact] now: x');
  });
});

describe('ExperienceService on a real save database (migration 030)', () => {
  function setup() {
    const ctx = mockApiContext();
    fs.mkdirSync(ctx.directory.getSentientSimsFolder(), { recursive: true });
    ctx.db.loadDatabase({ sessionId: `experience-${Math.random().toString(36).slice(2)}`, saveId: '1' });
    const rowMemoryRepository = new RowMemoryRepository(ctx.db);
    const experienceRepository = new ExperienceRepository(ctx.db);
    const service = new ExperienceService(ctx, { experienceRepository, rowMemoryRepository });
    return { ctx, rowMemoryRepository, experienceRepository, service };
  }

  const dossier = (bits: string[]): SimDossier => ({
    version: 1,
    sim_id: '100',
    name: 'Seth Polanco',
    relationships: [{ sim_id: '200', name: 'Arlene Zhang', has_met: true, friendship: 40, romance: 0, bits }],
  });

  it('builds the day once from the log and the facts, and the night text reads it ranked', () => {
    const { ctx, rowMemoryRepository, experienceRepository, service } = setup();
    rowMemoryRepository.insertInteractions([
      {
        at: 'now',
        simId: '100',
        name: 'sim_Chat',
        isSuper: true,
        targetKind: 'sim',
        targetId: '200',
        ran: true,
        day: 40,
        minute: 600,
        zone: '1',
      },
      { at: 'now', simId: '100', name: 'sit', isSuper: true, ran: true, day: 40, minute: 610, zone: '1' },
      { at: 'now', simId: '100', name: 'sit', isSuper: true, ran: true, day: 40, minute: 620, zone: '1' },
      // never ran: the game's own churn
      { at: 'now', simId: '100', name: 'browse_web', isSuper: true, ran: false, day: 40, minute: 630, zone: '1' },
      // a mixer is not an experience of its own
      { at: 'now', simId: '100', name: 'mixer_social_TellJoke', isSuper: false, ran: true, day: 40, minute: 601 },
      // Arlene's hug on Seth is his experience too
      {
        at: 'now',
        simId: '200',
        name: 'sim_Hug',
        isSuper: true,
        targetKind: 'sim',
        targetId: '100',
        ran: true,
        day: 40,
        minute: 640,
      },
    ]);
    ctx.semanticMemory.ingestDossier(dossier(['friendship-friend']), { day: 39 });
    ctx.semanticMemory.ingestDossier(dossier(['friendship-bff']), { day: 40 });

    const added = service.ingestDay('100', 40);
    expect(service.ingestDay('100', 40)).toBe(0);
    const rows = experienceRepository.forHolder('100', 40);
    expect(added).toBe(rows.length);
    expect(rows.filter((row) => row.source === 'interaction').map((row) => `${row.kind}:${row.verb}`)).toEqual([
      'did:sim_Chat',
      'did:sit',
      'did:sit',
      'with:sim_Hug',
    ]);
    const facts = rows.filter((row) => row.source === 'fact').map((row) => `${row.importance} ${row.text}`);
    expect(facts).toEqual([
      '8 no longer: friendship-friend with Arlene Zhang',
      '9 now: friendship-bff with Arlene Zhang',
    ]);
    // Day 39 was the predicate's first appearance (the record catching up): no experience
    service.ingestDay('100', 39);
    expect(experienceRepository.forHolder('100', 39).filter((row) => row.day === 39)).toHaveLength(0);

    const view = service.nightView('100', 40, 41, []);
    expect(view.changes).toEqual([
      '- no longer: friendship-friend with Arlene Zhang',
      '- now: friendship-bff with Arlene Zhang',
    ]);
    // The day's facts are injected above, not ranked again; the two sits fold into one
    expect(view.lived.some((line) => line.includes('[fact]'))).toBe(false);
    expect(view.lived).toContain('- yesterday 10:20 [did] sit (x2)');
    expect(view.count).toBe(3);
    // Shown rows were accessed at the night's time
    expect(experienceRepository.forHolder('100', 40).find((row) => row.verb === 'sim_Chat')?.lastAccess).toBe(
      41 * 1440,
    );

    const text = buildNightText({
      simId: '100',
      simName: 'Seth Polanco',
      endingDay: 40,
      newDay: 41,
      endingRows: [],
      todayRows: [],
      memories: [],
      outcomes: [],
      experiences: { changes: view.changes, lived: view.lived },
    });
    expect(text).toContain("What changed for Seth yesterday (the game's own record):");
    expect(text).toContain(
      'What Seth lived through (most recent, important and relevant to today first; oldest first):',
    );
    expect(text).not.toContain('their own memories');
  });
});
