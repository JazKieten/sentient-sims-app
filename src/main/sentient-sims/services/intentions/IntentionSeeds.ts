// The seeds of a Sim's intention list (autonomy part 5, decision 4-6, 14): pure functions
// from the state report to rows, in PRIORITY ORDER (the list order is the only priority):
// needs under the floor -> bills with funds -> the work schedule (a note) -> drama ahead
// (notes) -> aspiration -> promotion -> daily task -> wants. No model call anywhere here.
import type { GoalPoolEntry, SimStateEntry, SimStateReport } from '../../models/SimStateReport';
import {
  DeliberateDesire,
  IntentionRow,
  IntentionStoryAdd,
  Precondition,
  RowSource,
  RowWhat,
  clockMinutes,
  minutesToClock,
  newRowId,
  untilReached,
} from '../../models/IntentionRow';
import { parseNextShift } from '../../util/formatSelfStatus';

export type SeedSettings = {
  needFloor: number;
};

// The inverse of CognitionService's ACTION_NEED_CATEGORY, declared once (decision 5):
// need -> the whitelist recipes that fix it, tried in order across attempts. Energy's row
// never wakes a sleeper (the `awake` precondition) and the -85 critical rule lane keeps its
// own path above all of these.
export const NEED_RECIPES: Record<string, string[]> = {
  hunger: ['grab_snack', 'cook_meal'],
  bladder: ['use_toilet'],
  energy: ['nap', 'sleep'],
  hygiene: ['take_shower'],
  fun: ['watch_tv', 'listen_to_music', 'browse_web'],
  social: ['chat'],
};

// What a note row holds while it is live: the travel verbs (decision 14)
export const NOTE_HOLDS = ['go_out', 'travel_to_zone'];

const WORK_BEFORE_MINUTES = 60;
const WORK_AFTER_MINUTES = 120;
const DRAMA_BEFORE_MINUTES = 60;
const DRAMA_AFTER_MINUTES = 60;
const SCENE_ROW_MINUTES = 120;
const NEED_CLEAR_MARGIN = 20;

// What the Sim says aloud when the bills row fires (decision 7: a natural line where one exists)
export const BILLS_SAY = "I'd better pay the bills before they pile up.";

function row(
  partial: Pick<IntentionRow, 'seedKey' | 'source' | 'what' | 'why' | 'until'> &
    Partial<Pick<IntentionRow, 'target' | 'preconditions' | 'claim' | 'status' | 'say'>>,
): IntentionRow {
  return {
    id: newRowId(),
    seedKey: partial.seedKey,
    source: partial.source,
    what: partial.what,
    target: partial.target,
    why: partial.why,
    ...(partial.say ? { say: partial.say } : {}),
    preconditions: partial.preconditions ?? [],
    until: partial.until,
    status: partial.status ?? 'waiting',
    attempts: 0,
    history: [],
    claim: partial.claim,
  };
}

function needRows(entry: SimStateEntry, settings: SeedSettings): IntentionRow[] {
  if (entry.self?.asleep) {
    return [];
  }
  const needs = entry.self?.needs ?? {};
  return Object.entries(NEED_RECIPES)
    .filter(([need]) => typeof needs[need] === 'number' && needs[need] < settings.needFloor)
    .map(([need, actions]) =>
      row({
        seedKey: `need:${need}`,
        source: 'need',
        what: { kind: 'action', actions },
        why: `${need} is low`,
        preconditions: [{ kind: 'awake' }, { kind: 'need_below', need, value: settings.needFloor }],
        until: { kind: 'need_above', need, value: settings.needFloor + NEED_CLEAR_MARGIN },
      }),
    );
}

function billsRow(report: SimStateReport): IntentionRow | undefined {
  const bills = report.lot?.bills;
  if (!bills?.due) {
    return undefined;
  }
  const amount = typeof bills.amount === 'number' ? bills.amount : 0;
  return row({
    seedKey: 'bills',
    source: 'bills',
    what: { kind: 'action', actions: ['pay_bills'] },
    why: amount > 0 ? `the bills are due (§${amount})` : 'the bills are due',
    say: BILLS_SAY,
    preconditions: [{ kind: 'funds_at_least', amount }],
    until: { kind: 'bills_clear' },
    claim: 'bills',
  });
}

// A shift's start as absolute minutes: the mod's "HH:MM:SS.mmm day:D week:W" with the
// weekday matched against the clock's; a time already two hours gone with no day is tomorrow
export function shiftStartMinutes(nextShift: string | undefined, report: SimStateReport): number | undefined {
  const shift = parseNextShift(nextShift);
  const now = clockMinutes(report);
  const clock = report.lot?.clock;
  if (!shift || now === undefined || clock?.absolute_day === undefined) {
    return undefined;
  }
  const ofDay = shift.hour * 60 + shift.minute;
  let dayOffset = 0;
  if (shift.day !== undefined && clock.day !== undefined) {
    dayOffset = (((shift.day - clock.day) % 7) + 7) % 7;
  } else if (ofDay + WORK_AFTER_MINUTES < now - clock.absolute_day * 1440) {
    dayOffset = 1;
  }
  return (clock.absolute_day + dayOffset) * 1440 + ofDay;
}

