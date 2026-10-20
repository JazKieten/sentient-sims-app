import { Server } from 'http';
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runApi } from 'main/sentient-sims/api';
import { SimStateReport } from 'main/sentient-sims/models/SimStateReport';
import { lotFacts } from 'main/sentient-sims/util/lotDescription';
import { cleanPlayerWords, guessFromName, LotWordRow } from 'main/sentient-sims/services/LotWordsService';
import { StageId } from 'main/sentient-sims/pipeline/stages';
import { articleFor, pluralOf, splitArticle, withArticle } from 'main/sentient-sims/util/lotFurnishings';
import { LocationEntity } from 'main/sentient-sims/db/entities/LocationEntity';
import { mockApiContext, mockEnvironment } from './util';

// The dev build's Lot Words panel: GET /lot-words lists the furnishings on lots visited this
// run that have no plain words, each with a first guess; POST /lot-words/suggest asks the AI
// for better ones; PUT saves a player's words to lot-words.json, and the writer's facts use
// them from then on.
describe('/lot-words', () => {
  const { directoryService, settingsService } = mockEnvironment();
  const ctx = mockApiContext({ port: 25210, directoryService, settingsService });
  const apiUrl = `http://localhost:${ctx.port}`;
  const lot = {
    zone_id: 7,
    lot_id: '2841378864',
    lot_name: 'Pectoral Fitness',
    venue: 'venue_gym',
    furnishings: ['object_dish_stack', 'object_piano', 'object_wallLamp', 'object_mystery_GP01'],
  };
  let server: Server;

  async function rows(): Promise<LotWordRow[]> {
    const response = await fetch(`${apiUrl}/lot-words`);
    return ((await response.json()) as { rows: LotWordRow[] }).rows;
  }

  beforeAll(() => {
    fs.mkdirSync(ctx.directory.getSentientSimsFolder(), { recursive: true });
    ctx.simStateCache.ingest({ type: 'state_report', seq: 1, lot, sims: [] } as unknown as SimStateReport);
    server = runApi(ctx);
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  });

  it('lists the unmapped names with the lots they are on and a guess from the name, never structure or known kinds', async () => {
    expect(await rows()).toEqual([
      {
        name: 'object_dish_stack',
        lots: ['Pectoral Fitness'],
        suggestion: { word: { one: 'a dish stack', many: 'dish stacks' }, source: 'name' },
      },
      {
        name: 'object_mystery_GP01',
        lots: ['Pectoral Fitness'],
        suggestion: { word: { one: 'a mystery', many: 'mysteries' }, source: 'name' },
      },
    ]);
  });

  it('says which lots were checked and how many of their items have no words', async () => {
    ctx.simStateCache.ingest({
      type: 'state_report',
      seq: 2,
      lot: { zone_id: 8, lot_id: '1', lot_name: 'Studio PBP', venue: 'venue_lounge', furnishings: ['object_violin'] },
      sims: [],
    } as unknown as SimStateReport);
    const response = await fetch(`${apiUrl}/lot-words`);
    expect(((await response.json()) as { lots: unknown }).lots).toEqual([
      { name: 'Pectoral Fitness', missing: 2 },
      { name: 'Studio PBP', missing: 0 },
    ]);
  });

  it("puts the AI's guesses on the rows without letting them into the facts", async () => {
    const runOneShot = vi.spyOn(ctx.ai, 'runOneShot').mockResolvedValue({
      exchange: { label: 'Lot Words', request: { messages: [] }, responseText: '' },
      text: 'Sure: {"object_dish_stack": {"noun": "Dish rack", "plural": "dish racks"}, "object_mystery_GP01": null}',
    } as unknown as Awaited<ReturnType<typeof ctx.ai.runOneShot>>);
    const response = await fetch(`${apiUrl}/lot-words/suggest`, { method: 'POST' });
    const body = (await response.json()) as { rows: LotWordRow[]; unsuggested: number };
    expect(response.status).toBe(200);
    expect(body.unsuggested).toBe(0);
    expect(body.rows.map((row) => row.suggestion)).toEqual([
      { word: { one: 'a dish rack', many: 'dish racks' }, source: 'ai' },
      { word: null, source: 'ai' },
    ]);
    expect(runOneShot).toHaveBeenCalledTimes(1);
    expect(runOneShot.mock.calls[0][2]).toBe(['object_dish_stack', 'object_mystery_GP01'].join('\n'));
    expect(runOneShot.mock.calls[0][7]).toEqual({ stageId: StageId.LOT_WORDS, interactive: true });
    expect(
      JSON.parse(
        fs.readFileSync(path.join(ctx.directory.getSentientSimsFolder(), 'lot-word-suggestions.json'), 'utf-8'),
      ),
    ).toEqual({ object_dish_stack: { one: 'a dish rack', many: 'dish racks' }, object_mystery_GP01: null });
    expect(lotFacts({ id: 2841378864, name: 'Pectoral Fitness' } as LocationEntity, lot)).not.toContain('dish rack');
    await fetch(`${apiUrl}/lot-words/suggest`, { method: 'POST' });
    expect(runOneShot).toHaveBeenCalledTimes(1);
    runOneShot.mockRestore();
  });

  it('saves trimmed words, drops a row with none, and the facts use them', async () => {
    const response = await fetch(`${apiUrl}/lot-words`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        words: { ' object_dish_stack ': { one: ' a dish rack ', many: '' }, 'object_mystery_GP01': { one: '  ' } },
      }),
    });
    expect(response.status).toBe(200);
    const saved = JSON.parse(
      fs.readFileSync(path.join(ctx.directory.getSentientSimsFolder(), 'lot-words.json'), 'utf-8'),
    ) as unknown;
    expect(saved).toEqual({ object_dish_stack: { one: 'a dish rack', many: 'a dish rack' } });
    expect(await rows()).toEqual([
      { name: 'object_mystery_GP01', lots: ['Pectoral Fitness'], suggestion: { word: null, source: 'ai' } },
      { name: 'object_dish_stack', word: { one: 'a dish rack', many: 'a dish rack' }, lots: ['Pectoral Fitness'] },
    ]);
    expect(lotFacts({ id: 2841378864, name: 'Pectoral Fitness' } as LocationEntity, lot)).toContain('a dish rack');
  });

  it('keeps a name left out off the unmapped list', async () => {
    await fetch(`${apiUrl}/lot-words`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ words: { object_mystery_GP01: null } }),
    });
    expect(await rows()).toEqual([
      {
        name: 'object_dish_stack',
        lots: ['Pectoral Fitness'],
        suggestion: { word: { one: 'a dish rack', many: 'dish racks' }, source: 'ai' },
      },
      { name: 'object_mystery_GP01', word: null, lots: ['Pectoral Fitness'] },
    ]);
  });
});

