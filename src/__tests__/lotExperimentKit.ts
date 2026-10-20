import { vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { ApiContext } from 'main/sentient-sims/services/ApiContext';
import { NoopEmbeddingService } from 'main/sentient-sims/services/EmbeddingService';
import { InteractionEventStatus, LLMExchange } from 'main/sentient-sims/models/InteractionEventResult';
import { SettingsEnum } from 'main/sentient-sims/models/SettingsEnum';
import { SimAge } from 'main/sentient-sims/models/SimAge';
import { ApiType } from 'main/sentient-sims/models/ApiType';
import { SentientSim } from 'main/sentient-sims/models/SentientSim';
import { InteractionEvent, SSEventType } from 'main/sentient-sims/models/InteractionEvents';
import { LocationEntity } from 'main/sentient-sims/db/entities/LocationEntity';
import { DirectedGenerationOptions, parseSceneScores } from 'main/sentient-sims/services/AIService';
import { lotTraitLine } from 'main/sentient-sims/util/lotTraitWords';
import { mockApiContext } from './util';

// Shared plumbing for the lot description experiments: the OpenRouter key and a bare chat
// call, the two test sims, a throwaway ApiContext whose getLocation answers with the card
// under test, stage timing, JSONL resume, parallel lanes, spend from the key's usage, and
// the 15 real lotFacts fixtures. Not a test file; the experiments import it.

// ---- OpenRouter

// OPENROUTER_KEY, else the app's own setting (never printed)
export function loadOpenRouterKey(): string | undefined {
  if (process.env.OPENROUTER_KEY) return process.env.OPENROUTER_KEY;
  for (const folder of ['Electron', 'sentient-sims-app']) {
    try {
      const config = JSON.parse(
        fs.readFileSync(path.join(process.env.APPDATA ?? '', folder, 'config.json'), 'utf8'),
      ) as { openrouterKey?: string };
      if (config.openrouterKey) return config.openrouterKey;
    } catch {
      // no settings in this folder
    }
  }
  return undefined;
}

// Dollars the chat() calls of this process cost, as OpenRouter bills each reply
export const chatSpend = { dollars: 0, calls: 0 };

export async function chat(
  key: string,
  model: string,
  system: string,
  user: string,
  maxTokens: number,
): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, 90_000);
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          usage: { include: true },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: controller.signal,
      });
      const body = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
        error?: { message?: string };
        usage?: { cost?: number };
      };
      if (!response.ok || body.error) {
        throw new Error(`${response.status} ${body.error?.message ?? ''}`);
      }
      chatSpend.dollars += body.usage?.cost ?? 0;
      chatSpend.calls += 1;
      return body.choices?.[0]?.message?.content ?? '';
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  return '';
}

