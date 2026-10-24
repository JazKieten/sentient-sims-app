// The night call's text (autonomy part 6, 2026-10-22; autonomy tier): one Sim's day as the
// model reads it at the rollover. Pure: everything comes in as data and one string goes out.
// The turn is self-contained (no <live> block, no seed), so this text carries the whole
// picture: who the Sim is, yesterday's list and what became of each row, what happened, the
// new day's list as seeded with its ids, and the rules. The answer comes back through the
// edit_intentions tool, never as text.
import type { SimStateEntry, SimStateReport } from '../../models/SimStateReport';
import type { MemoryEntity } from '../../db/entities/MemoryEntity';
import type { ActionOutcomeRecord } from '../../db/ActionOutcomeRepository';
import { IntentionRow, Precondition, describeRow, minutesToClock } from '../../models/IntentionRow';
import { describeSim } from '../plum/plumLiveSims';
import { rowRank } from './IntentionSeeds';
import { RETIRE_CLEAR_DAYS, RowStats, isDead, statsTag } from './RowMemory';
import type { VocabularySeenEntry } from '../../db/RowMemoryRepository';

export const NIGHT_MEMORIES = 25;
// The clickable lists (renovation R3): what each target's menu offered yesterday
export const NIGHT_LABELS_PER_TARGET = 30;
export const NIGHT_LABELS_TOTAL = 150;
export const NIGHT_OUTCOMES = 20;
const MEMORY_CHARS = 200;

export type NightCallInput = {
  simId: string;
  simName: string;
  entry?: SimStateEntry;
  report?: SimStateReport;
  endingDay: number;
  newDay: number;
  // The ending day's rows as they stood at the rollover
  endingRows: IntentionRow[];
  // The new day's list as seeded so far
  todayRows: IntentionRow[];
  // The Sim's own memories of the ending day, oldest first
  memories: MemoryEntity[];
  // Graded outcomes of the Sim's pushes (any day; filtered to the ending one here)
  outcomes: ActionOutcomeRecord[];
  // Every row key's counters across days (renovation R1); retired keys carry retiredDay
  stats?: RowStats[];
  // Every item a menu offered the Sim on the ending day (R3: story rows click from these)
  vocabulary?: VocabularySeenEntry[];
};

// The heading a list is clicked by: 'self', 'phone', a Sim's name, or the object kind
function targetHeading(target: string, input: NightCallInput): string {
  if (target === 'self' || target === 'phone') {
    return target;
  }
  if (target.startsWith('sim:')) {
    const simId = target.slice(4);
    const known = (input.report?.sims ?? []).find((sim) => sim.sim_id === simId)?.sim_name;
    return known ?? simId;
  }
  return target;
}

// "What <First> could click yesterday": per target, the ungreyed labels its menu offered, as
// the mod printed them (a label two items share carries its [key]); collapsed <choice> rows
// and inventory objects are left out (a click needs one item on a reachable target)
export function clickableLines(input: NightCallInput): string[] {
  const byTarget = new Map<string, string[]>();
  (input.vocabulary ?? []).forEach((entry) => {
    if (entry.greyed || entry.kind === 'inventory' || /<choice>\s*$/.test(entry.label)) {
      return;
    }
    const labels = byTarget.get(entry.target) ?? [];
    if (!labels.includes(entry.label) && labels.length < NIGHT_LABELS_PER_TARGET) {
      labels.push(entry.label);
    }
    byTarget.set(entry.target, labels);
  });
  const lines: string[] = [];
  let total = 0;
  const ordered = [...byTarget.entries()].sort(([a], [b]) => {
    const rank = (target: string) =>
      target === 'self' ? 0 : target.startsWith('sim:') ? 1 : target === 'phone' ? 3 : 2;
    return rank(a) - rank(b);
  });
  for (const [target, labels] of ordered) {
    if (total >= NIGHT_LABELS_TOTAL) {
      break;
    }
    const kept = labels.slice(0, NIGHT_LABELS_TOTAL - total);
    total += kept.length;
    lines.push(`- ${targetHeading(target, input)}: ${kept.join(' | ')}`);
  }
  return lines;
}

// ACE-style counters before a row's line when its key has a record: `[key] fired=7 ran=0
// last=not_on_menu DEAD :: `. Counts, not rates: what happened, not what works.
function statsPrefix(item: IntentionRow, byKey: Map<string, RowStats>): string {
  const stats = byKey.get(item.seedKey);
  if (!stats || (stats.fires === 0 && stats.expired === 0 && stats.rewrites === 0)) {
    return '';
  }
  return `${statsTag(stats)}${isDead(stats) ? ' DEAD' : ''} :: `;
}

function retiredLines(stats: RowStats[]): string[] {
  return stats
    .filter((entry) => entry.retiredDay !== undefined)
    .map(
      (entry) =>
        `- ${statsTag(entry)} :: ${entry.why ?? entry.seedKey} (retired day ${entry.retiredDay}` +
        `${entry.retiredZone ? `, zone ${entry.retiredZone}` : ''})`,
    );
}

