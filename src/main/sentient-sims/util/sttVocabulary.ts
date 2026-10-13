// What the speech-to-text model is told about the names in play. Whisper-style
// endpoints (the Sentient Sims AI server, any OpenAI-compatible one) take a free-text
// prompt and treat it as a soft hint (buildTranscriptionPrompt in nameCorrection.ts, with
// the fuzzy post-pass that backs it up); ElevenLabs Scribe takes `keyterms`, a list of
// spellings it is biased toward in context, and needs no post-pass. Both come from the
// same vocabulary, built tightest scope first (the sims on the lot, then everyone they
// see, then everyone the household knows, then the save's participants) so what matters
// survives the caps.
import { isPlaceholderName } from './simAliases';
import { SIMS_WORLDS } from './nameCorrection';

export { SIMS_WORLDS };

// Scribe accepts up to 1000 keyterms, but a request carrying more than 100 is billed at
// a 20 s minimum and a spoken line is 3-5 s. Each term: under 50 chars, at most 5 words,
// none of < > { } [ ] \.
export const KEYTERMS_MAX = 100;
const KEYTERM_MAX_CHARS = 49;
const KEYTERM_MAX_WORDS = 5;
const KEYTERM_FORBIDDEN = /[<>{}[\]\\]/;

export type NameGroups = (string | null | undefined)[][];

// The Whisper hint, unchanged from before Scribe: one sentence of names, tightest scope first
export { buildTranscriptionPrompt } from './nameCorrection';

// The names in order, trimmed, placeholders ("Sim 1326...") dropped, deduped
// case-insensitively with the first spelling kept
function orderedNames(nameGroups: NameGroups): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  nameGroups.forEach((group) => {
    group.forEach((name) => {
      const trimmed = name?.trim();
      if (!trimmed || isPlaceholderName(trimmed)) {
        return;
      }
      const key = trimmed.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        ordered.push(trimmed);
      }
    });
  });
  return ordered;
}

function isValidKeyterm(term: string): boolean {
  return (
    term.length > 0 &&
    term.length <= KEYTERM_MAX_CHARS &&
    term.split(/\s+/).length <= KEYTERM_MAX_WORDS &&
    !KEYTERM_FORBIDDEN.test(term)
  );
}

// Sim names as the player says them: the full name ("Anker Solheim") and, right behind
// it, the first name ("Anker"), since the player mostly says the first name alone. Group
// order is kept so a later cap cuts the names least likely to be spoken.
export function nameTerms(nameGroups: NameGroups): string[] {
  const terms: string[] = [];
  orderedNames(nameGroups).forEach((name) => {
    terms.push(name);
    const first = name.split(/\s+/)[0];
    if (first !== name) {
      terms.push(first);
    }
  });
  return terms;
}

// The Scribe keyterm list: the given lists in order (names in play, then places, then
// the wider pool), each term checked against the API's limits, deduped
// case-insensitively, capped at KEYTERMS_MAX from the tail
export function keyterms(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  lists.forEach((list) => {
    list.forEach((raw) => {
      const term = raw.trim();
      const key = term.toLowerCase();
      if (terms.length < KEYTERMS_MAX && isValidKeyterm(term) && !seen.has(key)) {
        seen.add(key);
        terms.push(term);
      }
    });
  });
  return terms;
}

// What Whisper writes for silence or breath: subtitle credits and sign-offs it learned
// from captioned video (live: "Subs by www.zeoranger.co.uk" on a held key with nothing
// said). A line that is nothing but one of these was never spoken.
const SILENCE_HALLUCINATIONS: RegExp[] = [
  /^subs?\b.*\b(by|from)\b/i,
  /^subtitles?\b/i,
  /^(thank you|thanks)( so much)?( for watching)?[.!]?$/i,
  /^thank you for watching\b/i,
  /^(please )?(like|subscribe|share)\b.*\b(like|subscribe|share|channel|video)\b/i,
  /^see you (in the )?next (time|video)\b/i,
  /^(amara\.org|www\.)/i,
  /^\[?(music|applause|laughter|silence|blank_audio|inaudible)\]?$/i,
  /^\(.*\)$/,
];

export function isSilenceHallucination(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return true;
  }
  return SILENCE_HALLUCINATIONS.some((pattern) => pattern.test(trimmed));
}
