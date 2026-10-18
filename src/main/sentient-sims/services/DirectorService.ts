// Plum's director mode: the improv-watch loop as a service (autonomy tier, listed in
// tiers.json; core reaches it only through ctx.ext.director).
//
// Plum surveys the lot, casts the awake Sims as improv actors, plans a named script of three
// to seven beats from their traits, relationships and moods, and hands the whole script to
// plan_script (PlumWake.planScript): every beat is a WHISPER, a line Plum says to one Sim as
// the voice in their head plus the pie-menu item it hopes they pick (PlumWhisper.ts: the
// Sim's own actor model answers in character and may refuse). The app whispers the first
// beat, whispers each later beat itself when the one before it actually ends (by
// interaction id), and wakes Plum only when a Sim refuses or an agreed click is refused (the
// script FREEZES until Plum decides: script resume / replace_from / cancel), on a hard stop
// (fire, death, a cast Sim gone, a stale report), or when the script completes; then Plum
// recaps, plans the next one, and never stops on its own. plan_arc (pushes, no say) stays
// for now. The turns are on the same conversation as the chat (PlumService.runTurn with
// director options), so the player can talk to Plum mid-script and sees the narration as
// director rows.
//
// Guard rails: no tick while the player's own pause stands or the state report is stale,
// none while triggers are armed (the arc runs itself; the 60 s interval only catches a
// stalled arc), none while nothing changed since the last tick (report seq, newest memory,
// last graded outcome), none while a fire or a death is on the lot, and never more than
// plumDirectorMaxTicksPerHour ticks in a sliding hour.
import log from 'electron-log';
import { ApiContext } from './ApiContext';
import { ActionOutcomeRepository } from '../db/ActionOutcomeRepository';
import { getModClockState } from '../websocketServer';
import type { DirectorSlot } from '../tiers/types';
import type { PlumService } from './PlumService';

export const TICK_MS = 60_000;
const HOUR_MS = 3_600_000;
const EMERGENCY = /fire|death|grim|reaper|burn/i;

export type DirectorDeps = {
  outcomes?: Pick<ActionOutcomeRepository, 'isLoaded' | 'list'>;
  // Tests drive a PlumService with a scripted model; production uses the context's
  plum?: PlumService;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  now?: () => number;
};

export type DirectorStatus = { active: boolean; arc?: string; ticks: number; suspended?: string };

export class DirectorService implements DirectorSlot {
  private readonly ctx: ApiContext;

  private readonly deps: DirectorDeps;

  private timer: ReturnType<typeof setInterval> | undefined;

  private brief: string | undefined;

  private arc: string | undefined;

  private ticks = 0;

  private lastDigest: string | undefined;

  private tickTimes: number[] = [];

  private suspended: string | undefined;

  private ticking = false;

  // A fired wake-up trigger (PlumWake) waiting for the next tick to carry it
  private pendingWake: string | undefined;

  // The last "triggers armed" hold logged, so the minute tick does not repeat it
  private lastHold: string | undefined;

  constructor(ctx: ApiContext, deps: DirectorDeps = {}) {
    this.ctx = ctx;
    this.deps = deps;
  }

  private get plum(): PlumService {
    return this.deps.plum ?? this.ctx.plum;
  }

  start(brief?: string) {
    if (this.timer) {
      return;
    }
    this.brief = brief?.trim() || undefined;
    this.arc = undefined;
    this.ticks = 0;
    this.lastDigest = undefined;
    this.suspended = undefined;
    const schedule = this.deps.setInterval ?? setInterval;
    this.timer = schedule(() => {
      void this.tick();
    }, TICK_MS);
    log.info(`[Director] started${this.brief ? ` (brief: ${this.brief})` : ''}`);
    this.plum.emitStatus('idle');
    // The first tick plans the arc right away rather than a minute from now
    void this.tick();
  }

  stop() {
    if (!this.timer) {
      return;
    }
    const clear = this.deps.clearInterval ?? clearInterval;
    clear(this.timer);
    this.timer = undefined;
    this.pendingWake = undefined;
    log.info(`[Director] stopped after ${this.ticks} ticks`);
    this.plum.emitStatus('idle');
  }

  status(): DirectorStatus {
    return {
      active: this.timer !== undefined,
      ...(this.arc ? { arc: this.arc } : {}),
      ticks: this.ticks,
      ...(this.suspended ? { suspended: this.suspended } : {}),
    };
  }

