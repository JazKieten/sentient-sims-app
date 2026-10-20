import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { InteractionEventStatus } from 'main/sentient-sims/models/InteractionEventResult';
import { LocationEntity } from 'main/sentient-sims/db/entities/LocationEntity';
import { LOCATION_DESCRIPTION_SYSTEM_PROMPT } from 'main/sentient-sims/pipeline/prompts/utility';
import { lotTypeLabel, placeDescriptionProblems } from 'main/sentient-sims/util/lotDescription';
import { lotTraitLine } from 'main/sentient-sims/util/lotTraitWords';
import { cleanupAIOutput } from 'main/sentient-sims/formatter/PromptFormatter';
import {
  REAL_LOTS,
  RICHY,
  RICKY,
  RealLot,
  SceneOutcome,
  SceneSpec,
  actionScene,
  appendJsonl,
  chatSpend,
  cast,
  chat,
  dryStub,
  envList,
  envNumber,
  expectedLocationBlock,
  freshContext,
  loadOpenRouterKey,
  openRouterSpent,
  parseJsonObject,
  playerAsk,
  readJsonl,
  realLotFacts,
  runDirected,
  runLanes,
  timeStages,
} from './lotExperimentKit';

// Lot depth experiment (2026-10-19): does mapping furnishings to plain words improve the cards
// and the scenes played on them? Actors never name props (scene SAY rules, the reviewer) and see
// the card only through the director, so furnishings can only matter by helping the writer get
// sentence 1 (what kind of place) and the last sentence (its character, who it is for) right.
//
// The 15 real lotFacts strings at three depths: `full` as lotFacts writes them; `bare` without
// any furnishing line (Rooms, per-floor lines, Furnished with, Floors, speakers) but with the
// blurb, bedrooms/bathrooms, lot type, neighborhood and trait line; `defining` = bare plus one
// "Furnished with:" line of DEFINING_WORDS hits. Writer (production prompt + gate, 2 tries) ->
// card judge -> directed scenes (chat, ask_place, plan) -> scene judge -> pairwise preference
// in both orders -> summary.md. Gated so `npm run check` never runs it:
//
//   LOT_DEPTH_EXPERIMENT=dry   no network: the three derivations, one mocked scene per depth
//   LOT_DEPTH_EXPERIMENT=live  OpenRouter (key: OPENROUTER_KEY or the app's config.json, never
//                              printed), resumable JSONL + summary.md in LOT_OUT
//   LOT_DEPTH_EXPERIMENT=summary  no network: summary.md from the JSONL already in LOT_OUT
//
// Knobs: LOT_LOTS, LOT_DEPTHS, LOT_DRAFTS (2), LOT_EVENTS, LOT_SAMPLES (2 per lot x depth x event,
// sample n plays draft n), LOT_LANES (4), LOT_PAIRS (60 per comparison, ask_place/plan first),
// LOT_MODEL (writer and scenes), LOT_JUDGE, LOT_BUDGET (dollars, 15).
//
// Decision rule:
// - full beats defining at 65%+ on ask_place/plan, or `aware` +0.3: mapping matters, keep going
// - defining beats bare by that margin but full ~ defining: map defining objects only
// - all three within noise and `invented` does not rise at bare: stop mapping the long tail
//   (facts shrink to defining objects)
// - bare makes the writer guess (`grounded` falls): keep defining regardless
// At 60 pairs per comparison a 55% win is noise; 65%+ is readable.

const MODE = process.env.LOT_DEPTH_EXPERIMENT;
const OUT_DIR = process.env.LOT_OUT ?? path.join(os.tmpdir(), 'lot-depth');
const MODEL = process.env.LOT_MODEL ?? 'meta-llama/llama-3.3-70b-instruct';
const JUDGE = process.env.LOT_JUDGE ?? 'anthropic/claude-sonnet-4.5';
const BUDGET = envNumber('LOT_BUDGET', 15);
const MAX_DESCRIPTION_TOKENS = 220;

export type Depth = 'full' | 'defining' | 'bare';
const DEPTHS: Depth[] = ['full', 'defining', 'bare'];

type EventKind = 'chat' | 'ask_place' | 'plan';
const EVENTS: EventKind[] = ['chat', 'ask_place', 'plan'];

const COMPARISONS: [Depth, Depth][] = [
  ['full', 'bare'],
  ['full', 'defining'],
  ['defining', 'bare'],
];

