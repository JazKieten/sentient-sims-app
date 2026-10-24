// Intention rows (autonomy part 5, 2026-10-21): each household Sim carries an ORDERED list of
// rows `{what, target, why, preconditions, until, source}` with hard preconditions and no
// weights (design note sections 2 and 3). The day loop takes the FIRST row whose
// preconditions hold at a moment and clicks it; the game's events mark rows done; a
// structural cause sleeps a row until it clears. The list lives in the app
// (services/intentions/IntentionService.ts); the mod is the sensor and the hands.
//
// Everything here is pure: the predicates read a row against the clock, the Sim's entry and
// the report, and the service decides what to do with the answer.
import type { SimStateEntry, SimStateReport } from './SimStateReport';

// The night call's edits (edit_intentions) are defined in the core seam so core's tool never
// names this autonomy module
export type { IntentionEdits, IntentionEditSlot, IntentionRewrite, IntentionStoryAdd } from '../tiers/types';

export type RowSource =
  | 'need'
  | 'bills'
  | 'work'
  | 'drama'
  | 'aspiration'
  | 'promotion'
  | 'daily_task'
  | 'want'
  | 'scene'
  | 'conversation'
  // A row the night call wrote (autonomy part 6): something the Sim means to do today
  | 'story';

// What a scene or a conversation left the Sim wanting (CognitionService's ConversationDesire
// and armDesireFromScene's shape, kept verbatim so the EXISTING deliberation runs on it)
export type DeliberateDesire = {
  score: number;
  reason?: string;
  thought?: string;
  speaker?: string;
  transcript?: string;
  speakerKind?: 'sim' | 'player' | 'viewer';
  targetSimId?: string;
};

// The four kinds of `what` (decision 3): a pie-menu click over candidate tuning names, a
// whitelist recipe (tried in order across attempts), the existing deliberation with the row
// as the armed desire, or a note that never fires and only holds verbs and informs the prompt.
export type RowWhat =
  | { kind: 'pie'; candidates: string[]; label: string; fallback?: string }
  | { kind: 'action'; actions: string[] }
  | { kind: 'deliberate'; desire: DeliberateDesire }
  | { kind: 'note'; holds?: string[] };

export type RowTarget = { sim_id: string; name?: string };

// Game time is ABSOLUTE minutes: absolute_day * 1440 + hour * 60 + minute (decision 7)
export type Precondition =
  | { kind: 'game_time'; from: number; to: number }
  | { kind: 'funds_at_least'; amount: number }
  | { kind: 'need_below'; need: string; value: number }
  | { kind: 'target_present'; sim_id: string }
  | { kind: 'at_home' }
  | { kind: 'not_at_work' }
  | { kind: 'after'; row_id: string }
  | { kind: 'awake' };

export type Until =
  | { kind: 'game_time'; at: number }
  | { kind: 'goal_absent' }
  | { kind: 'want_absent' }
  | { kind: 'bills_clear' }
  | { kind: 'need_above'; need: string; value: number }
  | { kind: 'day_end' }
  | { kind: 'once' };

// dropped: the night call (or a chat edit) struck the row for today; the every-report merge
// keeps it struck, and pick, the prompt and the list log skip it
export type RowStatus = 'waiting' | 'in_flight' | 'done' | 'asleep' | 'expired' | 'unreachable' | 'dropped';

// What wakes a structural sleep besides a zone change (renovation R2: events, not a 2-hour
// timer): the target arriving, a candidate on today's menus, the item running for anyone
export type WakeOn = 'target_present' | 'candidate_seen' | 'ran_by_anyone';

export type RowClears =
  | { kind: 'funds_at_least'; amount: number }
  // `until` only on rows slept before R2 (the old 2-hour re-check)
  | { kind: 'zone_change'; zone_id?: string; until?: number; wake_on?: WakeOn[] }
  | { kind: 'object_fixed'; object_id: string }
  | { kind: 'day_end' }
  | { kind: 'never' };

