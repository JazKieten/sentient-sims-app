// Experiences (autonomy renovation R5a, 2026-10-24; autonomy tier). Pure: importance from game
// signals, the verb family, the fold of repeats, and the Generative Agents retrieval score in
// plain code. ExperienceService builds the rows at night and calls these.
//
// Generative Agents' worst failure was a fact the agent had but did not retrieve, and its
// importance came from an LLM. Here importance comes from what the game says happened (a
// relationship bit, a life event, a failure), relevance is overlap with what tomorrow holds
// (who, what kind of thing, where), and recency decays 0.995 per game hour since the row was
// last shown (GA's "since last access"); each term min-max normalized, weights 1. No model.
import { FactPredicate } from '../../pipeline/facts/predicates';

export type ExperienceKind = 'did' | 'with' | 'fact';
export type ExperienceSource = 'interaction' | 'memory' | 'fact';

export type Experience = {
  id?: number;
  holder: string;
  day: number;
  // Minute of the day (0..1439); undefined = not known (a memory, a fact)
  minute?: number;
  kind: ExperienceKind;
  // Other Sims involved (ids)
  participants: string[];
  verb?: string;
  verbFamily?: string;
  target?: string;
  zone?: string;
  outcome?: string;
  finishing?: string;
  importance: number;
  // Absolute game minutes when the night text last showed it
  lastAccess?: number;
  source: ExperienceSource;
  sourceId: string;
  sceneId?: string;
  text?: string;
};

export const RECENCY_DECAY_PER_HOUR = 0.995;
export const NIGHT_EXPERIENCES = 25;
export const EXPERIENCE_WINDOW_DAYS = 7;
export const EXPERIENCE_KEEP_DAYS = 30;
export const DEFAULT_MEMORY_IMPORTANCE = 3;

// The R5a table: game signals stand in for GA's 1-10 poignancy
export const IMPORTANCE = {
  ordinary: 2,
  withSim: 3,
  failedBonus: 2,
  bitAdded: 9,
  bitRemoved: 8,
  partner: 10,
  lifecycle: 10,
  job: 9,
  firstMeeting: 5,
} as const;

const PARTNER_PREDICATES = new Set<string>([
  FactPredicate.SPOUSE,
  FactPredicate.FIANCE,
  FactPredicate.STEADY,
  FactPredicate.EX_PARTNER,
]);

// One interaction the household log kept: 2, 3 with a Sim, +2 when it failed or the player
// canceled it
export function interactionImportance(facts: {
  withSim: boolean;
  ran?: boolean;
  canceled?: boolean;
  userCanceled?: boolean;
}): number {
  let importance = facts.withSim ? IMPORTANCE.withSim : IMPORTANCE.ordinary;
  if (facts.ran === false || facts.canceled || facts.userCanceled) {
    importance += IMPORTANCE.failedBonus;
  }
  return importance;
}

// A game fact that opened or closed: the importance of the change, or undefined when the change
// is not an experience (a skill level, a like, what one knows about another: R5b's input)
export function factImportance(predicate: string, opened: boolean): number | undefined {
  if (predicate === FactPredicate.REL_BIT) {
    return opened ? IMPORTANCE.bitAdded : IMPORTANCE.bitRemoved;
  }
  if (PARTNER_PREDICATES.has(predicate)) {
    return IMPORTANCE.partner;
  }
  if (predicate === FactPredicate.AGE_STAGE || predicate === FactPredicate.ALIVE) {
    return opened ? IMPORTANCE.lifecycle : undefined;
  }
  if (predicate === FactPredicate.JOB) {
    return opened ? IMPORTANCE.job : undefined;
  }
  if (predicate === FactPredicate.KNOWS) {
    return opened ? IMPORTANCE.firstMeeting : undefined;
  }
  return undefined;
}

const VERB_PREFIXES = [
  'mixer_social_',
  'mixer_',
  'social_',
  'super_',
  'sim_',
  'si_',
  'interaction_',
  'object_',
  'generic_',
];