// Objects that say what kind of place it is or who it is for. No seating, tables, storage,
// decor, computers or bookshelves. Each pattern is matched whole-word, with an optional article.
export const DEFINING_WORDS: { word: string; pattern: string }[] = [
  { word: 'pool', pattern: '(?:swimming\\s+)?pools?(?!\\s+tables?)' },
  { word: 'hot tub', pattern: 'hot\\s+tubs?' },
  { word: 'bar', pattern: 'bars?(?!\\s+stools?)' },
  { word: 'stage light', pattern: 'stage\\s+lights?' },
  { word: 'microphone', pattern: 'microphones?(?:\\s+stands?)?' },
  { word: 'karaoke', pattern: 'karaoke\\s+machines?' },
  { word: 'DJ booth', pattern: 'DJ\\s+booths?' },
  { word: 'jukebox', pattern: 'jukebox(?:es)?' },
  { word: 'dance floor', pattern: 'dance\\s+floors?' },
  { word: 'treadmill', pattern: 'treadmills?' },
  { word: 'workout machine', pattern: 'workout\\s+machines?' },
  { word: 'punching bag', pattern: 'punching\\s+bags?' },
  { word: 'climbing wall', pattern: '(?:rock\\s+)?climbing\\s+walls?' },
  { word: 'yoga mat', pattern: 'yoga\\s+mats?' },
  { word: 'locker', pattern: 'lockers?(?:\\s+rooms?)?' },
  { word: 'sauna', pattern: 'saunas?' },
  { word: 'massage table', pattern: 'massage\\s+(?:tables?|chairs?)' },
  { word: 'grill', pattern: 'grills?' },
  { word: 'fire pit', pattern: 'fire\\s*pits?' },
  { word: 'picnic table', pattern: 'picnic\\s+tables?' },
  { word: 'playground', pattern: 'playground(?:\\s+(?:slides?|equipment|sets?))?' },
  { word: 'easel', pattern: 'easels?' },
  { word: 'pottery wheel', pattern: 'pottery\\s+wheels?' },
  { word: 'woodworking table', pattern: 'woodworking\\s+(?:tables?|benches?)' },
  { word: 'instrument', pattern: '(?:grand\\s+)?pianos?|guitars?|violins?|drum\\s+(?:sets?|kits?)|drums' },
  { word: 'telescope', pattern: 'telescopes?' },
  { word: 'microscope', pattern: 'microscopes?' },
  { word: 'chemistry table', pattern: 'chemistry\\s+(?:tables?|labs?|sets?)' },
  { word: 'arcade', pattern: 'arcade\\s+(?:machines?|games?)' },
  { word: 'bowling', pattern: 'bowling\\s+(?:lanes?|alleys?)' },
  { word: 'foosball', pattern: 'foosball\\s+tables?' },
  { word: 'chess', pattern: 'chess\\s+tables?|chessboards?' },
  { word: 'pool table', pattern: 'pool\\s+tables?' },
  { word: 'dartboard', pattern: 'dartboards?' },
  { word: 'basketball', pattern: 'basketball\\s+(?:hoops?|courts?)' },
  { word: 'fishing spot', pattern: 'fishing\\s+spots?' },
  { word: 'fountain', pattern: 'fountains?' },
  { word: 'gravestone', pattern: 'gravestones?|tombstones?' },
  { word: 'crib', pattern: 'cribs?' },
];

const ARTICLE = '(?:\\b(?:an?|the)\\s+)?';

const FURNISHING_LINE = /^(?:Rooms|Floors|Furnished with|The speakers play|Basement|[A-Z][a-z]+ floor):/;

function isHome(lot: RealLot): boolean {
  return lotTypeLabel(lot.venue).endsWith('Residence');
}

export function furnishingLines(lot: RealLot): string[] {
  return realLotFacts(lot)
    .split('\n')
    .filter((line) => FURNISHING_LINE.test(line));
}

// Every DEFINING_WORDS hit in the lot's furnishing lines, in reading order, as the facts say it
export function definingHits(lot: RealLot): string[] {
  const text = furnishingLines(lot)
    .map((line) => line.replace(FURNISHING_LINE, ''))
    .join('\n');
  const hits: { index: number; text: string }[] = [];
  for (const { pattern } of DEFINING_WORDS) {
    const match = new RegExp(`${ARTICLE}\\b(?:${pattern})\\b`, 'i').exec(text);
    if (match) hits.push({ index: match.index, text: match[0].trim() });
  }
  return hits
    .sort((a, b) => a.index - b.index)
    .map((hit) => hit.text)
    .filter((hit, index, all) => all.indexOf(hit) === index);
}

export function isDefiningItem(item: string): boolean {
  return DEFINING_WORDS.some(({ pattern }) => new RegExp(`^${ARTICLE}(?:${pattern})$`, 'i').test(item));
}

export function depthFacts(lot: RealLot, depth: Depth): string {
  const lines = realLotFacts(lot).split('\n');
  if (depth === 'full') return lines.join('\n');
  const at = lines.findIndex((line) => FURNISHING_LINE.test(line));
  const bare = lines.filter((line) => !FURNISHING_LINE.test(line));
  const hits = definingHits(lot);
  if (depth === 'bare' || hits.length === 0 || at < 0) return bare.join('\n');
  bare.splice(at, 0, `Furnished with: ${hits.join(', ')}`);
  return bare.join('\n');
}

function locationFor(lot: RealLot, card: string): LocationEntity {
  return {
    id: 7_000_000 + REAL_LOTS.indexOf(lot),
    name: lot.name,
    lot_type: lotTypeLabel(lot.venue),
    description: card,
  };
}

function sceneFor(lot: RealLot, location: LocationEntity, event: EventKind, playerSpeaker: string): SceneSpec {
  const [ricky, richy] = cast(isHome(lot));
  switch (event) {
    case 'chat':
      return actionScene(
        location.id,
        [ricky, richy],
        `${RICKY} and ${RICHY} are catching up on the week.`,
        'lot_depth_chat',
      );
    case 'plan':
      return actionScene(
        location.id,
        [ricky, richy],
        `${RICKY} and ${RICHY} decide what to do here next.`,
        'lot_depth_plan',
      );
    case 'ask_place':
    default:
      return playerAsk(location.id, ricky, playerSpeaker, 'What do you think of this place?', 'lot_depth_ask');
  }
}

function situation(lot: RealLot, event: EventKind): string {
  const home = isHome(lot) ? ` ${RICKY} lives here; ${RICHY} is visiting.` : '';
  switch (event) {
    case 'chat':
      return `${RICKY} and ${RICHY} are catching up on the week.${home}`;
    case 'plan':
      return `${RICKY} and ${RICHY} decide what to do here next.${home}`;
    case 'ask_place':
    default:
      return `The player asks ${RICKY}: "What do you think of this place?"${home}`;
  }
}

// ---- Judges