// Dollars this key has spent in all, from OpenRouter's own meter (it lags a few seconds)
export async function openRouterSpent(key: string): Promise<number | undefined> {
  try {
    const response = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${key}` } });
    const body = (await response.json()) as { data?: { usage?: number } };
    return typeof body.data?.usage === 'number' ? body.data.usage : undefined;
  } catch {
    return undefined;
  }
}

// The first {...} in a reply, parsed; undefined when there is none or it does not parse
export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

// ---- Env knobs, JSONL, lanes

export function envList<T extends string>(name: string, all: readonly T[]): T[] {
  const raw = process.env[name];
  if (!raw) return [...all];
  const picked = raw.split(',').map((item) => item.trim()) as T[];
  const unknown = picked.filter((item) => !all.includes(item));
  if (unknown.length > 0) throw new Error(`${name}: unknown ${unknown.join(', ')} (choose from ${all.join(', ')})`);
  return picked;
}

export function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : Number(raw);
}

export function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export function appendJsonl(file: string, row: unknown): void {
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}

// Runs every job across `lanes` workers; a throwing job stops its lane and fails the whole run
export async function runLanes<J>(jobs: J[], lanes: number, work: (job: J) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < jobs.length) {
      const job = jobs[next];
      next += 1;
      await work(job);
    }
  };
  await Promise.all(Array.from({ length: Math.min(lanes, jobs.length) }, lane));
}

// ---- The two test sims

export const RICKY = 'Ricky Rickerson';
export const RICHY = 'Richy Richardson';

export function sim(
  name: string,
  simId: string,
  traits: string[],
  mood: string,
  atHome: boolean,
  player: boolean,
): SentientSim {
  return {
    careers: [],
    name,
    age: SimAge.ADULT,
    sim_id: simId,
    gender: 'Male',
    traits,
    moods: [mood],
    is_ghost: false,
    grubby: false,
    in_pool: false,
    is_at_home: atHome,
    is_dying: false,
    is_human: true,
    is_inside_building: false,
    is_outside: false,
    is_pet: false,
    on_fire: false,
    on_home_lot: atHome,
    sleeping: false,
    is_pregnant: false,
    is_player_sim: player,
  };
}

// The Scratch-test adults, no facts seeded: Ricky lives there when the lot is a home
export function cast(atHome: boolean): [SentientSim, SentientSim] {
  return [
    sim(
      RICKY,
      '772948625141858300',
      ['trait_Evil', 'trait_Glutton', 'trait_CommitmentIssues'],
      'Mood_Confident',
      atHome,
      true,
    ),
    sim(
      RICHY,
      '772949305175180300',
      ['trait_Ambitious', 'trait_Romantic', 'trait_Outgoing'],
      'Mood_Happy',
      false,
      false,
    ),
  ];
}

// ---- Scenes

export type SceneSpec = { event: InteractionEvent; options: DirectedGenerationOptions };

function baseEvent(locationId: number, performers: SentientSim[], interactionName: string): InteractionEvent {
  return {
    event_id: randomUUID(),
    event_type: SSEventType.INTERACTION,
    location_id: locationId,
    relationships: { relationship_bits: [] },
    environment: { location_id: locationId, world_id: 0, time: { second: 0, minute: 0, hour: 19, day: 2, week: 1 } },
    sentient_sims: performers,
    interaction_name: interactionName,
  };
}

// A sim-to-sim beat driven by a one-line action
export function actionScene(
  locationId: number,
  performers: SentientSim[],
  action: string,
  interactionName: string,
): SceneSpec {
  return { event: baseEvent(locationId, performers, interactionName), options: { action, saveMemory: true } };
}

// The player asks one sim something; the sim answers full-length
export function playerAsk(
  locationId: number,
  performer: SentientSim,
  speaker: string,
  text: string,
  interactionName: string,
): SceneSpec {
  return {
    event: baseEvent(locationId, [performer], interactionName),
    options: { playerLine: { speaker, text }, saveMemory: true, suggestActionsOnly: true },
  };
}

export function expectedLocationBlock(location: LocationEntity): string {
  return `<LOCATION>\n${location.name} (${location.lot_type}), ${location.description}\n</LOCATION>`;
}

export type FreshContextOptions = { live: boolean; model?: string; key?: string };

// A throwaway context: one round, no default-description writer, no TTS, and getLocation
// answers with the location under test (the one way to put any text, stock included, in the card)
export function freshContext(sessionId: string, location: LocationEntity, options: FreshContextOptions): ApiContext {
  const ctx: ApiContext = mockApiContext({ tiers: [] });
  fs.mkdirSync(ctx.directory.getSentientSimsFolder(), { recursive: true });
  ctx.db.loadDatabase({ sessionId, saveId: '1' });
  ctx.settings.set(SettingsEnum.GENERATED_DEFAULT_DESCRIPTIONS, false);
  ctx.settings.set(SettingsEnum.SCENE_MAX_ROUNDS, 1);
  if (options.live && options.model) {
    ctx.settings.aiProviderConfigs = [
      { id: 'lot-exp', name: 'lot-exp', apiType: ApiType.OpenRouter, model: options.model },
    ];
    ctx.settings.defaultAiProviderConfigId = 'lot-exp';
    if (options.key) ctx.settings.openrouterKey = options.key;
  }
  vi.spyOn(ctx, 'embedding', 'get').mockReturnValue(new NoopEmbeddingService());
  vi.spyOn(ctx.modelSettings, 'getModelSettings').mockResolvedValue({
    temperature: undefined,
    top_p: undefined,
    top_k: undefined,
    repetition_penalty: undefined,
    max_tokens: 32000,
  });
  vi.spyOn(ctx.ai, 'playTtsLines').mockReturnValue(undefined);
  vi.spyOn(ctx.locationRepository, 'getLocation').mockReturnValue(location);
  return ctx;
}

export type StageTiming = { label: string; ms: number };

// Wraps runOneShot to time every stage; the original still runs (live) or a stub answers (dry)
export function timeStages(ctx: ApiContext, stub?: (label: string, systemPrompt: string) => string) {
  const timings: StageTiming[] = [];
  const systemPrompts: Record<string, string> = {};
  const original = ctx.ai.runOneShot.bind(ctx.ai);
  vi.spyOn(ctx.ai, 'runOneShot').mockImplementation(async (label, systemPrompt, ...rest) => {
    systemPrompts[label] = systemPrompt;
    const startedAt = Date.now();
    if (stub) {
      const text = stub(label, systemPrompt);
      timings.push({ label, ms: 0 });
      return { exchange: { label, request: { messages: [], maxResponseTokens: 0 }, responseText: text }, text };
    }
    try {
      return await original(label, systemPrompt, ...rest);
    } finally {
      timings.push({ label, ms: Date.now() - startedAt });
    }
  });
  return { timings, systemPrompts };
}

// The dry run's model: a briefing for the named performers, a plain line each, scores
export function dryStub(placeName: string, performers: string[]) {
  return (label: string): string => {
    if (label === 'Scene Scores') {
      return JSON.stringify(
        Object.fromEntries(
          performers.map((name) => [name, { memory: 5, action: 1, action_reason: '', unfinished: false, continue: 1 }]),
        ),
      );
    }
    if (label === 'Director Briefing') {
      const prompts = performers.map((name) => `=== PROMPT FOR ${name} ===\nPlay it straight.`).join('\n');
      return `=== SCENE ===\nA quiet beat at ${placeName}.\n${prompts}`;
    }
    if (label === 'Director Review') return '';
    return 'SAY: This place is fine.\nTHINK: It really is.';
  };
}

export function locationBlockSent(exchanges: LLMExchange[] | undefined): string | undefined {
  const briefing = exchanges?.find((exchange) => exchange.label === 'Director Briefing');
  const content = briefing?.request.messages.map((message) => message.content).join('\n') ?? '';
  return /<LOCATION>\n[\s\S]*?\n<\/LOCATION>/.exec(content)?.[0];
}

export function sharedBriefing(briefingText: string): string {
  return /===\s*SCENE\s*===\s*([\s\S]*?)(?=\n\s*===\s*PROMPT FOR|$)/i.exec(briefingText)?.[1]?.trim() ?? '';
}

export type SceneOutcome = {
  status: string;
  dialogue?: string;
  briefing?: string;
  sharedBriefing?: string;
  locationBlock?: string;
  fallbackUsed: boolean;
  scores?: Record<string, unknown>;
  error?: string;
  totalMs: number;
};

// One directed scene through the real pipeline; the context's database is closed after
export async function runDirected(ctx: ApiContext, spec: SceneSpec, timeoutMs = 240_000): Promise<SceneOutcome> {
  const startedAt = Date.now();
  const outcome: SceneOutcome = { status: 'ERROR', fallbackUsed: false, totalMs: 0 };
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`scene timed out after ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
    });
    const result = await Promise.race([ctx.ai.runDirectedGeneration(spec.event, spec.options), timeout]);
    outcome.status = result.status;
    outcome.locationBlock = locationBlockSent(result.exchanges);
    outcome.dialogue = result.text;
    const briefing = result.exchanges?.find((exchange) => exchange.label === 'Director Briefing');
    outcome.briefing = briefing?.responseText;
    outcome.sharedBriefing = briefing ? sharedBriefing(briefing.responseText) : '';
    outcome.fallbackUsed = !briefing || briefing.responseText.trim().length === 0;
    const scores = result.exchanges?.find((exchange) => exchange.label === 'Scene Scores');
    if (scores) {
      outcome.scores = Object.fromEntries(
        parseSceneScores(
          scores.responseText,
          spec.event.sentient_sims.map((performer) => performer.name),
        ),
      );
    }
    if (result.status !== InteractionEventStatus.GENERATED) outcome.error = `status ${result.status}`;
  } catch (err) {
    outcome.error = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
    outcome.totalMs = Date.now() - startedAt;
    try {
      ctx.db.unloadDatabase();
    } catch {
      // already closed
    }
  }
  return outcome;
}

