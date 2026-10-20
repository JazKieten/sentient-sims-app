// The dev build's Lot Words panel (Locations page): the furnishing tuning names the lots
// visited this app run carry that no rule turns into plain words, a first guess for each, and
// the words a player accepts, kept in Mods/sentient-sims/lot-words.json and used by every
// description written after. Guesses live apart in lot-word-suggestions.json and reach no
// description until accepted. "Copy for Claude" on the panel is how accepted words reach
// FURNISHING_WORDS and every player.
import fs from 'fs';
import path from 'path';
import log from 'electron-log';
import type { ApiContext } from './ApiContext';
import { LotBlock } from '../models/SimStateReport';
import { AIActionType } from '../models/AIActionType';
import { StageId } from '../pipeline/stages';
import { lotFurnishingNames } from '../util/lotDescription';
import { firstJsonBlockLoose } from '../util/jsonBlock';
import {
  articleFor,
  FurnishingWord,
  furnishingWords,
  PlayerFurnishingWords,
  pluralOf,
  setPlayerFurnishingWords,
  splitArticle,
  withArticle,
} from '../util/lotFurnishings';

/** A first guess at a name's words: from the AI, or read off the name itself. */
export type WordSuggestion = { word: FurnishingWord | null; source: 'ai' | 'name' };

/**
 * One row of the panel: a tuning name, its saved words (absent when unmapped, null when left
 * out), the lots it is on, and for an unmapped name a first guess.
 */
export type LotWordRow = {
  name: string;
  word?: FurnishingWord | null;
  lots: string[];
  suggestion?: WordSuggestion;
};

/** A lot visited this run and how many of its furnishings have no words. */
export type CheckedLot = { name: string; missing: number };

export type LotWords = { rows: LotWordRow[]; lots: CheckedLot[]; unsuggested: number };

const SUGGEST_BATCH = 40;

const SUGGEST_SYSTEM_PROMPT = `You put names to furniture and objects from The Sims 4 for a writer describing a lot. Each input line is one object's internal tuning name.
For each name, give what a player would call the object itself, in plain everyday words: a lowercase noun phrase WITHOUT an article, and its plural. Name the object, not its category ("cat tree", not "pet furniture"). Drop pack codes, sizes, styles and quality words (GP01, SP08, GEN, _large, _Med, Nice, Deluxe, 2x1).
Use null for anything a description of the place should not mention: hidden game plumbing and markers (stage marks, proxies, effects, fairy dust), building parts (chimneys, lattice), clutter and small props (a frying pan, a yarn ball, a tarot deck, drawings on a board), food, crops, collectibles, card packs and craft kits.
Set "mass": true for a noun that takes no "a" (art supplies).
Examples:
object_vetMedicineStation -> {"noun": "vet medicine station", "plural": "vet medicine stations"}
catCondo_2x1_High -> {"noun": "cat tree", "plural": "cat trees"}
object_Canvas_large -> {"noun": "art supplies", "plural": "art supplies", "mass": true}
object_StageMark_Group -> null
object_FryingPan_ChickenBreast -> null
Reply with one JSON object mapping every input name, exactly as given, to {"noun", "plural", "mass"} or null, and nothing else.`;

// Pack codes, sizes, tiers and plumbing words a tuning name carries that name nothing
const NAME_NOISE =
  /^(object|obj|gen|gensp\d*|[gesf]p\d+|bm|ds|homelot|small|med|medium|large|high|low|tall|short|nice|cheap|expensive|deluxe|basic|\d+x\d+|\d+|[a-z])$/i;

/** A guess read off the tuning name alone: object_vetMedicineStation -> "a vet medicine station". */
export function guessFromName(name: string): FurnishingWord | undefined {
  const words = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[\s_\-:]+/)
    .filter((word) => word && !NAME_NOISE.test(word))
    .map((word) => word.toLowerCase());
  if (words.length === 0) {
    return undefined;
  }
  const noun = words.join(' ');
  return { one: withArticle(noun, articleFor(noun)), many: pluralOf(noun) };
}

// The AI's reply for one name: words with the article added, null to leave out, undefined
// when the reply says nothing usable about it
function suggestionOf(raw: unknown): FurnishingWord | null | undefined {
  if (raw === null) {
    return null;
  }
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const { noun, plural, mass } = raw as { noun?: unknown; plural?: unknown; mass?: unknown };
  if (typeof noun !== 'string' || !noun.trim()) {
    return undefined;
  }
  const bare = splitArticle(noun.trim().toLowerCase()).noun;
  const many = typeof plural === 'string' && plural.trim() ? splitArticle(plural.trim().toLowerCase()).noun : '';
  if (mass === true) {
    return { one: bare, many: many || bare };
  }
  return { one: withArticle(bare, articleFor(bare)), many: many || pluralOf(bare) };
}

function namesOn(lot: LotBlock): string[] {
  const inRooms = (lot.rooms ?? []).flatMap((room) => Object.keys(room.kinds));
  return Array.from(new Set([...lotFurnishingNames(lot), ...inRooms]));
}

function lotLabel(lot: LotBlock): string {
  return lot.lot_name || `lot ${lot.lot_id ?? '?'}`;
}