const CARD_JUDGE_PROMPT = `You judge one short reference card for a place in The Sims 4. You see everything the game knows about the place; the card's writer may have been shown less. Answer with JSON only, in this exact shape:
{"kind":0|1,"who":0|1|2,"specific":0|1|2,"grounded":0|1,"invented":0|1,"note":"<a few words>"}
kind: 1 if the first sentence names the right kind of place for these facts (a gym as a gym, a family home as a home), else 0.
who: what the card's closing says the place is like and who it is for. 0 = missing, generic or wrong for these facts; 1 = plausible but would fit any place of this kind; 2 = specific to this place and true to the facts.
specific: 0 = the card would fit any place of its kind; 1 = a few details only this place has; 2 = unmistakably this place.
grounded: 1 if the card is built from concrete particulars the facts give; 0 if it leans on filler or hedged guesses where it knows nothing ("various amenities", "a range of equipment", stock rooms, generic atmosphere).
invented: 1 if the card names any room, object, feature, view, sound, person or event the facts do not support, else 0.`;

const SCENE_JUDGE_PROMPT = `You judge one short scene from The Sims 4: what the sims said, at a place whose facts you are given. Answer with JSON only, in this exact shape:
{"fits":0|1|2,"aware":0|1|2,"invented":0|1,"place_words":0|1,"note":"<a few words>"}
fits: 0 = the talk clashes with this place or could be anywhere; 1 = compatible with it; 2 = clearly belongs at this place.
aware: 0 = no sign they know where they are; 1 = a passing nod to the place; 2 = the place shapes what they say or want to do.
invented: 1 if anyone claims a feature of the place (a room, object, view, activity on offer) the facts do not support, else 0.
place_words: 1 if any line names a specific piece of furniture or equipment (the jukebox, a treadmill, the sofa); naming the kind of place or an activity does not count.`;

const PAIR_PROMPT = `You compare two versions of the same short scene from The Sims 4: the same sims, the same situation, the same place. Pick the one where the sims more plainly know where they are and talk, or plan, the way people at THIS place would. A version that claims something the place does not have, or lists its furniture, loses on that. If neither is better, answer tie. Answer with JSON only, in this exact shape:
{"winner":"A"|"B"|"tie","why":"<a few words>"}`;

type CardVerdict = { kind: number; who: number; specific: number; grounded: number; invented: number; note: string };
type SceneVerdict = { fits: number; aware: number; invented: number; place_words: number; note: string };

function num(value: unknown): number {
  return Number(value) || 0;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseCardVerdict(text: string): CardVerdict | undefined {
  const parsed = parseJsonObject(text);
  if (!parsed || parsed.kind === undefined) return undefined;
  return {
    kind: num(parsed.kind),
    who: num(parsed.who),
    specific: num(parsed.specific),
    grounded: num(parsed.grounded),
    invented: num(parsed.invented),
    note: str(parsed.note),
  };
}

function parseSceneVerdict(text: string): SceneVerdict | undefined {
  const parsed = parseJsonObject(text);
  if (!parsed || parsed.fits === undefined) return undefined;
  return {
    fits: num(parsed.fits),
    aware: num(parsed.aware),
    invented: num(parsed.invented),
    place_words: num(parsed.place_words),
    note: str(parsed.note),
  };
}

function parseWinner(reply: string): 'A' | 'B' | 'tie' | undefined {
  const winner = str(parseJsonObject(reply)?.winner).trim().toUpperCase();
  if (winner === 'A' || winner === 'B') return winner;
  return winner === 'TIE' ? 'tie' : undefined;
}

// ---- Rows

type CardRow = {
  key: string;
  lot: string;
  depth: Depth;
  draft: number;
  facts: string;
  attempts: { text: string; problems: string[] }[];
  card?: string;
  error?: string;
  at: string;
};

type CardVerdictRow = { key: string; verdict?: CardVerdict; raw: string };

type SceneRow = SceneOutcome & {
  key: string;
  lot: string;
  depth: Depth;
  event: EventKind;
  sample: number;
  draft: number;
  card: string;
  at: string;
};

type SceneVerdictRow = { key: string; verdict?: SceneVerdict; raw: string };

type PairRow = {
  key: string;
  comparison: string;
  lot: string;
  event: EventKind;
  sample: number;
  order: 'ab' | 'ba';
  winner?: Depth | 'tie';
  raw: string;
};

// Latest row per key wins, so a retried job replaces its failed row
function latest<T extends { key: string }>(file: string): Map<string, T> {
  const rows = new Map<string, T>();
  readJsonl<T>(file).forEach((row) => rows.set(row.key, row));
  return rows;
}

// ---- Spend

type State = { spent: number; wallMs: number };

class Meter {
  private readonly stateFile: string;

  private readonly prior: State;

  private baseline = 0;

  private readonly startedAt = Date.now();

  constructor(
    private readonly key: string,
    outDir: string,
  ) {
    this.stateFile = path.join(outDir, 'state.json');
    this.prior = fs.existsSync(this.stateFile)
      ? (JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as State)
      : { spent: 0, wallMs: 0 };
  }

  async start() {
    this.baseline = (await openRouterSpent(this.key)) ?? 0;
  }

  // Dollars spent across every run of this LOT_OUT (the key's meter lags a few seconds)
  async spent(): Promise<number> {
    const now = (await openRouterSpent(this.key)) ?? this.baseline;
    const total = this.prior.spent + Math.max(now - this.baseline, 0);
    const state: State = { spent: total, wallMs: this.prior.wallMs + Date.now() - this.startedAt };
    fs.writeFileSync(this.stateFile, JSON.stringify(state));
    return total;
  }

  wallMs(): number {
    return this.prior.wallMs + Date.now() - this.startedAt;
  }
}

// Rough judge costs on sonnet-4.5 for the projection, dollars per call
const CARD_JUDGE_COST = 0.006;
const SCENE_JUDGE_COST = 0.008;
const PAIR_COST = 0.012;

// ---- Summary

const avg = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN);
const fmt = (value: number, digits = 2) => (Number.isNaN(value) ? '-' : value.toFixed(digits));
const pct = (value: number) => (Number.isNaN(value) ? '-' : `${Math.round(100 * value)}%`);

