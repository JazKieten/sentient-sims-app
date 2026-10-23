// The night call (autonomy part 6, 2026-10-22; autonomy tier): one model call per household
// Sim at the day rollover that EDITS the new day's intention list from what fired, what died
// and why, and the day's events, and adds story rows. It runs as a Plum turn of kind `night`
// (PlumService.runTurn with `night: true`: detached, hidden, no <live> block), so the one
// Claude Code brain session serves it in dev and the API key path is wired the same way; the
// result comes back through the edit_intentions tool (IntentionService.applyEdits).
//
// One call at a time, interleaved with the player: a queue started from the state report
// only while no Plum turn runs, the brain is up and Plum is on. A Sim still queued six
// sim-hours into the new day is dropped (the seeds alone serve). The queue is in memory.
import log from 'electron-log';
import type { ApiContext } from '../ApiContext';
import type { AutonomyServices } from '../../tiers/autonomy';
import type { SimStateReport } from '../../models/SimStateReport';
import type { MemoryEntity } from '../../db/entities/MemoryEntity';
import type { ActionOutcomeRecord } from '../../db/ActionOutcomeRepository';
import { IntentionRow, clockMinutes } from '../../models/IntentionRow';
import type { DayRollover } from './IntentionService';
import { NIGHT_MEMORIES, buildNightText } from './NightCall';

// How long past midnight a queued call may still start (sim minutes)
export const NIGHT_CALL_STALE_MINUTES = 6 * 60;
const OUTCOMES_READ = 80;

type Pending = {
  simId: string;
  endingDay: number;
  newDay: number;
  endingRows: IntentionRow[];
};

export type NightCallDeps = Pick<AutonomyServices, 'intentions'> &
  Partial<Pick<AutonomyServices, 'actionOutcomeRepository'>>;

export class NightCallService {
  private readonly ctx: ApiContext;

  private readonly deps: NightCallDeps;

  private readonly queue: Pending[] = [];

  // sim|newDay pairs already called (or dropped): a rollover is answered once
  private readonly done = new Set<string>();

  private running: string | undefined;

  constructor(ctx: ApiContext, deps: NightCallDeps) {
    this.ctx = ctx;
    this.deps = deps;
    deps.intentions.onDayRollover((rollover) => {
      this.enqueue(rollover);
    });
  }

  private enabled(): boolean {
    return this.ctx.settings.intentionNightCallEnabled && this.ctx.settings.intentionRowsEnabled;
  }

  private simName(simId: string): string {
    return this.ctx.simStateCache.getSim(simId)?.sim_name ?? `sim ${simId}`;
  }

  private static key(simId: string, day: number): string {
    return `${simId}|${day}`;
  }

  get pending(): readonly { simId: string; newDay: number }[] {
    return this.queue.map(({ simId, newDay }) => ({ simId, newDay }));
  }

  get runningSim(): string | undefined {
    return this.running;
  }

  enqueue(rollover: DayRollover) {
    if (!this.enabled()) {
      return;
    }
    const key = NightCallService.key(rollover.simId, rollover.newDay);
    if (this.done.has(key) || this.queue.some((item) => NightCallService.key(item.simId, item.newDay) === key)) {
      return;
    }
    this.queue.push({ ...rollover });
    log.info(`[Night] ${this.simName(rollover.simId)} queued (day ${rollover.endingDay} -> ${rollover.newDay})`);
  }

  // Why no Plum turn may start now, or undefined
  private plumBusy(): string | undefined {
    const { plum } = this.ctx;
    if (!this.ctx.settings.plumEnabled) {
      return 'Plum is off';
    }
    if (plum.isRunning) {
      return 'a Plum turn is running';
    }
    return plum.brainUnavailable();
  }

  // From the state report, after the row lane: drop stale entries, start the next when idle
  tick(report: SimStateReport) {
    if (!this.enabled() || this.queue.length === 0) {
      return;
    }
    const now = clockMinutes(report);
    if (now !== undefined) {
      for (let index = this.queue.length - 1; index >= 0; index -= 1) {
        const item = this.queue[index];
        if (now > item.newDay * 1440 + NIGHT_CALL_STALE_MINUTES) {
          this.queue.splice(index, 1);
          this.done.add(NightCallService.key(item.simId, item.newDay));
          log.info(`[Night] ${this.simName(item.simId)} dropped: still queued 6 sim-hours into day ${item.newDay}`);
        }
      }
    }
    if (this.running || this.queue.length === 0 || this.plumBusy()) {
      return;
    }
    // The Sim's list for the new day must exist (their first report of the day seeds it)
    const index = this.queue.findIndex((item) => report.sims?.some((sim) => sim.sim_id === item.simId));
    if (index < 0) {
      return;
    }
    const [next] = this.queue.splice(index, 1);
    void this.run(next);
  }

