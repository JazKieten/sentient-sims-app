// Procedures and pitfalls (autonomy renovation R4, 2026-10-24; autonomy tier): what clicked and
// ran for a row key, kept so tomorrow clicks it first, and the lessons failures taught. Code
// drafts and counts from the game's own outcomes; the night call revises a failed procedure in
// place and writes pitfalls (its diagnoses and add_pitfall). No model is called from here, and
// every database touch is guarded: no save loaded means nothing is kept, never a throw.
import log from 'electron-log';
import type { ApiContext } from '../ApiContext';
import type { IntentionRow } from '../../models/IntentionRow';
import type { ProcedureRepository } from '../../db/ProcedureRepository';
import type {
  IntentionClick,
  IntentionPitfallAdd,
  IntentionProcedureRevision,
  IntentionStoryAdd,
} from '../../tiers/types';
import type { RowMemoryService } from './RowMemoryService';
import { classifyOutcome } from './RowMemory';
import {
  NightLessons,
  Pitfall,
  Procedure,
  SHARED_SCOPE,
  applyToRow,
  bindClick,
  draftFrom,
  emptyProcedure,
  nightLessons,
  normalizeKey,
  procedureKeyOf,
  promotable,
  recordFailure,
  revise,
} from './Procedures';

export type ProcedureDeps = { procedureRepository?: ProcedureRepository; rowMemory?: RowMemoryService };

// What came back for a row's click (InteractionOutcomeEvent's fields that matter here)
export type ProcedureOutcome = { outcome: string; cause?: string; reason?: string; ran?: boolean; label?: string };

const PITFALL_TEXT_CHARS = 200;
const EVIDENCE_FIRES = 3;

export class ProcedureService {
  private readonly ctx: ApiContext;

  private readonly deps: ProcedureDeps;

  // scope -> its procedures / pitfalls (read lazily, dropped on any write to that scope)
  private readonly procedureCache = new Map<string, Procedure[]>();

  private readonly pitfallCache = new Map<string, Pitfall[]>();

  // `${day}|${zone}` -> the shared block, frozen for the game day (a byte-stable prefix)
  private sharedFrozen: { key: string; lines: string[] } | undefined;

  constructor(ctx: ApiContext, deps: ProcedureDeps) {
    this.ctx = ctx;
    this.deps = deps;
  }

  // --- plumbing -----------------------------------------------------------------------------

  private repo(): ProcedureRepository | undefined {
    const repository = this.deps.procedureRepository;
    try {
      return repository?.isLoaded() ? repository : undefined;
    } catch {
      return undefined;
    }
  }

  private guard<T>(what: string, fn: (repository: ProcedureRepository) => T): T | undefined {
    const repository = this.repo();
    if (!repository) {
      return undefined;
    }
    try {
      return fn(repository);
    } catch (error) {
      log.debug(`[Procedures] ${what} failed: ${String(error)}`);
      return undefined;
    }
  }

  private today(): number | undefined {
    return this.ctx.simStateCache.getReport()?.lot?.clock?.absolute_day;
  }

  private zone(): string | undefined {
    const zone = this.ctx.simStateCache.getReport()?.lot?.zone_id;
    return zone === undefined ? undefined : String(zone);
  }

  private simName(simId: string): string {
    return (this.ctx.simStateCache.getSim(simId)?.sim_name ?? '').trim().split(/\s+/)[0] || `sim ${simId}`;
  }

  private proceduresOf(scope: string): Procedure[] {
    let cached = this.procedureCache.get(scope);
    if (!cached) {
      cached = this.guard('load procedures', (repository) => repository.procedures(scope)) ?? [];
      this.procedureCache.set(scope, cached);
    }
    return cached;
  }

  private pitfallsOf(scope: string): Pitfall[] {
    let cached = this.pitfallCache.get(scope);
    if (!cached) {
      cached = this.guard('load pitfalls', (repository) => repository.pitfalls(scope)) ?? [];
      this.pitfallCache.set(scope, cached);
    }
    return cached;
  }

  private saveProcedure(procedure: Procedure) {
    this.guard('save procedure', (repository) => {
      repository.saveProcedure(procedure);
    });
    this.procedureCache.delete(procedure.scope);
  }

  private savePitfall(pitfall: Pitfall) {
    this.guard('save pitfall', (repository) => {
      repository.savePitfall(pitfall);
    });
    this.pitfallCache.delete(pitfall.scope);
  }

  procedureFor(scope: string, key: string): Procedure | undefined {
    return this.proceduresOf(scope).find((procedure) => procedure.key === key);
  }

