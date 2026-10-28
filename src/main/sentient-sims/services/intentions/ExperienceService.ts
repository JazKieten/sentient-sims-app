// The private view, first half (autonomy renovation R5a, 2026-10-24; autonomy tier): each
// household Sim's experiences, built by code at night from what is already stored (the
// household's interaction_log for the day, the Sim's own memories of the day, and the game facts
// that opened or closed that day), and ranked the Generative Agents way for the night text in
// place of "the last 25 memories". Game facts are sim_fact rows of source 'game' (code-diffed
// from the dossier, Zep-style); they are INJECTED as the day's changes, never left to ranking.
// No model is called from here; every database touch is guarded.
import log from 'electron-log';
import type { ApiContext } from '../ApiContext';
import type { IntentionRow } from '../../models/IntentionRow';
import type { SimDossier } from '../../models/SimDossier';
import type { SimFactRecord } from '../../db/SimFactRepository';
import type { ExperienceRepository } from '../../db/ExperienceRepository';
import type { InteractionLogEntry, RowMemoryRepository } from '../../db/RowMemoryRepository';
import { FactPredicate } from '../../pipeline/facts/predicates';
import {
  DEFAULT_MEMORY_IMPORTANCE,
  EXPERIENCE_KEEP_DAYS,
  EXPERIENCE_WINDOW_DAYS,
  Experience,
  NIGHT_EXPERIENCES,
  Ranked,
  RelevanceQuery,
  experienceLine,
  factImportance,
  interactionImportance,
  rank,
  verbFamily,
} from './Experience';

export type ExperienceDeps = { experienceRepository?: ExperienceRepository; rowMemoryRepository?: RowMemoryRepository };

const MEMORIES_READ = 200;
const MEMORY_TEXT_CHARS = 200;
const NIGHT_CHANGES = 20;

// The night text's two blocks
export type NightExperiences = { changes: string[]; lived: string[]; count: number };

function pretty(text: string): string {
  return text.replace(/_/g, ' ');
}

function flat(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}...` : line;
}

// A game fact in words: "friends with Arlene Zhang (friendship-friend)", "job career_Adult_Athletic"
function factWords(fact: SimFactRecord, names: Record<string, string | undefined>): string {
  const other = fact.objectSimId ? (names[fact.objectSimId] ?? `sim ${fact.objectSimId}`) : undefined;
  const text = fact.objectText;
  switch (fact.predicate) {
    case FactPredicate.REL_BIT:
      return `${text ?? 'a bit'} with ${other ?? '?'}`;
    case FactPredicate.KNOWS:
      return `has met ${other ?? '?'}`;
    case FactPredicate.KNOWS_TRAIT:
      return `knows ${other ?? '?'} is ${text ? pretty(text) : '?'}`;
    case FactPredicate.KNOWS_CAREER:
      return `knows ${other ?? '?'} works as ${text ? pretty(text) : '?'}`;
    case FactPredicate.KNOWS_MAJOR:
      return `knows ${other ?? '?'} studies ${text ? pretty(text) : '?'}`;
    case FactPredicate.KNOWS_SECRET:
      return `knows ${other ?? '?'}'s secret ${text ? pretty(text) : ''}`.trim();
    case FactPredicate.KNOWS_STATUS:
      return `knows whether ${other ?? '?'} is taken`;
    default:
      return `${pretty(fact.predicate)} ${[text ? pretty(text) : undefined, other].filter(Boolean).join(' ')}`.trim();
  }
}

export class ExperienceService {
  private readonly ctx: ApiContext;

  private readonly deps: ExperienceDeps;

  private prunedDay: number | undefined;

  constructor(ctx: ApiContext, deps: ExperienceDeps) {
    this.ctx = ctx;
    this.deps = deps;
  }

  private loaded(): boolean {
    try {
      return this.ctx.db.isLoaded();
    } catch {
      return false;
    }
  }