// ---- Real lots

// The lotFacts shape (three from main.log, the rest built to match), with each lot's traits
export type RealLot = {
  key: string;
  name: string;
  venue: string;
  facts: string[];
  traits: string[];
  challenges?: string[];
};

export const REAL_LOTS: RealLot[] = [
  {
    key: 'calle',
    name: 'Calle de la Promesa',
    venue: 'venue_residential',
    facts: [
      'Kind of place: a private home',
      'Neighborhood: Vista Hermosa, Ciudad Enamorada',
      'Floors: three stories',
      'Main floor: a kitchen with bar stools, a coffee maker and a dining table; a living room with sofas, an armchair, a TV, a bookshelf, a stereo and coffee tables; outside: a patio with an easel, grills, a gravestone, garden planters and dining tables',
      'Second floor: three bedrooms, one with a computer and desks, another with dining tables, another with a punching bag and a stereo',
      'Third floor: outside: a patio with a telescope and a dining table',
      'The game describes it as: Home is just a few bricks away on this lot, perfectly situated on the outskirts of Vista Hermosa. With stunning views and friendly neighbors, this charming little spot is ready and waiting for you.',
      'Bedrooms: 3, bathrooms: 2',
    ],
    traits: [
      'zoneModifier_lotTrait_GreatAcoustics',
      'zoneModifier_lotTrait_FreshAir',
      'zoneModifiers_lotTrait_CelebrityHomeLotTrait',
      'zoneModifier_lotTrait_BurglarTime',
    ],
    challenges: ['zoneModifier_lotTrait_BurglarTime'],
  },
  {
    key: 'pectoral',
    name: 'Pectoral Fitness',
    venue: 'venue_gym',
    facts: [
      'Kind of place: a gym',
      'Neighborhood: Starlight Boulevard, Del Sol Valley',
      'Floors: two stories',
      'Main floor: a dining area with sofas, a bookshelf and a desk; three locker rooms, one with a sofa and a coffee table, another with a sofa and a coffee table, another with swimming pools, sofas, coffee tables and dining tables; two bathrooms; six restrooms; outside: sculptures',
      'Second floor: a workout room with punching bags; two locker rooms, one with a bookshelf and desks, another with treadmills, workout machines and a stereo',
      'The speakers play: Pop',
      'The game describes it as: In order to reach the peak of celebrity status you need to look the part. That is where Pectoral Fitness comes in! We have the workouts that will make you sweat. Do you have what it takes to hang with the best of them?',
    ],
    traits: ['zoneModifier_lotTrait_CelebrityHangOut_LowFame'],
  },
  {
    key: 'ward',
    name: 'Ward Park',
    venue: 'venue_ForestPark',
    facts: [
      'Kind of place: a national park',
      'Neighborhood: Mirage Park, Del Sol Valley',
      'Furnished with: benches, a picnic table, a grill',
      'The game describes it as: Need an escape from the hustle and bustle of the celebrity lifestyle? Ward Park is the perfect place to clear your mind, relax, and listen to the sounds of water.',
    ],
    traits: ['lotTrait_Generic_PeaceAndQuiet', 'zoneModifier_PetWorld_DogHangout'],
  },
  {
    key: 'salty',
    name: 'Salty Paws Saloon',
    venue: 'venue_bar',
    facts: [
      'Kind of place: a bar',
      "Neighborhood: Whiskerman's Wharf, Brindleton Bay",
      'Floors: two stories',
      'Main floor: a bar with bar stools, a jukebox and dining tables; a restroom; outside: a deck with dining tables and grills',
      'Second floor: two restrooms',
    ],
    traits: ['zoneModifier_PetWorld_DogFriendly', 'zoneModifier_lotTrait_Convivial'],
  },
  {
    key: 'llama',
    name: 'The Shrieking Llama',
    venue: 'venue_bar',
    facts: [
      'Kind of place: a bar',
      'Neighborhood: Windslar, Windenburg',
      'Floors: two stories',
      'Main floor: a bar with bar stools, a dartboard, a foosball table and dining tables; a restroom',
      'Second floor: a lounge with sofas, armchairs and a fireplace; outside: a balcony with dining tables',
    ],
    traits: ['zoneModifier_lotTrait_GreatAcoustics', 'zoneModifier_lotTrait_Singles_Hangout'],
  },
  {
    key: 'honeypop',
    name: 'Planet Honey Pop!',
    venue: 'venue_karaoke',
    facts: [
      'Kind of place: a karaoke bar',
      'Neighborhood: Fashion District, San Myshuno',
      'Floors: two stories',
      'Main floor: a bar with bar stools, karaoke machines, sofas and dining tables; two restrooms',
      'Second floor: karaoke rooms with sofas and karaoke machines; a bar with bar stools',
      'The speakers play: Pop',
    ],
    traits: ['zoneModifier_lotTrait_CelebrityHangOut_HighFame', 'zoneModifier_lotTrait_GreatAcoustics'],
  },
  {
    key: 'chic',
    name: '1310 21 Chic Street',
    venue: 'venue_residential',
    facts: [
      'Kind of place: a private home',
      'Neighborhood: Fashion District, San Myshuno',
      'Rooms: a kitchen with a dining table; a living room with a sofa, a TV, a bookshelf and a coffee table; a bedroom with a desk and a computer; a bathroom',
      'Bedrooms: 1, bathrooms: 1',
    ],
    traits: ['zoneModifier_pro_GreatView', 'zoneModifier_con_LivelyNeighbors', 'zoneModifier_lotTrait_QuakeZone'],
    challenges: ['zoneModifier_lotTrait_QuakeZone'],
  },
  {
    key: 'umbrage',
    name: 'Umbrage Manor',
    venue: 'venue_residential',
    facts: [
      'Kind of place: a private home',
      'Neighborhood: Foundry Cove, Willow Creek',
      'Floors: two stories',
      'Main floor: a kitchen with a dining table; a living room with sofas, a fireplace, a piano and bookshelves; a study with a desk and a computer; a bathroom; outside: a garden with garden planters and a bench',
      'Second floor: three bedrooms, one with a desk, another with a crib; a bathroom',
      'Bedrooms: 3, bathrooms: 2',
    ],
    traits: ['zoneModifier_lotTrait_Homey', 'zoneModifier_lotTrait_GreatSoil', 'zoneModifier_lotTrait_Gremlins'],
    challenges: ['zoneModifier_lotTrait_Gremlins'],
  },
  {
    key: 'vonhaunt',
    name: 'Von Haunt Estate',
    venue: 'venue_museum',
    facts: [
      'Kind of place: a museum',
      'Neighborhood: Olde Platz, Windenburg',
      'Floors: two stories',
      'Main floor: a gallery with paintings and sculptures; a library with bookshelves and armchairs; a ballroom with a piano; two restrooms; outside: a garden with hedges, fountains, benches and gravestones',
      'Second floor: galleries with paintings; a bedroom with a canopy bed',
    ],
    traits: ['zoneModifier_lotTrait_Haunted', 'zoneModifier_lotTrait_NaturalLight'],
    challenges: ['zoneModifier_lotTrait_Haunted'],
  },
  {
    key: 'gnomesarms',
    name: "The Gnome's Arms",
    venue: 'venue_bar',
    facts: [
      'Kind of place: a bar',
      'Neighborhood: Finchwick, Henford-on-Bagley',
      'Rooms: a bar with bar stools, a dartboard, a fireplace and dining tables; a restroom; outside: a beer garden with dining tables and a grill',
    ],
    traits: ['zoneModifier_LotTraits_Foxes', 'zoneModifier_lotTrait_SimpleLiving', 'zoneModifier_lotTrait_Convivial'],
    challenges: ['zoneModifier_LotTraits_Foxes', 'zoneModifier_lotTrait_SimpleLiving'],
  },
  {
    key: 'lagoon',
    name: 'Lagoon Look',
    venue: 'venue_residential',
    facts: [
      'Kind of place: a private home',
      "Neighborhood: Mua Pel'am, Sulani",
      'Rooms: a living room with a sofa and a TV; a kitchen with a dining table; a bedroom; a bathroom; outside: a deck with a grill, deck chairs and a hammock',
      'Bedrooms: 1, bathrooms: 1',
    ],
    traits: [
      'zoneModifier_lotTrait_OceanicParadise',
      'zoneModifier_lotTrait_IslandSpirits',
      'zoneModifier_lotTrait_OffTheGrid',
    ],
    challenges: ['zoneModifier_lotTrait_OffTheGrid'],
  },
  {
    key: 'canal',
    name: 'Canal Corner',
    venue: 'venue_residential',
    facts: [
      'Kind of place: a private home',
      'Neighborhood: Conifer Station, Evergreen Harbor',
      'Floors: two stories',
      'Main floor: a kitchen with a dining table; a living room with a sofa, a TV and a bookshelf; a bathroom; outside: a garden with garden planters, a compost bin and a wind turbine',
      'Second floor: two bedrooms, one with a desk; a bathroom',
      'Bedrooms: 2, bathrooms: 2',
    ],
    traits: ['zoneModifier_lotTrait_EcoLot', 'zoneModifier_lotTrait_Geothermal', 'zoneModifier_lotTrait_LandfillLot'],
    challenges: ['zoneModifier_lotTrait_LandfillLot'],
  },
  {
    key: 'archive',
    name: 'Willow Creek Archive',
    venue: 'venue_library',
    facts: [
      'Kind of place: a library',
      'Neighborhood: Courtyard Lane, Willow Creek',
      'Floors: two stories',
      'Main floor: a library with bookshelves, armchairs, desks and computers; two restrooms',
      'Second floor: a reading room with bookshelves, sofas and a chess table; a study with desks and computers',
    ],
    traits: ['zoneModifier_lotTrait_StudySpot', 'lotTrait_Generic_PeaceAndQuiet'],
  },
  {
    key: 'movers',
    name: 'Movers & Shakers Gym',
    venue: 'venue_gym',
    facts: [
      'Kind of place: a gym',
      'Neighborhood: Parched Prospect, Oasis Springs',
      'Rooms: a workout room with treadmills, workout machines, punching bags and a stereo; a locker room with showers and lockers; two restrooms; outside: a pool with loungers and a basketball hoop',
      'The speakers play: Electronica',
    ],
    traits: ['zoneModifier_lotTrait_FreshAir', 'zoneModifier_lotTrait_UniversityStudentHangout'],
  },
  {
    key: 'magnolia',
    name: 'Magnolia Blossom Park',
    venue: 'venue_park',
    facts: [
      'Kind of place: a park',
      'Neighborhood: Sage Estates, Willow Creek',
      'Furnished with: benches, picnic tables, grills, a fishing spot, a playground slide, a chess table, a fountain, garden planters',
    ],
    traits: ['zoneModifier_lotTrait_ChildsPlay', 'zoneModifier_PetWorld_CatHangout', 'zoneModifier_lotTrait_GreatSoil'],
  },
];

// Name line, the facts, then the trait line as lotFacts writes it (with or without the clauses)
export function realLotFacts(lot: RealLot, traits: 'none' | 'names' | 'flavor' = 'flavor'): string {
  const lines = [`Name: ${lot.name}`, ...lot.facts];
  if (traits !== 'none') {
    const line = lotTraitLine(lot.traits, lot.challenges, { flavor: traits === 'flavor' });
    if (line) lines.push(line);
  }
  return lines.join('\n');
}
