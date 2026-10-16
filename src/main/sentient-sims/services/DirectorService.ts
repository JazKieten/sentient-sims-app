// Plum's director mode: the improv-watch loop as a service (autonomy tier, listed in
// tiers.json; core reaches it only through ctx.ext.director).
//
// Plum surveys the lot, casts the awake Sims as improv actors, plans a named arc of three
// to seven beats from their traits, relationships and moods, then pushes ONE beat a tick
// and adapts the script to what the AIs actually play; when an arc completes or collapses
// it recaps and plans the next one, and never stops on its own. The ticks are turns on
// the same conversation as the chat (PlumService.runTurn with director options), so the
// player can talk to Plum mid-arc and sees the narration as director rows.
//
// Guard rails: no tick while the player's own pause stands or the state report is stale,
// none while nothing changed since the last tick (report seq, newest memory, last graded
// outcome), none while a fire or a death is on the lot, and never more than
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
      }
      this.suspended = reason;
      return;
    }
    this.suspended = undefined;
    const digest = this.digest();
    if (this.ticks > 0 && digest === this.lastDigest) {
      return;
    }
    this.lastDigest = digest;
    this.ticking = true;
    this.ticks += 1;
    this.tickTimes.push(this.now());
    const planning = this.ticks === 1 || this.arc === undefined;
    const rowsBefore = this.plum.rows.length;
    try {
      await this.plum.runTurn(this.tickText(planning), {
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

  // The arc's name rides a line of this tick's narration: "ARC: <name>" (the newest wins)
  private readArc(rowsBefore: number) {
    const { rows } = this.plum;
    for (let i = rows.length - 1; i >= rowsBefore; i -= 1) {
      const row = rows[i];
      if (row.kind !== 'director') {
        continue;
      }
      const match = /^\s*ARC:\s*(.+)$/im.exec(row.text);
      if (match) {
        this.arc = match[1].trim().slice(0, 80);
        log.info(`[Director] arc: ${this.arc}`);
        return;
      }
    }
  }

  tickText(planning: boolean): string {
    const lines = [`<director_tick n="${this.ticks}">`];
    lines.push(
      'You are directing an improv episode with the Sims as the actors: you plan a story and push beats, ' +
        'they play them their own way, and the script bends to what they do.',
    );
    if (this.brief) {
      lines.push(`The player's brief: ${this.brief}`);
    }
    if (planning) {
      lines.push(
        'Survey the lot (look_at_lot, then relationships for the awake Sims; sleeping Sims are set dressing). ' +
          'Plan a named arc of three to seven beats, each one whitelisted action from one actor to one target ' +
          '(list_actions has the keys). Start your reply with "ARC: <name>" on its own line, list the beats in ' +
          'one short line each, then push the FIRST beat with push_action.',
      );
    } else {
      lines.push(`Current arc: ${this.arc ?? 'none yet'}.`);
      lines.push(
        'Look at the lot and verify how the actors played the last beat (what they are doing, recent_memories ' +
          'for the lines). Adapt the remaining beats to what actually happened, then push at most ONE beat with ' +
          'push_action, or none if the last one is still playing out. If the arc is finished or has collapsed ' +
          '(cast asleep or gone, premise overtaken), recap it in two sentences and plan the next one: start that ' +
          'reply with "ARC: <name>".',
      );
    }
    lines.push(
      'Narrate in one to three sentences like a director watching dailies; quote a good line when there is one. ' +
        'Never cancel what a Sim is doing, never travel, never touch the clock or the settings while directing.',
    );
    lines.push('</director_tick>');
    return lines.join('\n');
  }
}
