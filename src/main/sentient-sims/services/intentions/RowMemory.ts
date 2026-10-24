// Row memory (autonomy renovation R1, 2026-10-24; autonomy tier): pure helpers for what each
// row KEY did across days. Rows live per day, so a row that dies daily for a structural reason
// looked new every morning and the night call reworded it (Seth's gardening rows on 10-22:
// 7 fires, 0 runs). ACE keeps counters per item and merges deltas in code; we have the game's
// ground truth, so code counts and code retires (decision D4: 3 fires with no run and a
// structural last cause), never a model, and never on a raw success rate.
import type { SimStateEntry, SimStateReport } from '../../models/SimStateReport';
import type { IntentionRow } from '../../models/IntentionRow';
import { SOCIAL_ACTIONS } from '../../models/CognitionIntent';

export type RowStats = {
  simId: string;
  seedKey: string;
  fires: number;
  clicked: number;
  ran: number;
  canceled: number;
  refused: number;
  // Skipped because I failed (renovation R2: the day's vocabulary said the item is not there)
  notOnMenu: number;
  noTarget: number;
  // The click itself found none of the candidates on the live menu (R2: counted apart)
  refusedLive: number;
  expired: number;
  nightsKept: number;
  rewrites: number;
  // Fires since the key last ran or last came back from retirement: what D4 reads, so a key
  // that clears must earn its keep instead of re-retiring on its old count
  firesSinceRan: number;
  lastCause?: string;
  lastStructural: boolean;
  firstDay?: number;
  lastDay?: number;
  saidDay?: number;
  retiredDay?: number;
  retiredCause?: string;
  retiredZone?: string;
  // The row's `why` as last seen, for the night text's "dead here" lines
  why?: string;
};

export type StatsCounter =
  | 'fires'
  | 'clicked'
  | 'ran'
  | 'canceled'
  | 'refused'
  | 'notOnMenu'
  | 'noTarget'
  | 'refusedLive'
  | 'expired'
  | 'nightsKept'
  | 'rewrites';

export const RETIRE_MIN_FIRES = 3;
export const RETIRE_CLEAR_DAYS = 3;

// Causes that never clear today (age, trait, relationship gates). Owned here since R1: the
// retire rule reads them; IntentionService imports them for its sleeps.
export const NEVER_CAUSES = new Set([
  'incest_rules_block',
  'relationship_gate_blocks_romance',
  'trait_gated_affordance_variant',
  'actor_age_blocked',
  'target_age_blocked',
  'skill_level_too_low',
  'strangers_have_not_met',
  'relationship_too_low',
  'not_valid_species',
  'already_in_home_zone',
  'player_kept_them_home',
]);

export const CAUSE_NOT_ON_MENU = 'not_on_menu';
export const CAUSE_NO_TARGET = 'no_target';
export const CAUSE_TIMEOUT = 'timeout';

export function emptyStats(simId: string, seedKey: string): RowStats {
  return {
    simId,
    seedKey,
    fires: 0,
    clicked: 0,
    ran: 0,
    canceled: 0,
    refused: 0,
    notOnMenu: 0,
    noTarget: 0,
    refusedLive: 0,
    expired: 0,
    nightsKept: 0,
    rewrites: 0,
    firesSinceRan: 0,
    lastStructural: false,
  };
}

export type ClassifiedOutcome = {
  counter: 'ran' | 'canceled' | 'refused' | 'refusedLive' | 'noTarget';
  cause?: string;
  structural: boolean;
};

// One outcome of a row's push, sorted into the counter it bumps. The click's own refusals are
// read off the mod's reason text (ss_cognition_click / ss_pie_menu / ss_push_engine wording).
export function classifyOutcome(outcome: string, cause?: string, reason?: string): ClassifiedOutcome {
  if (outcome === 'success') {
    return { counter: 'ran', structural: false };
  }
  const text = `${cause ?? ''} ${reason ?? ''}`;
  if (/none of \d+ candidates is on the menu|no pie-menu item called/i.test(text)) {
    return { counter: 'refusedLive', cause: CAUSE_NOT_ON_MENU, structural: true };
  }
  if (/requires target_sim_id/i.test(text)) {
    return { counter: 'noTarget', cause: CAUSE_NO_TARGET, structural: true };
  }
  if (/nobody nearby to/i.test(text)) {
    return { counter: 'noTarget', cause: 'nobody_nearby', structural: false };
  }
  if (outcome === 'ineligible') {
    return { counter: 'refused', cause: cause ?? 'ineligible', structural: true };
  }
  if (cause && NEVER_CAUSES.has(cause)) {
    return { counter: 'refused', cause, structural: true };
  }
  if (outcome === 'canceled') {
    return { counter: 'canceled', cause: cause ?? 'canceled', structural: false };
  }
  return { counter: 'refused', cause: cause ?? outcome, structural: false };
}

