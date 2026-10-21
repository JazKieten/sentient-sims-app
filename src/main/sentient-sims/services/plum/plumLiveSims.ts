// The Sims in Plum's <live> block (sprint plan 2026-10-17 section 2, roadmap C2). Built from
// the 5 s state report the mod already sends (no mod change): one line per household Sim on
// the lot, ~40 tokens each, so a director tick knows the cast without a look_at_lot (36 such
// calls a day on 2026-10-17, most of them to learn who was awake), and the non-household Sims
// as a count plus names. look_at_lot stays the full picture (objects, relationships, needs).
import type { SimStateEntry, SimStateReport } from '../../models/SimStateReport';
import { isAsleep } from '../../util/simSleep';

// A need is worth a word only below this: the band the cognition tick interrupts a busy
// Sim for (CognitionService NEED_URGENT_INTERRUPT)
export const LOW_NEED = -25;
export const WANTS_SHOWN = 3;
const OTHERS_NAMED = 8;

export type LiveSims = { sims: string[]; others?: string };

function pretty(text: string): string {
  return text.replace(/_/g, ' ');
}

function nameOf(sim: SimStateEntry): string {
  return sim.sim_name?.trim() || `sim ${sim.sim_id}`;
}

// What the Sim is doing: the whitelist verb when the mod mapped one, else "doing", with the
// running interaction's tuning name in parentheses (the key a wake_me `doing` can match)
function activityOf(sim: SimStateEntry): string {
  const running = sim.activity?.running;
  if (!running) {
    return 'idle';
  }
  const verb = sim.activity?.running_action_key
    ? pretty(sim.activity.running_action_key)
    : sim.activity?.in_social
      ? 'socialising'
      : 'doing';
  return `${verb} (${running})`;
}

// "- Corinne Stiles (sim 123, ACTIVE): awake, cook meal (counter_MakeFood_...), tense; low:
// hunger -40; wants: play chess, tell a joke" / "- Duane Miles (sim 456): asleep (bed_sleep)"
export function describeSim(sim: SimStateEntry, active: boolean): string {
  const head = `${nameOf(sim)} (sim ${sim.sim_id}${active ? ', ACTIVE' : ''})`;
  const parts: string[] = [];
  if (isAsleep(sim)) {
    parts.push(sim.activity?.running ? `asleep (${sim.activity.running})` : 'asleep');
  } else {
    parts.push(`awake, ${activityOf(sim)}`);
  }
  if (sim.self?.mood) {
    parts.push(pretty(sim.self.mood));
  }
  const clauses = [parts.join(', ')];
  const low = Object.entries(sim.self?.needs ?? {})
    .filter(([, value]) => typeof value === 'number' && value < LOW_NEED)
    .sort(([, a], [, b]) => a - b)
    .map(([need, value]) => `${pretty(need)} ${Math.round(value)}`);
  if (low.length > 0) {
    clauses.push(`low: ${low.join(', ')}`);
  }
  const wants = (sim.self?.wants ?? []).slice(0, WANTS_SHOWN).map(pretty);
  if (wants.length > 0) {
    clauses.push(`wants: ${wants.join(', ')}`);
  }
  return `${head}: ${clauses.join('; ')}`;
}

// The section's lines from a report: the household one line each, everyone else one line
export function describeLiveSims(report: SimStateReport | undefined): LiveSims {
  const all = report?.sims ?? [];
  const household = all.filter((sim) => sim.is_household !== false);
  const visitors = all.filter((sim) => sim.is_household === false);
  const activeId = report?.active_sim_id;
  const sims = household.map((sim) =>
    describeSim(sim, sim.sim_id === activeId || (!activeId && sim.is_active === true)),
  );
  if (visitors.length === 0) {
    return { sims };
  }
  const names = visitors.slice(0, OTHERS_NAMED).map(nameOf);
  const more = visitors.length > names.length ? `, +${visitors.length - names.length} more` : '';
  return { sims, others: `${visitors.length} (${names.join(', ')}${more})` };
}