// 'mixer_social_TellJoke_targeted_Friendly' -> 'telljoke', 'sim_Chat' -> 'chat'
export function verbFamily(name: string | undefined): string | undefined {
  if (!name) {
    return undefined;
  }
  let lowered = name.toLowerCase();
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const prefix of VERB_PREFIXES) {
      if (lowered.startsWith(prefix) && lowered.length > prefix.length) {
        lowered = lowered.slice(prefix.length);
        stripped = true;
      }
    }
  }
  return lowered.split(/[_\s]+/)[0] || undefined;
}

export function whenOf(experience: Pick<Experience, 'day' | 'minute'>): number {
  return experience.day * 1440 + (experience.minute ?? 720);
}

// What tomorrow holds: the Sims it names or that are around, the kinds of thing it means to do,
// the zone it starts in
export type RelevanceQuery = { sims: Set<string>; verbs: Set<string>; zone?: string };

export function relevance(experience: Experience, query: RelevanceQuery): number {
  const sims = new Set([...experience.participants, ...(experience.target ? [experience.target] : [])]);
  let score = 0;
  sims.forEach((simId) => {
    if (query.sims.has(simId)) {
      score += 1;
    }
  });
  if (experience.verbFamily && query.verbs.has(experience.verbFamily)) {
    score += 1;
  }
  if (experience.zone && query.zone && experience.zone === query.zone) {
    score += 1;
  }
  return score;
}

export function recency(experience: Experience, nowMinutes: number): number {
  const since = Math.max(experience.lastAccess ?? 0, whenOf(experience));
  const hours = Math.max(0, (nowMinutes - since) / 60);
  return RECENCY_DECAY_PER_HOUR ** hours;
}

// A repeated interaction on one day (sitting thirty times) is one experience, counted
export type Folded = Experience & { count: number; members: Experience[] };

export function fold(experiences: Experience[]): Folded[] {
  const groups = new Map<string, Folded>();
  const out: Folded[] = [];
  experiences.forEach((experience) => {
    if (experience.source !== 'interaction') {
      out.push({ ...experience, count: 1, members: [experience] });
      return;
    }
    // By the Sims involved, not the object: five puddles mopped are one chore (live 10-24)
    const key = `${experience.day}|${experience.kind}|${experience.verb ?? ''}|${experience.participants.join(',')}`;
    const group = groups.get(key);
    if (!group) {
      const created: Folded = { ...experience, count: 1, members: [experience] };
      groups.set(key, created);
      out.push(created);
      return;
    }
    group.count += 1;
    group.members.push(experience);
    group.importance = Math.max(group.importance, experience.importance);
    if (whenOf(experience) > whenOf(group)) {
      group.minute = experience.minute;
    }
    group.lastAccess = Math.max(group.lastAccess ?? 0, experience.lastAccess ?? 0) || undefined;
  });
  return out;
}

function normalize(values: number[]): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  return values.map((value) => (max > min ? (value - min) / (max - min) : 0));
}

export type Ranked = Folded & { score: number; parts: { recency: number; importance: number; relevance: number } };

// The GA score over the folded candidates: top k by score, returned oldest first
export function rank(experiences: Experience[], nowMinutes: number, query: RelevanceQuery, k: number): Ranked[] {
  const folded = fold(experiences);
  if (folded.length === 0) {
    return [];
  }
  const recencies = normalize(folded.map((item) => recency(item, nowMinutes)));
  const importances = normalize(folded.map((item) => item.importance));
  const relevances = normalize(folded.map((item) => relevance(item, query)));
  const scored: Ranked[] = folded.map((item, index) => ({
    ...item,
    score: recencies[index] + importances[index] + relevances[index],
    parts: { recency: recencies[index], importance: importances[index], relevance: relevances[index] },
  }));
  return scored
    .sort((a, b) => b.score - a.score || whenOf(b) - whenOf(a))
    .slice(0, k)
    .sort((a, b) => whenOf(a) - whenOf(b));
}

function clock(minute: number | undefined): string {
  if (minute === undefined) {
    return '';
  }
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')} `;
}

export function experienceLine(item: Ranked | Folded, newDay: number): string {
  const daysAgo = newDay - item.day;
  const when = daysAgo <= 1 ? 'yesterday' : `${daysAgo} days ago`;
  const count = item.count > 1 ? ` (x${item.count})` : '';
  return `- ${when} ${clock(item.minute)}[${item.kind}] ${item.text ?? item.verb ?? '?'}${count}`;
}