function workRows(entry: SimStateEntry, report: SimStateReport): IntentionRow[] {
  const rows: IntentionRow[] = [];
  (entry.self?.careers ?? []).forEach((career) => {
    if (!career.career || career.at_work) {
      return;
    }
    const start = shiftStartMinutes(career.next_shift, report);
    if (start === undefined) {
      return;
    }
    const from = start - WORK_BEFORE_MINUTES;
    const to = start + WORK_AFTER_MINUTES;
    const now = clockMinutes(report) ?? 0;
    if (now > to || from - now > 1440) {
      return;
    }
    rows.push(
      row({
        seedKey: `work:${career.career}`,
        source: 'work',
        what: { kind: 'note', holds: NOTE_HOLDS },
        why: `work at ${career.career} starts at ${minutesToClock(start)}`,
        preconditions: [{ kind: 'game_time', from, to }, { kind: 'not_at_work' }],
        until: { kind: 'game_time', at: to },
      }),
    );
  });
  return rows;
}

function dramaRows(entry: SimStateEntry, report: SimStateReport): IntentionRow[] {
  const now = clockMinutes(report);
  if (now === undefined) {
    return [];
  }
  return (entry.self?.drama ?? [])
    .filter((drama) => typeof drama.in_minutes === 'number')
    .map((drama) => {
      const at = now + drama.in_minutes;
      const who = drama.other_name ? ` with ${drama.other_name}` : '';
      const word = drama.role === 'sender' ? 'you planned' : 'coming up';
      return row({
        seedKey: `drama:${drama.uid || `${drama.node}:${at}`}`,
        source: 'drama',
        what: { kind: 'note', holds: NOTE_HOLDS },
        why: `${drama.node.replace(/_/g, ' ')}${who} at ${minutesToClock(at)} (${word})`,
        preconditions: [{ kind: 'game_time', from: at - DRAMA_BEFORE_MINUTES, to: at + DRAMA_AFTER_MINUTES }],
        until: { kind: 'game_time', at: at + DRAMA_AFTER_MINUTES },
      });
    });
}

// Decision 4: a goal's own affordances are its pie candidates; else its first whitelist
// verb is an action; neither = unreachable (shown, never fires)
export function whatForGoal(goal: GoalPoolEntry): { what: RowWhat; status: IntentionRow['status'] } {
  const label = goal.text ?? goal.label;
  const fallback = goal.action_keys?.[0];
  if (goal.affordances && goal.affordances.length > 0) {
    return { what: { kind: 'pie', candidates: [...goal.affordances], label, fallback }, status: 'waiting' };
  }
  if (fallback) {
    return { what: { kind: 'action', actions: [...(goal.action_keys ?? [])] }, status: 'waiting' };
  }
  return { what: { kind: 'note' }, status: 'unreachable' };
}

const GOAL_ORDER: GoalPoolEntry['source'][] = ['aspiration', 'promotion', 'daily_task', 'want'];

function goalRows(entry: SimStateEntry): IntentionRow[] {
  const pool = entry.self?.goal_pool ?? [];
  const rows: IntentionRow[] = [];
  GOAL_ORDER.forEach((source) => {
    pool
      .filter((goal) => goal.source === source)
      .forEach((goal) => {
        const { what, status } = whatForGoal(goal);
        const preconditions: Precondition[] = [];
        let target: IntentionRow['target'];
        if (goal.target_sim_id) {
          target = { sim_id: goal.target_sim_id, name: goal.target_name };
          preconditions.push({ kind: 'target_present', sim_id: goal.target_sim_id });
        }
        rows.push(
          row({
            seedKey: goal.id,
            source: source,
            what,
            target,
            why: goal.text ?? goal.label,
            // A want's text is already the Sim's own line ("The jams are on now!"); a goal's
            // label is a game objective and is never said aloud
            say: source === 'want' ? goal.text : undefined,
            preconditions,
            until: { kind: source === 'want' ? 'want_absent' : 'goal_absent' },
            status,
          }),
        );
      });
  });
  return rows;
}

export function seedRows(entry: SimStateEntry, report: SimStateReport, settings: SeedSettings): IntentionRow[] {
  const seeded: IntentionRow[] = [...needRows(entry, settings)];
  const bills = billsRow(report);
  if (bills) {
    seeded.push(bills);
  }
  seeded.push(...workRows(entry, report), ...dramaRows(entry, report), ...goalRows(entry));
  return seeded;
}