export type RowHistoryEntry = { at: number; outcome: string; cause?: string };

export type IntentionRow = {
  id: string;
  // The dedupe key across reports: a goal id, 'bills', 'need:hunger', 'work:<career>',
  // 'drama:<uid>', 'scene:<at>', 'conversation:<at>'
  seedKey: string;
  source: RowSource;
  what: RowWhat;
  target?: RowTarget;
  why: string;
  // The Sim's own line, said aloud when the row fires (first person, one sentence). Never the
  // mechanical `why`; seeds set it where a natural line exists, the night call for its rows
  say?: string;
  // An order the night call set: overrides the source's rank in orderRows (lower first)
  rank?: number;
  preconditions: Precondition[];
  until: Until;
  status: RowStatus;
  attempts: number;
  history: RowHistoryEntry[];
  sleep?: { cause: string; clears: RowClears };
  // Lot-level claim (decision 8): bills | repair | clean | fire
  claim?: string;
  requestId?: string;
  firedAt?: number;
  // The provider object the last fire resolved to (for an object_fixed sleep)
  targetObjectId?: string;
  // Consecutive initiation-set failures (R2): counted at most once per game hour; at
  // MAX_ABSENT the row expires
  absent?: { count: number; lastAt: number; cause: string };
};

export type RowClockContext = {
  nowMinutes: number;
  absoluteDay?: number;
  entry: SimStateEntry;
  report: SimStateReport;
};

const NIL_WORDS = new Set(['null', 'none', 'undefined', '']);

export function clockMinutes(report: SimStateReport | undefined): number | undefined {
  const clock = report?.lot?.clock;
  if (!clock || clock.absolute_day === undefined || typeof clock.hour !== 'number') {
    return undefined;
  }
  return clock.absolute_day * 1440 + clock.hour * 60 + (clock.minute ?? 0);
}