// Need rows and the one-off impulse keys (scene:<at>, conversation:<at>, story:<id>) are never
// judged: a need is the game's, an impulse never re-seeds
export function isJudgedRow(item: Pick<IntentionRow, 'source'>): boolean {
  return !['need', 'scene', 'conversation', 'story'].includes(item.source);
}

// Fired 3+ times since it last ran (or came back) and never ran in that streak
export function isDead(stats: RowStats | undefined): boolean {
  return !!stats && stats.firesSinceRan >= RETIRE_MIN_FIRES;
}

// D4: dead AND the last cause structural (no candidates on the menu, no target, ineligible, a
// NEVER cause). Never on a raw rate.
export function shouldRetire(stats: RowStats | undefined): boolean {
  return !!stats && stats.retiredDay === undefined && isDead(stats) && stats.lastStructural;
}

// ACE-style inline counters: `[goal:x] fired=7 ran=0 rewrites=1 last=not_on_menu`
export function statsTag(stats: RowStats): string {
  const parts = [`fired=${stats.fires}`, `ran=${stats.ran}`];
  if (stats.notOnMenu > 0) {
    parts.push(`not_on_menu=${stats.notOnMenu}`);
  }
  if (stats.refusedLive > 0) {
    parts.push(`refused_live=${stats.refusedLive}`);
  }
  if (stats.noTarget > 0) {
    parts.push(`no_target=${stats.noTarget}`);
  }
  if (stats.expired > 0) {
    parts.push(`expired=${stats.expired}`);
  }
  if (stats.rewrites > 0) {
    parts.push(`rewrites=${stats.rewrites}`);
  }
  if (stats.lastCause) {
    parts.push(`last=${stats.lastCause}`);
  }
  return `[${stats.seedKey}] ${parts.join(' ')}`;
}

// The state BEFORE a decision (the causal survey: logs without it support bounds only). Plain
// facts the report already carries; nothing measured after the click.
export type DecisionContext = {
  day?: number;
  hour?: number;
  minute?: number;
  speed?: string;
  zone?: string;
  funds?: number;
  needs?: Record<string, number>;
  mood?: string;
  asleep?: boolean;
  at_work?: boolean;
  on_active_lot?: boolean;
  in_social?: boolean;
  running?: string | null;
  queue?: string[];
  sims?: { sim_id: string; distance?: number; tier?: string; asleep?: boolean }[];
};

export function contextSnapshot(entry: SimStateEntry, report: SimStateReport | undefined): DecisionContext {
  const clock = report?.lot?.clock;
  const zone = report?.lot?.zone_id;
  return {
    day: clock?.absolute_day,
    hour: clock?.hour,
    minute: clock?.minute,
    speed: clock?.speed,
    zone: zone === undefined ? undefined : String(zone),
    funds: report?.lot?.funds,
    needs: entry.self?.needs ? { ...entry.self.needs } : undefined,
    mood: entry.self?.mood,
    asleep: entry.self?.asleep,
    at_work: (entry.self?.careers ?? []).some((career) => career.at_work === true),
    on_active_lot: entry.self?.on_active_lot,
    in_social: entry.activity?.in_social,
    running: entry.activity?.running,
    queue: entry.activity?.queue ? [...entry.activity.queue] : undefined,
    sims: entry.sims.map((sim) => ({
      sim_id: sim.sim_id,
      distance: sim.distance,
      tier: sim.tier,
      asleep: sim.asleep,
    })),
  };
}

// One day of a Sim's rows, for the rollover's readout line
export type DaySummary = {
  fired: number;
  clicked: number;
  ran: number;
  notOnMenu: number;
  refusedLive: number;
  noTarget: number;
  expired: number;
  retired: string[];
};

export function daySummaryLine(name: string, day: number, summary: DaySummary): string {
  return (
    `[Rows] ${name} day ${day}: fired=${summary.fired} clicked=${summary.clicked} ran=${summary.ran} ` +
    `not_on_menu=${summary.notOnMenu} refused_live=${summary.refusedLive} no_target=${summary.noTarget} ` +
    `expired=${summary.expired} ` +
    `retired=[${summary.retired.join(', ')}]`
  );
}

// Whether `text` names the Sim (first or last name as a word): the game's third-person want
// lines ("Duane is starting to see sheep.") are not the Sim's own voice
export function namesSim(text: string | undefined, simName: string | undefined): boolean {
  if (!text || !simName) {
    return false;
  }
  const words = simName
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 1)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return words.some((word) => new RegExp(`\\b${word}\\b`, 'i').test(text));
}

