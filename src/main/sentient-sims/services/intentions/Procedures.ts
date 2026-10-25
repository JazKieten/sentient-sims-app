// Procedures and pitfalls (autonomy renovation R4, 2026-10-24; autonomy tier). Pure: the keys,
// the rules and the night text's lines. ProcedureService keeps them and calls these.
//
// A procedure is what clicked and RAN for a row key: a target and 1-3 pie items, the winner
// first (a row fires one click, first runnable item wins, so the "chain" is the ordered item
// list). Code drafts one from the game's own outcome (Memp's Validation: successes only, the
// game is the judge, never a model); the night call revises a failed one in place (Memp's
// adjust). A pitfall is a lesson a failure taught (ReasoningBank: distilled, not the raw
// failure): the night call's diagnosis of a dead key, or its add_pitfall. Counters move by code;
// R1's rule retires a procedure (3 failures since it last ran, the last one structural).
// Exact keys, no embeddings; one procedure per row at most (ReasoningBank's k = 1).
import type { IntentionRow, PieTarget } from '../../models/IntentionRow';
import type { IntentionClick, IntentionProcedureRevision } from '../../tiers/types';
import { RETIRE_MIN_FIRES } from './RowMemory';

export const SHARED_SCOPE = '*';
export const MAX_PROCEDURE_ITEMS = 3;
// The night text's caps (ACE: a small per-Sim section; its pruning results were flat in size)
export const NIGHT_PROCEDURES = 15;
export const NIGHT_FAILED_PROCEDURES = 8;
export const NIGHT_PITFALLS = 15;
export const NIGHT_SHARED = 10;
// A pitfall not seen again for this many game days drops out of the text (kept in the table)
export const PITFALL_SHOW_DAYS = 7;
// Code promotes a procedure to everyone here when this many Sims ran the same click for a key
export const PROMOTE_SIMS = 2;

export type ProcedureStatus = 'active' | 'needs_fix' | 'retired';
// 'sim' is the procedure's variable ({target}): it binds to whoever the row names. 'find' =
// no target named, the mod finds a provider.
export type ProcedureTargetKind = 'self' | 'sim' | 'kind' | 'phone' | 'find';
export type ProcedureFailure = { day?: number; cause?: string; reason?: string; target?: string };

export type Procedure = {
  id?: number;
  scope: string;
  key: string;
  zone?: string;
  targetKind: ProcedureTargetKind;
  targetName?: string;
  items: string[];
  why?: string;
  uses: number;
  ran: number;
  failed: number;
  firesSinceRan: number;
  lastCause?: string;
  lastStructural: boolean;
  lastFailure?: ProcedureFailure;
  status: ProcedureStatus;
  source: 'code' | 'night';
  firstDay?: number;
  lastDay?: number;
  revisions: number;
  revisedDay?: number;
};

export type PitfallStatus = 'active' | 'stale';

export type Pitfall = {
  id?: number;
  scope: string;
  about: string;
  text: string;
  // row_fire_log ids of the failures it was written from (a diagnosis); [] for a free lesson
  evidence: number[];
  seen: number;
  status: PitfallStatus;
  source: 'diagnosis' | 'night';
  zone?: string;
  firstDay?: number;
  lastDay?: number;
};

// The night text's lesson blocks, rendered
export type NightLessons = {
  // Everyone here: shared procedures and pitfalls (first in the text, frozen per day and zone)
  shared: string[];
  worked: string[];
  failed: string[];
  pitfalls: string[];
};

const GOAL_SOURCES = new Set(['aspiration', 'promotion', 'daily_task', 'want']);
const KEYED_SOURCES = new Set(['work', 'drama', 'bills']);

// The key as the night call wrote it, made exact: no brackets, no spaces, at most 80 chars.
// Case is kept: a goal key is the game's tuning name (objective_Asp_Nature_A1_1@<zone>).
export function normalizeKey(raw: string | undefined | null): string | undefined {
  if (!raw) {
    return undefined;
  }
  const key = raw
    .trim()
    .replace(/^\[|\]$/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_:@.\-{}]/g, '')
    .slice(0, 80);
  return key || undefined;
}

// The procedure key a row is judged under: a story row's own key (the night's), a goal row's
// seed key at this zone (providers differ by lot), work / drama / bills by their seed key.
// Need, scene and conversation rows never get one; only pie rows click a procedure.
export function procedureKeyOf(row: IntentionRow, zone: string | undefined): string | undefined {
  if (row.what.kind !== 'pie') {
    return undefined;
  }
  if (row.source === 'story') {
    return row.procedureKey;
  }
  if (GOAL_SOURCES.has(row.source)) {
    return zone ? `${row.seedKey}@${zone}` : row.seedKey;
  }
  if (KEYED_SOURCES.has(row.source)) {
    return row.seedKey;
  }
  return undefined;
}

