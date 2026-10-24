// The day's vocabulary sampler (autonomy renovation R2, 2026-10-24; autonomy tier). A row may
// start only when a candidate is on a menu the Sim has actually seen, and at night (R3) the
// night call picks story rows from those menus, so once per Sim per game day per zone the app
// asks the mod for the menus that matter: the Sim's own, the household Sims who are awake and
// here, and the objects the Sim's pie rows need (a provider target: the mod finds the nearest
// object providing a candidate, as the click would). A sleeping target is never sampled (its
// menu is ~2 items). Everything the day's own vocabulary queries already filled is skipped.
//
// Budget (handoff R2.1): pie menus cost 60-800 ms of game thread each and the mod builds one
// target per game-thread task, so one sample is in flight at a time, at least 30 s apart.
import log from 'electron-log';
import type { AutonomyServices } from '../../tiers/autonomy';
import type { SimStateEntry, SimStateReport } from '../../models/SimStateReport';
import { speciesWord } from '../../util/alsoPresent';
import type { VocabularyAnswer } from './RowMemoryService';

export const SAMPLE_SPACING_MS = 30_000;
export const SAMPLE_TIMEOUT_MS = 30_000;
// Pie rows with no target whose candidates the sample looks for a provider of
export const SAMPLE_PROVIDER_ROWS = 3;
export const SAMPLE_MAX_TARGETS = 8;

export type SampleTarget =
  | { kind: 'self' }
  | { kind: 'sim'; sim_id: string }
  | { kind: 'provider'; candidates: string[] };

export type VocabularySamplerDeps = Partial<Pick<AutonomyServices, 'modQuery' | 'intentions' | 'rowMemory'>>;

function firstName(entry: SimStateEntry): string {
  return (entry.sim_name ?? '').trim().split(/\s+/)[0] || `sim ${entry.sim_id}`;
}

export class VocabularySampler {
  private readonly deps: VocabularySamplerDeps;

  // `${simId}|${day}|${zone}` sampled (or found nothing to sample)
  private readonly done = new Set<string>();

  private inFlight: string | undefined;

  private lastStartAt = 0;

  private unsupported = false;

  constructor(deps: VocabularySamplerDeps) {
    this.deps = deps;
  }

  get busy(): string | undefined {
    return this.inFlight;
  }

  // From the state report, after the row lane: start at most one sample
  tick(entries: SimStateEntry[], report: SimStateReport, now = Date.now()) {
    const { modQuery, intentions, rowMemory } = this.deps;
    const day = report.lot?.clock?.absolute_day;
    const zoneRaw = report.lot?.zone_id;
    if (!modQuery || !intentions || !rowMemory || this.unsupported || this.inFlight) {
      return;
    }
    if (day === undefined || zoneRaw === undefined || now - this.lastStartAt < SAMPLE_SPACING_MS) {
      return;
    }
    const zone = String(zoneRaw);
    for (const entry of entries) {
      const key = `${entry.sim_id}|${day}|${zone}`;
      if (!entry.sim_id || entry.is_household === false || this.done.has(key) || !VocabularySampler.awake(entry)) {
        continue;
      }
      const targets = this.targetsFor(entry, report, day, zone);
      this.done.add(key);
      if (targets.length > 0) {
        this.start(entry, targets, report, now);
        return;
      }
    }
  }

  private static awake(entry: SimStateEntry): boolean {
    return entry.self?.asleep !== true && entry.self?.on_active_lot !== false && entry.self?.in_ww_scene !== true;
  }

  targetsFor(entry: SimStateEntry, report: SimStateReport, day: number, zone: string): SampleTarget[] {
    const { intentions, rowMemory } = this.deps;
    if (!intentions || !rowMemory) {
      return [];
    }
    const view = rowMemory.vocabularyView(entry.sim_id, day, zone);
    const targets: SampleTarget[] = [];
    if (!view.targets.has('self')) {
      targets.push({ kind: 'self' });
    }
    const present = new Set(entry.sims.map((sim) => sim.sim_id));
    const awakeHere = (report.sims ?? []).filter(
      (sim) =>
        sim.sim_id &&
        sim.sim_id !== entry.sim_id &&
        speciesWord(sim.self?.species) === undefined &&
        VocabularySampler.awake(sim) &&
        present.has(sim.sim_id),
    );
    const wanted = new Set<string>();
    awakeHere.filter((sim) => sim.is_household !== false).forEach((sim) => wanted.add(sim.sim_id));
    const live = intentions
      .rowsFor(entry.sim_id)
      .filter((row) => (row.status === 'waiting' || row.status === 'asleep') && row.what.kind === 'pie');
    // A row's own target, household or not, when they are here and awake
    live.forEach((row) => {
      if (row.target && awakeHere.some((sim) => sim.sim_id === row.target?.sim_id)) {
        wanted.add(row.target.sim_id);
      }
    });
    wanted.forEach((simId) => {
      if (!view.targets.has(`sim:${simId}`)) {
        targets.push({ kind: 'sim', sim_id: simId });
      }
    });
    const seen = (candidate: string) =>
      view.checked.has(candidate) ||
      [...view.targets.values()].some((menu) => menu.keys.has(candidate) || menu.supers.has(candidate));
    live
      .filter((row) => !row.target && row.what.kind === 'pie')
      .map((row) => (row.what.kind === 'pie' ? row.what.candidates : []))
      .filter((candidates) => candidates.length > 0 && !candidates.some(seen))
      .slice(0, SAMPLE_PROVIDER_ROWS)
      .forEach((candidates) => targets.push({ kind: 'provider', candidates: [...candidates] }));
    return targets.slice(0, SAMPLE_MAX_TARGETS);
  }

  private start(entry: SimStateEntry, targets: SampleTarget[], report: SimStateReport, now: number) {
    const { modQuery, rowMemory } = this.deps;
    if (!modQuery || !rowMemory) {
      return;
    }
    this.inFlight = entry.sim_id;
    this.lastStartAt = now;
    const name = firstName(entry);
    void modQuery
      .query<VocabularyAnswer & { ms?: number }>(
        'vocabulary',
        { sim_id: entry.sim_id, sample: { targets } },
        SAMPLE_TIMEOUT_MS,
      )
      .then((answer) => {
        if (!answer.ok) {
          if (/unknown kind/i.test(answer.error)) {
            this.unsupported = true;
          }
          log.info(`[Rows] sampling ${name}'s menus failed: ${answer.error}`);
          return false;
        }
        rowMemory.recordVocabulary(entry.sim_id, answer.result, report);
        log.info(
          `[Rows] sampled ${name}'s menus: ${answer.result.rows?.length ?? 0} rows over ${targets.length} ` +
            `targets (${targets.map((target) => target.kind).join(', ')}) in ${answer.result.ms ?? '?'} ms`,
        );
        return true;
      })
      .catch((error: unknown) => {
        log.warn(`[Rows] sampling ${name}'s menus crashed`, error);
      })
      .finally(() => {
        this.inFlight = undefined;
      });
  }

  onModDisconnected() {
    this.unsupported = false;
  }

  onDatabaseLoaded() {
    this.done.clear();
    this.lastStartAt = 0;
  }
}