// --- the initiation set (renovation R2) --------------------------------------------------------
// A row is an option <I, pi, beta> and may start only when I holds (Sutton, Precup & Singh); the
// pie menu is the free half of the affordance oracle. The day's vocabulary (vocabulary_seen plus
// the candidates a provider sample checked) is a PRIOR: a target nobody sampled today in this
// zone is unknown, never empty, and the click's own refusal stays the last word.

export type TargetMenu = {
  // Item keys offered and runnable, and the supers those items stage
  keys: Set<string>;
  supers: Set<string>;
  // Their labels, case-folded, without " [key]" or " (picker)" (R3: story rows click by label)
  labels?: Set<string>;
  // Offered but greyed: key (and super) -> the game's reason
  greyed: Map<string, string>;
};

export type VocabularyView = {
  // 'self' | 'sim:<id>' | an object's class name | 'phone' -> what its menu offered today
  targets: Map<string, TargetMenu>;
  // Candidate keys a provider sample judged today (found on that object or not)
  checked: Set<string>;
};

export type Initiation = { ok: true } | { ok: false; cause: 'not_on_menu' | 'greyed' | 'no_target'; why: string };

export function emptyView(): VocabularyView {
  return { targets: new Map(), checked: new Set() };
}

// "Cook [fridge_Cook] (picker)" -> {label: 'cook', key: 'fridge_Cook'}: how a menu label and a
// story row's item are compared (ss_pie_menu.item_view's forms)
export function labelParts(text: string): { label: string; key?: string } {
  let rest = text.trim().replace(/\s*\(picker\)\s*$/i, '');
  let key: string | undefined;
  const bracket = /^(.*?)\s*\[([^[\]]+)\]\s*$/.exec(rest);
  if (bracket) {
    rest = bracket[1];
    key = bracket[2].trim();
  }
  return { label: rest.trim().toLowerCase(), key };
}

function onMenu(menu: TargetMenu, candidate: string): 'ok' | 'greyed' | undefined {
  if (menu.keys.has(candidate) || menu.supers.has(candidate)) {
    return 'ok';
  }
  const parts = labelParts(candidate);
  if (parts.key && menu.keys.has(parts.key)) {
    return 'ok';
  }
  if (menu.labels?.has(parts.label)) {
    return 'ok';
  }
  if (menu.greyed.has(candidate) || (parts.key && menu.greyed.has(parts.key)) || menu.greyed.has(parts.label)) {
    return 'greyed';
  }
  return undefined;
}

export function initiation(row: IntentionRow, view: VocabularyView): Initiation {
  if (row.what.kind === 'action') {
    const allSocial = row.what.actions.length > 0 && row.what.actions.every((action) => SOCIAL_ACTIONS.has(action));
    if (allSocial && !row.target) {
      return { ok: false, cause: 'no_target', why: `${row.what.actions.join('|')} needs someone to do it with` };
    }
    return { ok: true };
  }
  if (row.what.kind !== 'pie') {
    return { ok: true };
  }
  if (view.targets.size === 0 && view.checked.size === 0) {
    return { ok: true };
  }
  const candidates = [...row.what.candidates, ...(row.what.fallback ? [row.what.fallback] : [])];
  const clickSim = row.what.target?.kind === 'sim' ? row.what.target.id : undefined;
  if (row.target || clickSim) {
    const simId = clickSim ?? row.target?.sim_id;
    const menu = view.targets.get(`sim:${simId}`);
    if (!menu) {
      return { ok: true };
    }
    const states = candidates.map((candidate) => onMenu(menu, candidate));
    if (states.includes('ok')) {
      return { ok: true };
    }
    const whose = row.target?.name ?? row.what.target?.name ?? 'their';
    if (states.includes('greyed')) {
      return { ok: false, cause: 'greyed', why: `greyed on ${whose} menu` };
    }
    return { ok: false, cause: 'not_on_menu', why: `not on ${whose} menu today` };
  }
  let greyed = false;
  for (const candidate of candidates) {
    const states = [...view.targets.values()].map((menu) => onMenu(menu, candidate));
    if (states.includes('ok')) {
      return { ok: true };
    }
    if (states.includes('greyed')) {
      greyed = true;
    } else if (!view.checked.has(candidate)) {
      // Never judged today (a social super, an object nobody sampled): unknown, so it may fire
      return { ok: true };
    }
  }
  return greyed
    ? { ok: false, cause: 'greyed', why: 'only greyed on the menus seen today' }
    : { ok: false, cause: 'not_on_menu', why: 'on none of the menus seen today' };
}