describe('lot word helpers', () => {
  it('reads a guess off the tuning name without pack codes, sizes or tiers', () => {
    expect(guessFromName('object_vetMedicineStation')).toEqual({
      one: 'a vet medicine station',
      many: 'vet medicine stations',
    });
    expect(guessFromName('object_CateringTable_Nice')).toEqual({ one: 'a catering table', many: 'catering tables' });
    expect(guessFromName('object_easel_GP01_large')).toEqual({ one: 'an easel', many: 'easels' });
    expect(guessFromName('object_2x1')).toBeUndefined();
  });

  it('picks a or an by sound and splits an article off', () => {
    expect(articleFor('easel')).toBe('an');
    expect(articleFor('unicorn lamp')).toBe('a');
    expect(articleFor('hour glass')).toBe('an');
    expect(articleFor('dish rack')).toBe('a');
    expect(splitArticle('an easel')).toEqual({ article: 'an', noun: 'easel' });
    expect(splitArticle('art supplies')).toEqual({ article: 'none', noun: 'art supplies' });
    expect(withArticle('art supplies', 'none')).toBe('art supplies');
    expect(pluralOf('bench')).toBe('benches');
    expect(pluralOf('camera dolly')).toBe('camera dollies');
    expect(pluralOf("director's chair")).toBe("director's chairs");
  });

  it('cleans saved words: spaces collapsed, a leading article lowercased', () => {
    expect(cleanPlayerWords({ x: { one: 'A  Dish rack', many: '  ' }, y: null, z: { one: '' } })).toEqual({
      x: { one: 'a Dish rack', many: 'a Dish rack' },
      y: null,
    });
  });
});
