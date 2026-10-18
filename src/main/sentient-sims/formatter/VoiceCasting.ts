import { SentientSim } from '../models/SentientSim';
import { VoiceType } from '../models/VoiceType';
import { getSimAliases } from '../util/simAliases';
import { moodDeliveryTag } from '../util/moodDeliveryTags';
import { castElevenLabsVoice } from './ElevenLabsVoiceCasting';
import { castKokoroVoice } from './KokoroVoiceCasting';
import { DialogueLine } from './PromptFormatter';

export function castVoiceForSim(sim: SentientSim, voiceType: VoiceType): string {
  return voiceType === VoiceType.Kokoro ? castKokoroVoice(sim) : castElevenLabsVoice(sim);
}

export function findSimForSpeaker(speaker: string, sims: SentientSim[]): SentientSim | undefined {
  // A delivery label on the speaker ("Jasmine (to self)") never changes whose voice it is
  const speakerLower = speaker.replace(/\s*\([^)]*\)\s*$/, '').toLowerCase();
  // Exact full-name match beats first-name prefix, and an AMBIGUOUS prefix match casts
  // nobody rather than first-in-list: "Lillie:" in a scene holding two Lillies used to
  // bind whichever appeared first (live 2026-08-26, finding #4). Uncast falls back to
  // the configured default voice, which is the safe failure.
  const exact = sims.filter((sim) => sim.name.toLowerCase() === speakerLower);
  if (exact.length === 1) {
    return exact[0];
  }
  if (exact.length === 0) {
    const prefixMatches = sims.filter((sim) => sim.name.toLowerCase().startsWith(`${speakerLower} `));
    if (prefixMatches.length === 1) {
      return prefixMatches[0];
    }
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A sim's name and the IPA the voice should read for it ("Halley Calloway", "ˈhæl.i")
export type NamePronunciation = { name: string; ipa: string };

// Eleven v4 reads an inline IPA spelling between slashes in place of the word. Measured
// 2026-10-12 with Scribe listening back: "/ˈhæl.i/" read hah-lee on every voice tried,
// while plain "Halley" read hay-lee on some, so the stored IPA goes through untouched
export function inlinePronunciation(ipa: string): string {
  return `/${ipa.trim().replace(/^\/+|\/+$/g, '')}/`;
}

/**
 * Replaces every pronounced sim's full name and first name in what the voice READS with
 * the stored IPA (v4 only; the caller decides). Not scoped to the scene's cast: a name
 * is read by whoever says it, and Anker talking ABOUT Halley read hers wrong because she
 * was not in his scene (live 2026-10-12). The subtitle text is untouched: `text` stays
 * the written name, `ttsText` carries the phonetic one. Longer names go first so
 * "Lillie Cason" is not half-replaced by "Lillie".
 */
export function applyPronunciations(lines: DialogueLine[], pronunciations: NamePronunciation[]): DialogueLine[] {
  const replacements = pronunciations
    .filter((entry) => entry.name.trim() && entry.ipa.trim())
    .flatMap((entry) => {
      const ipa = inlinePronunciation(entry.ipa);
      const full = entry.name.trim();
      return [...new Set([full, full.split(/\s+/)[0]])].map((name) => ({ name, ipa }));
    })
    .sort((a, b) => b.name.length - a.name.length);
  if (replacements.length === 0) {
    return lines;
  }

  return lines.map((line) => {
    let spoken = line.ttsText ?? line.text;
    replacements.forEach(({ name, ipa }) => {
      // Word boundaries so "Al" never rewrites "Also"; names with apostrophes keep working
      spoken = spoken.replace(
        new RegExp(`(^|[^\\p{L}\\p{N}'’])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'gu'),
        `$1${ipa}`,
      );
    });
    return spoken === (line.ttsText ?? line.text) ? line : { ...line, ttsText: spoken };
  });
}

/**
 * Gives each line whose speaker resolves to a sim in a tagged mood a delivery note for
 * that mood, unless the line already carries one (the classic screenplay path lets the
 * LLM write `(nervous)` and that wins). Only v3/v4 turn the note into an audio tag
 * (elevenLabsLineText); every other model and provider ignores it.
 */
export function attachMoodDeliveryNotes(lines: DialogueLine[], sims: SentientSim[]): DialogueLine[] {
  return lines.map((line) => {
    if (line.deliveryNote) {
      return line;
    }
    const sim = findSimForSpeaker(line.speaker, sims);
    const tag = sim ? moodDeliveryTag(sim.moods) : undefined;
    return tag ? { ...line, deliveryNote: tag } : line;
  });
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
