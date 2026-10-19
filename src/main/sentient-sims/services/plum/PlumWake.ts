// Plum's wake-up triggers: Plum sets a condition for itself and the app wakes it with a
// turn when the condition is met, instead of waiting for the director's minute or for the
// player to type. Three kinds, all read off what the app already receives:
//
//   sim_finishes  the Sim's running interaction (the state report's activity.running) is
//                 no longer the one it was when the trigger was set, or the autonomy tier's
//                 outcome report names that Sim (richer: it says how the action went)
//   game_time     the lot clock reaches hh:mm (the report's lot.clock)
//   real_minutes  N real minutes have passed (a timer)
//
// A trigger fires once and is gone. The wake is a turn on the same thread: a director tick
// while the director is active (its hold rules still apply, so a wake under the player's
// pause waits for the next evaluation), otherwise a plain Plum turn with no player row.
// Triggers expire after TRIGGER_TTL_MS and at most MAX_TRIGGERS are live at once.
//
// A trigger may ACT instead of waking (set_trigger with then = push_action): when the
// condition is met the app pushes the stored action itself through PlumService's tool
// runner, no model turn, and only wakes Plum when the beat it waited for ended badly
// (canceled, failure) or the push was refused. That is how the director chains an arc
// of beats on the Sims' own outcomes instead of polling. What triggers did since Plum
// last looked is the journal, rendered into the next turn's <live> block.
//
// A trigger may wait on ANOTHER trigger's push (`after`): it is inert until that trigger
// has pushed, then takes the pushed interaction's id as what to wait for, so a chain of
// beats runs in order on each beat's actual end and never on a name guess (live 2026-10-17
// a beat keyed on the target's `sim_Chat` fired when the target stepped out of beat 1). A
// bad end, a refused push or an expiry drops the whole chain below it with a journal line
// and wakes Plum. planArc builds such a chain in one call for the director.
//
// WHISPERS (plan merry-conjuring-dahl, 2026-10-17): a trigger may instead WHISPER (then =
// whisper): Plum's line to a Sim plus the pie-menu item it hopes they pick, answered by the
// Sim's own actor model (PlumWhisper.ts), so the Sim has a say. An accepted beat runs as the
// Sim's choice and chains on like a push; a decline, an agreed click the world refused, or
// a cast Sim gone from the lot FREEZES the script (nothing below it fires, nothing is
// dropped) and wakes Plum once to decide: resume, replace_from, or cancel (the script tool).
// A beat whose accepted interaction ends canceled is clicked again once, with no new
// decision; a second cancel freezes. The player's pause defers a whisper to the unpause
// (the balloon is dropped under pause), it does not freeze. planScript builds a whisper
// chain in one call; describeScript renders it into the <live> block.
import log from 'electron-log';
import { randomUUID } from 'crypto';
import type { ApiContext } from '../ApiContext';
import type { SimStateReport } from '../../models/SimStateReport';
import type { PlumService, PlumToolOutcome } from '../PlumService';
import { getModClockState } from '../../websocketServer';
import { describeOutcome, NO_ANSWER, WhisperItem, WhisperRequest, WhisperResult } from './PlumWhisper';

export type WakeKind = 'sim_finishes' | 'game_time' | 'real_minutes';

export type PushAction = {
  do: 'push_action';
  simId: string;
  simName: string;
  action: string;
  targetId?: string;
  targetName?: string;
};

export type WhisperAction = {
  do: 'whisper';
  simId: string;
  simName: string;
  line: string;
  item?: WhisperItem;
};

// What a trigger does when it fires instead of waking Plum
export type WakeAction = PushAction | WhisperAction;

// The whisper whose accepted click a chained trigger waits on: a canceled end clicks it
// again once (decision 7), with no new decision call
export type FromWhisper = { simId: string; simName: string; item: WhisperItem; retried: boolean };

export type WakeTrigger = {
  id: string;
  kind: WakeKind;
  note: string;
  setAt: number;
  simId?: string;
  simName?: string;
  // sim_finishes: the running interaction when the trigger was set (null = idle)
  baseline?: string | null;
  // sim_finishes with `doing`: the interaction to wait for (a pushed or clicked key); the
  // wake comes when the Sim stops doing it, so a queued action is waited for, not the
  // chat it queued behind. `started` flips once a report shows the Sim doing it.
  doing?: string;
  started?: boolean;
  // When this trigger began waiting for `doing` to start (set, resolved from a parent's push,
  // or thawed): past DOING_START_GRACE_MS with no start it fires "never started"
  waitingSince?: number;
  // Chain by reference: this trigger waits for the interaction that trigger `after`'s push
  // creates. While set, the trigger is INERT (no report, end or outcome can fire it);
  // resolveDependents() clears it and fills doing / doingId / requestId from the push result.
  after?: string;
  // The exact interaction the mod watches (the push result's interaction_id): an end matches
  // by id, never by the loose name match, so the target's same-named social cannot fire it
  doingId?: string;
  // The push's request_id, for the autonomy tier's outcome route (WakeOutcome.request_id)
  requestId?: string;
  // The whisper this trigger's `doing` came from (retry once on a canceled end)
  fromWhisper?: FromWhisper;
  // A script beat: which script and which beat this trigger whispers (planScript); the
  // closing wake carries the script name and `closing`
  script?: string;
  beat?: number;
  closing?: boolean;
  // game_time
  hour?: number;
  minute?: number;
  // real_minutes
  dueAt?: number;
  // Absent = wake Plum (the wake_me behaviour)
  then?: WakeAction;
};

// How the end that fired a trigger went; absent when the state report fired it (no outcome
// there, and it counts as good)
export type WakeEnd = { outcome: string };

const GOOD_OUTCOMES = new Set(['finished', 'success']);

export function endedWell(ended?: WakeEnd): boolean {
  return !ended || GOOD_OUTCOMES.has(ended.outcome.trim().toLowerCase());
}

// What the outcome route hands us (ActionIntent's InteractionOutcomeEvent, in plain fields
// so core never names the autonomy tier's types)
export type WakeOutcome = {
  request_id?: string;
  sim_id: string;
  sim_name?: string;
  action?: string;
  interaction_name?: string;
  outcome: string;
  reason?: string;
};

export type WakeDeps = {
  now?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};

// One beat of planArc: Sims already resolved to ids by the tool
export type ArcBeat = {
  simId: string;
  simName: string;
  action: string;
  targetId?: string;
  targetName?: string;
};

export type ArcResult = {
  changed: string;
  arc: string;
  beats: { n: number; sim: string; action: string; target?: string; trigger_id?: string }[];
  pending: number;
};

// One beat of planScript: a whisper, Sims and the item resolved by the tool
export type ScriptBeat = {
  simId: string;
  simName: string;
  line: string;
  item: WhisperItem;
};

export type ScriptResult = {
  changed: string;
  script: string;
  beats: { n: number; sim: string; line: string; item: string; trigger_id?: string }[];
  frozen?: string;
  pending: number;
};