function pretty(text: string): string {
  return text.replace(/_/g, ' ');
}

function flat(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}...` : line;
}

// What a row waited on, in plain words, read off its preconditions (no clock needed)
function waitedFor(item: IntentionRow): string | undefined {
  const words = item.preconditions
    .map((condition: Precondition) => {
      switch (condition.kind) {
        case 'game_time':
          return `the window ${minutesToClock(condition.from)}-${minutesToClock(condition.to)}`;
        case 'target_present':
          return `${item.target?.name ?? 'the other Sim'} to be here`;
        case 'funds_at_least':
          return `§${condition.amount}`;
        case 'need_below':
          return `${condition.need} under ${condition.value}`;
        case 'not_at_work':
          return 'the shift to end';
        case 'at_home':
          return 'being home';
        case 'after':
          return 'an earlier row';
        default:
          return undefined;
      }
    })
    .filter((word): word is string => Boolean(word));
  return words.length > 0 ? words.join(', ') : undefined;
}

// "canceled target_left x3, timeout": the row's history grouped by outcome and cause
function attemptsText(item: IntentionRow): string {
  const counts = new Map<string, number>();
  item.history.forEach((entry) => {
    if (entry.outcome === 'dropped') {
      return;
    }
    const key = entry.cause ? `${entry.outcome} ${entry.cause}` : entry.outcome;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  return [...counts.entries()].map(([key, count]) => (count > 1 ? `${key} x${count}` : key)).join(', ');
}

// One verdict word (and why) for what became of a row by the day's end
export function verdictOf(item: IntentionRow): string {
  const tried = attemptsText(item);
  const triedText = tried ? ` (${tried})` : '';
  switch (item.status) {
    case 'done':
      if (item.history.some((entry) => entry.outcome === 'goal_completed')) {
        return 'done: the game completed it';
      }
      if (item.history.length === 0) {
        return 'done: the world settled it (never fired)';
      }
      return `done${triedText}`;
    case 'asleep':
      return `asleep: ${item.sleep?.cause ?? 'blocked'}${item.attempts > 0 ? `, ${item.attempts} attempts` : ''}${triedText}`;
    case 'dropped':
      return 'dropped';
    case 'expired':
      return item.history.length > 0 ? `expired${triedText}` : 'expired: it never got its moment';
    case 'unreachable':
      return 'unreachable: no way to do it here';
    case 'in_flight':
      return 'still in flight at midnight';
    case 'waiting':
    default: {
      if (item.history.length === 0) {
        const waited = waitedFor(item);
        return `never fired${waited ? ` (waited for ${waited})` : ''}`;
      }
      return `tried ${item.history.length} time${item.history.length === 1 ? '' : 's'}${triedText}`;
    }
  }
}

function whoLine(input: NightCallInput): string {
  const self = input.entry?.self;
  const parts: string[] = [input.simName];
  if (self?.age) {
    parts.push(pretty(self.age).toLowerCase());
  }
  if (self?.traits && self.traits.length > 0) {
    parts.push(`traits: ${self.traits.map(pretty).join(', ')}`);
  }
  const careers = (self?.careers ?? [])
    .filter((career) => career.career)
    .map((career) => `${pretty(career.career ?? '')}${career.level !== undefined ? ` level ${career.level}` : ''}`);
  if (careers.length > 0) {
    parts.push(`work: ${careers.join(', ')}`);
  }
  const aspiration = self?.next_objective?.aspiration ?? self?.next_objective?.track;
  if (aspiration) {
    parts.push(`aspiration: ${pretty(aspiration)}`);
  }
  if (self?.mood) {
    parts.push(`mood: ${pretty(self.mood)}`);
  }
  const funds = input.report?.lot?.funds;
  if (typeof funds === 'number') {
    parts.push(`household funds §${funds}`);
  }
  return parts.join('; ');
}

function householdLines(input: NightCallInput): string[] {
  return (input.report?.sims ?? [])
    .filter((sim) => sim.is_household !== false && sim.sim_id && sim.self?.species === undefined)
    .map((sim) => `- ${describeSim(sim, sim.sim_id === input.simId)}`);
}

function memoryLines(memories: MemoryEntity[]): string[] {
  return memories.slice(-NIGHT_MEMORIES).map((memory) => {
    const text = memory.content ?? memory.action ?? memory.pre_action ?? '';
    return `- [${memory.event_type ?? 'memory'}] ${flat(text, MEMORY_CHARS)}`;
  });
}

function outcomeLines(outcomes: ActionOutcomeRecord[], day: number): string[] {
  return outcomes
    .filter((record) => record.gameClock?.absolute_day === day)
    .sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
    .slice(-NIGHT_OUTCOMES)
    .map((record) => {
      const clock = record.gameClock;
      const at =
        clock && typeof clock.hour === 'number'
          ? `${String(clock.hour).padStart(2, '0')}:${String(clock.minute ?? 0).padStart(2, '0')} `
          : '';
      const what = record.interactionName ?? record.action ?? '?';
      const cause = record.cause ? ` (${record.cause})` : '';
      return `- ${at}${what} -> ${record.outcome}${cause}`;
    });
}

function todayLine(item: IntentionRow, byKey: Map<string, RowStats>): string {
  const say = item.say ? ` | says: "${item.say}"` : '';
  const need = item.source === 'need' ? ' | a need row: never touch it' : '';
  return `- ${statsPrefix(item, byKey)}${describeRow(item)} | rank ${rowRank(item)}${say}${need}`;
}

export const NIGHT_RULES = [
  'Story beats only: the game looks after needs, so never drop or rewrite a need row.',
  "A row is something a person would mean to do today, phrased as the Sim's own wish (`why`), with a `say` line: one sentence in their voice that they say aloud when it fires.",
  'Add 0 to 4 story rows. Ground them in yesterday: what fired and what died and why, who they spent time with, what is coming. Name a Sim (`target`) only if they live here or were around yesterday; give hours only when the beat has a time.',
  'Drop what is stale or impossible today (the same thing died three times for a reason that has not changed). Rewrite a row whose words are mechanical when a line in their voice would serve; re-rank when the order is wrong (lower rank runs first).',
  "Give each story row a `click`: its target (a heading from the clickable lists: 'self', a Sim, an object kind, 'phone') and 1 to 3 items COPIED EXACTLY from that heading's list, best first, plus an optional fallback target. Never invent an item or name a tuning key that is not listed. A row with no click waits for a slow pick at its moment and usually expires.",
  'The counts in [brackets] are what happened to that row on earlier days, not a measure of what works. A row marked DEAD fired 3 or more times without running: drop it or leave it; a rewrite of it is refused.',
  'The Sim never learns a night call exists; write as their own intentions, not as instructions.',
  'For each DEAD row and each row that failed yesterday, one `diagnoses` line by its [key]: why it died, in one sentence (what was missing, not a rewording).',
];

export function buildNightText(input: NightCallInput): string {
  const lines: string[] = [
    `<night_call sim="${input.simName}" sim_id="${input.simId}" ending_day="${input.endingDay}" new_day="${input.newDay}">`,
    `It is the start of day ${input.newDay} for ${input.simName}. Write their intentions for the new day.`,
    '',
    `Who: ${whoLine(input)}`,
  ];
  const household = householdLines(input);
  if (household.length > 0) {
    lines.push('', 'The household right now:', ...household);
  }
  const byKey = new Map((input.stats ?? []).map((stats) => [stats.seedKey, stats]));
  lines.push('', `Yesterday's list (day ${input.endingDay}) and what became of it:`);
  if (input.endingRows.length === 0) {
    lines.push('- (no list was kept)');
  } else {
    input.endingRows.forEach((item) =>
      lines.push(`- ${statsPrefix(item, byKey)}${describeRow(item)} => ${verdictOf(item)}`),
    );
  }
  const retired = retiredLines(input.stats ?? []);
  if (retired.length > 0) {
    lines.push(
      '',
      `Dead here (retired by code, left off today's list until the zone changes, a candidate shows on a menu, or ${RETIRE_CLEAR_DAYS} days pass):`,
      ...retired,
    );
  }
  lines.push('', 'What happened yesterday (their own memories, oldest first):');
  const memories = memoryLines(input.memories);
  lines.push(...(memories.length > 0 ? memories : ['- (nothing remembered)']));
  const outcomes = outcomeLines(input.outcomes, input.endingDay);
  if (outcomes.length > 0) {
    lines.push('', "What the day loop's clicks came to:", ...outcomes);
  }
  const first = input.simName.trim().split(/\s+/)[0] || input.simName;
  const clickable = clickableLines(input);
  lines.push('', `What ${first} could click yesterday (heading = click target; items copied exactly):`);
  lines.push(...(clickable.length > 0 ? clickable : ['- (no menus were seen yesterday: leave click null)']));
  lines.push('', `Today's list as seeded (day ${input.newDay}; edit these ids):`);
  const today = input.todayRows.filter(
    (item) => item.status !== 'done' && item.status !== 'expired' && item.status !== 'dropped',
  );
  lines.push(...(today.length > 0 ? today.map((item) => todayLine(item, byKey)) : ['- (empty)']));
  lines.push('', 'Rules:', ...NIGHT_RULES.map((rule) => `- ${rule}`));
  lines.push(
    '',
    `In ONE response: one line of what you changed, and edit_intentions once with sim_id "${input.simId}" ` +
      '(empty lists for what you leave alone; `diagnoses` for the dead and failed rows). Then stop. No reply.',
    '</night_call>',
  );
  return lines.join('\n');
}
