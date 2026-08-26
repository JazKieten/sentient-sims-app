// Display aliases for sims the game reports namelessly (service NPCs like the Grim
// Reaper, reported as "Sim <id>"). Fed from the Twitch "Extra targets" setting by
// TwitchChatService; read by voice casting so a line the model labels "Grim Reaper:"
// still finds the placeholder-named sim's pinned voice.
export type SimAlias = { name: string; simId: string };

let aliases: SimAlias[] = [];

export function setSimAliases(next: SimAlias[]) {
  aliases = next;
}

export function getSimAliases(): SimAlias[] {
  return aliases;
}

// Replace placeholder names ("Sim 153...", or empty) with the alias name on a scene's
// cast, so prompts, dialogue labels, and memory rows use the real character name and the
// other sims stop addressing the Grim Reaper as "Sim". Real names are never overwritten.
export function applySimAliasNames<T extends { sim_id: string; name: string }>(sims: T[]): T[] {
  if (aliases.length === 0) {
    return sims;
  }
  return sims.map((sim) => {
    const placeholder = sim.name.trim() === '' || /^Sim \d+$/i.test(sim.name.trim());
    if (!placeholder) {
      return sim;
    }
    const alias = aliases.find((entry) => entry.simId === sim.sim_id);
    return alias ? { ...sim, name: alias.name } : sim;
  });
}