// Where the row clicked, generalized: a Sim becomes the variable
export function targetOf(row: IntentionRow): { kind: ProcedureTargetKind; name?: string } {
  const target: PieTarget | undefined = row.what.kind === 'pie' ? row.what.target : undefined;
  if (!target) {
    return { kind: 'find' };
  }
  if (target.kind === 'sim') {
    return { kind: 'sim' };
  }
  if (target.kind === 'kind') {
    return { kind: 'kind', name: target.name ?? target.id };
  }
  return { kind: target.kind };
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.trim().toLowerCase();
    if (!item.trim() || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function emptyProcedure(scope: string, key: string): Procedure {
  return {
    scope,
    key,
    targetKind: 'find',
    items: [],
    uses: 0,
    ran: 0,
    failed: 0,
    firesSinceRan: 0,
    lastStructural: false,
    status: 'active',
    source: 'code',
    revisions: 0,
  };
}

// A row's click ran: the procedure for its key, with the item that actually ran first. A
// night-revised procedure keeps its source; its items gain the winner at the front.
export function draftFrom(
  existing: Procedure | undefined,
  args: { scope: string; key: string; zone?: string; row: IntentionRow; clicked?: string; day?: number },
): Procedure {
  const base = existing ? { ...existing } : emptyProcedure(args.scope, args.key);
  const candidates = args.row.what.kind === 'pie' ? args.row.what.candidates : [];
  const rest = existing && existing.items.length > 0 ? existing.items : candidates;
  base.items = dedupe([...(args.clicked ? [args.clicked] : []), ...rest]).slice(0, MAX_PROCEDURE_ITEMS);
  if (!existing || existing.source === 'code') {
    const target = targetOf(args.row);
    base.targetKind = target.kind;
    base.targetName = target.name;
  }
  base.zone = base.zone ?? args.zone;
  base.why = base.why ?? args.row.why;
  base.uses += 1;
  base.ran += 1;
  base.firesSinceRan = 0;
  base.lastCause = undefined;
  base.lastStructural = false;
  base.status = 'active';
  if (args.day !== undefined) {
    base.firstDay = base.firstDay ?? args.day;
    base.lastDay = args.day;
  }
  return base;
}

// R1's rule on a procedure: failed 3 times since it last ran, the last time structurally
export function shouldRetireProcedure(procedure: Procedure): boolean {
  return procedure.firesSinceRan >= RETIRE_MIN_FIRES && procedure.lastStructural;
}

// A click under this key did not run. A structural failure (not on the menu, no target, a
// gate the Sim cannot pass) asks the night for a fix; a passing one (the target walked off)
// is only counted.
export function recordFailure(procedure: Procedure, failure: ProcedureFailure & { structural: boolean }): Procedure {
  const next = { ...procedure };
  next.uses += 1;
  next.failed += 1;
  next.firesSinceRan += 1;
  next.lastCause = failure.cause;
  next.lastStructural = failure.structural;
  next.lastFailure = { day: failure.day, cause: failure.cause, reason: failure.reason, target: failure.target };
  if (failure.day !== undefined) {
    next.lastDay = failure.day;
  }
  if (next.status !== 'retired') {
    if (shouldRetireProcedure(next)) {
      next.status = 'retired';
    } else if (failure.structural) {
      next.status = 'needs_fix';
    }
  }
  return next;
}

// The night call's revision, in place: a new target and items, a fresh streak
export function revise(procedure: Procedure, revision: IntentionProcedureRevision, day: number | undefined): Procedure {
  const next = { ...procedure };
  next.items = dedupe(revision.items).slice(0, MAX_PROCEDURE_ITEMS);
  next.targetKind = revision.target_kind;
  next.targetName = revision.target_kind === 'sim' ? undefined : (revision.target_name ?? revision.target_id);
  if (revision.why) {
    next.why = revision.why;
  }
  next.status = 'active';
  next.source = 'night';
  next.revisions += 1;
  next.revisedDay = day;
  next.firesSinceRan = 0;
  next.lastStructural = false;
  if (day !== undefined) {
    next.lastDay = day;
  }
  return next;
}

// A procedure's click for a story row (k = 1). The variable binds to the row's Sim; a
// procedure that needs a Sim and a row that names none, or one with no target, gives nothing.
export function bindClick(
  procedure: Procedure,
  row: { target_sim_id?: string; target_name?: string },
): IntentionClick | undefined {
  if (procedure.items.length === 0 || procedure.status !== 'active') {
    return undefined;
  }
  const items = procedure.items.slice(0, MAX_PROCEDURE_ITEMS);
  switch (procedure.targetKind) {
    case 'sim':
      return row.target_sim_id
        ? { target_kind: 'sim', target_id: row.target_sim_id, target_name: row.target_name, items }
        : undefined;
    case 'kind':
      return procedure.targetName
        ? { target_kind: 'kind', target_id: procedure.targetName, target_name: procedure.targetName, items }
        : undefined;
    case 'self':
    case 'phone':
      return { target_kind: procedure.targetKind, items };
    default:
      return undefined;
  }
}

// A seeded pie row clicks its key's active procedure first (k = 1): its items lead the
// candidates, and an object / self / phone target is taken when the row names none. Returns
// the new `what`, or undefined when nothing changes (idempotent across reports).
export function applyToRow(row: IntentionRow, procedure: Procedure): IntentionRow['what'] | undefined {
  if (row.what.kind !== 'pie' || procedure.status !== 'active' || procedure.items.length === 0) {
    return undefined;
  }
  const candidates = dedupe([...procedure.items, ...row.what.candidates]);
  let { target } = row.what;
  if (!target && (procedure.targetKind === 'self' || procedure.targetKind === 'phone')) {
    target = { kind: procedure.targetKind };
  } else if (!target && procedure.targetKind === 'kind' && procedure.targetName) {
    target = { kind: 'kind', id: procedure.targetName, name: procedure.targetName };
  }
  const same =
    candidates.length === row.what.candidates.length &&
    candidates.every((candidate, index) => candidate === (row.what as { candidates: string[] }).candidates[index]) &&
    target === row.what.target;
  return same ? undefined : { ...row.what, candidates, target };
}

// Code's promotion to everyone here: PROMOTE_SIMS Sims ran the same first item at the same
// kind of target for one key
export function promotable(procedures: Procedure[], winner: Procedure): boolean {
  const first = winner.items[0]?.toLowerCase();
  if (!first) {
    return false;
  }
  const scopes = new Set(
    procedures
      .filter(
        (procedure) =>
          procedure.scope !== SHARED_SCOPE &&
          procedure.key === winner.key &&
          procedure.status === 'active' &&
          procedure.ran > 0 &&
          procedure.targetKind === winner.targetKind &&
          procedure.items[0]?.toLowerCase() === first,
      )
      .map((procedure) => procedure.scope),
  );
  return scopes.size >= PROMOTE_SIMS;
}

// --- the night text's lines -------------------------------------------------------------------

function targetText(procedure: Procedure): string {
  switch (procedure.targetKind) {
    case 'sim':
      return '{target}';
    case 'kind':
      return procedure.targetName ?? 'an object';
    case 'find':
      return 'the nearest provider';
    default:
      return procedure.targetKind;
  }
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}...` : line;
}

export function procedureLine(procedure: Procedure): string {
  const why = procedure.why ? ` :: ${clip(procedure.why, 100)}` : '';
  return (
    `- [${procedure.key}] ran=${procedure.ran} failed=${procedure.failed} :: ` +
    `${targetText(procedure)}: ${procedure.items.join(' | ')}${why}`
  );
}

export function failedProcedureLine(procedure: Procedure): string {
  const failure = procedure.lastFailure;
  const when = failure?.day !== undefined ? ` day ${failure.day}` : '';
  const what = failure ? `${failure.cause ?? 'failed'}${failure.reason ? `: ${clip(failure.reason, 120)}` : ''}` : '';
  return (
    `- [${procedure.key}] ran=${procedure.ran} failed=${procedure.failed} :: was ${targetText(procedure)}: ` +
    `${procedure.items.join(' | ')} :: failed${when}${what ? ` (${what})` : ''}`
  );
}

export function pitfallLine(pitfall: Pitfall): string {
  return `- [${pitfall.about}] ${clip(pitfall.text, 200)}${pitfall.seen > 1 ? ` (seen ${pitfall.seen}x)` : ''}`;
}

function byRecent<T extends { lastDay?: number }>(a: T, b: T): number {
  return (b.lastDay ?? -1) - (a.lastDay ?? -1);
}

function inZone(zone: string | undefined, itemZone: string | undefined): boolean {
  return !itemZone || !zone || itemZone === zone;
}

// The per-Sim and shared blocks for a night text
export function nightLessons(args: {
  own: Procedure[];
  ownPitfalls: Pitfall[];
  shared: Procedure[];
  sharedPitfalls: Pitfall[];
  day: number;
  zone?: string;
}): NightLessons {
  const fresh = (pitfall: Pitfall) =>
    pitfall.status === 'active' && (pitfall.lastDay === undefined || pitfall.lastDay >= args.day - PITFALL_SHOW_DAYS);
  const worked = args.own
    .filter((procedure) => procedure.status === 'active' && procedure.ran > 0)
    .sort((a, b) => byRecent(a, b) || b.ran - a.ran)
    .slice(0, NIGHT_PROCEDURES)
    .map(procedureLine);
  const failed = args.own
    .filter((procedure) => procedure.status === 'needs_fix')
    .sort(byRecent)
    .slice(0, NIGHT_FAILED_PROCEDURES)
    .map(failedProcedureLine);
  const pitfalls = args.ownPitfalls.filter(fresh).sort(byRecent).slice(0, NIGHT_PITFALLS).map(pitfallLine);
  const shared = [
    ...args.shared
      .filter((procedure) => procedure.status === 'active' && inZone(args.zone, procedure.zone))
      .sort(byRecent)
      .map(procedureLine),
    ...args.sharedPitfalls
      .filter((pitfall) => fresh(pitfall) && inZone(args.zone, pitfall.zone))
      .sort(byRecent)
      .map(pitfallLine),
  ].slice(0, NIGHT_SHARED);
  return { shared, worked, failed, pitfalls };
}
