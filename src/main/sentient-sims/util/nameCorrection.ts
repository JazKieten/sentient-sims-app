// V-7: STT dictionary. Whisper hears "Lily" for Lillie, "Meika" for Mika, "Chapman" for
// Chatman (all observed live 08-04..08-14). Two layers: the transcription request carries
// a `prompt` of the names in play (a soft bias every OpenAI-compatible whisper honours or
// ignores silently), and a post-pass snaps near-miss tokens to known names.
import { isPlaceholderName } from './simAliases';

export function levenshtein(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }
  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) {
    previous[j] = j;
  }
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

// Whisper truncates the prompt at ~224 tokens; keep the hint short and name-dense
const PROMPT_MAX_CHARS = 700;

// Names go in tightest-scope-first order so the on-lot sims survive truncation
export function buildTranscriptionPrompt(nameGroups: string[][]): string | undefined {
  const seen = new Set<string>();
  const ordered: string[] = [];
  nameGroups.forEach((group) => {
    group.forEach((name) => {
      const trimmed = (name ?? '').trim();
      if (trimmed && !seen.has(trimmed.toLowerCase())) {
        seen.add(trimmed.toLowerCase());
        ordered.push(trimmed);
      }
    });
  });
  if (ordered.length === 0) {
    return undefined;
  }
  let prompt = `Names in this scene: ${ordered.join(', ')}.`;
  while (prompt.length > PROMPT_MAX_CHARS && ordered.length > 1) {
    ordered.pop();
    prompt = `Names in this scene: ${ordered.join(', ')}.`;
  }
  return prompt;
}

// Loose phonetic normalization so "Lily" and "Lillie" (or "Meika"/"Mika") compare close:
// doubled letters collapse, y/ie -> i, ph -> f, ck -> k
export function phonetic(text: string): string {
  return text
    .toLowerCase()
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/ie\b/g, 'i')
    .replace(/y/g, 'i')
    .replace(/(.)\1+/g, '$1');
}

// Everyday speech a sentence starts with, which capitalization alone cannot tell from a
// name. Live 08-27 the player's "Well,"/"Kay"/"Hey" became Wells/Kai/Huy and the sims were
// addressed by the wrong name. A word in here is never FUZZY-matched; an exact vocabulary
// hit still wins first, so a sim actually named Will or Grace is untouched.
const COMMON_WORDS = new Set(
  `about after again all also and any anyway are ask back bad because been before being both boy
   but bye call came can cant come cool could damn day did does doing done dont down dude each
   even ever every eyes face fine first for from game geez get give going gonna good gosh got
   gotta great guess had has hate have hay heck hell hello help her here hey him his hmm home
   hope how huh its just kay keep kind know less let lets like listen little look lot love made
   make man many may maybe mean more most much must nah need never new next nice nope not now off
   okay old once one only ooh other our out over own play please put really right said same say
   see she should sim sims some sorry stay still stop sure take talk tell than thank thanks that
   the their them then there these they thing think this those time too two umm use used very
   wait walk want wanna was watch way well were what when where which while who why will with
   wont work would wow whoa yeah yep yes yet you your`.split(/\s+/),
);

// Snap tokens within a small edit distance of a known first/last name to that name.
// Conservative on purpose: never touch common speech, never touch exact dictionary words
// (a token that IS a known name stays), and require the candidate to be clearly closest.
//
// `sceneNames` MUST be scene-scoped (sims on the lot / in the room). The wide pools —
// every sim the household has ever met, the whole participant table — belong in the
// transcription prompt (buildTranscriptionPrompt), not here: fuzzy-matching against 100+
// half-forgotten townies is what produced the wrong-name snaps live 08-27.
export function correctNames(transcript: string, sceneNames: string[]): string {
  const vocabulary = new Map<string, string>(); // lowercase -> canonical
  sceneNames.forEach((full) => {
    if (isPlaceholderName(full)) {
      // "Sim 153" would otherwise contribute "Sim" as a name candidate
      return;
    }
    (full ?? '')
      .split(/\s+/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 3)
      .forEach((part) => {
        vocabulary.set(part.toLowerCase(), part);
      });
  });
  if (vocabulary.size === 0 || !transcript) {
    return transcript;
  }
  const canonical = [...vocabulary.values()];
  return transcript.replace(/[A-Za-z][A-Za-z'’-]{2,}/g, (token) => {
    const lowered = token.toLowerCase().replace(/[’']s$/, '');
    if (vocabulary.has(lowered)) {
      return token;
    }
    // Only capitalized tokens are name candidates; a lowercase word is prose
    if (token[0] !== token[0].toUpperCase()) {
      return token;
    }
    // Sentence-initial capitalization is indistinguishable from a name, so everyday
    // speech needs its own guard
    if (COMMON_WORDS.has(lowered)) {
      return token;
    }
    const spoken = phonetic(lowered);
    // A three-letter token is one edit from half the world; require an exact phonetic hit
    const allowed = spoken.length <= 3 ? 0 : spoken.length <= 4 ? 1 : spoken.length <= 7 ? 2 : 3;
    let best: string | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    let secondBest = Number.POSITIVE_INFINITY;
    canonical.forEach((name) => {
      const distance = levenshtein(spoken, phonetic(name));
      if (distance < bestDistance) {
        secondBest = bestDistance;
        bestDistance = distance;
        best = name;
      } else if (distance < secondBest) {
        secondBest = distance;
      }
    });
    if (best && bestDistance <= allowed && bestDistance < secondBest) {
      const possessive = /[’']s$/.test(token) ? token.slice(-2) : '';
      return `${best}${possessive}`;
    }
    return token;
  });
}