type SummaryInput = {
  lots: RealLot[];
  depths: Depth[];
  events: EventKind[];
  cards: CardRow[];
  cardVerdicts: Map<string, CardVerdictRow>;
  scenes: SceneRow[];
  sceneVerdicts: Map<string, SceneVerdictRow>;
  pairs: PairRow[];
  spent: number;
  wallMs: number;
};

function lotGroup(lotKey: string): 'home' | 'venue' {
  const lot = REAL_LOTS.find((candidate) => candidate.key === lotKey);
  return lot && isHome(lot) ? 'home' : 'venue';
}

function cardTable(input: SummaryInput, group?: 'home' | 'venue'): string[] {
  const lines = [
    '| depth | drafts | passed | first try | kind | who (0-2) | specific (0-2) | grounded | invented | words |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const depth of input.depths) {
    const rows = input.cards.filter((row) => row.depth === depth && (!group || lotGroup(row.lot) === group));
    const passed = rows.filter((row) => row.card);
    const verdicts = passed
      .map((row) => input.cardVerdicts.get(row.key)?.verdict)
      .filter((verdict): verdict is CardVerdict => verdict !== undefined);
    const firstTry = rows.filter((row) => row.attempts[0]?.problems.length === 0).length;
    const words = avg(passed.map((row) => (row.card ?? '').split(/\s+/).length));
    lines.push(
      `| ${depth} | ${rows.length} | ${passed.length} | ${pct(firstTry / rows.length)} | ${pct(avg(verdicts.map((v) => v.kind)))} | ${fmt(avg(verdicts.map((v) => v.who)))} | ${fmt(avg(verdicts.map((v) => v.specific)))} | ${pct(avg(verdicts.map((v) => v.grounded)))} | ${pct(avg(verdicts.map((v) => v.invented)))} | ${fmt(words, 0)} |`,
    );
  }
  return lines;
}

function sceneTable(input: SummaryInput, by: 'event' | 'group', events: EventKind[]): string[] {
  const lines = [
    `| depth | ${by} | scenes run | judged | fits (0-2) | aware (0-2) | invented | place words |`,
    '|---|---|---|---|---|---|---|---|',
  ];
  const splits: string[] = by === 'event' ? events : ['venue', 'home'];
  for (const depth of input.depths) {
    for (const split of splits) {
      const rows = input.scenes.filter(
        (row) =>
          row.depth === depth &&
          events.includes(row.event) &&
          (by === 'event' ? row.event === split : lotGroup(row.lot) === split),
      );
      const verdicts = rows
        .map((row) => input.sceneVerdicts.get(row.key)?.verdict)
        .filter((verdict): verdict is SceneVerdict => verdict !== undefined);
      lines.push(
        `| ${depth} | ${split} | ${rows.length} | ${verdicts.length} | ${fmt(avg(verdicts.map((v) => v.fits)))} | ${fmt(avg(verdicts.map((v) => v.aware)))} | ${pct(avg(verdicts.map((v) => v.invented)))} | ${pct(avg(verdicts.map((v) => v.place_words)))} |`,
      );
    }
  }
  return lines;
}

type PairStats = { judgments: number; firstWins: number; ties: number; pairs: number; consistent: number };

function pairStats(input: SummaryInput, comparison: string, keep: (row: PairRow) => boolean): PairStats {
  const [first] = comparison.split('-');
  const rows = input.pairs.filter((row) => row.comparison === comparison && row.winner && keep(row));
  const byPair = new Map<string, PairRow[]>();
  rows.forEach((row) => {
    const id = `${row.lot}/${row.event}/${row.sample}`;
    byPair.set(id, [...(byPair.get(id) ?? []), row]);
  });
  const both = Array.from(byPair.values()).filter((pair) => pair.length === 2);
  return {
    judgments: rows.length,
    firstWins:
      rows.filter((row) => row.winner === first).length + 0.5 * rows.filter((row) => row.winner === 'tie').length,
    ties: rows.filter((row) => row.winner === 'tie').length,
    pairs: both.length,
    consistent: both.filter((pair) => pair[0].winner === pair[1].winner).length,
  };
}

function pairTable(input: SummaryInput): string[] {
  const lines = [
    '| comparison | events | judgments | first depth wins (ties half) | ties | consistent across orders |',
    '|---|---|---|---|---|---|',
  ];
  const groups: [string, (row: PairRow) => boolean][] = [
    ['ask_place + plan', (row) => row.event !== 'chat'],
    ['ask_place', (row) => row.event === 'ask_place'],
    ['plan', (row) => row.event === 'plan'],
    ['chat', (row) => row.event === 'chat'],
    ['ask_place + plan, venues', (row) => row.event !== 'chat' && lotGroup(row.lot) === 'venue'],
    ['ask_place + plan, homes', (row) => row.event !== 'chat' && lotGroup(row.lot) === 'home'],
  ];
  for (const [a, b] of COMPARISONS) {
    if (!input.depths.includes(a) || !input.depths.includes(b)) continue;
    for (const [label, keep] of groups) {
      const stats = pairStats(input, `${a}-${b}`, keep);
      if (stats.judgments === 0) continue;
      lines.push(
        `| ${a} vs ${b} | ${label} | ${stats.judgments} | ${a} ${pct(stats.firstWins / stats.judgments)} | ${pct(stats.ties / stats.judgments)} | ${stats.consistent}/${stats.pairs} (${pct(stats.consistent / stats.pairs)}) |`,
      );
    }
  }
  return lines;
}

