// Twitch !ask sim targeting: "!ask lillie how are you" aims the question at Lillie even
// when she is not the active sim. Pure functions — the resolver fuzzy-matches the leading
// word(s) of the question against the live household roster (reusing the voice feature's
// phonetic matching, so "lilly" hits Lillie), and the builders fabricate the one-sim chat
// event that rides AIService.runDirectedGeneration's solo player-voice branch.
import { SSEventType, ChatInteractionEvent } from '../models/InteractionEvents';
import { SentientSim } from '../models/SentientSim';
import { SimAge } from '../models/SimAge';
import { levenshtein, phonetic } from './nameCorrection';

export type SimTargetCandidate = {
  simId: string;
  name: string;
  isActive?: boolean;
};

export type SimTargetResolution = {
  simId: string;
  name: string;
  // The question with the sim's name removed
  question: string;
};

function matchesName(word: string, namePart: string): boolean {
  const wordLower = word.toLowerCase();
  const partLower = namePart.toLowerCase();
  if (wordLower === partLower) {
    return true;
  }
  // Fuzzy only for longer tokens so words like "how" can never snap to a short name
  if (wordLower.length < 3 || partLower.length < 3) {
    return false;
  }
  const spoken = phonetic(wordLower);
  const allowed = spoken.length <= 4 ? 1 : 2;
  return levenshtein(spoken, phonetic(partLower)) <= allowed;
}

// Leading "<first name> <question>" or "<first> <last> <question>". Returns undefined when
// the first word is not clearly one sim's name (no match, ambiguous match, or nothing left
// over to ask) — the caller then falls back to the active sim.
export function resolveSimTarget(question: string, candidates: SimTargetCandidate[]): SimTargetResolution | undefined {
  const words = question.trim().split(/\s+/);
  if (words.length < 2 || candidates.length === 0) {
    return undefined;
  }

  // Full-name match first ("lillie smith how are you") so siblings never collide
  if (words.length >= 3) {
    const twoWords = `${words[0]} ${words[1]}`;
    const fullMatches = candidates.filter((candidate) => candidate.name.toLowerCase() === twoWords.toLowerCase());
    if (fullMatches.length === 1) {
      return { simId: fullMatches[0].simId, name: fullMatches[0].name, question: words.slice(2).join(' ') };
    }
  }

  const firstWord = words[0];
  const matches = candidates.filter((candidate) => {
    const firstName = candidate.name.trim().split(/\s+/)[0] ?? '';
    return matchesName(firstWord, firstName);
  });
  if (matches.length !== 1) {
    return undefined;
  }
  return { simId: matches[0].simId, name: matches[0].name, question: words.slice(1).join(' ') };
}

// The fabricated target rides the same shape the scenario tester proves works without the
// game building the event. Traits/moods/age/gender are not in the live state report, so
// they stay neutral — the sim's stored description and memories carry the personality.
export function buildAskSentientSim(input: {
  simId: string;
  name: string;
  description?: string;
  isActive?: boolean;
}): SentientSim {
  return {
    name: input.name,
    age: SimAge.ADULT,
    sim_id: input.simId,
    gender: '',
    description: input.description,
    traits: [],
    moods: [],
    careers: [],
    is_ghost: false,
    grubby: false,
    in_pool: false,
    is_at_home: true,
    is_dying: false,
    is_human: true,
    is_inside_building: false,
    is_outside: false,
    is_pet: false,
    on_fire: false,
    on_home_lot: true,
    sleeping: false,
    is_pregnant: false,
    is_player_sim: input.isActive ?? false,
  };
}

export function buildTwitchAskEvent(sim: SentientSim, question: string, locationId: number): ChatInteractionEvent {
  return {
    event_id: crypto.randomUUID(),
    event_type: SSEventType.CHAT,
    location_id: locationId,
    environment: {
      location_id: locationId,
      world_id: 0,
      time: { second: 0, minute: 0, hour: 12, day: 0, week: 0 },
    },
    sentient_sims: [sim],
    action: question,
  };
}

// Single word on purpose: the mod's memories window titles sections with the FIRST word of
// the row's speaker prefix ("The Voice: ..." renders a section called "The"), so "Chat"
// gives viewers' questions their own correctly-named section with no mod change.
export const TWITCH_CHAT_SPEAKER = 'Chat';
// What the sim is told is speaking to them (rides DirectedGenerationOptions.playerLineFlavor)
export const TWITCH_CHAT_FLAVOR = 'a friendly, curious crowd watching their life that only they can hear';