// A scene's armed desire or a conversation's follow-through as a row that WAITS for a
// moment (decision 3 `deliberate`, decision 16): the existing model call runs when it fires
export function desireRow(
  source: 'scene' | 'conversation',
  desire: DeliberateDesire,
  nowMinutes: number,
  targetName?: string,
): IntentionRow {
  const preconditions: Precondition[] = [];
  let target: IntentionRow['target'];
  if (desire.targetSimId) {
    target = { sim_id: desire.targetSimId, name: targetName };
    preconditions.push({ kind: 'target_present', sim_id: desire.targetSimId });
  }
  const why =
    source === 'conversation'
      ? `follow through on the talk with ${desire.speaker ?? 'the player'}${desire.reason ? `: ${desire.reason}` : ''}`
      : (desire.reason ?? desire.thought ?? 'act on what the scene stirred up');
  return row({
    seedKey: `${source}:${Date.now()}`,
    source,
    what: { kind: 'deliberate', desire },
    target,
    why,
    say: desire.thought,
    preconditions,
    until: { kind: 'game_time', at: nowMinutes + SCENE_ROW_MINUTES },
  });
}

// A story row the night call wrote (decision 5): a `deliberate` row, so the existing options
// and choice calls pick the pie item at the moment; the model never names a tuning key. The
// hours are hours of `day`; a named Sim must be present. Until the window's end, else the day's.
export function storyRow(edit: IntentionStoryAdd, day: number, threshold: number): IntentionRow {
  const preconditions: Precondition[] = [];
  let windowEnd: number | undefined;
  if (edit.from_hour !== undefined || edit.to_hour !== undefined) {
    const from = day * 1440 + (edit.from_hour ?? 0) * 60;
    windowEnd = day * 1440 + (edit.to_hour ?? 23) * 60 + 59;
    preconditions.push({ kind: 'game_time', from, to: windowEnd });
  }
  let target: IntentionRow['target'];
  if (edit.target_sim_id) {
    target = { sim_id: edit.target_sim_id, name: edit.target_name };
    preconditions.push({ kind: 'target_present', sim_id: edit.target_sim_id });
  }
  const id = newRowId();
  return {
    ...row({
      seedKey: `story:${id}`,
      source: 'story',
      what: {
        kind: 'deliberate',
        desire: { score: threshold, reason: edit.why, thought: edit.say, targetSimId: edit.target_sim_id },
      },
      target,
      why: edit.why,
      say: edit.say,
      preconditions,
      until: windowEnd !== undefined ? { kind: 'game_time', at: windowEnd } : { kind: 'day_end' },
    }),
    id,
  };
}

// Rows no seed ever writes: the merge leaves them alone (a scene's or a talk's impulse, a
// night call's story beat)
export function isImpulseRow(item: IntentionRow): boolean {
  return item.source === 'scene' || item.source === 'conversation' || item.source === 'story';
}

// Merge the fresh seeds into the day's list: existing rows keep their status and history,
// new seed keys are appended in seed order, and a seed that vanished marks its row expired
// (a rerolled want) or done (the goal pool, the bills flag, the need). Done rows are sticky
// for the day by seedKey (collision 7). Scene, conversation and story rows are never seeded,
// so they are untouched here, and a row the night call dropped stays dropped.
export function mergeSeeds(existing: IntentionRow[], seeded: IntentionRow[]): IntentionRow[] {
  const seededKeys = new Set(seeded.map((seed) => seed.seedKey));
  const byKey = new Map(existing.map((item) => [item.seedKey, item]));
  const merged: IntentionRow[] = existing.map((item) => {
    if (isImpulseRow(item) || item.status === 'dropped') {
      return item;
    }
    if (seededKeys.has(item.seedKey)) {
      const fresh = seeded.find((seed) => seed.seedKey === item.seedKey);
      if (!item.say && fresh?.say) {
        // A row stored before seeds carried a line picks it up
        item.say = fresh.say;
      }
      if (item.status === 'unreachable') {
        // A want may gain a target or an affordance on a later report
        if (fresh && fresh.status === 'waiting') {
          return {
            ...item,
            what: fresh.what,
            target: fresh.target,
            preconditions: fresh.preconditions,
            status: 'waiting',
          };
        }
      }
      return item;
    }
    if (item.status === 'done' || item.status === 'expired') {
      return item;
    }
    if (item.status === 'in_flight') {
      return item; // the outcome decides
    }
    return { ...item, status: item.source === 'want' ? 'expired' : 'done' };
  });
  seeded.forEach((seed) => {
    if (!byKey.has(seed.seedKey)) {
      merged.push(seed);
    }
  });
  return orderRows(merged);
}

export function orderRows(rows: IntentionRow[]): IntentionRow[] {
  return rows.sort((a, b) => rowRank(a) - rowRank(b));
}

// The list order IS the priority: needs, bills, then what a scene or a talk just stirred up
// (the Sim's present impulse outranks a long-term want), then the night call's story beats,
// then the schedule notes and the goal pool. A stable sort keeps seed order inside a source.
export const SOURCE_RANK: Record<RowSource, number> = {
  need: 0,
  bills: 1,
  scene: 2,
  conversation: 2,
  story: 3,
  work: 4,
  drama: 5,
  aspiration: 6,
  promotion: 7,
  daily_task: 8,
  want: 9,
};

// A night call's `rank` overrides the source's
export function rowRank(item: IntentionRow): number {
  return item.rank ?? SOURCE_RANK[item.source];
}

export { untilReached };
