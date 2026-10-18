import { Server } from 'http';
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runApi } from 'main/sentient-sims/api';
import { SimStateReport } from 'main/sentient-sims/models/SimStateReport';
import { lotFacts } from 'main/sentient-sims/util/lotDescription';
import { LotWordRow } from 'main/sentient-sims/services/LotWordsService';
import { LocationEntity } from 'main/sentient-sims/db/entities/LocationEntity';
import { mockApiContext, mockEnvironment } from './util';

// The dev build's Lot Words panel: GET /lot-words lists the furnishings on lots visited this
// run that have no plain words; PUT saves a player's words to lot-words.json, and the writer's
// facts use them from then on.
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

  it('lists the unmapped names with the lots they are on, never structure or known kinds', async () => {
    expect(await rows()).toEqual([
      { name: 'object_dish_stack', lots: ['Pectoral Fitness'] },
      { name: 'object_mystery_GP01', lots: ['Pectoral Fitness'] },
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
      { name: 'object_mystery_GP01', lots: ['Pectoral Fitness'] },
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
      { name: 'object_dish_stack', lots: ['Pectoral Fitness'] },
      { name: 'object_mystery_GP01', word: null, lots: ['Pectoral Fitness'] },
    ]);
  });
});