  private memoriesOf(simId: string, day: number): MemoryEntity[] {
    try {
      if (!this.ctx.db.isLoaded()) {
        return [];
      }
      return this.ctx.memoryRepository.getOwnDayMemories(simId, day, NIGHT_MEMORIES);
    } catch (error) {
      log.debug(`[Night] memories unavailable for sim ${simId}: ${String(error)}`);
      return [];
    }
  }

  private outcomesOf(simId: string): ActionOutcomeRecord[] {
    const repository = this.deps.actionOutcomeRepository;
    try {
      return repository?.isLoaded() ? repository.list({ simId, limit: OUTCOMES_READ }) : [];
    } catch (error) {
      log.debug(`[Night] outcomes unavailable for sim ${simId}: ${String(error)}`);
      return [];
    }
  }

  private textFor(item: Pending): { text: string; rows: number; memories: number } {
    const memories = this.memoriesOf(item.simId, item.endingDay);
    const todayRows = this.deps.intentions.rowsFor(item.simId);
    const text = buildNightText({
      simId: item.simId,
      simName: this.simName(item.simId),
      entry: this.ctx.simStateCache.getSim(item.simId),
      report: this.ctx.simStateCache.getReport(),
      endingDay: item.endingDay,
      newDay: item.newDay,
      endingRows: item.endingRows,
      todayRows,
      memories,
      outcomes: this.outcomesOf(item.simId),
    });
    return { text, rows: todayRows.length, memories: memories.length };
  }

  private async run(item: Pending): Promise<void> {
    const name = this.simName(item.simId);
    this.running = item.simId;
    this.done.add(NightCallService.key(item.simId, item.newDay));
    try {
      const { text, rows, memories } = this.textFor(item);
      log.info(
        `[Night] ${name} call starts (day ${item.endingDay} -> ${item.newDay}, ${item.endingRows.length} rows yesterday, ` +
          `${rows} today, ${memories} memories, ${text.length} chars)`,
      );
      const before = this.deps.intentions.editsApplied(item.simId);
      const result = await this.ctx.plum.runTurn(text, { night: true });
      const edited = this.deps.intentions.editsApplied(item.simId) > before;
      log.info(
        `[Night] ${name} call ended edited=${edited}` +
          (result.error ? ` error=${result.error.status ?? ''} ${result.error.message}` : ''),
      );
    } catch (error) {
      log.warn(`[Night] ${name} call failed`, error);
    } finally {
      this.running = undefined;
    }
  }

  // The debug route: a night call for the Sim now, for the current day, with yesterday's
  // stored rows as "the day" if there are any, else today's rows so far. Starts the turn and
  // returns; the turn's end is the `[Night] ... call ended` line.
  runNow(simId: string): { ok: boolean; started?: string; error?: string } {
    const report = this.ctx.simStateCache.getReport();
    const day = report?.lot?.clock?.absolute_day;
    if (day === undefined || !this.ctx.simStateCache.getSim(simId)) {
      return { ok: false, error: `no state report for sim ${simId}` };
    }
    if (!this.deps.intentions.hasList(simId, day)) {
      return { ok: false, error: `sim ${simId} has no list today (household Sims only, after their first report)` };
    }
    if (this.running) {
      return { ok: false, error: `a night call for ${this.simName(this.running)} is running` };
    }
    const busy = this.plumBusy();
    if (busy) {
      return { ok: false, error: busy };
    }
    const yesterday = this.deps.intentions.rowsForDay(simId, day - 1);
    const endingDay = yesterday.length > 0 ? day - 1 : day;
    const endingRows = yesterday.length > 0 ? yesterday : this.deps.intentions.rowsFor(simId);
    void this.run({ simId, endingDay, newDay: day, endingRows });
    return { ok: true, started: `night call for ${this.simName(simId)} (day ${endingDay} -> ${day})` };
  }
}
