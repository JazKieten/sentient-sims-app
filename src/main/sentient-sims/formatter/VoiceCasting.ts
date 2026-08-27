import { SentientSim } from '../models/SentientSim';
import { VoiceType } from '../models/VoiceType';
import { getSimAliases } from '../util/simAliases';
import { castElevenLabsVoice } from './ElevenLabsVoiceCasting';
import { castKokoroVoice } from './KokoroVoiceCasting';
import { DialogueLine } from './PromptFormatter';

export function castVoiceForSim(sim: SentientSim, voiceType: VoiceType): string {
  return voiceType === VoiceType.Kokoro ? castKokoroVoice(sim) : castElevenLabsVoice(sim);
}

function findSimForSpeaker(speaker: string, sims: SentientSim[]): SentientSim | undefined {
  // A delivery label on the speaker ("Jasmine (to self)") never changes whose voice it is
  const speakerLower = speaker.replace(/\s*\([^)]*\)\s*$/, '').toLowerCase();
  const match = sims.find((sim) => {
    const nameLower = sim.name.toLowerCase();
    return nameLower === speakerLower || nameLower.startsWith(`${speakerLower} `);
  });
  if (match) {
    return match;
  }
  // Namelessly-reported sims (service NPCs): the scene knows "Sim 153...", but the model
  // labels the line with the character's real name ("Grim Reaper:") — the alias table
  // bridges the two so the pinned voice still applies
  const alias = getSimAliases().find((entry) => {
    const aliasLower = entry.name.toLowerCase();
    return aliasLower === speakerLower || aliasLower.startsWith(`${speakerLower} `);
  });
  return alias ? sims.find((sim) => sim.sim_id === alias.simId) : undefined;
}

/**
 * Attaches a voice of the given type to each dialogue line whose speaker matches one of
 * the sims in the scene: the voice the user pinned to that sim in the Sims tab if there
 * is one, otherwise a personality cast one. Lines with no matching sim (e.g. Narrator)
 * are left uncast and fall back to the user's configured voice.
 */
export function castVoicesForLines(
  lines: DialogueLine[],
  sims: SentientSim[],
  voiceType: VoiceType,
  voiceOverrides?: Map<string, string>,
): DialogueLine[] {
  return lines.map((line) => {
    const sim = findSimForSpeaker(line.speaker, sims);
    if (!sim) {
      return line;
    }
    // A line that arrives pre-cast (e.g. a Twitch chat question in the dedicated chat
    // voice) keeps its voice; pins and automatic casting only fill the gaps
    const voiceId = line.voiceId ?? voiceOverrides?.get(sim.sim_id) ?? castVoiceForSim(sim, voiceType);
    return voiceId ? { ...line, voiceId } : line;
  });
}