// Trimmed, a leading "A "/"An " lowercased; a word with no singular is dropped, a missing
// plural repeats the singular
export function cleanPlayerWords(words: unknown): PlayerFurnishingWords {
  const cleaned: PlayerFurnishingWords = {};
  if (!words || typeof words !== 'object') {
    return cleaned;
  }
  const tidy = (text: string) =>
    text
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/^(an?) /i, (article) => article.toLowerCase());
  Object.entries(words as Record<string, unknown>).forEach(([rawName, raw]) => {
    const name = rawName.trim();
    if (!name) {
      return;
    }
    if (raw === null) {
      cleaned[name] = null;
      return;
    }
    const { one, many } = (raw ?? {}) as Partial<Record<keyof FurnishingWord, unknown>>;
    const singular = typeof one === 'string' ? tidy(one) : '';
    if (!singular) {
      return;
    }
    const plural = typeof many === 'string' && many.trim() ? tidy(many) : singular;
    cleaned[name] = { one: singular, many: plural };
  });
  return cleaned;
}

export class LotWordsService {
  private readonly ctx: ApiContext;

  private words: PlayerFurnishingWords = {};

  private suggestions: PlayerFurnishingWords = {};

  // Names the AI was asked about this run and gave nothing for, so Refresh does not ask again
  private readonly askedThisRun = new Set<string>();

  private pending: Promise<void> | undefined;

  constructor(ctx: ApiContext) {
    this.ctx = ctx;
  }

  private filePath(file = 'lot-words.json'): string {
    return path.join(this.ctx.directory.getSentientSimsFolder(), file);
  }

  private readJson(file: string): PlayerFurnishingWords {
    try {
      const full = this.filePath(file);
      return fs.existsSync(full) ? cleanPlayerWords(JSON.parse(fs.readFileSync(full, 'utf-8'))) : {};
    } catch (err) {
      log.error(`[LotWords] Could not read ${file}`, err);
      return {};
    }
  }

  load() {
    this.words = this.readJson('lot-words.json');
    this.suggestions = this.readJson('lot-word-suggestions.json');
    setPlayerFurnishingWords(this.words);
  }

  save(words: unknown): PlayerFurnishingWords {
    this.words = cleanPlayerWords(words);
    fs.writeFileSync(this.filePath(), JSON.stringify(this.words, null, 2));
    setPlayerFurnishingWords(this.words);
    log.info(`[LotWords] saved words for ${Object.keys(this.words).length} furnishings`);
    return this.words;
  }

  /** Every lot visited this run, A to Z, so a lot with nothing missing still shows it was checked. */
  checkedLots(): CheckedLot[] {
    return this.ctx.simStateCache
      .getLotBlocks()
      .map((lot) => ({
        name: lotLabel(lot),
        missing: furnishingWords(namesOn(lot), { isHome: false }).unmapped.length,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private unmappedNames(): string[] {
    const unmapped = new Set<string>();
    this.ctx.simStateCache.getLotBlocks().forEach((lot) => {
      furnishingWords(namesOn(lot), { isHome: false }).unmapped.forEach((name) => unmapped.add(name));
    });
    return Array.from(unmapped).filter((name) => !(name in this.words));
  }

  private unsuggested(): string[] {
    return this.unmappedNames().filter((name) => !(name in this.suggestions) && !this.askedThisRun.has(name));
  }

  /** Unmapped names first, then saved ones, each A to Z. */
  rows(): LotWordRow[] {
    const lotsByName = new Map<string, Set<string>>();
    this.ctx.simStateCache.getLotBlocks().forEach((lot) => {
      const label = lotLabel(lot);
      namesOn(lot).forEach((name) => {
        lotsByName.set(name, (lotsByName.get(name) ?? new Set()).add(label));
      });
    });
    const lotsOf = (name: string) => Array.from(lotsByName.get(name) ?? []).sort();
    const byName = (a: string, b: string) => a.localeCompare(b);
    const suggestionFor = (name: string): WordSuggestion | undefined => {
      if (name in this.suggestions) {
        return { word: this.suggestions[name], source: 'ai' };
      }
      const guess = guessFromName(name);
      return guess ? { word: guess, source: 'name' } : undefined;
    };
    return [
      ...this.unmappedNames()
        .sort(byName)
        .map((name) => {
          const suggestion = suggestionFor(name);
          return suggestion ? { name, lots: lotsOf(name), suggestion } : { name, lots: lotsOf(name) };
        }),
      ...Object.keys(this.words)
        .sort(byName)
        .map((name) => ({ name, word: this.words[name], lots: lotsOf(name) })),
    ];
  }

  all(): LotWords {
    return { rows: this.rows(), lots: this.checkedLots(), unsuggested: this.unsuggested().length };
  }

  /** Asks the AI for words for every unmapped name it has not guessed yet, one batch at a time. */
  async suggest(): Promise<void> {
    if (!this.pending) {
      this.pending = this.suggestAll().finally(() => {
        this.pending = undefined;
      });
    }
    return this.pending;
  }

  private async suggestAll() {
    for (let names = this.unsuggested(); names.length > 0; names = this.unsuggested()) {
      const batch = names.slice(0, SUGGEST_BATCH);
      batch.forEach((name) => this.askedThisRun.add(name));
      const oneShot = await this.ctx.ai.runOneShot(
        `Lot Words: ${batch.length} furnishings`,
        SUGGEST_SYSTEM_PROMPT,
        batch.join('\n'),
        2400,
        undefined,
        AIActionType.DESCRIPTION_DEFAULT,
        undefined,
        { stageId: StageId.LOT_WORDS, interactive: true },
      );
      const parsed = firstJsonBlockLoose(oneShot.text);
      const reply = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      let named = 0;
      batch.forEach((name) => {
        const word = suggestionOf(reply[name]);
        if (word !== undefined) {
          this.suggestions[name] = word;
          named += 1;
        }
      });
      fs.writeFileSync(this.filePath('lot-word-suggestions.json'), JSON.stringify(this.suggestions, null, 2));
      log.info(`[LotWords] AI suggested words for ${named} of ${batch.length} furnishings`);
    }
  }
}
