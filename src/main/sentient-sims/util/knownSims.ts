import { SentientSim } from '../models/SentientSim';

// The last full SentientSim the game sent for each sim id. Voice casting needs gender, age
// and traits, which the state report does not carry, so a line voiced outside a game event
// (a Plum whisper's thought) finds its speaker here instead of falling to the default voice.
const MAX_KNOWN_SIMS = 500;

const knownSims = new Map<string, SentientSim>();

export function rememberSims(sims: SentientSim[]) {
  sims.forEach((sim) => {
    if (!sim.sim_id || !sim.name) {
      return;
    }
    knownSims.delete(sim.sim_id);
    knownSims.set(sim.sim_id, sim);
  });
  while (knownSims.size > MAX_KNOWN_SIMS) {
    const oldest = knownSims.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    knownSims.delete(oldest);
  }
}

export function knownSim(simId: string): SentientSim | undefined {
  return knownSims.get(simId);
}

export function clearKnownSims() {
  knownSims.clear();
}
