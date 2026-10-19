// What a Plum model call costs, from the response's usage: the "$x.xx this hour" on the tab's
// status line while directing and the kind= / model= fields the `[Plum] turn` log line carries
// for scripts/plum-cost.py (keep the two tables in step). Prices are Anthropic's list prices
// per million tokens (2026-10): input, cache read, cache write (5 min), output. Haiku 5.5's
// prices double past a 100k-token prompt; the director never gets there (the thread rolls at
// 30k), so the low band is used throughout.
import type Anthropic from '@anthropic-ai/sdk';

export type ModelPrice = { input: number; cacheRead: number; cacheWrite: number; output: number };

const PRICES: Record<string, ModelPrice> = {
  'claude-opus-5-5': { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 },
  'claude-opus-5': { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
  'claude-sonnet-5-5': { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
  'claude-sonnet-5': { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
  'claude-haiku-5-5': { input: 0.1, cacheRead: 0.01, cacheWrite: 0.125, output: 0.5 },
};

// An unknown model id (a dated alias, a future model) is priced as Opus: the number on the
// tab is then an upper bound rather than a surprise
export function priceOf(model: string): ModelPrice {
  const key = model.trim().toLowerCase();
  if (key in PRICES) {
    return PRICES[key];
  }
  const family = Object.keys(PRICES).find((known) => key.startsWith(known));
  return family ? PRICES[family] : PRICES['claude-opus-5-5'];
}

export type PlumUsage = Pick<Anthropic.Beta.Messages.BetaUsage, 'input_tokens' | 'output_tokens'> & {
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

// Dollars for one call
export function costOf(model: string, usage: PlumUsage): number {
  const price = priceOf(model);
  return (
    (usage.input_tokens * price.input +
      (usage.cache_read_input_tokens ?? 0) * price.cacheRead +
      (usage.cache_creation_input_tokens ?? 0) * price.cacheWrite +
      usage.output_tokens * price.output) /
    1_000_000
  );
}

export function formatDollars(amount: number): string {
  return `$${amount.toFixed(2)}`;
}