  private guard<T>(what: string, fn: () => T): T | undefined {
    if (!this.loaded()) {
      return undefined;
    }
    try {
      return fn();
    } catch (error) {
      log.debug(`[Experience] ${what} failed: ${String(error)}`);
      return undefined;
    }
  }

  private dossierOf(simId: string): SimDossier | undefined {
    const record = this.guard('dossier', () => this.ctx.simFactRepository.getDossier(simId));
    if (!record) {
      return undefined;
    }
    try {
      return JSON.parse(record.json) as SimDossier;
    } catch {
      return undefined;
    }
  }

  // Everyone the Sim's dossier and the state report can name
  private namesFor(simId: string, dossier: SimDossier | undefined): Record<string, string | undefined> {
    const names: Record<string, string | undefined> = {};
    (dossier?.relationships ?? []).forEach((edge) => {
      names[edge.sim_id] = edge.name;
    });
    (this.ctx.simStateCache.getReport()?.sims ?? []).forEach((sim) => {
      if (sim.sim_id && sim.sim_name) {
        names[sim.sim_id] = sim.sim_name;
      }
    });
    if (dossier?.name) {
      names[simId] = dossier.name;
    }
    return names;
  }

  // --- building ------------------------------------------------------------------------------

  private fromInteraction(
    holder: string,
    record: InteractionLogEntry,
    kind: 'did' | 'with',
    names: Record<string, string | undefined>,
  ): Experience | undefined {
    if (record.id === undefined || record.day === undefined || record.isSuper === false) {
      return undefined;
    }
    // What ran, and what the player stopped; an exit that never ran is the game's own churn
    if (!record.ran && !record.userCanceled) {
      return undefined;
    }
    const verb = record.superName ?? record.name;
    const other =
      kind === 'with'
        ? record.simId
        : record.targetKind === 'sim' && record.targetId && record.targetId !== holder
          ? record.targetId
          : undefined;
    const outcome = record.userCanceled ? 'canceled by the player' : record.canceled ? 'cut short' : undefined;
    const otherName = other ? (names[other] ?? `sim ${other}`) : undefined;
    const verbText = verb ? pretty(verb) : '?';
    const text =
      kind === 'with'
        ? `${otherName ?? '?'} did ${verbText} with them`
        : `${verbText}${otherName ? ` with ${otherName}` : ''}`;
    return {
      holder,
      day: record.day,
      minute: record.minute,
      kind,
      participants: other ? [other] : [],
      verb,
      verbFamily: verbFamily(verb),
      target: other ?? (record.targetKind === 'object' ? record.targetId : undefined),
      zone: record.zone,
      outcome,
      finishing: record.finishing,
      importance: interactionImportance({
        withSim: Boolean(other),
        ran: record.ran,
        canceled: record.canceled,
        userCanceled: record.userCanceled,
      }),
      source: 'interaction',
      sourceId: `${record.id}:${kind}`,
      text: `${text}${outcome ? ` (${outcome})` : ''}`,
    };
  }

  private fromMemories(holder: string, day: number): Experience[] {
    const memories =
      this.guard('memories', () => this.ctx.memoryRepository.getOwnDayMemories(holder, day, MEMORIES_READ)) ?? [];
    const ids = memories.map((memory) => memory.id).filter((id): id is string => Boolean(id));
    const participants =
      this.guard('memory participants', () => this.ctx.memoryRepository.getParticipantIdsForMemories(ids)) ??
      new Map<string, string[]>();
    return memories
      .filter((memory) => memory.id)
      .map((memory) => {
        const id = memory.id as string;
        const others = (participants.get(id) ?? []).filter((simId) => simId !== holder);
        const index = this.guard('memory index', () => this.ctx.memoryIndexRepository.getIndex(id));
        const importance =
          typeof index?.importance === 'number' && Number.isFinite(index.importance)
            ? index.importance
            : DEFAULT_MEMORY_IMPORTANCE;
        const text = memory.content ?? memory.action ?? memory.pre_action ?? '';
        const verb = memory.interaction_name ?? memory.event_type;
        return {
          holder,
          day,
          kind: others.length > 0 ? ('with' as const) : ('did' as const),
          participants: others,
          verb,
          verbFamily: verbFamily(memory.interaction_name ?? undefined),
          importance,
          source: 'memory' as const,
          sourceId: id,
          text: `${memory.event_type ? `(${memory.event_type}) ` : ''}${flat(text, MEMORY_TEXT_CHARS)}`,
        };
      });
  }