// The decision rule's inputs, read straight off the rows
function readout(input: SummaryInput): string[] {
  const decisive = (row: PairRow) => row.event !== 'chat';
  const aware = (depth: Depth) =>
    avg(
      input.scenes
        .filter((row) => row.depth === depth && row.event !== 'chat')
        .map((row) => input.sceneVerdicts.get(row.key)?.verdict?.aware)
        .filter((value): value is number => value !== undefined),
    );
  const cardMean = (depth: Depth, field: keyof Omit<CardVerdict, 'note'>) =>
    avg(
      input.cards
        .filter((row) => row.depth === depth && row.card)
        .map((row) => input.cardVerdicts.get(row.key)?.verdict?.[field])
        .filter((value): value is number => value !== undefined),
    );
  const sceneInvented = (depth: Depth) =>
    avg(
      input.scenes
        .filter((row) => row.depth === depth)
        .map((row) => input.sceneVerdicts.get(row.key)?.verdict?.invented)
        .filter((value): value is number => value !== undefined),
    );
  const lines: string[] = [];
  for (const [a, b] of COMPARISONS) {
    if (!input.depths.includes(a) || !input.depths.includes(b)) continue;
    const stats = pairStats(input, `${a}-${b}`, decisive);
    lines.push(
      `- ${a} vs ${b} (ask_place + plan): ${a} wins ${pct(stats.firstWins / stats.judgments)} of ${stats.judgments}; aware ${fmt(aware(a))} vs ${fmt(aware(b))} (${fmt(aware(a) - aware(b))})`,
    );
  }
  lines.push(
    `- card grounded: ${input.depths.map((depth) => `${depth} ${pct(cardMean(depth, 'grounded'))}`).join(', ')}`,
  );
  lines.push(
    `- card invented: ${input.depths.map((depth) => `${depth} ${pct(cardMean(depth, 'invented'))}`).join(', ')}`,
  );
  lines.push(`- scene invented: ${input.depths.map((depth) => `${depth} ${pct(sceneInvented(depth))}`).join(', ')}`);
  return lines;
}

function examples(input: SummaryInput, lotKeys: string[]): string[] {
  const lines: string[] = [];
  for (const key of lotKeys) {
    const lot = input.lots.find((candidate) => candidate.key === key);
    if (!lot) continue;
    lines.push(`### ${lot.name} (${lotGroup(key)})`, '');
    for (const depth of input.depths) {
      lines.push(`**${depth}** facts:`, '', '```', depthFacts(lot, depth), '```', '');
      input.cards
        .filter((row) => row.lot === key && row.depth === depth)
        .sort((a, b) => a.draft - b.draft)
        .forEach((row) => {
          const verdict = input.cardVerdicts.get(row.key)?.verdict;
          const scores = verdict
            ? ` _(kind ${verdict.kind}, who ${verdict.who}, specific ${verdict.specific}, grounded ${verdict.grounded}, invented ${verdict.invented}: ${verdict.note})_`
            : '';
          lines.push(`- draft ${row.draft}: ${row.card ?? `(no card: ${row.error ?? 'gate'})`}${scores}`);
        });
      lines.push('');
    }
  }
  return lines;
}

function summarize(input: SummaryInput): string {
  const exampleLots = (process.env.LOT_EXAMPLES ?? 'pectoral,movers,umbrage,calle').split(',');
  return [
    '# Lot depth experiment',
    '',
    `writer and scenes ${MODEL}, judge ${JUDGE}; ${input.cards.length} cards, ${input.scenes.length} scenes, ${input.pairs.length} pairwise judgments; spent $${input.spent.toFixed(2)} (key meter, all runs${chatSpend.calls > 0 ? `; writer + judge replies this run ${chatSpend.dollars.toFixed(2)} over ${chatSpend.calls} calls` : ''}), wall ${(input.wallMs / 60000).toFixed(0)} min`,
    '',
    '## Readout',
    '',
    ...readout(input),
    '',
    '## Cards',
    '',
    ...cardTable(input),
    '',
    'Venues:',
    '',
    ...cardTable(input, 'venue'),
    '',
    'Homes:',
    '',
    ...cardTable(input, 'home'),
    '',
    '## Scenes by depth x event',
    '',
    ...sceneTable(input, 'event', input.events),
    '',
    '## Scenes by depth x venue/home (ask_place + plan)',
    '',
    ...sceneTable(
      input,
      'group',
      input.events.filter((event) => event !== 'chat'),
    ),
    '',
    '## Pairwise',
    '',
    ...pairTable(input),
    '',
    '## Defining lines',
    '',
    ...input.lots.map((lot) => `- ${lot.key}: ${definingHits(lot).join(', ') || '(none: defining = bare)'}`),
    '',
    '## Example cards',
    '',
    ...examples(input, exampleLots),
  ].join('\n');
}

type Scope = { lots: RealLot[]; depths: Depth[]; events: EventKind[]; samples: number };

const outFiles = {
  cards: path.join(OUT_DIR, 'cards.jsonl'),
  cardVerdicts: path.join(OUT_DIR, 'card-verdicts.jsonl'),
  scenes: path.join(OUT_DIR, 'scenes.jsonl'),
  sceneVerdicts: path.join(OUT_DIR, 'scene-verdicts.jsonl'),
  pairs: path.join(OUT_DIR, 'pairs.jsonl'),
};

// summary.md from whatever the JSONL files in LOT_OUT hold, so a stopped run still reads
function writeSummary(scope: Scope, spent: number, wallMs: number): string {
  const inScope = (row: { lot: string; depth?: Depth; event?: EventKind }) =>
    scope.lots.some((lot) => lot.key === row.lot) &&
    (!row.depth || scope.depths.includes(row.depth)) &&
    (!row.event || scope.events.includes(row.event));
  const summary = summarize({
    ...scope,
    cards: Array.from(latest<CardRow>(outFiles.cards).values()).filter(inScope),
    cardVerdicts: latest<CardVerdictRow>(outFiles.cardVerdicts),
    scenes: Array.from(latest<SceneRow>(outFiles.scenes).values()).filter(
      (row) => inScope(row) && row.status === (InteractionEventStatus.GENERATED as string) && row.dialogue,
    ),
    sceneVerdicts: latest<SceneVerdictRow>(outFiles.sceneVerdicts),
    pairs: Array.from(latest<PairRow>(outFiles.pairs).values()).filter(
      (row) => inScope(row) && row.sample < scope.samples,
    ),
    spent,
    wallMs,
  });
  fs.writeFileSync(path.join(OUT_DIR, 'summary.md'), `${summary}\n`);
  process.stdout.write(`\n${summary}\n\n[depth] summary: ${path.join(OUT_DIR, 'summary.md')}\n`);
  return summary;
}