  // The ONE procedure a row uses (k = 1): the Sim's own, else everyone's here; active only
  activeFor(simId: string, key: string): Procedure | undefined {
    const own = this.procedureFor(simId, key);
    if (own) {
      return own.status === 'active' ? own : undefined;
    }
    const shared = this.procedureFor(SHARED_SCOPE, key);
    return shared?.status === 'active' ? shared : undefined;
  }

  // --- what the day's outcomes teach --------------------------------------------------------

  // A keyed pie row's click came back. Success that ran drafts or strengthens the procedure
  // (the item that ran goes first); anything else is a failure counted against it.
  onOutcome(simId: string, row: IntentionRow, facts: ProcedureOutcome) {
    const key = procedureKeyOf(row, this.zone());
    if (!key) {
      return;
    }
    const day = this.today();
    const name = this.simName(simId);
    if (facts.outcome === 'success' && facts.ran !== false) {
      const existing = this.procedureFor(simId, key);
      const clicked = facts.label?.trim() || undefined;
      const next = draftFrom(existing, { scope: simId, key, zone: this.zone(), row, clicked, day });
      this.saveProcedure(next);
      if (!existing || existing.status !== 'active') {
        log.info(
          `[Procedures] ${name} ${existing ? 'restored' : 'drafted'} [${key}]: ${next.targetKind}` +
            `${next.targetName ? ` ${next.targetName}` : ''}: ${next.items.join(' | ')}`,
        );
      }
      this.staleAbout(simId, [key, row.seedKey]);
      this.promote(next);
      return;
    }
    const existing = this.procedureFor(simId, key);
    if (!existing) {
      return;
    }
    const classified = classifyOutcome(facts.outcome, facts.cause, facts.reason);
    this.fail(simId, existing, {
      day,
      cause: classified.cause,
      reason: facts.reason?.slice(0, 240),
      target: row.what.kind === 'pie' ? (row.what.target?.name ?? row.what.target?.kind) : undefined,
      structural: classified.structural,
    });
  }

  private fail(
    simId: string,
    procedure: Procedure,
    failure: { day?: number; cause?: string; reason?: string; target?: string; structural: boolean },
  ) {
    const next = recordFailure(procedure, failure);
    this.saveProcedure(next);
    if (next.status !== procedure.status) {
      log.info(
        `[Procedures] ${this.simName(simId)} [${next.key}] ${next.status === 'retired' ? 'retired' : 'needs a fix'}: ` +
          `${failure.cause ?? 'failed'} (ran=${next.ran} failed=${next.failed})`,
      );
    }
  }

  // The debug route's force (the live check): one structural failure through the same code
  recordFailureNow(simId: string, key: string, cause = 'not_on_menu'): Procedure | undefined {
    const procedure = this.procedureFor(simId, key);
    if (!procedure) {
      return undefined;
    }
    this.fail(simId, procedure, { day: this.today(), cause, reason: 'debug: forced failure', structural: true });
    return this.procedureFor(simId, key);
  }

  // Two Sims ran the same click for one key: everyone here gets it (code, never the model)
  private promote(procedure: Procedure) {
    if (this.procedureFor(SHARED_SCOPE, procedure.key)) {
      return;
    }
    const sameKey = this.guard('procedures by key', (repository) => repository.proceduresByKey(procedure.key)) ?? [];
    if (!promotable(sameKey, procedure)) {
      return;
    }
    this.saveProcedure({
      ...emptyProcedure(SHARED_SCOPE, procedure.key),
      zone: procedure.zone,
      targetKind: procedure.targetKind,
      targetName: procedure.targetName,
      items: [...procedure.items],
      why: procedure.why,
      ran: sameKey.reduce((sum, entry) => sum + entry.ran, 0),
      firstDay: procedure.lastDay,
      lastDay: procedure.lastDay,
    });
    log.info(`[Procedures] [${procedure.key}] shared: ran for several Sims here`);
  }

  // A key that ran makes its pitfalls history
  private staleAbout(simId: string, abouts: string[]) {
    this.pitfallsOf(simId)
      .filter((pitfall) => pitfall.status === 'active' && abouts.includes(pitfall.about))
      .forEach((pitfall) => {
        this.savePitfall({ ...pitfall, status: 'stale' });
      });
  }

  // --- the seeded rows ----------------------------------------------------------------------

  // A seeded pie row clicks its key's procedure first (k = 1); story rows carry their own click
  applyToRow(simId: string, row: IntentionRow): boolean {
    if (row.source === 'story' || row.status !== 'waiting') {
      return false;
    }
    const key = procedureKeyOf(row, this.zone());
    if (!key) {
      return false;
    }
    const procedure = this.activeFor(simId, key);
    const what = procedure ? applyToRow(row, procedure) : undefined;
    if (!what) {
      return false;
    }
    row.what = what;
    return true;
  }

  // --- the night call's edits ---------------------------------------------------------------