  // The game facts that opened or closed for the Sim on a day. A predicate's first appearance
  // for the Sim (a fresh save, or a predicate this build added) is the record catching up, not
  // something that happened, so its openings are left out; a closing whose other Sim fell out
  // of the dossier (the 80-edge cap) is the record shrinking, not a change.
  factChanges(holder: string, day: number, dossier?: SimDossier): { fact: SimFactRecord; opened: boolean }[] {
    const history = this.guard('fact history', () => this.ctx.simFactRepository.getHistory(holder)) ?? [];
    const game = history.filter((fact) => fact.source === 'game');
    const firstDay = new Map<string, number>();
    game.forEach((fact) => {
      if (fact.validFromDay === undefined) {
        return;
      }
      const seen = firstDay.get(fact.predicate);
      if (seen === undefined || fact.validFromDay < seen) {
        firstDay.set(fact.predicate, fact.validFromDay);
      }
    });
    const edges = new Set((dossier?.relationships ?? []).map((edge) => edge.sim_id));
    const changes: { fact: SimFactRecord; opened: boolean }[] = [];
    game.forEach((fact) => {
      if (fact.validFromDay === day && firstDay.get(fact.predicate) !== day) {
        changes.push({ fact, opened: true });
      }
      if (fact.validToDay === day) {
        if (fact.objectSimId && dossier && !edges.has(fact.objectSimId)) {
          return;
        }
        changes.push({ fact, opened: false });
      }
    });
    return changes.sort((a, b) => (a.fact.id ?? 0) - (b.fact.id ?? 0));
  }

  // Everything the Sim lived through on a day, stored once (a second call adds nothing)
  ingestDay(holder: string, day: number): number {
    const repository = this.deps.experienceRepository;
    if (!repository || !this.loaded()) {
      return 0;
    }
    const dossier = this.dossierOf(holder);
    const names = this.namesFor(holder, dossier);
    const rows: Experience[] = [];
    const logs = this.deps.rowMemoryRepository;
    (this.guard('interactions', () => logs?.interactionsFor(holder, day, 'actor')) ?? []).forEach((record) => {
      const experience = this.fromInteraction(holder, record, 'did', names);
      if (experience) {
        rows.push(experience);
      }
    });
    (this.guard('interactions with', () => logs?.interactionsFor(holder, day, 'target')) ?? []).forEach((record) => {
      if (record.simId === holder) {
        return;
      }
      const experience = this.fromInteraction(holder, record, 'with', names);
      if (experience) {
        rows.push(experience);
      }
    });
    rows.push(...this.fromMemories(holder, day));
    this.factChanges(holder, day, dossier).forEach(({ fact, opened }) => {
      const importance = factImportance(fact.predicate, opened);
      if (importance === undefined || fact.id === undefined) {
        return;
      }
      rows.push({
        holder,
        day,
        kind: 'fact',
        participants: fact.objectSimId ? [fact.objectSimId] : [],
        verb: fact.predicate,
        verbFamily: fact.predicate,
        target: fact.objectSimId,
        importance,
        source: 'fact',
        sourceId: `${fact.id}:${opened ? 'open' : 'close'}`,
        text: `${opened ? 'now' : 'no longer'}: ${factWords(fact, names)}`,
      });
    });
    return this.guard('insert', () => repository.insertMany(rows)) ?? 0;
  }

  // --- reading -------------------------------------------------------------------------------