// ---- Tests

const describeExperiment = MODE ? describe : describe.skip;

describeExperiment('Lot depth experiment', () => {
  const lots = envList(
    'LOT_LOTS',
    REAL_LOTS.map((lot) => lot.key),
  ).map((key) => REAL_LOTS.find((lot) => lot.key === key) as RealLot);
  const depths = envList('LOT_DEPTHS', DEPTHS);
  const events = envList('LOT_EVENTS', EVENTS);
  const drafts = envNumber('LOT_DRAFTS', 2);
  const samples = envNumber('LOT_SAMPLES', 2);
  const lanes = envNumber('LOT_LANES', 4);
  const pairsPerComparison = envNumber('LOT_PAIRS', 60);

  it('derives bare and defining from the full facts', () => {
    expect(REAL_LOTS.length).toBe(15);
    for (const lot of REAL_LOTS) {
      const full = depthFacts(lot, 'full').split('\n');
      const bare = depthFacts(lot, 'bare').split('\n');
      const defining = depthFacts(lot, 'defining').split('\n');
      const traitLine = lotTraitLine(lot.traits, lot.challenges);
      expect(full, lot.key).toEqual(realLotFacts(lot).split('\n'));
      expect(furnishingLines(lot).length, `${lot.key} has furnishing lines`).toBeGreaterThan(0);

      expect(
        bare.filter((line) => FURNISHING_LINE.test(line)),
        lot.key,
      ).toEqual([]);
      expect(bare, lot.key).toEqual(full.filter((line) => !FURNISHING_LINE.test(line)));
      expect(bare, lot.key).toContain(traitLine);
      for (const kept of full.filter((line) =>
        /^(Name|Kind of place|Neighborhood|The game describes|Bedrooms):/.test(line),
      )) {
        expect(bare, lot.key).toContain(kept);
      }

      const added = defining.filter((line) => !bare.includes(line));
      expect(
        defining.filter((line) => bare.includes(line)),
        lot.key,
      ).toEqual(bare);
      expect(added.length, lot.key).toBeLessThanOrEqual(1);
      if (added.length === 1) {
        expect(added[0], lot.key).toMatch(/^Furnished with: /);
        const items = added[0].replace(/^Furnished with: /, '').split(', ');
        const source = furnishingLines(lot).join('\n').toLowerCase();
        for (const item of items) {
          expect(isDefiningItem(item), `${lot.key}: ${item}`).toBe(true);
          expect(source, `${lot.key}: ${item}`).toContain(item.replace(/^(an?|the) /i, '').toLowerCase());
        }
      }
    }
    expect(definingHits(REAL_LOTS.find((lot) => lot.key === 'salty') as RealLot)).toEqual([
      'a bar',
      'a jukebox',
      'grills',
    ]);
    expect(definingHits(REAL_LOTS.find((lot) => lot.key === 'chic') as RealLot)).toEqual([]);
  });

  (MODE === 'dry' ? it : it.skip)(
    'dry run: one mocked scene per depth carries that depth card in <LOCATION>',
    async () => {
      const lot = REAL_LOTS.find((candidate) => candidate.key === 'pectoral') as RealLot;
      const eventFor: Record<Depth, EventKind> = { full: 'chat', defining: 'ask_place', bare: 'plan' };
      for (const depth of DEPTHS) {
        const location = locationFor(lot, `${lot.name} is a gym, written from the ${depth} facts.`);
        const ctx = freshContext(`lot-depth-dry-${depth}`, location, { live: false });
        const spec = sceneFor(lot, location, eventFor[depth], ctx.settings.playerSpeakerName);
        const { systemPrompts } = timeStages(
          ctx,
          dryStub(
            lot.name,
            spec.event.sentient_sims.map((performer) => performer.name),
          ),
        );
        const outcome = await runDirected(ctx, spec);
        expect(outcome.status, `${depth}: ${outcome.error ?? ''}`).toEqual(InteractionEventStatus.GENERATED);
        expect(systemPrompts['Director Briefing'], depth).toContain(expectedLocationBlock(location));
      }
    },
    120_000,
  );

  (MODE === 'summary' ? it : it.skip)('summary: summary.md from the JSONL already in LOT_OUT, no network', () => {
    const statePath = path.join(OUT_DIR, 'state.json');
    const state = fs.existsSync(statePath)
      ? (JSON.parse(fs.readFileSync(statePath, 'utf8')) as State)
      : { spent: 0, wallMs: 0 };
    expect(writeSummary({ lots, depths, events, samples }, state.spent, state.wallMs).length).toBeGreaterThan(0);
  });

  (MODE === 'live' ? it : it.skip)(
    'live run: cards, card judge, scenes, scene judge, pairwise, summary.md',
    async () => {
      const key = loadOpenRouterKey() as string;
      expect(key, 'No OpenRouter key: set OPENROUTER_KEY or the app OpenRouter setting').toBeTruthy();
      fs.mkdirSync(OUT_DIR, { recursive: true });
      process.stdout.write(`[depth] LOT_OUT ${OUT_DIR}\n[depth] writer/scenes ${MODEL}, judge ${JUDGE}\n`);
      const meter = new Meter(key, OUT_DIR);
      await meter.start();
      const files = outFiles;
      const judgeLanes = lanes * 2;
      const sceneJobsPlanned = lots.length * depths.length * events.length * samples;
      const pairJobsPlanned = COMPARISONS.length * pairsPerComparison * 2;

      const guard = async (label: string, laterCost: number) => {
        const spent = await meter.spent();
        if (spent + laterCost > BUDGET) {
          throw new Error(
            `[depth] ${label}: spent $${spent.toFixed(2)} + projected $${laterCost.toFixed(2)} exceeds the $${BUDGET} budget`,
          );
        }
        return spent;
      };

      // 1. Writer: the production prompt and gate, one retry, per (lot, depth, draft)
      const cards = latest<CardRow>(files.cards);
      const cardJobs: { lot: RealLot; depth: Depth; draft: number; key: string }[] = [];
      lots.forEach((lot) => {
        depths.forEach((depth) => {
          for (let draft = 1; draft <= drafts; draft += 1) {
            const rowKey = `${lot.key}/${depth}/${draft}`;
            if (!cards.has(rowKey) || cards.get(rowKey)?.error) cardJobs.push({ lot, depth, draft, key: rowKey });
          }
        });
      });
      process.stdout.write(`[depth] cards: ${cardJobs.length} to write\n`);
      await runLanes(cardJobs, lanes, async (job) => {
        const facts = depthFacts(job.lot, job.depth);
        const row: CardRow = {
          key: job.key,
          lot: job.lot.key,
          depth: job.depth,
          draft: job.draft,
          facts,
          attempts: [],
          at: new Date().toISOString(),
        };
        try {
          for (let attempt = 1; attempt <= 2 && !row.card; attempt += 1) {
            const text = cleanupAIOutput(
              await chat(
                key,
                MODEL,
                LOCATION_DESCRIPTION_SYSTEM_PROMPT,
                `Facts about ${job.lot.name}:\n${facts}`,
                MAX_DESCRIPTION_TOKENS,
              ),
            ).trim();
            const problems = text.length < 20 ? ['empty'] : placeDescriptionProblems(text, job.lot.venue);
            row.attempts.push({ text, problems });
            if (problems.length === 0) row.card = text;
          }
        } catch (err) {
          row.error = err instanceof Error ? err.message : String(err);
        }
        cards.set(row.key, row);
        appendJsonl(files.cards, row);
        process.stdout.write(`[depth] card ${row.key} ${row.card ? 'ok' : `failed ${row.error ?? 'gate'}`}\n`);
      });

      // 2. Card judge: blind to depth, against the full facts
      const cardVerdicts = latest<CardVerdictRow>(files.cardVerdicts);
      const cardJudgeJobs = Array.from(cards.values()).filter(
        (row) => row.card && lots.some((lot) => lot.key === row.lot) && !cardVerdicts.get(row.key)?.verdict,
      );
      await guard(
        'before the card judge',
        cardJudgeJobs.length * CARD_JUDGE_COST +
          sceneJobsPlanned * 0.01 +
          sceneJobsPlanned * SCENE_JUDGE_COST +
          pairJobsPlanned * PAIR_COST,
      );
      process.stdout.write(`[depth] card judge: ${cardJudgeJobs.length} to judge\n`);
      await runLanes(cardJudgeJobs, judgeLanes, async (row) => {
        const lot = REAL_LOTS.find((candidate) => candidate.key === row.lot) as RealLot;
        const raw = await chat(
          key,
          JUDGE,
          CARD_JUDGE_PROMPT,
          `Everything the game knows about ${lot.name}:\n${depthFacts(lot, 'full')}\n\nThe card:\n${row.card}`,
          300,
        );
        const verdictRow: CardVerdictRow = { key: row.key, verdict: parseCardVerdict(raw), raw: raw.slice(0, 600) };
        cardVerdicts.set(row.key, verdictRow);
        appendJsonl(files.cardVerdicts, verdictRow);
      });

      // 3. Scenes: sample n plays draft n (another passing draft when that one failed the gate)
      const scenes = latest<SceneRow>(files.scenes);
      const cardFor = (lot: RealLot, depth: Depth, sample: number) => {
        const wanted = (sample % drafts) + 1;
        const passing = Array.from({ length: drafts }, (_value, index) => index + 1)
          .sort((a, b) => (a === wanted ? -1 : b === wanted ? 1 : a - b))
          .map((draft) => cards.get(`${lot.key}/${depth}/${draft}`))
          .find((row) => row?.card);
        return passing ? { draft: passing.draft, card: passing.card as string } : undefined;
      };
      const sceneJobs: { lot: RealLot; depth: Depth; event: EventKind; sample: number; key: string }[] = [];
      for (let sample = 0; sample < samples; sample += 1) {
        lots.forEach((lot) => {
          events.forEach((event) => {
            depths.forEach((depth) => {
              const rowKey = `${lot.key}/${depth}/${event}/${sample}`;
              if (scenes.get(rowKey)?.status !== (InteractionEventStatus.GENERATED as string)) {
                sceneJobs.push({ lot, depth, event, sample, key: rowKey });
              }
            });
          });
        });
      }
      process.stdout.write(`[depth] scenes: ${sceneJobs.length} to run, ${lanes} lanes\n`);
      const sceneStageSpent = await meter.spent();
      let scenesRun = 0;
      await runLanes(sceneJobs, lanes, async (job) => {
        const picked = cardFor(job.lot, job.depth, job.sample);
        if (!picked) {
          process.stdout.write(`[depth] scene ${job.key}: no card passed the gate, skipped\n`);
          return;
        }
        const location = locationFor(job.lot, picked.card);
        const ctx = freshContext(`lot-depth-${job.key.replace(/\W/g, '-')}-${randomUUID().slice(0, 8)}`, location, {
          live: true,
          model: MODEL,
          key,
        });
        const outcome = await runDirected(ctx, sceneFor(job.lot, location, job.event, ctx.settings.playerSpeakerName));
        const row: SceneRow = {
          ...outcome,
          key: job.key,
          lot: job.lot.key,
          depth: job.depth,
          event: job.event,
          sample: job.sample,
          draft: picked.draft,
          card: picked.card,
          at: new Date().toISOString(),
        };
        scenes.set(row.key, row);
        appendJsonl(files.scenes, row);
        scenesRun += 1;
        process.stdout.write(
          `[depth] scene ${row.key} ${row.status} ${(row.totalMs / 1000).toFixed(1)}s${row.error ? ` (${row.error})` : ''} [${scenesRun}/${sceneJobs.length}]\n`,
        );
        if (scenesRun === 12 || scenesRun % 40 === 0) {
          const spent = await meter.spent();
          const perScene = Math.max(spent - sceneStageSpent, 0) / scenesRun;
          const later =
            perScene * (sceneJobs.length - scenesRun) +
            sceneJobsPlanned * SCENE_JUDGE_COST +
            pairJobsPlanned * PAIR_COST;
          process.stdout.write(
            `[depth] spent $${spent.toFixed(2)}, $${perScene.toFixed(4)} a scene, projected total $${(spent + later).toFixed(2)}\n`,
          );
          await guard('scenes', later);
        }
      });

      // 4. Scene judge: blind to depth, against the full facts
      const sceneVerdicts = latest<SceneVerdictRow>(files.sceneVerdicts);
      const generated = (row?: SceneRow) =>
        row?.status === (InteractionEventStatus.GENERATED as string) && row.dialogue;
      const sceneJudgeJobs = Array.from(scenes.values()).filter(
        (row) => generated(row) && !sceneVerdicts.get(row.key)?.verdict,
      );
      await guard('before the scene judge', sceneJudgeJobs.length * SCENE_JUDGE_COST + pairJobsPlanned * PAIR_COST);
      process.stdout.write(`[depth] scene judge: ${sceneJudgeJobs.length} to judge\n`);
      await runLanes(sceneJudgeJobs, judgeLanes, async (row) => {
        const lot = REAL_LOTS.find((candidate) => candidate.key === row.lot) as RealLot;
        const raw = await chat(
          key,
          JUDGE,
          SCENE_JUDGE_PROMPT,
          `The place, ${lot.name}:\n${depthFacts(lot, 'full')}\n\nThe situation: ${situation(lot, row.event)}\n\nThe scene:\n${row.dialogue}`,
          300,
        );
        const verdictRow: SceneVerdictRow = { key: row.key, verdict: parseSceneVerdict(raw), raw: raw.slice(0, 600) };
        sceneVerdicts.set(row.key, verdictRow);
        appendJsonl(files.sceneVerdicts, verdictRow);
      });

      // 5. Pairwise: same lot, event and sample at two depths, shown in both orders
      const pairs = latest<PairRow>(files.pairs);
      const pairJobs: {
        a: Depth;
        b: Depth;
        lot: RealLot;
        event: EventKind;
        sample: number;
        order: 'ab' | 'ba';
        key: string;
      }[] = [];
      const eventRank = (event: EventKind) => (event === 'chat' ? 1 : 0);
      for (const [a, b] of COMPARISONS) {
        if (!depths.includes(a) || !depths.includes(b)) continue;
        const candidates: { lot: RealLot; event: EventKind; sample: number }[] = [];
        for (let sample = 0; sample < samples; sample += 1) {
          lots.forEach((lot) => {
            events.forEach((event) => {
              const left = scenes.get(`${lot.key}/${a}/${event}/${sample}`);
              const right = scenes.get(`${lot.key}/${b}/${event}/${sample}`);
              if (generated(left) && generated(right)) candidates.push({ lot, event, sample });
            });
          });
        }
        candidates
          .sort((x, y) => eventRank(x.event) - eventRank(y.event))
          .slice(0, pairsPerComparison)
          .forEach((candidate) => {
            (['ab', 'ba'] as const).forEach((order) => {
              const rowKey = `${a}-${b}/${candidate.lot.key}/${candidate.event}/${candidate.sample}/${order}`;
              if (!pairs.get(rowKey)?.winner) pairJobs.push({ a, b, ...candidate, order, key: rowKey });
            });
          });
      }
      await guard('before the pairwise judge', pairJobs.length * PAIR_COST);
      process.stdout.write(`[depth] pairwise: ${pairJobs.length} to judge\n`);
      await runLanes(pairJobs, judgeLanes, async (job) => {
        const [shownA, shownB] = job.order === 'ab' ? [job.a, job.b] : [job.b, job.a];
        const sceneA = scenes.get(`${job.lot.key}/${shownA}/${job.event}/${job.sample}`) as SceneRow;
        const sceneB = scenes.get(`${job.lot.key}/${shownB}/${job.event}/${job.sample}`) as SceneRow;
        const raw = await chat(
          key,
          JUDGE,
          PAIR_PROMPT,
          `The place, ${job.lot.name}:\n${depthFacts(job.lot, 'full')}\n\nThe situation: ${situation(job.lot, job.event)}\n\nScene A:\n${sceneA.dialogue}\n\nScene B:\n${sceneB.dialogue}`,
          200,
        );
        const winner = parseWinner(raw);
        const row: PairRow = {
          key: job.key,
          comparison: `${job.a}-${job.b}`,
          lot: job.lot.key,
          event: job.event,
          sample: job.sample,
          order: job.order,
          winner: winner === 'A' ? shownA : winner === 'B' ? shownB : winner,
          raw: raw.slice(0, 400),
        };
        pairs.set(row.key, row);
        appendJsonl(files.pairs, row);
      });

      // 6. Summary over the selected lots, depths and events
      const spent = await meter.spent();
      writeSummary({ lots, depths, events, samples }, spent, meter.wallMs());
      expect(cards.size).toBeGreaterThan(0);
    },
    8 * 60 * 60 * 1000,
  );
});