  // Plum set itself a wake-up and it fired: the next tick carries the wake and runs at once
  // when nothing holds it (a held wake waits for the next interval, not for a changed digest)
  wake(text: string): boolean {
    if (!this.timer) {
      return false;
    }
    this.pendingWake = this.pendingWake ? `${this.pendingWake}\n${text}` : text;
    void this.tick();
    return true;
  }

  // --- the tick ----------------------------------------------------------------------------

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  // Why this tick must not run, or undefined
  skipReason(): string | undefined {
    if (getModClockState()?.paused_by === 'user') {
      return 'the player paused the game';
    }
    if (this.ctx.simStateCache.isStale(this.now())) {
      return 'the state report is stale (loading screen?)';
    }
    if (this.plum.isRunning) {
      return 'Plum is mid-turn';
    }
    const report = this.ctx.simStateCache.getReport();
    const situations = report?.lot?.situations ?? [];
    const actionKeys = report?.lot?.action_keys ?? [];
    if (actionKeys.includes('call_firefighter') || situations.some((name) => EMERGENCY.test(name))) {
      return 'an emergency on the lot (fire or death)';
    }
    const windowStart = this.now() - HOUR_MS;
    this.tickTimes = this.tickTimes.filter((at) => at > windowStart);
    if (this.tickTimes.length >= this.ctx.settings.plumDirectorMaxTicksPerHour) {
      return `the hourly cap (${this.ctx.settings.plumDirectorMaxTicksPerHour} ticks)`;
    }
    return undefined;
  }

  digest(): string {
    const report = this.ctx.simStateCache.getReport();
    let memoryId = '';
    try {
      const memories = this.ctx.memoryRepository.getMemories();
      memoryId = memories[memories.length - 1]?.id ?? '';
    } catch {
      // No database loaded: the report alone drives the digest
    }
    let outcomeId = '';
    try {
      if (this.deps.outcomes?.isLoaded()) {
        outcomeId = String(this.deps.outcomes.list({ limit: 1 })[0]?.id ?? '');
      }
    } catch {
      outcomeId = '';
    }
    return `${report?.seq ?? ''}|${memoryId}|${outcomeId}`;
  }

  async tick(): Promise<void> {
    if (!this.timer || this.ticking) {
      return;
    }
    const reason = this.skipReason();
    if (reason) {
      if (reason !== this.suspended) {
        log.info(`[Director] holding: ${reason}`);
        this.hardStop(reason);
      }
      this.suspended = reason;
      return;
    }
    this.suspended = undefined;
    const wake = this.pendingWake;
    // With triggers armed the arc runs itself (PlumWake pushes the beats); the director only
    // runs from wakes. The interval then catches a stalled arc: nothing armed, digest moved.
    const armed = this.plum.wake.list().length;
    if (!wake && this.ticks > 0 && armed > 0) {
      const hold = `holding: ${armed} trigger${armed === 1 ? '' : 's'} armed`;
      if (hold !== this.lastHold) {
        log.info(`[Director] ${hold}`);
        this.lastHold = hold;
      }
      return;
    }
    this.lastHold = undefined;
    const digest = this.digest();
    if (!wake && this.ticks > 0 && digest === this.lastDigest) {
      return;
    }
    this.lastDigest = digest;
    this.pendingWake = undefined;
    this.ticking = true;
    this.ticks += 1;
    this.tickTimes.push(this.now());
    const planning = this.ticks === 1 || this.arc === undefined;
    const rowsBefore = this.plum.rows.length;
    try {
      await this.plum.runTurn(this.tickText(planning, wake), {
        director: true,
        effort: planning ? 'high' : 'medium',
        maxPushes: 1,
      });
      this.readArc(rowsBefore);
    } catch (error) {
      log.warn('[Director] tick failed', error);
    } finally {
      this.ticking = false;
    }
  }

  // A hard stop (decision 6): an emergency on the lot or a stale report (zone load) freezes
  // the whisper script without Plum's say, once per transition; the player's pause and the
  // hourly cap only hold the tick
  private hardStop(reason: string) {
    if (!/emergency|stale/.test(reason)) {
      return;
    }
    const { wake } = this.plum;
    if (wake.hasScript() && !wake.isFrozen()) {
      wake.freeze(reason);
    }
  }