// The script is frozen (decision 5): no beat fires until Plum decides. `nextIds` are the
// triggers that waited on the spent beat; resume re-bases them onto the Sim's current
// activity so the script goes on from the next beat.
export type FrozenScript = { at: number; reason: string; simId?: string; simName?: string; nextIds: string[] };

export const MAX_ARC_BEATS = 7;

// An arc of five beats plus the closing wake plus whatever Plum sets in chat
export const MAX_TRIGGERS = 12;
export const TRIGGER_TTL_MS = 2 * 3_600_000;
export const MAX_REAL_MINUTES = 120;
// Same cap as the mod's ss_plum_watch
export const MAX_WATCHED = 32;
const CLICK_TIMEOUT_MS = 20_000;
// A real_minutes trigger that acts, due while the script is frozen, looks again this often
const FROZEN_RETRY_MS = 60_000;
// A `doing` the Sim has not started this long after the trigger began waiting (real time) is
// never going to: the push was queued behind something that ate it, or the click died in the
// game. Fires as a bad end ("never started") so Plum re-plans instead of waiting forever
// (2026-10-17: a "(not started yet)" counter_MakeFood wait outlived the evening).
export const DOING_START_GRACE_MS = 90_000;

export class PlumWakeService {
  private readonly ctx: ApiContext;

  private readonly plum: PlumService;

  private readonly deps: WakeDeps;

  private readonly triggers: WakeTrigger[] = [];

  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  // Fired triggers whose wake could not run yet (Plum mid-turn, director holding)
  private readonly fired: { trigger: WakeTrigger; text: string }[] = [];

  // Whisper triggers that fired under the player's pause: they act on the unpause
  private readonly deferred: { trigger: WakeTrigger; because: string }[] = [];

  // What triggers did since Plum last looked (takeJournal empties it into a turn)
  private journal: string[] = [];

  // Interactions Plum pushed or clicked that the mod is watching for their exact end
  // (push_action / click_pie_menu results carry interaction_id), by interaction id
  private readonly watched = new Map<string, { simId: string; name: string; at: number }>();

  private frozen: FrozenScript | undefined;

  constructor(ctx: ApiContext, plum: PlumService, deps: WakeDeps = {}) {
    this.ctx = ctx;
    this.plum = plum;
    this.deps = deps;
  }

