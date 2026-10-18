// The dev build's Lot Words panel (Locations page): the furnishing tuning names the lots
// visited this app run carry that no rule turns into plain words, and the words a player
// gives them, kept in Mods/sentient-sims/lot-words.json and used by every description
// written after. "Copy for Claude" on the panel is how they reach FURNISHING_WORDS and
// every player.
import fs from 'fs';
import path from 'path';
import log from 'electron-log';
import type { ApiContext } from './ApiContext';
import { LotBlock } from '../models/SimStateReport';
import { lotFurnishingNames } from '../util/lotDescription';
import {
  FurnishingWord,
  furnishingWords,
  PlayerFurnishingWords,
  setPlayerFurnishingWords,
} from '../util/lotFurnishings';

/** One row of the panel: a tuning name, its saved words (absent when unmapped), the lots it is on. */
export type LotWordRow = { name: string; word?: FurnishingWord | null; lots: string[] };

function namesOn(lot: LotBlock): string[] {
  const inRooms = (lot.rooms ?? []).flatMap((room) => Object.keys(room.kinds));
  return Array.from(new Set([...lotFurnishingNames(lot), ...inRooms]));
}

// Trimmed; a word with no singular is dropped, a missing plural repeats the singular
export function cleanPlayerWords(words: unknown): PlayerFurnishingWords {
  const cleaned: PlayerFurnishingWords = {};
  if (!words || typeof words !== 'object') {
    return cleaned;
  }
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
    const singular = typeof one === 'string' ? one.trim() : '';
    if (!singular) {
      return;
    }
    const plural = typeof many === 'string' && many.trim() ? many.trim() : singular;
    cleaned[name] = { one: singular, many: plural };
  });
  return cleaned;
}

export class LotWordsService {
  private readonly ctx: ApiContext;

  private words: PlayerFurnishingWords = {};

  constructor(ctx: ApiContext) {
    this.ctx = ctx;
  }

  private filePath(): string {
    return path.join(this.ctx.directory.getSentientSimsFolder(), 'lot-words.json');
  }

  load() {
    try {
      const file = this.filePath();
      this.words = fs.existsSync(file) ? cleanPlayerWords(JSON.parse(fs.readFileSync(file, 'utf-8'))) : {};
    } catch (err) {
      log.error('[LotWords] Could not read lot-words.json', err);
      this.words = {};
    }
    setPlayerFurnishingWords(this.words);
  }

  save(words: unknown): PlayerFurnishingWords {
    this.words = cleanPlayerWords(words);
    fs.writeFileSync(this.filePath(), JSON.stringify(this.words, null, 2));
    setPlayerFurnishingWords(this.words);
    log.info(`[LotWords] saved words for ${Object.keys(this.words).length} furnishings`);
    return this.words;
  }

  /** Unmapped names first, then saved ones, each A to Z. */
  rows(): LotWordRow[] {
    const lotsByName = new Map<string, Set<string>>();
    const unmapped = new Set<string>();
    this.ctx.simStateCache.getLotBlocks().forEach((lot) => {
      const names = namesOn(lot);
      const label = lot.lot_name || `lot ${lot.lot_id ?? '?'}`;
      names.forEach((name) => {
        lotsByName.set(name, (lotsByName.get(name) ?? new Set()).add(label));
      });
      furnishingWords(names, { isHome: false }).unmapped.forEach((name) => unmapped.add(name));
    });
    const lotsOf = (name: string) => Array.from(lotsByName.get(name) ?? []).sort();
    const byName = (a: string, b: string) => a.localeCompare(b);
    return [
      ...Array.from(unmapped)
        .filter((name) => !(name in this.words))
        .sort(byName)
        .map((name) => ({ name, lots: lotsOf(name) })),
      ...Object.keys(this.words)
        .sort(byName)
        .map((name) => ({ name, word: this.words[name], lots: lotsOf(name) })),
    ];
  }
}