  // The script's name rides a line of this tick's narration, "ARC: <name>", or the summary
  // of a plan_script / plan_arc call that went through (`SCRIPT "<name>": whispered beat 1
  // ...`, `ARC "<name>": pushed beat 1 ...`); the newest wins
  private readArc(rowsBefore: number) {
    const { rows } = this.plum;
    for (let i = rows.length - 1; i >= rowsBefore; i -= 1) {
      const row = rows[i];
      let match: RegExpExecArray | null = null;
      if (row.kind === 'director') {
        match = /^\s*ARC:\s*(.+)$/im.exec(row.text);
      } else if (row.kind === 'tool' && row.name === 'plan_script' && row.ok) {
        match = /SCRIPT "(.+?)":/.exec(row.summary ?? '');
      } else if (row.kind === 'tool' && row.name === 'plan_arc' && row.ok) {
        match = /ARC "(.+?)":/.exec(row.summary ?? '');
      }
      if (match) {
        this.arc = match[1].trim().slice(0, 80);
        log.info(`[Director] arc: ${this.arc}`);
        return;
      }
    }
  }

  tickText(planning: boolean, wake?: string): string {
    const lines = [`<director_tick n="${this.ticks}">`];
    if (wake) {
      lines.push(wake);
    }
    lines.push(
      'You are directing an improv episode with the Sims as the actors: you plan a story and WHISPER beats. ' +
        'Each beat is a line you say to one Sim as the voice in their head plus the pie-menu item you hope ' +
        'they choose (pie_menu shows what they can do right now). They answer in character and may refuse; ' +
        'the script bends to what they do.',
    );
    if (this.brief) {
      lines.push(`The player's brief: ${this.brief}`);
    }
    // The chat rules (ask first, say so when nothing needs doing, wait for the player) do
    // not apply here: a director tick is the show running with nobody at the keyboard.
    // Measured 2026-10-17 on Haiku: every recap ended with "holding off until you want one"
    // and the show stopped between arcs.
    lines.push(
      'The player is NOT at the keyboard during a director tick and you never wait for them: a question to the ' +
        'player ends the show. When a script is finished, frozen beyond saving or collapsed, recap it in a sentence ' +
        'and plan the NEXT script in this same turn, every time, without asking. A quiet lot is the raw material, ' +
        'not a reason to hold: a script has three to seven beats, and a single beat is not a script.',
    );
    if (planning) {
      lines.push(
        'Survey the lot (look_at_lot, then relationships for the awake Sims; sleeping Sims are set dressing; ' +
          'pie_menu for the actors you will use). Plan a named script of three to seven beats, each one line ' +
          'to one Sim and one pie-menu item (key or label) with its target. Start your reply with ' +
          '"ARC: <name>" on its own line, list the beats in one short line each, then call plan_script ONCE ' +
          'with the beats in order: it whispers the first beat, whispers each later beat when the previous ' +
          "one's interaction actually ends, and wakes you to recap.",
      );
    } else {
      lines.push(`Current arc: ${this.arc ?? 'none yet'}.`);
      lines.push(
        'Look at the lot and verify how the actors played the last beat (what they are doing, recent_memories ' +
          'for the lines; the <live> block says what your triggers did and shows the script). If a Sim refused ' +
          'a beat the script is FROZEN and the wake carries their reply: read it, then decide with the script ' +
          'tool (resume = go on from the next beat; replace_from = rewrite from a beat on; cancel = drop it). ' +
          'If the script is finished or has collapsed (cast asleep or gone, premise overtaken), recap it in two ' +
          'sentences and plan the next one with plan_script: start that reply with "ARC: <name>".',
      );
      lines.push(
        'The <live> block is the truth about your triggers and your script: if it has no `triggers:` section, ' +
          'none are set; if it has no `script:` section, no script is set. Narrate from `since your last turn:`, ' +
          'not from memory of what you armed.',
      );
    }
    lines.push(
      'plan_script arms the whole chain. Then stop: the app whispers the beats, and a wake comes when a Sim ' +
        'refuses, an agreed click is refused, something stops the show, or the script completes. Never ' +
        'push_action while directing unless the player asked for that beat; whispers only.',
    );
    lines.push(
      'Narrate in one to three sentences like a director watching dailies; quote a good line when there is one. ' +
        'Never cancel what a Sim is doing, never travel, never touch the clock or the settings while directing.',
    );
    lines.push('</director_tick>');
    return lines.join('\n');
  }
}