export function minutesToClock(minutes: number): string {
  const ofDay = ((minutes % 1440) + 1440) % 1440;
  const hour = Math.floor(ofDay / 60);
  const minute = ofDay % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function newRowId(): string {
  return `i${Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0')}`;
}

function isAtWork(entry: SimStateEntry): boolean {
  return (entry.self?.careers ?? []).some((career) => career.at_work === true);
}

function sleeping(entry: SimStateEntry): boolean {
  return entry.self?.asleep === true;
}

export function targetPresent(entry: SimStateEntry, simId: string): boolean {
  return entry.sims.some((perceived) => perceived.sim_id === simId);
}

// Every precondition must hold. `after` is answered by the service (it knows the other
// row's status) through `rowsById`; absent, an `after` row waits.
export function preconditionsHold(
  row: IntentionRow,
  ctx: RowClockContext,
  rowsById?: Map<string, IntentionRow>,
): { ok: true } | { ok: false; waiting: string } {
  for (const condition of row.preconditions) {
    switch (condition.kind) {
      case 'game_time':
        if (ctx.nowMinutes < condition.from || ctx.nowMinutes > condition.to) {
          return { ok: false, waiting: `the window ${minutesToClock(condition.from)}-${minutesToClock(condition.to)}` };
        }
        break;
      case 'funds_at_least': {
        const funds = ctx.report.lot?.funds;
        if (typeof funds === 'number' && funds < condition.amount) {
          return { ok: false, waiting: `§${condition.amount} (have §${funds})` };
        }
        break;
      }
      case 'need_below': {
        const value = ctx.entry.self?.needs?.[condition.need];
        if (typeof value !== 'number' || value >= condition.value) {
          return { ok: false, waiting: `${condition.need} under ${condition.value}` };
        }
        break;
      }
      case 'target_present':
        if (!targetPresent(ctx.entry, condition.sim_id)) {
          return { ok: false, waiting: `${row.target?.name ?? condition.sim_id} to be here` };
        }
        break;
      case 'at_home':
        if (ctx.report.lot?.is_home === false) {
          return { ok: false, waiting: 'being home' };
        }
        break;
      case 'not_at_work':
        if (isAtWork(ctx.entry)) {
          return { ok: false, waiting: 'the shift to end' };
        }
        break;
      case 'awake':
        if (sleeping(ctx.entry)) {
          return { ok: false, waiting: 'waking up' };
        }
        break;
      case 'after': {
        const other = rowsById?.get(condition.row_id);
        if (!other || other.status !== 'done') {
          return { ok: false, waiting: other ? `"${other.why}" first` : 'an earlier row' };
        }
        break;
      }
      default:
        break;
    }
  }
  return { ok: true };
}

// One-shot untils are done on the first success (decision 10); the others wait for the
// world (the goal pool, the want list, the bills flag, the need, the clock).
export function isOneShotUntil(until: Until): boolean {
  return (
    until.kind === 'bills_clear' || until.kind === 'need_above' || until.kind === 'once' || until.kind === 'game_time'
  );
}

// Whether the world says the row's purpose is met (or gone), judged from the report
export function untilReached(row: IntentionRow, ctx: RowClockContext): boolean {
  const { until } = row;
  switch (until.kind) {
    case 'game_time':
      return ctx.nowMinutes >= until.at;
    case 'goal_absent':
      return !(ctx.entry.self?.goal_pool ?? []).some((goal) => goal.id === row.seedKey);
    case 'want_absent':
      return (
        !(ctx.entry.self?.wants ?? []).includes(row.seedKey) &&
        !(ctx.entry.self?.goal_pool ?? []).some((goal) => goal.id === row.seedKey)
      );
    case 'bills_clear':
      return ctx.report.lot?.bills?.due !== true;
    case 'need_above': {
      const value = ctx.entry.self?.needs?.[until.need];
      return typeof value === 'number' && value >= until.value;
    }
    case 'day_end':
    case 'once':
    default:
      return false;
  }
}

export function whatText(what: RowWhat): string {
  switch (what.kind) {
    case 'pie':
      return `pie ${what.candidates[0] ?? '?'}${what.candidates.length > 1 ? ` (+${what.candidates.length - 1})` : ''}`;
    case 'action':
      return `action ${what.actions.join('|')}`;
    case 'deliberate':
      return `deliberate (${what.desire.score}${what.desire.reason ? `, ${what.desire.reason}` : ''})`;
    case 'note':
    default:
      return 'note';
  }
}

// One line for the log and the prompt: `i3 want: Chat with Alex -> pie mixer_social_...`
export function describeRow(row: IntentionRow): string {
  const target = row.target?.name ? ` with ${row.target.name}` : '';
  let state = '';
  if (row.status === 'asleep' && row.sleep) {
    state = ` [asleep: ${row.sleep.cause}]`;
  } else if (row.status !== 'waiting') {
    state = ` [${row.status}]`;
  }
  return `${row.id} ${row.source}: ${row.why}${target} -> ${whatText(row.what)}${state}`;
}

// The prompt's line: what the Sim means to do and what it is waiting for, in plain words
export function promptLine(
  row: IntentionRow,
  ctx: RowClockContext | undefined,
  rowsById?: Map<string, IntentionRow>,
): string {
  const target = row.target?.name ? ` with ${row.target.name}` : '';
  if (row.status === 'asleep') {
    return `${row.why}${target} (on hold: ${row.sleep?.cause ?? 'blocked'})`;
  }
  if (row.status === 'in_flight') {
    return `${row.why}${target} (doing it now)`;
  }
  if (row.status === 'unreachable') {
    return `${row.why}${target} (no way to do it here)`;
  }
  if (ctx) {
    const held = preconditionsHold(row, ctx, rowsById);
    if (!held.ok) {
      return `${row.why}${target} (waiting for ${held.waiting})`;
    }
  }
  return `${row.why}${target}`;
}

export function cleanIdWord(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return NIL_WORDS.has(trimmed.toLowerCase()) ? undefined : trimmed;
}
