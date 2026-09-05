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
// doubled letters collapse, y/ie -> i, ph -> f, ck -> k, silent-w wr -> r ("Wren" is
// heard as "Ren"/"Rin", live 08-27)
export function phonetic(text: string): string {
  return text
    .toLowerCase()
    .replace(/wr/g, 'r')
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
   wont work would wow whoa yeah yep yes yet you your
   actually alright already always another answer anyone anything around away awesome
   basically better bring calm careful check chill dear easy either enough everyone everything
   excuse follow forget forgive found gone guys happy hear heard hold honestly hurry idea
   inside instead later leave listen maybe mind minute moment morning night nobody nothing
   nowhere obviously outside perfect perhaps probably quick quiet ready remember seriously
   simply someone something somewhere sounds speak start thanks though today tonight totally
   trust truly until upstairs whatever whenever wherever whether whose yours yourself`.split(/\s+/),
);

// Snap tokens within a small edit distance of a known first/last name to that name.
// Conservative on purpose: never touch common speech, never touch exact dictionary words
// (a token that IS a known name stays), and require the candidate to be clearly closest.
//
// The pool is deliberately WIDE (participants included): players pause the game to talk,
// and while paused the state report carries no sims — a scene-scoped pool went empty at
// exactly the moment it was needed (live 08-27: "Margot" stayed uncorrected). The
// wrong-name snaps that motivated scoping were sentence-initial fillers, and the
// COMMON_WORDS guard handles those directly.
// Tie-breaks (J7, Jaz's 09-04 handoff, cause 7): "Rin" is phonetic distance 1 from BOTH
// Wren ("ren") and Rainn ("rain"), so the clearly-closest rule let it through uncorrected
// and the sims copied the misspelling into memory. Three keys settle a phonetic tie
// before giving up: same phonetic length as what was heard (a vowel swap, not a dropped
// syllable), then the raw spelling, then presence on the lot (the caller passes the names
// in play). A tie that survives all three stays untouched.
export function correctNames(transcript: string, knownNames: string[], onLotNames: string[] = []): string {
  const vocabulary = new Map<string, string>(); // lowercase -> canonical
  knownNames.forEach((full) => {
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
  const onLot = new Set<string>();
  onLotNames.forEach((full) => {
    full
      .split(/\s+/)
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part.length >= 3)
      .forEach((part) => onLot.add(part));
  });
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
    const allowed = spoken.length <= 4 ? 1 : spoken.length <= 7 ? 2 : 3;
    const best = closestName(lowered, spoken, canonical, onLot);
    if (best && best.distance <= allowed) {
      const possessive = /[’']s$/.test(token) ? token.slice(-2) : '';
      return `${best.name}${possessive}`;
    }
    return token;
  });
}

// The single closest candidate by phonetic distance, with the J7 tie-breaks; undefined
// when the phonetic tie cannot be settled (never guess between two equal names).
function closestName(
  lowered: string,
  spoken: string,
  canonical: string[],
  onLot: Set<string>,
): { name: string; distance: number } | undefined {
  let bestDistance = Number.POSITIVE_INFINITY;
  let tied: string[] = [];
  canonical.forEach((name) => {
    const distance = levenshtein(spoken, phonetic(name));
    if (distance < bestDistance) {
      bestDistance = distance;
      tied = [name];
    } else if (distance === bestDistance) {
      tied.push(name);
    }
  });
  if (tied.length === 0) {
    return undefined;
  }
  if (tied.length > 1) {
    // A substitution beats an insertion: "rin" heard for "ren" (Wren) is one vowel off,
    // "rin" for "rain" (Rainn) is a syllable short, and Whisper mishears vowels far more
    // often than it drops them. Keep the candidates whose phonetic length matches.
    const sameLength = tied.filter((name) => phonetic(name).length === spoken.length);
    if (sameLength.length > 0) {
      tied = sameLength;
    }
  }
  if (tied.length > 1) {
    // Then raw spelling: the phonetic layer threw away letters that may tell the names apart
    let rawBest = Number.POSITIVE_INFINITY;
    let rawTied: string[] = [];
    tied.forEach((name) => {
      const raw = levenshtein(lowered, name.toLowerCase());
      if (raw < rawBest) {
        rawBest = raw;
        rawTied = [name];
      } else if (raw === rawBest) {
        rawTied.push(name);
      }
    });
    tied = rawTied;
  }
  if (tied.length > 1) {
    // Then whoever is actually here
    const present = tied.filter((name) => onLot.has(name.toLowerCase()));
    if (present.length === 1) {
      tied = present;
    }
  }
  return tied.length === 1 ? { name: tied[0], distance: bestDistance } : undefined;
}