  // What tomorrow holds, for relevance: the Sims today's rows name and the Sims around, the
  // verbs the rows mean to click, the zone
  queryFor(holder: string, todayRows: IntentionRow[]): RelevanceQuery {
    const sims = new Set<string>();
    const verbs = new Set<string>();
    todayRows.forEach((row) => {
      if (row.target?.sim_id) {
        sims.add(row.target.sim_id);
      }
      const candidates =
        row.what.kind === 'pie' ? row.what.candidates : row.what.kind === 'action' ? row.what.actions : [];
      candidates.forEach((candidate) => {
        const family = verbFamily(candidate);
        if (family) {
          verbs.add(family);
        }
      });
    });
    (this.ctx.simStateCache.getSim(holder)?.sims ?? []).forEach((perceived) => {
      if (perceived.sim_id) {
        sims.add(perceived.sim_id);
      }
    });
    const zone = this.ctx.simStateCache.getReport()?.lot?.zone_id;
    return { sims, verbs, zone: zone === undefined ? undefined : String(zone) };
  }

  ranked(holder: string, newDay: number, nowMinutes: number, query: RelevanceQuery, excludeFactsOf?: number): Ranked[] {
    const candidates =
      this.guard('candidates', () =>
        this.deps.experienceRepository?.forHolder(holder, newDay - EXPERIENCE_WINDOW_DAYS),
      ) ?? [];
    const pool = candidates.filter((item) => !(item.kind === 'fact' && item.day === excludeFactsOf));
    return rank(pool, nowMinutes, query, NIGHT_EXPERIENCES);
  }

  // The night text's blocks for the ending day: the game's record of what changed (injected),
  // and the ranked experiences (the shown ones are marked accessed now)
  nightView(holder: string, endingDay: number, newDay: number, todayRows: IntentionRow[]): NightExperiences {
    this.ingestDay(holder, endingDay);
    this.prune(newDay);
    const dossier = this.dossierOf(holder);
    const names = this.namesFor(holder, dossier);
    const changes = this.factChanges(holder, endingDay, dossier)
      .slice(0, NIGHT_CHANGES)
      .map(({ fact, opened }) => `- ${opened ? 'now' : 'no longer'}: ${factWords(fact, names)}`);
    const nowMinutes = newDay * 1440;
    const ranked = this.ranked(holder, newDay, nowMinutes, this.queryFor(holder, todayRows), endingDay);
    const ids = ranked.flatMap((item) => item.members.map((member) => member.id)).filter((id): id is number => !!id);
    if (ids.length > 0) {
      this.guard('mark accessed', () => this.deps.experienceRepository?.markAccessed(ids, nowMinutes));
    }
    return { changes, lived: ranked.map((item) => experienceLine(item, newDay)), count: ranked.length };
  }

  // Kept EXPERIENCE_KEEP_DAYS game days
  prune(day: number) {
    if (this.prunedDay === day) {
      return;
    }
    this.prunedDay = day;
    this.guard('prune', () => this.deps.experienceRepository?.prune(day - EXPERIENCE_KEEP_DAYS));
  }

  // The debug view: the rows of the window and the ranking as the night would see it now
  view(holder: string, todayRows: IntentionRow[]) {
    const report = this.ctx.simStateCache.getReport();
    const day = report?.lot?.clock?.absolute_day ?? 0;
    const clock = report?.lot?.clock;
    const now = day * 1440 + (typeof clock?.hour === 'number' ? clock.hour * 60 + (clock.minute ?? 0) : 0);
    const query = this.queryFor(holder, todayRows);
    return {
      sim_id: holder,
      day,
      query: { sims: [...query.sims], verbs: [...query.verbs], zone: query.zone },
      ranked: this.ranked(holder, day, now, query).map(({ members, ...item }) => ({
        ...item,
        members: members.length,
      })),
      rows:
        this.guard('rows', () => this.deps.experienceRepository?.forHolder(holder, day - EXPERIENCE_WINDOW_DAYS)) ?? [],
    };
  }

  onDatabaseLoaded() {
    this.prunedDay = undefined;
  }
}
