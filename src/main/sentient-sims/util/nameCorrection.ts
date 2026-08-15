// V-7: STT dictionary. Whisper hears "Lily" for Lillie, "Meika" for Mika, "Chapman" for
// Chatman (all observed live 08-04..08-14). Two layers: the transcription request carries
// a `prompt` of the names in play (a soft bias every OpenAI-compatible whisper honours or
// ignores silently), and a post-pass snaps near-miss tokens to known names.

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

// Snap tokens within a small edit distance of a known first/last name to that name.
// Conservative on purpose: never touch short tokens, never touch exact dictionary words
// (a token that IS a known name stays), and require the candidate to be clearly closest.
export function correctNames(transcript: string, knownNames: string[]): string {
  const vocabulary = new Map<string, string>(); // lowercase -> canonical
  knownNames.forEach((full) => {
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
    const spoken = phonetic(lowered);
    const allowed = spoken.length <= 4 ? 1 : spoken.length <= 7 ? 2 : 3;
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
