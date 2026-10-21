// Is this Sim asleep, as the state report tells it. Core (Plum's <live> block and the
// director both read it; CognitionService re-exports it for the autonomy tier).
//
// The game reports a sleeping Sim three ways and older mod builds send fewer of them: the
// game's own sim.sleeping flag (`self.asleep`, the reliable read), the whitelist key the mod
// mapped the running interaction to (`running_action_key` sleep / nap), and as the last
// resort the running interaction's tuning name. The name match alone never caught a Sim in
// bed (live 2026-09-21: `sleep_Passive` over `bed_sleep`), hence the three reads.
import type { SimStateEntry } from '../models/SimStateReport';

const SLEEP_ACTION_KEYS = new Set(['sleep', 'nap']);
const SLEEP_INTERACTION_NAME = /(^|[_\s])(sleep|sleeping|nap|napping)([_\s]|$)|energyfailure|passout|pass_out/i;

export function isAsleep(entry: SimStateEntry): boolean {
  if (entry.self?.asleep) {
    return true;
  }
  const key = entry.activity?.running_action_key;
  if (key && SLEEP_ACTION_KEYS.has(key)) {
    return true;
  }
  const running = entry.activity?.running ?? '';
  return running.length > 0 && SLEEP_INTERACTION_NAME.test(running);
}