  // A story row with a key and no click takes its procedure's click (k = 1)
  bindStoryClick(simId: string, add: IntentionStoryAdd): IntentionClick | undefined {
    const key = normalizeKey(add.key);
    if (!key || add.click) {
      return undefined;
    }
    const procedure = this.activeFor(simId, key);
    return procedure ? bindClick(procedure, add) : undefined;
  }

  // Memp's adjust: a listed procedure revised in place. Returns why it was refused, if it was.
  revise(simId: string, revision: IntentionProcedureRevision): string | undefined {
    const key = normalizeKey(revision.key);
    const procedure = key ? this.procedureFor(simId, key) : undefined;
    if (!key || !procedure) {
      return `[${revision.key}] is not one of ${this.simName(simId)}'s procedures`;
    }
    if (procedure.status === 'retired') {
      return `[${key}] is retired (failed ${procedure.failed} times)`;
    }
    const next = revise(procedure, revision, this.today());
    this.saveProcedure(next);
    log.info(
      `[Procedures] ${this.simName(simId)} revised [${key}]: ${next.targetKind}` +
        `${next.targetName ? ` ${next.targetName}` : ''}: ${next.items.join(' | ')}`,
    );
    return undefined;
  }

  // A lesson: the Sim's own, or everyone's here when shared. Same scope and subject = the same
  // lesson, rewritten in place and counted again.
  addPitfall(simId: string, lesson: IntentionPitfallAdd, source: Pitfall['source'], evidence: number[] = []) {
    const about = normalizeKey(lesson.about) ?? lesson.about.trim().slice(0, 80);
    const text = lesson.text.replace(/\s+/g, ' ').trim().slice(0, PITFALL_TEXT_CHARS);
    if (!about || !text) {
      return;
    }
    const scope = lesson.shared ? SHARED_SCOPE : simId;
    const day = this.today();
    const existing = this.pitfallsOf(scope).find((pitfall) => pitfall.about === about);
    this.savePitfall({
      scope,
      about,
      text,
      evidence: [...new Set([...(existing?.evidence ?? []), ...evidence])].slice(-10),
      seen: (existing?.seen ?? 0) + 1,
      status: 'active',
      source,
      zone: lesson.shared ? this.zone() : existing?.zone,
      firstDay: existing?.firstDay ?? day,
      lastDay: day,
    });
  }

  // The night call's diagnosis of a dead or failed key is that key's pitfall, with the fires
  // that failed as its evidence
  diagnose(simId: string, seedKey: string, text: string) {
    const evidence = (this.deps.rowMemory?.firesFor(simId, undefined, 100) ?? [])
      .filter((fire) => fire.seedKey === seedKey && fire.outcome !== 'success' && fire.outcome !== 'echo')
      .slice(0, EVIDENCE_FIRES)
      .map((fire) => fire.id)
      .filter((id): id is number => typeof id === 'number');
    this.addPitfall(simId, { about: seedKey, text, shared: false }, 'diagnosis', evidence);
  }

  diagnosisFor(simId: string, seedKey: string): string | undefined {
    return this.pitfallsOf(simId).find((pitfall) => pitfall.about === seedKey && pitfall.source === 'diagnosis')?.text;
  }

  // --- the night text -----------------------------------------------------------------------

  nightLessons(simId: string, day: number): NightLessons {
    const zone = this.zone();
    const lessons = nightLessons({
      own: this.proceduresOf(simId),
      ownPitfalls: this.pitfallsOf(simId),
      shared: this.proceduresOf(SHARED_SCOPE),
      sharedPitfalls: this.pitfallsOf(SHARED_SCOPE),
      day,
      zone,
    });
    // Frozen for the game day and zone: every night call of the day opens with the same bytes
    const frozenKey = `${day}|${zone ?? '?'}`;
    if (this.sharedFrozen?.key !== frozenKey) {
      this.sharedFrozen = { key: frozenKey, lines: lessons.shared };
    }
    return { ...lessons, shared: this.sharedFrozen.lines };
  }

  // --- views --------------------------------------------------------------------------------

  view(simId?: string): { procedures: Procedure[]; pitfalls: Pitfall[] } {
    if (simId) {
      return {
        procedures: [...this.proceduresOf(simId), ...this.proceduresOf(SHARED_SCOPE)],
        pitfalls: [...this.pitfallsOf(simId), ...this.pitfallsOf(SHARED_SCOPE)],
      };
    }
    return {
      procedures: this.guard('all procedures', (repository) => repository.allProcedures()) ?? [],
      pitfalls: this.guard('all pitfalls', (repository) => repository.allPitfalls()) ?? [],
    };
  }

  // Procedures are per save
  onDatabaseLoaded() {
    this.procedureCache.clear();
    this.pitfallCache.clear();
    this.sharedFrozen = undefined;
  }
}