  // Subscribes to the state channel; separate from the constructor so a test can drive
  // onReport by hand
  attach() {
    this.ctx.simStateCache.onReport((report) => {
      this.onReport(report);
    });
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  // Every trigger, or with `live` only the ones that can fire now: not waiting on another
  // trigger's push (`after`) and not a script beat held by a freeze. The director counts the
  // live ones as "armed": a frozen script with nothing live is a wake, not a hold.
  list(options: { live?: boolean } = {}): readonly WakeTrigger[] {
    if (!options.live) {
      return this.triggers;
    }
    return this.triggers.filter((trigger) => this.canFire(trigger));
  }

  private canFire(trigger: WakeTrigger): boolean {
    return !trigger.after && !(this.frozen !== undefined && Boolean(trigger.then));
  }

  // Both time stamps move when frozen time is given back (resume / replace_from)
  private shiftTimes(span: number) {
    for (const trigger of this.triggers) {
      trigger.setAt += span;
      if (trigger.waitingSince !== undefined) {
        trigger.waitingSince += span;
      }
    }
  }

  // The journal since the last call, emptied
  takeJournal(): string[] {
    return this.journal.splice(0);
  }

  // A tool of Plum's created an interaction the mod watches (ss_plum_watch): a `doing`
  // trigger naming it by id or name waits for the mod's interaction_ended, not the report
  noteWatched(simId: string, interactionId: string, name: string) {
    while (this.watched.size >= MAX_WATCHED) {
      const oldest = this.watched.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.watched.delete(oldest);
    }
    this.watched.set(interactionId, { simId, name, at: this.now() });
  }

  private isWatched(simId: string, doing: string): boolean {
    const cutoff = this.now() - TRIGGER_TTL_MS;
    for (const [interactionId, entry] of this.watched) {
      if (entry.at < cutoff) {
        this.watched.delete(interactionId);
      } else if (entry.simId === simId && (interactionId === doing || sameInteraction(entry.name, doing))) {
        return true;
      }
    }
    return false;
  }

  // One line for the tab's status: the frozen script, else the trigger that was set first
  // and is still armed
  status(): string | undefined {
    this.expire();
    if (this.frozen) {
      return `script frozen: ${this.frozen.reason}`;
    }
    return this.triggers.length > 0 ? `waiting ${describe(this.triggers[0])}` : undefined;
  }

  // --- setting and cancelling ------------------------------------------------------------

  set(args: {
    kind: WakeKind;
    note: string;
    simId?: string;
    simName?: string;
    doing?: string;
    at?: string;
    minutes?: number;
    then?: WakeAction;
    // The id of an armed acting trigger this one waits on (sim and doing come from its act)
    after?: string;
    script?: string;
    beat?: number;
    closing?: boolean;
  }): WakeTrigger {
    this.expire();
    if (this.triggers.length >= MAX_TRIGGERS) {
      throw new Error(`you already have ${MAX_TRIGGERS} wake-ups set; cancel some first (when: cancel)`);
    }
    const trigger: WakeTrigger = {
      id: `w${randomUUID().slice(0, 6)}`,
      kind: args.kind,
      note: args.note.trim(),
      setAt: this.now(),
      ...(args.then ? { then: args.then } : {}),
      ...(args.script ? { script: args.script } : {}),
      ...(args.beat !== undefined ? { beat: args.beat } : {}),
      ...(args.closing ? { closing: true } : {}),
    };
    if (args.after) {
      if (args.kind !== 'sim_finishes') {
        throw new Error('`after` only works with sim_finishes');
      }
      const parent = this.triggers.find((candidate) => candidate.id === args.after);
      if (!parent || !parent.then) {
        throw new Error(`\`after\` names no armed push trigger (${args.after})`);
      }
      trigger.after = parent.id;
      trigger.simId = parent.then.simId;
      trigger.simName = parent.then.simName;
      this.triggers.push(trigger);
      log.info(`[PlumWake] set ${trigger.id} ${trigger.kind} ${describe(trigger)}`);
      return trigger;
    }
    switch (args.kind) {
      case 'sim_finishes': {
        if (!args.simId) {
          throw new Error('sim_finishes needs `sim`');
        }
        const entry = this.ctx.simStateCache.getSim(args.simId);
        trigger.simId = args.simId;
        trigger.simName = args.simName ?? entry?.sim_name ?? args.simId;
        trigger.baseline = entry?.activity?.running ?? null;
        if (args.doing?.trim()) {
          trigger.doing = args.doing.trim();
          trigger.started = sameInteraction(trigger.baseline, trigger.doing);
          trigger.waitingSince = this.now();
        }
        break;
      }
      case 'game_time': {
        const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(args.at ?? '');
        if (!match) {
          throw new Error('game_time needs `at` as "HH:MM" on the 24-hour clock');
        }
        trigger.hour = Number(match[1]) % 24;
        trigger.minute = Number(match[2]) % 60;
        break;
      }
      case 'real_minutes': {
        const minutes = Math.floor(args.minutes ?? 0);
        if (!(minutes >= 1 && minutes <= MAX_REAL_MINUTES)) {
          throw new Error(`real_minutes needs \`minutes\` between 1 and ${MAX_REAL_MINUTES}`);
        }
        trigger.dueAt = this.now() + minutes * 60_000;
        this.armTimer(trigger, minutes * 60_000, `${minutes} real minute${minutes === 1 ? '' : 's'} have passed`);
        break;
      }
      default:
        throw new Error(`unknown wake kind ${String(args.kind)}`);
    }
    this.triggers.push(trigger);
    log.info(`[PlumWake] set ${trigger.id} ${trigger.kind} ${describe(trigger)}`);
    return trigger;
  }

  private armTimer(trigger: WakeTrigger, delayMs: number, because: string) {
    const schedule = this.deps.setTimeout ?? setTimeout;
    this.timers.set(
      trigger.id,
      schedule(() => {
        this.timers.delete(trigger.id);
        if (!this.triggers.includes(trigger)) {
          return;
        }
        if (this.frozen && trigger.then) {
          // The script is frozen: an acting timer waits, it does not fire
          this.armTimer(trigger, FROZEN_RETRY_MS, because);
          return;
        }
        this.fire(trigger, because);
      }, delayMs),
    );
  }

  cancelAll(): number {
    const count = this.triggers.length;
    for (const trigger of this.triggers.splice(0)) {
      this.clearTimer(trigger);
    }
    this.fired.splice(0);
    this.deferred.splice(0);
    if (this.frozen) {
      this.frozen = undefined;
      this.journal.push('the frozen script was cancelled');
    }
    if (count > 0) {
      this.journal.push(`cancelled ${count} trigger${count === 1 ? '' : 's'}`);
    }
    return count;
  }

  private remove(trigger: WakeTrigger) {
    const index = this.triggers.indexOf(trigger);
    if (index >= 0) {
      this.triggers.splice(index, 1);
    }
    this.clearTimer(trigger);
  }

  private clearTimer(trigger: WakeTrigger) {
    const timer = this.timers.get(trigger.id);
    if (timer !== undefined) {
      (this.deps.clearTimeout ?? clearTimeout)(timer);
      this.timers.delete(trigger.id);
    }
  }

  private expire() {
    const cutoff = this.now() - TRIGGER_TTL_MS;
    for (const trigger of [...this.triggers]) {
      if (this.frozen && (trigger.then || trigger.script)) {
        // Frozen time does not count (resume shifts setAt by the frozen span)
        continue;
      }
      if (trigger.setAt < cutoff && this.triggers.includes(trigger)) {
        log.info(`[PlumWake] ${trigger.id} expired unfired`);
        this.journal.push(`${trigger.id} expired unfired (${describe(trigger)})`);
        this.remove(trigger);
        this.dropDependents(trigger);
      }
    }
  }

  // --- chains ---------------------------------------------------------------------------------

  // The act a trigger waited on has gone out: it now waits for THAT interaction, by id when
  // the mod watches it (the act created an interaction object), by name as the fallback
  private resolveFrom(
    trigger: WakeTrigger,
    actSimId: string,
    actSimName: string,
    action: string,
    result: unknown,
    parentAction?: WakeAction,
  ) {
    const fields = (result ?? {}) as { interaction_id?: unknown; interaction?: unknown; request_id?: unknown };
    delete trigger.after;
    trigger.simId = actSimId;
    trigger.simName = actSimName;
    trigger.doing = typeof fields.interaction === 'string' && fields.interaction ? fields.interaction : action;
    delete trigger.doingId;
    delete trigger.requestId;
    if (typeof fields.interaction_id === 'string' && fields.interaction_id) {
      trigger.doingId = fields.interaction_id;
    }
    if (typeof fields.request_id === 'string' && fields.request_id) {
      trigger.requestId = fields.request_id;
    }
    if (parentAction?.do === 'whisper' && parentAction.item) {
      trigger.fromWhisper = { simId: actSimId, simName: actSimName, item: parentAction.item, retried: false };
    }
    trigger.baseline = this.ctx.simStateCache.getSim(actSimId)?.activity?.running ?? null;
    trigger.started = sameInteraction(trigger.baseline, trigger.doing);
    trigger.waitingSince = this.now();
    log.info(
      `[PlumWake] ${trigger.id} now waits for ${trigger.simName}'s "${trigger.doing}" (${trigger.doingId ?? 'by name'})`,
    );
  }

  private resolveDependents(parent: WakeTrigger, result: unknown) {
    const action = parent.then;
    if (!action) {
      return;
    }
    const key = action.do === 'push_action' ? action.action : (action.item?.key ?? '');
    for (const trigger of this.triggers) {
      if (trigger.after === parent.id) {
        this.resolveFrom(trigger, action.simId, action.simName, key, result, action);
      }
    }
  }

  private dependentsOf(parent: WakeTrigger): WakeTrigger[] {
    return this.triggers.filter((trigger) => trigger.after === parent.id);
  }

  // A trigger that waited on a beat that is spent (declined, refused, talk only) waits
  // instead for its Sim to finish whatever they are doing now
  private rebase(trigger: WakeTrigger, simId: string, simName: string) {
    delete trigger.after;
    delete trigger.doing;
    delete trigger.doingId;
    delete trigger.requestId;
    delete trigger.fromWhisper;
    delete trigger.waitingSince;
    trigger.simId = simId;
    trigger.simName = simName;
    trigger.baseline = this.ctx.simStateCache.getSim(simId)?.activity?.running ?? null;
    trigger.started = false;
    log.info(`[PlumWake] ${trigger.id} now waits for ${simName} to finish ${describeBaseline(trigger)}`);
  }

  // The parent did not run (bad end, refused push, expiry): everything chained below it
  // would fire out of order, so it goes, with one journal line naming the lot
  private dropDependents(parent: WakeTrigger): string[] {
    const dropped: string[] = [];
    const queue = [parent.id];
    while (queue.length > 0) {
      const parentId = queue.shift();
      for (const trigger of [...this.triggers]) {
        if (trigger.after === parentId) {
          this.remove(trigger);
          dropped.push(trigger.id);
          queue.push(trigger.id);
        }
      }
    }
    if (dropped.length > 0) {
      log.info(`[PlumWake] ${dropped.join(', ')} dropped: ${parent.id} did not run`);
      this.journal.push(`${dropped.join(', ')} dropped: ${parent.id} did not run`);
    }
    return dropped;
  }

  private static droppedClause(dropped: string[]): string {
    return dropped.length > 0 ? `; its dependents (${dropped.join(', ')}) were dropped, so re-plan the rest` : '';
  }

  // The director's whole arc in one call: beat 1 is pushed now, beat 2 waits on that push's
  // interaction, beats 3..N each wait on the trigger before them, and a closing wake trigger
  // waits on the last beat. A refused beat 1 throws and arms nothing.
  async planArc(args: { name: string; beats: ArcBeat[]; recapNote: string; beatNote?: string }): Promise<ArcResult> {
    const name = args.name.trim();
    const { beats } = args;
    if (!name) {
      throw new Error('an arc needs a name');
    }
    if (beats.length < 1 || beats.length > MAX_ARC_BEATS) {
      throw new Error(`an arc is 1 to ${MAX_ARC_BEATS} beats, not ${beats.length}`);
    }
    this.expire();
    // N - 1 beat triggers plus the closing wake
    if (this.triggers.length + beats.length > MAX_TRIGGERS) {
      throw new Error(
        `${beats.length} beats would need ${beats.length} triggers and ${this.triggers.length} are already set (max ${MAX_TRIGGERS}); wake_me cancel first`,
      );
    }
    const [first] = beats;
    const firstAction: WakeAction = {
      do: 'push_action',
      simId: first.simId,
      simName: first.simName,
      action: first.action,
      ...(first.targetId ? { targetId: first.targetId, targetName: first.targetName } : {}),
    };
    let pushed: PlumToolOutcome;
    try {
      pushed = await this.plum.runScheduledTool(
        'push_action',
        { sim: first.simId, action: first.action, target: first.targetId ?? null, preempt: false },
        `arc "${name}" beat 1`,
      );
    } catch (error) {
      pushed = { ok: false, summary: '', content: '', error: error instanceof Error ? error.message : String(error) };
    }
    if (!pushed.ok) {
      throw new Error(
        `beat 1 (${describeAction(firstAction)}) was refused, so nothing was armed: ${pushed.error ?? pushed.summary}`,
      );
    }
    const ids: string[] = [];
    const rows: ArcResult['beats'] = [
      { n: 1, sim: first.simName, action: first.action, ...(first.targetName ? { target: first.targetName } : {}) },
    ];
    // The trigger for beat n waits on beat n-1: beat 2 on the push just made, later ones on
    // the trigger before them
    let previous: WakeTrigger | undefined;
    for (let n = 2; n <= beats.length; n += 1) {
      const beat = beats[n - 1];
      const then: WakeAction = {
        do: 'push_action',
        simId: beat.simId,
        simName: beat.simName,
        action: beat.action,
        ...(beat.targetId ? { targetId: beat.targetId, targetName: beat.targetName } : {}),
      };
      const note = args.beatNote?.trim() || `beat ${n} of "${name}" did not run; adapt the arc`;
      const trigger = previous
        ? this.set({ kind: 'sim_finishes', note, then, after: previous.id })
        : this.set({ kind: 'sim_finishes', note, then, simId: first.simId, simName: first.simName });
      if (!previous) {
        this.resolveFrom(trigger, first.simId, first.simName, first.action, pushed.result);
      }
      ids.push(trigger.id);
      rows.push({
        n,
        sim: beat.simName,
        action: beat.action,
        ...(beat.targetName ? { target: beat.targetName } : {}),
        trigger_id: trigger.id,
      });
      previous = trigger;
    }
    const wake = previous
      ? this.set({ kind: 'sim_finishes', note: args.recapNote, after: previous.id })
      : this.set({ kind: 'sim_finishes', note: args.recapNote, simId: first.simId, simName: first.simName });
    if (!previous) {
      this.resolveFrom(wake, first.simId, first.simName, first.action, pushed.result);
    }
    const summary = pushed.summary.replace(/^arc "[^"]*" beat 1: /, '');
    const armed = ids.length > 0 ? `; armed ${ids.join(', ')} for beats 2..${beats.length}` : '';
    return {
      changed: `ARC "${name}": pushed beat 1 (${summary})${armed}; wake ${wake.id} after beat ${beats.length}`,
      arc: name,
      beats: rows,
      pending: this.triggers.length,
    };
  }

  // --- the whisper script --------------------------------------------------------------------

  isFrozen(): boolean {
    return this.frozen !== undefined;
  }

  frozenReason(): string | undefined {
    return this.frozen?.reason;
  }

  // Any script beat armed, deferred or frozen
  hasScript(): boolean {
    return this.frozen !== undefined || this.deferred.length > 0 || this.triggers.some((trigger) => trigger.then);
  }

  // Freeze the script: no trigger with a `then` fires until resume / replace_from / cancel.
  // False when it was already frozen (the first reason stands).
  freeze(reason: string, options: { simId?: string; simName?: string; nextIds?: string[] } = {}): boolean {
    if (this.frozen) {
      return false;
    }
    this.frozen = {
      at: this.now(),
      reason,
      simId: options.simId,
      simName: options.simName,
      nextIds: options.nextIds ?? [],
    };
    log.info(`[PlumWake] frozen: ${reason}`);
    this.journal.push(`script frozen: ${reason}`);
    return true;
  }

  // Thaw: the beat that froze is spent; the triggers that waited on it wait for the Sim's
  // current activity to end, so the script goes on from the next beat
  resume(): string {
    const frozen = this.frozen;
    if (!frozen) {
      return 'the script was not frozen';
    }
    this.frozen = undefined;
    this.shiftTimes(this.now() - frozen.at);
    const rebased: string[] = [];
    for (const id of frozen.nextIds) {
      const trigger = this.triggers.find((candidate) => candidate.id === id);
      if (trigger && frozen.simId) {
        this.rebase(trigger, frozen.simId, frozen.simName ?? frozen.simId);
        rebased.push(`${trigger.id} (${describe(trigger)})`);
      }
    }
    const text = rebased.length > 0 ? `resumed; now waiting on ${rebased.join('; ')}` : 'resumed';
    log.info(`[PlumWake] ${text}`);
    this.journal.push(`script ${text}`);
    this.drainDeferred();
    return text;
  }

  // The whisper script in one call: beat 1 is whispered now, beat 2 waits on the click that
  // whisper made, beats 3..N each wait on the trigger before them, and a closing wake waits
  // on the last. A beat 1 the Sim declined (or the world refused) freezes the script at
  // once with beat 2 armed on that Sim: Plum reads the reply in the result and decides.
  async planScript(args: {
    name: string;
    beats: ScriptBeat[];
    recapNote: string;
    beatNote?: string;
  }): Promise<ScriptResult> {
    const name = args.name.trim();
    const { beats } = args;
    if (!name) {
      throw new Error('a script needs a name');
    }
    if (beats.length < 1 || beats.length > MAX_ARC_BEATS) {
      throw new Error(`a script is 1 to ${MAX_ARC_BEATS} beats, not ${beats.length}`);
    }
    this.expire();
    if (this.frozen) {
      throw new Error(`a script is frozen (${this.frozen.reason}); decide it first with the script tool`);
    }
    if (this.triggers.length + beats.length > MAX_TRIGGERS) {
      throw new Error(
        `${beats.length} beats would need ${beats.length} triggers and ${this.triggers.length} are already set (max ${MAX_TRIGGERS}); wake_me cancel first`,
      );
    }
    const [first] = beats;
    const result = await this.plum.whisper.whisper(whisperRequest(first, `script "${name}" beat 1`));
    const rows: ScriptResult['beats'] = [{ n: 1, sim: first.simName, line: first.line, item: first.item.label }];
    const armed = this.chain(name, beats, 2, first, args.recapNote, args.beatNote, {
      action: whisperAction(first),
      result,
    });
    rows.push(...armed.rows);
    const view: ScriptResult = {
      changed: `SCRIPT "${name}": whispered beat 1 (${describeOutcome(whisperRequest(first), result)})${armed.summary}`,
      script: name,
      beats: rows,
      pending: this.triggers.length,
    };
    if (!(result.accepted && result.clicked)) {
      const reason = freezeReason(first.simName, 1, result);
      this.freeze(reason, { simId: first.simId, simName: first.simName, nextIds: armed.nextIds });
      view.frozen = reason;
      view.changed += `; FROZEN: ${reason}. Read the reply, then script resume | replace_from | cancel`;
    }
    return view;
  }

  // Arms beats `from`..N of a script after `anchor` (an armed trigger) or on `onSim` (the
  // Sim whose beat was just whispered, resolved from `fromAct` when its click took), then the
  // closing wake. Returns the rows, the ids that wait on the spent/anchor beat, a summary.
  private chain(
    name: string,
    beats: ScriptBeat[],
    from: number,
    onSim: { simId: string; simName: string },
    recapNote: string,
    beatNote: string | undefined,
    fromAct?: { action: WhisperAction; result: WhisperResult },
    anchor?: WakeTrigger,
    // beats[0] is script beat 1 + offset (replace_from rewrites from the middle)
    offset = 0,
  ): { rows: ScriptResult['beats']; nextIds: string[]; summary: string } {
    const rows: ScriptResult['beats'] = [];
    const ids: string[] = [];
    const nextIds: string[] = [];
    let previous: WakeTrigger | undefined = anchor;
    const resolveFirst = (trigger: WakeTrigger) => {
      if (fromAct?.result.accepted && fromAct.result.clicked) {
        this.resolveFrom(
          trigger,
          onSim.simId,
          onSim.simName,
          fromAct.action.item?.key ?? '',
          fromAct.result.clicked,
          fromAct.action,
        );
      }
      nextIds.push(trigger.id);
    };
    for (let i = from; i <= beats.length; i += 1) {
      const beat = beats[i - 1];
      const n = i + offset;
      const then = whisperAction(beat);
      const note = beatNote?.trim() || `beat ${n} of "${name}" did not run; adapt the script`;
      const trigger = previous
        ? this.set({ kind: 'sim_finishes', note, then, after: previous.id, script: name, beat: n })
        : this.set({
            kind: 'sim_finishes',
            note,
            then,
            simId: onSim.simId,
            simName: onSim.simName,
            script: name,
            beat: n,
          });
      if (!previous) {
        resolveFirst(trigger);
      }
      ids.push(trigger.id);
      rows.push({ n, sim: beat.simName, line: beat.line, item: beat.item.label, trigger_id: trigger.id });
      previous = trigger;
    }
    const wake = previous
      ? this.set({ kind: 'sim_finishes', note: recapNote, after: previous.id, script: name, closing: true })
      : this.set({
          kind: 'sim_finishes',
          note: recapNote,
          simId: onSim.simId,
          simName: onSim.simName,
          script: name,
          closing: true,
        });
    if (!previous) {
      resolveFirst(wake);
    }
    const last = beats.length + offset;
    const armed = ids.length > 0 ? `; armed ${ids.join(', ')} for beats ${from + offset}..${last}` : '';
    return { rows, nextIds, summary: `${armed}; wake ${wake.id} after beat ${last}` };
  }

  // Rewrite the script from beat `from` on: the beats at and after it go (the closing wake
  // too), the new ones chain after beat from-1's trigger when it is still armed, else the
  // first is whispered now; then the script thaws
  async replaceFrom(from: number, beats: ScriptBeat[], recapNote: string, beatNote?: string): Promise<ScriptResult> {
    if (!(from >= 1) || beats.length < 1 || beats.length + from - 1 > MAX_ARC_BEATS) {
      throw new Error(`a script is at most ${MAX_ARC_BEATS} beats; ${beats.length} from beat ${from} does not fit`);
    }
    const name = this.scriptName() ?? 'script';
    for (const trigger of [...this.triggers]) {
      if (trigger.script && (trigger.closing || (trigger.beat !== undefined && trigger.beat >= from))) {
        this.remove(trigger);
      }
    }
    for (let i = this.deferred.length - 1; i >= 0; i -= 1) {
      const { trigger } = this.deferred[i];
      if (trigger.script && trigger.beat !== undefined && trigger.beat >= from) {
        this.deferred.splice(i, 1);
      }
    }
    const frozen = this.frozen;
    this.frozen = undefined;
    if (frozen) {
      this.shiftTimes(this.now() - frozen.at);
      this.journal.push(`script rewritten from beat ${from}`);
    }
    const anchor = this.triggers.find((trigger) => trigger.script === name && trigger.beat === from - 1);
    const [first] = beats;
    const offset = from - 1;
    if (anchor) {
      const armed = this.chain(name, beats, 1, first, recapNote, beatNote, undefined, anchor, offset);
      return {
        changed: `SCRIPT "${name}": beats ${from}.. rewritten after ${anchor.id}${armed.summary}`,
        script: name,
        beats: armed.rows,
        pending: this.triggers.length,
      };
    }
    const result = await this.plum.whisper.whisper(whisperRequest(first, `script "${name}" beat ${from}`));
    const armed = this.chain(
      name,
      beats,
      2,
      first,
      recapNote,
      beatNote,
      { action: whisperAction(first), result },
      undefined,
      offset,
    );
    const view: ScriptResult = {
      changed: `SCRIPT "${name}": whispered beat ${from} (${describeOutcome(whisperRequest(first), result)})${armed.summary}`,
      script: name,
      beats: [{ n: from, sim: first.simName, line: first.line, item: first.item.label }, ...armed.rows],
      pending: this.triggers.length,
    };
    if (!(result.accepted && result.clicked)) {
      const reason = freezeReason(first.simName, from, result);
      this.freeze(reason, { simId: first.simId, simName: first.simName, nextIds: armed.nextIds });
      view.frozen = reason;
      view.changed += `; FROZEN: ${reason}. Read the reply, then script resume | replace_from | cancel`;
    }
    return view;
  }

  private scriptName(): string | undefined {
    return (
      this.triggers.find((trigger) => trigger.script)?.script ??
      this.deferred.find((entry) => entry.trigger.script)?.trigger.script
    );
  }

  // The script as the <live> block and the script tool show it: frozen or running, then one
  // line per armed beat (and per deferred one). Empty when there is no script.
  describeScript(): string[] {
    const lines: string[] = [];
    if (this.frozen) {
      lines.push(`FROZEN: ${this.frozen.reason} (script resume | replace_from | cancel)`);
    }
    const entries: { beat: number; line: string }[] = [];
    for (const trigger of this.triggers) {
      if (!trigger.script) {
        continue;
      }
      if (trigger.closing) {
        entries.push({ beat: 99, line: `after the last beat: ${trigger.id} wakes you (${trigger.note})` });
      } else {
        entries.push({ beat: trigger.beat ?? 98, line: `beat ${trigger.beat}: ${trigger.id} ${describe(trigger)}` });
      }
    }
    for (const { trigger } of this.deferred) {
      const what = trigger.then ? describeAction(trigger.then) : '';
      entries.push({
        beat: trigger.beat ?? 98,
        line: `beat ${trigger.beat ?? '?'}: ${trigger.id} ${what} (waits for the unpause)`,
      });
    }
    entries.sort((a, b) => a.beat - b.beat);
    lines.push(...entries.map((entry) => entry.line));
    return lines;
  }

  // --- what wakes a trigger ------------------------------------------------------------------

  onReport(report: SimStateReport) {
    this.expire();
    this.hardStopIfCastGone(report);
    const clock = report.lot?.clock;
    for (const trigger of [...this.triggers]) {
      if (trigger.after || (this.frozen && trigger.then)) {
        continue;
      }
      if (trigger.kind === 'sim_finishes' && trigger.simId) {
        const entry = (report.sims ?? []).find((sim) => sim.sim_id === trigger.simId);
        if (!entry) {
          continue;
        }
        const running = entry.activity?.running ?? null;
        const is = running ? `now "${running}"` : 'now idle';
        if (trigger.doing) {
          // An interaction the mod watches ends exactly (onInteractionEnded); the report's
          // guess is not needed and was wrong live (2026-10-17: a chat's TellJoke mixer took
          // the head and three triggers fired as "finished sim_Chat" the moment it began)
          if (this.isWatched(trigger.simId, trigger.doingId ?? trigger.doing)) {
            continue;
          }
          // Wait for the named interaction to start, then to stop. A running MIXER is a
          // beat of the super the trigger waits on, never a new super: still doing it.
          if (sameInteraction(running, trigger.doing)) {
            trigger.started = true;
          } else if (trigger.started && !isMixer(running)) {
            this.fire(trigger, `${trigger.simName} finished "${trigger.doing}", ${is}`);
          } else if (!trigger.started && this.now() - (trigger.waitingSince ?? trigger.setAt) >= DOING_START_GRACE_MS) {
            // Never began: a bad end, so a script beat freezes and an arc wakes Plum
            const seconds = Math.round(DOING_START_GRACE_MS / 1000);
            this.fire(trigger, `${trigger.simName} never started "${trigger.doing}" in ${seconds} s, ${is}`, {
              outcome: 'never started',
            });
          }
          continue;
        }
        const wentIdle = (report.went_idle ?? []).includes(trigger.simId);
        if (running !== (trigger.baseline ?? null) || (wentIdle && trigger.baseline)) {
          const was = trigger.baseline ? `"${trigger.baseline}"` : 'idle';
          this.fire(trigger, `${trigger.simName} finished ${was}, ${is}`);
        }
      } else if (trigger.kind === 'game_time' && clock && typeof clock.hour === 'number') {
        const target = (trigger.hour ?? 0) * 60 + (trigger.minute ?? 0);
        const current = clock.hour * 60 + (clock.minute ?? 0);
        // Within the hour after the target, so a report that lands a minute late still counts
        const passed = (current - target + 24 * 60) % (24 * 60);
        if (passed < 60) {
          this.fire(trigger, `the clock reached ${pad(trigger.hour ?? 0)}:${pad(trigger.minute ?? 0)}`);
        }
      }
    }
    this.drainDeferred();
    this.drain();
  }

  // A whisper beat's Sim is gone from the lot (travelled, despawned): a hard stop, frozen
  // without Plum's say and one wake
  private hardStopIfCastGone(report: SimStateReport) {
    if (this.frozen || !report.sims || report.sims.length === 0) {
      return;
    }
    const onLot = new Set(report.sims.map((sim) => sim.sim_id));
    for (const trigger of this.triggers) {
      const action = trigger.then;
      if (action?.do === 'whisper' && !onLot.has(action.simId)) {
        const reason = `${action.simName} is no longer on the lot (beat ${trigger.beat ?? '?'} was theirs)`;
        this.freeze(reason);
        this.queueWake(
          trigger,
          `${reason}. The script is frozen: nothing further fires until you decide with the script tool (resume, replace_from or cancel); the <live> block's script section is the truth about it`,
        );
        return;
      }
    }
  }

  // The mod watched an interaction Plum clicked or pushed and saw it end (ss_plum_watch):
  // the exact end for a `doing` trigger (by name or interaction id), and an end of
  // something for a trigger with no `doing`
  onInteractionEnded(event: {
    interaction_id: string;
    sim_id: string;
    sim_name?: string;
    name: string;
    outcome: string;
  }) {
    this.watched.delete(event.interaction_id);
    for (const trigger of [...this.triggers]) {
      if (trigger.after || trigger.kind !== 'sim_finishes' || trigger.simId !== event.sim_id) {
        continue;
      }
      if (this.frozen && trigger.then) {
        continue;
      }
      if (trigger.doingId) {
        // A chained beat knows its interaction exactly: nothing else on that Sim counts
        if (trigger.doingId !== event.interaction_id) {
          continue;
        }
      } else if (
        trigger.doing &&
        trigger.doing !== event.interaction_id &&
        !sameInteraction(event.name, trigger.doing)
      ) {
        continue;
      }
      this.fire(
        trigger,
        `${trigger.simName ?? event.sim_name ?? 'the Sim'}'s "${event.name}" ended: ${event.outcome}`,
        {
          outcome: event.outcome,
        },
      );
    }
    this.drain();
  }

  // The autonomy tier's outcome report for a push: a sim_finishes trigger on that Sim fires
  // with the outcome in the text (success, failure, canceled and the game's reason)
  onOutcome(event: WakeOutcome) {
    for (const trigger of [...this.triggers]) {
      if (trigger.after || trigger.kind !== 'sim_finishes' || trigger.simId !== event.sim_id) {
        continue;
      }
      if (this.frozen && trigger.then) {
        continue;
      }
      if (trigger.requestId) {
        if (trigger.requestId !== event.request_id) {
          continue;
        }
      } else if (
        trigger.doing &&
        !sameInteraction(event.interaction_name, trigger.doing) &&
        !sameInteraction(event.action, trigger.doing)
      ) {
        continue;
      }
      const what = event.interaction_name ?? event.action ?? 'the action';
      const reason = event.reason ? ` (${event.reason})` : '';
      this.fire(trigger, `${trigger.simName}'s "${what}" ended: ${event.outcome}${reason}`, { outcome: event.outcome });
    }
    this.drain();
  }

  // --- the wake ----------------------------------------------------------------------------

  // The condition was met. A plain trigger wakes Plum; a trigger with `then` acts itself,
  // unless the end that fired it was bad, in which case Plum is woken to adapt (the minimal
  // gate). A whisper's accepted click that ended canceled is clicked again once first.
  private fire(trigger: WakeTrigger, because: string, ended?: WakeEnd) {
    if (!trigger.then) {
      this.remove(trigger);
      log.info(`[PlumWake] ${trigger.id} fired: ${because}`);
      this.queueWake(trigger, because);
      return;
    }
    if (!endedWell(ended)) {
      const outcome = ended?.outcome ?? 'badly';
      const retry = trigger.fromWhisper;
      if (retry && !retry.retried && outcome.trim().toLowerCase() === 'canceled') {
        log.info(`[PlumWake] ${trigger.id}: ${because}; clicking ${retry.simName}'s "${retry.item.label}" again`);
        void this.retryWhisper(trigger, retry, because);
        return;
      }
      this.remove(trigger);
      log.info(`[PlumWake] ${trigger.id} fired: ${because}`);
      if (trigger.then.do === 'whisper') {
        // A script beat: freeze, keep the chain (decision 5), one wake. The trigger itself
        // is the next beat: back in the list, inert while frozen.
        const tried = retry ? ' (clicked again once already)' : '';
        const reason = `${because}${tried}; beat ${trigger.beat ?? '?'} (${describeAction(trigger.then)}) was not whispered`;
        this.journal.push(
          `${trigger.id} fired (${because}) but the whisper was not made: the beat before it ended ${outcome}`,
        );
        this.triggers.push(trigger);
        this.freeze(reason, {
          simId: trigger.simId,
          simName: trigger.simName,
          nextIds: [trigger.id, ...this.dependentsOf(trigger).map((dependent) => dependent.id)],
        });
        this.queueWake(
          trigger,
          `${because}. The whisper it was to make (${describeAction(trigger.then)}) was not made. The script is frozen: nothing further fires until you decide with the script tool (resume whispers this beat when ${trigger.simName} finishes what they are doing now; replace_from rewrites from a beat; cancel drops it)`,
        );
        return;
      }
      this.journal.push(`${trigger.id} fired (${because}) but the push was not sent: the beat ended ${outcome}`);
      const dropped = this.dropDependents(trigger);
      this.queueWake(
        trigger,
        `${because}. The beat it waited for ended ${outcome}, so the push it was to send (${describeAction(trigger.then)}) was not sent${PlumWakeService.droppedClause(dropped)}`,
      );
      return;
    }
    this.remove(trigger);
    log.info(`[PlumWake] ${trigger.id} fired: ${because}`);
    void this.act(trigger, because);
  }

  // The accepted click a trigger waited on ended canceled: click it again once (the Sim
  // already agreed), and the trigger waits for the new interaction instead
  private async retryWhisper(trigger: WakeTrigger, retry: FromWhisper, because: string) {
    retry.retried = true;
    const onLot = (this.ctx.simStateCache.getReport()?.sims ?? []).some((sim) => sim.sim_id === retry.simId);
    let error: string | undefined;
    if (!onLot) {
      error = `${retry.simName} is no longer on the lot`;
    } else {
      const outcome = await this.plum.callMod(
        'click_pie_menu',
        { sim: retry.simId, target: retry.item.targetId ?? null, item: retry.item.key, source: 'whisper' },
        CLICK_TIMEOUT_MS,
      );
      if (outcome.ok) {
        const result = (outcome.result ?? {}) as { changed?: unknown; interaction_id?: unknown };
        const changed = typeof result.changed === 'string' ? result.changed : `clicked ${retry.item.label}`;
        if (typeof result.interaction_id === 'string' && result.interaction_id) {
          this.noteWatched(retry.simId, result.interaction_id, retry.item.key);
        }
        if (this.triggers.includes(trigger)) {
          this.resolveFrom(trigger, retry.simId, retry.simName, retry.item.key, outcome.result);
        }
        log.info(`[PlumWake] ${trigger.id}: ${changed} (second try)`);
        this.journal.push(
          `${trigger.id}: ${because}; clicked "${retry.item.label}" again for ${retry.simName} (${changed})`,
        );
        return;
      }
      error = outcome.error ?? 'the click did not take';
    }
    if (!this.triggers.includes(trigger)) {
      return;
    }
    const reason = `${retry.simName}'s "${retry.item.label}" ended canceled and clicking it again was refused: ${error}`;
    log.info(`[PlumWake] ${trigger.id}: ${reason}`);
    this.journal.push(`${trigger.id}: ${reason}`);
    this.freeze(reason, {
      simId: retry.simId,
      simName: retry.simName,
      nextIds: [trigger.id, ...this.dependentsOf(trigger).map((dependent) => dependent.id)],
    });
    this.queueWake(
      trigger,
      `${reason}. The script is frozen: nothing further fires until you decide with the script tool (resume goes on from the next beat when ${retry.simName} finishes what they are doing now; replace_from rewrites from a beat; cancel drops it)`,
    );
    this.drain();
  }

  // Runs the trigger's act at once: a push does not need Plum idle (the mod answers by
  // request id), and a refused push wakes Plum so the arc never dies silently
  private async act(trigger: WakeTrigger, because: string) {
    const action = trigger.then;
    if (!action) {
      return;
    }
    if (action.do === 'whisper') {
      await this.actWhisper(trigger, action, because);
      return;
    }
    const label = `trigger ${trigger.id}`;
    let result: PlumToolOutcome;
    try {
      result = await this.plum.runScheduledTool(
        'push_action',
        { sim: action.simId, action: action.action, target: action.targetId ?? null, preempt: false },
        label,
      );
    } catch (error) {
      result = { ok: false, summary: '', content: '', error: error instanceof Error ? error.message : String(error) };
    }
    if (result.ok) {
      log.info(`[PlumWake] ${trigger.id} ${result.summary}`);
      this.journal.push(`${trigger.id} fired (${because}): ${result.summary}`);
      // runTool noted the watch before returning, so a dependent matching by id is live at once
      this.resolveDependents(trigger, result.result);
      return;
    }
    const error = result.error ?? result.summary;
    log.info(`[PlumWake] ${trigger.id} push refused: ${error}`);
    this.journal.push(
      `${trigger.id} fired (${because}) but its push (${describeAction(action)}) was refused: ${error}`,
    );
    const dropped = this.dropDependents(trigger);
    this.queueWake(
      trigger,
      `${because}. The push it was to send (${describeAction(action)}) was refused: ${error}${PlumWakeService.droppedClause(dropped)}`,
    );
    this.drain();
  }

  // A whisper beat: under the player's pause it waits for the unpause; otherwise the Sim
  // answers, an accepted click chains the next beat, anything else freezes the script
  private async actWhisper(trigger: WakeTrigger, action: WhisperAction, because: string) {
    if (getModClockState()?.paused_by === 'user') {
      log.info(`[PlumWake] ${trigger.id} fired under the player's pause; the whisper waits for the unpause`);
      this.journal.push(
        `${trigger.id} fired (${because}) while the game was paused; its whisper waits for the unpause`,
      );
      this.deferred.push({ trigger, because });
      return;
    }
    const label = trigger.script ? `script "${trigger.script}" beat ${trigger.beat ?? '?'}` : `trigger ${trigger.id}`;
    const request: WhisperRequest = {
      simId: action.simId,
      simName: action.simName,
      line: action.line,
      ...(action.item ? { item: action.item } : {}),
      origin: 'script',
      beatLabel: label,
    };
    let result: WhisperResult;
    try {
      result = await this.plum.whisper.whisper(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = { accepted: false, reply: `(the whisper failed: ${message})` };
    }
    const outcome = describeOutcome(request, result);
    this.journal.push(`${trigger.id} fired (${because}): ${outcome}`);
    if (result.accepted && result.clicked) {
      this.resolveDependents(trigger, result.clicked);
      return;
    }
    if (result.accepted && !action.item) {
      // Talk only: the beat is spent; what waited on it waits for the Sim's next end
      for (const dependent of this.dependentsOf(trigger)) {
        this.rebase(dependent, action.simId, action.simName);
      }
      return;
    }
    const reason = freezeReason(action.simName, trigger.beat, result);
    this.freeze(reason, {
      simId: action.simId,
      simName: action.simName,
      nextIds: this.dependentsOf(trigger).map((dependent) => dependent.id),
    });
    this.queueWake(
      trigger,
      `${because}. ${label}: ${outcome}. The script is frozen: nothing further fires until you decide with the script tool (resume goes on from the next beat when ${action.simName} finishes what they are doing now; replace_from rewrites from a beat; cancel drops it); the <live> block's script section is the truth about it`,
    );
    this.drain();
  }

  // Whispers deferred by the player's pause run once the clock runs again
  private drainDeferred() {
    if (this.deferred.length === 0 || this.frozen || getModClockState()?.paused_by === 'user') {
      return;
    }
    for (const { trigger, because } of this.deferred.splice(0)) {
      void this.act(trigger, `${because}; the game was unpaused`);
    }
  }

  private queueWake(trigger: WakeTrigger, because: string) {
    const text = [
      `<wake id="${trigger.id}" trigger="${trigger.kind}">`,
      `${because}.`,
      `You asked to be woken for: "${trigger.note}".`,
      'Nobody typed anything: look, say only what matters to the player (one or two sentences), act only if the note calls for it.',
      '</wake>',
    ].join('\n');
    this.fired.push({ trigger, text });
    this.drain();
  }

  // Runs the fired wakes the moment Plum can take them. A director that is holding (pause,
  // stale report, emergency, cap) keeps its wake for the next evaluation.
  private drain() {
    while (this.fired.length > 0) {
      const next = this.fired[0];
      const director = this.ctx.ext.director;
      if (director?.status().active) {
        if (!director.wake(next.text)) {
          return;
        }
      } else {
        if (this.plum.isRunning) {
          return;
        }
        // A script's or an arc's wake with the director off is still the director's business:
        // its model and its roll threshold (PlumService.isDirectorTurn)
        const script = Boolean(next.trigger.script || next.trigger.then);
        void this.plum.runTurn(next.text, { wake: true, ...(script ? { script: true } : {}) });
      }
      this.fired.shift();
    }
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function whisperAction(beat: ScriptBeat): WhisperAction {
  return { do: 'whisper', simId: beat.simId, simName: beat.simName, line: beat.line, item: beat.item };
}

function whisperRequest(beat: ScriptBeat, beatLabel?: string): WhisperRequest {
  return {
    simId: beat.simId,
    simName: beat.simName,
    line: beat.line,
    item: beat.item,
    origin: 'script',
    ...(beatLabel ? { beatLabel } : {}),
  };
}

// Why a whispered beat froze the script, with the Sim's reply so the wake carries it
function freezeReason(simName: string, beat: number | undefined, result: WhisperResult): string {
  const which = `beat ${beat ?? '?'}`;
  if (result.reply === NO_ANSWER) {
    return `${simName} gave no usable answer to ${which} (a model glitch, not a refusal; resume or replace_from re-whispers it)`;
  }
  if (!result.accepted) {
    return `${simName} declined ${which}: "${result.reply}"`;
  }
  return `${simName} agreed to ${which} ("${result.reply}") but ${result.refused ?? 'the click did not take'}`;
}

const NAME_PREFIXES = ['mixer_social_', 'mixer_', 'super_', 'si_', 'sim_'];

// The report's running head is a mixer while a social or a looping super plays its beats
export function isMixer(running: string | null | undefined): boolean {
  return Boolean(running && running.toLowerCase().startsWith('mixer_'));
}

function normalizeName(name: string): string {
  let text = name.toLowerCase();
  for (const prefix of NAME_PREFIXES) {
    if (text.startsWith(prefix)) {
      text = text.slice(prefix.length);
      break;
    }
  }
  return text;
}

// The report's `running` is the affordance's tuning name, as are the keys pie_menu and push
// results carry; but the game runs a super through its mixers (Solo_Stargazing shows up as
// mixer_solo_stargaze) and a whitelist key is a word of the name (insult), so the match is
// loose: one contains the other, or they share a long enough stem
export function sameInteraction(running: string | null | undefined, wanted: string): boolean {
  if (!running || !wanted) {
    return false;
  }
  const a = normalizeName(running);
  const b = normalizeName(wanted);
  if (a === b || a.includes(b) || b.includes(a)) {
    return true;
  }
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix += 1;
  }
  return prefix >= Math.max(6, 0.75 * Math.min(a.length, b.length));
}

export function describeAction(action: WakeAction): string {
  if (action.do === 'whisper') {
    const nudge = action.item
      ? `, nudging ${action.item.label}${action.item.targetName ? ` (with ${action.item.targetName})` : ''}`
      : '';
    return `whisper to ${action.simName} "${action.line}"${nudge}`;
  }
  return `push ${action.action} on ${action.simName}${action.targetName ? ` (with ${action.targetName})` : ''}`;
}

function describeBaseline(trigger: WakeTrigger): string {
  return trigger.baseline ? `"${trigger.baseline}"` : 'what they start next';
}

function describeWhen(trigger: WakeTrigger): string {
  switch (trigger.kind) {
    case 'sim_finishes':
      if (trigger.after) {
        return `after ${trigger.after}, when ${trigger.simName} finishes the beat it pushes`;
      }
      if (trigger.doing) {
        return `when ${trigger.simName} finishes "${trigger.doing}"${trigger.started ? '' : ' (not started yet)'}`;
      }
      return `when ${trigger.simName} finishes ${describeBaseline(trigger)}`;
    case 'game_time':
      return `at ${pad(trigger.hour ?? 0)}:${pad(trigger.minute ?? 0)}`;
    case 'real_minutes':
      return `in ${Math.max(1, Math.round(((trigger.dueAt ?? trigger.setAt) - trigger.setAt) / 60_000))} real minutes`;
    default:
      return trigger.kind;
  }
}

export function describe(trigger: WakeTrigger): string {
  const when = describeWhen(trigger);
  return trigger.then ? `${when}, then ${describeAction(trigger.then)}` : when;
}
