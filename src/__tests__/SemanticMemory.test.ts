import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import { ApiContext } from 'main/sentient-sims/services/ApiContext';
import { DirectoryService } from 'main/sentient-sims/services/DirectoryService';
import { SettingsService } from 'main/sentient-sims/services/SettingsService';
import { SimDossier } from 'main/sentient-sims/models/SimDossier';
import { FactPredicate } from 'main/sentient-sims/pipeline/facts/predicates';
import { mockApiContext, mockEnvironment } from './util';

// H2: the semantic fact store. The point of the block is that a sim can answer a question
// about itself correctly, and that nothing it is TOLD can overwrite what the game says.
describe('semantic memory', () => {
  let ctx: ApiContext;
  let directoryService: DirectoryService;
  let settingsService: SettingsService;
  let sessionId: string;

  function dossier(overrides: Partial<SimDossier> = {}): SimDossier {
    return {
      version: 1,
      sim_id: '100',
      name: 'Travis Scott',
      age: 'ELDER',
      gender: 'MALE',
      occult: { types: ['HUMAN'], current: ['HUMAN'] },
      is_ghost: false,
      household: { id: '900', name: 'BFF', member_ids: ['100', '200'] },
      family: { parents: [], siblings: [], children: ['200'], grandparents: [], steady_ids: [] },
      family_bits: { '200': 'family_Target_IsSonOrDaughterOf_Actor' },
      traits: ['trait_Geek'],
      likes: ['trait_SimPreference_Likes_Music_HipHop'],
      dislikes: [],
      relationships: [{ sim_id: '200', name: 'Mackenzie Scott', has_met: true, friendship: 100, romance: 0 }],
      ...overrides,
    };
  }

  beforeEach(() => {
    ({ directoryService, settingsService } = mockEnvironment());
    ctx = mockApiContext({ directoryService, settingsService });
    fs.mkdirSync(ctx.directory.getSentientSimsFolder(), { recursive: true });
    sessionId = `facts-${Math.random().toString(36).slice(2)}`;
    ctx.db.loadDatabase({ sessionId, saveId: '1' });
  });

  it('turns a dossier into game facts', () => {
    const result = ctx.semanticMemory.ingestDossier(dossier(), { hash: 'h1', day: 10 });
    expect(result.skipped).toBe(false);
    expect(result.inserted).toBeGreaterThan(0);

    const facts = ctx.semanticMemory.getCurrentFacts('100');
    const child = facts.find((fact) => fact.predicate === FactPredicate.CHILD);
    expect(child?.objectSimId).toBe('200');
    expect(child?.source).toBe('game');
    expect(child?.confidence).toBe(1);
    expect(child?.validFromDay).toBe(10);
    expect(facts.find((fact) => fact.predicate === FactPredicate.AGE_STAGE)?.objectText).toBe('ELDER');
    expect(facts.find((fact) => fact.predicate === FactPredicate.HOUSEHOLD)?.objectText).toBe('BFF');
    // The family bit is the only place step/in-law distinctions live
    expect(facts.find((fact) => fact.predicate === FactPredicate.FAMILY_BIT)?.objectText).toBe(
      'family_Target_IsSonOrDaughterOf_Actor',
    );
  });

  it('does nothing at all when the hash has not moved', () => {
    ctx.semanticMemory.ingestDossier(dossier(), { hash: 'h1', day: 10 });
    const before = ctx.simFactRepository.count();
    const again = ctx.semanticMemory.ingestDossier(dossier(), { hash: 'h1', day: 11 });
    expect(again.skipped).toBe(true);
    expect(ctx.simFactRepository.count()).toBe(before);
  });

  it('re-ingesting an unchanged dossier under a new hash inserts nothing new', () => {
    // The mod's hash deliberately ignores relationship scores, but a zone load re-sends
    // unconditionally: the diff, not the hash, is what must keep the table from growing.
    ctx.semanticMemory.ingestDossier(dossier(), { hash: 'h1', day: 10 });
    const before = ctx.simFactRepository.count();
    const again = ctx.semanticMemory.ingestDossier(dossier(), { hash: 'h2', day: 11 });
    expect(again.inserted).toBe(0);
    expect(again.retired).toBe(0);
    expect(ctx.simFactRepository.count()).toBe(before);
  });

  it('retires a fact the dossier stopped asserting, without deleting it', () => {
    // A divorce: the old edge is history, not a lie, and "she used to be married to him"
    // is worth keeping
    ctx.semanticMemory.ingestDossier(dossier({ family: { spouse_id: '300', steady_ids: [] } }), {
      hash: 'h1',
      day: 10,
    });
    expect(ctx.semanticMemory.getCurrentFacts('100').some((f) => f.predicate === FactPredicate.SPOUSE)).toBe(true);

    ctx.semanticMemory.ingestDossier(dossier({ family: { steady_ids: [] } }), { hash: 'h2', day: 20 });

    expect(ctx.semanticMemory.getCurrentFacts('100').some((f) => f.predicate === FactPredicate.SPOUSE)).toBe(false);
    const historic = ctx.semanticMemory.getHistory('100').find((f) => f.predicate === FactPredicate.SPOUSE);
    expect(historic).toBeDefined();
    expect(historic?.validToDay).toBe(20);
  });

  it('a new single-valued game fact supersedes the old one', () => {
    ctx.semanticMemory.ingestDossier(dossier({ age: 'ADULT' }), { hash: 'h1', day: 1 });
    ctx.semanticMemory.ingestDossier(dossier({ age: 'ELDER' }), { hash: 'h2', day: 2 });
    const current = ctx.semanticMemory.getCurrentFacts('100').filter((f) => f.predicate === FactPredicate.AGE_STAGE);
    expect(current).toHaveLength(1);
    expect(current[0].objectText).toBe('ELDER');
  });

  it('keeps a told lie but never lets it beat the game', () => {
    // The 3.1 acceptance test: tell the sim a false family fact
    ctx.semanticMemory.ingestDossier(dossier(), { hash: 'h1', day: 10 });
    const toldId = ctx.semanticMemory.addFact({
      subjectSimId: '100',
      predicate: FactPredicate.SPOUSE,
      objectSimId: '999',
      source: 'told',
      provenanceMemoryId: '55',
      day: 10,
    });
    expect(toldId).toBeDefined();

    // The lie is stored, at low confidence, with its source and its provenance
    const told = ctx.semanticMemory.getCurrentFacts('100').find((f) => f.objectSimId === '999');
    expect(told?.source).toBe('told');
    expect(told?.confidence).toBeLessThan(0.5);
    expect(told?.provenanceMemoryId).toBe('55');

    // ...and the moment the game asserts a real spouse, the lie is retired by it
    ctx.semanticMemory.ingestDossier(dossier({ family: { spouse_id: '300', steady_ids: [] } }), {
      hash: 'h2',
      day: 11,
    });
    const spouses = ctx.semanticMemory.getCurrentFacts('100').filter((f) => f.predicate === FactPredicate.SPOUSE);
    expect(spouses).toHaveLength(1);
    expect(spouses[0].objectSimId).toBe('300');
    expect(spouses[0].source).toBe('game');
  });

  it('a told fact cannot retire a game fact', () => {
    ctx.semanticMemory.ingestDossier(dossier({ family: { spouse_id: '300', steady_ids: [] } }), {
      hash: 'h1',
      day: 10,
    });
    ctx.semanticMemory.addFact({
      subjectSimId: '100',
      predicate: FactPredicate.SPOUSE,
      objectSimId: '999',
      source: 'told',
      day: 10,
    });
    const game = ctx.semanticMemory
      .getCurrentFacts('100')
      .find((f) => f.predicate === FactPredicate.SPOUSE && f.source === 'game');
    expect(game?.objectSimId).toBe('300');
    expect(game?.validToDay).toBeUndefined();
  });

  it('renders what the sim knows into a KNOWN_FACTS block', () => {
    ctx.semanticMemory.ingestDossier(dossier(), { hash: 'h1', day: 10 });
    const block = ctx.semanticMemory.recall('100', { mentionedSimIds: ['200'] });
    expect(block).toContain('<KNOWN_FACTS>');
    expect(block).toContain('you are elder');
    expect(block).toContain('Mackenzie Scott');
    // The family word beats the score band, and the score band still appears
    expect(block).toContain('your child');
    expect(block).toContain('a good friend');
  });

  it('recall is empty for a sim with no facts, so the prompt is unchanged', () => {
    expect(ctx.semanticMemory.recall('404')).toBe('');
  });

  it('finds the path between two sims through the edges', () => {
    ctx.semanticMemory.ingestDossier(dossier(), { hash: 'h1', day: 10 });
    ctx.semanticMemory.ingestDossier(
      {
        sim_id: '200',
        name: 'Mackenzie Scott',
        family: { parents: ['100'], children: ['400'], steady_ids: [] },
      },
      { hash: 'm1', day: 10 },
    );
    const direct = ctx.semanticMemory.pathBetween('100', '200');
    expect(direct.length).toBe(1);
    const twoHops = ctx.semanticMemory.pathBetween('100', '400', 2);
    expect(twoHops.length).toBe(2);
    expect(ctx.semanticMemory.pathBetween('100', '7777', 2)).toEqual([]);
  });

  it('keeps facts and the stored dossier across a restart', () => {
    ctx.semanticMemory.ingestDossier(dossier(), { hash: 'h1', day: 10 });

    const restarted = mockApiContext({ directoryService, settingsService });
    restarted.db.loadDatabase({ sessionId, saveId: '1' });

    expect(restarted.semanticMemory.getCurrentFacts('100').length).toBeGreaterThan(0);
    expect(restarted.semanticMemory.readDossier('100')?.name).toBe('Travis Scott');
    // ...and an unchanged dossier is still recognized as unchanged after the restart
    expect(restarted.semanticMemory.ingestDossier(dossier(), { hash: 'h1' }).skipped).toBe(true);
  });
});
