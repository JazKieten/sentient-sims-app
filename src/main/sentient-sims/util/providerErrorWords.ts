// A provider's error says what went wrong in its own terms ("404 No endpoints found that
// support image input", "401 Incorrect API key provided"). The player gets what it means and
// where to fix it; the raw text stays in main.log.

export type PlainProviderError = {
  plain: string;
  raw: string;
  // The fix is in Settings (a key, a model, a provider choice)
  inSettings: boolean;
};

export const SIGN_IN_TIMED_OUT =
  'Your Sentient Sims sign-in timed out. Close the app, open it again and sign in, then try again.';

const SIGN_IN_EXPIRED = /token has invalid claims|token is expired|sign-in timed out/i;

// Messages the app writes itself are already plain and pass through as they are
const ALREADY_PLAIN = /maintenance mode|No AI workers available|Must be a Founder or Patron|Upgrade on Patreon/i;

const KEY_REFUSED =
  /\b401\b|invalid api key|incorrect api key|invalid_api_key|api key not valid|unauthori[sz]ed|no .*key.* set/i;

// First match wins: the narrow cases come before the status codes they share (an image-input
// 404 before model-not-found, an exhausted quota before a plain 429, Gemini's disabled API
// before a plain 403)
const RULES: Array<[RegExp, string, boolean]> = [
  [SIGN_IN_EXPIRED, SIGN_IN_TIMED_OUT, false],
  [
    /image input|support(?:s|ing)? images?|vision is not supported|image_url/i,
    "The model you picked can't look at pictures. Pick one that can in Settings > AI Model.",
    true,
  ],
  [
    /has not been used in project|SERVICE_DISABLED|API has not been enabled/i,
    'The Gemini API is not switched on for your Google project yet. Turn on the Generative Language API in Google Cloud, then try again.',
    false,
  ],
  [
    /exceeded your current quota|insufficient_quota|insufficient credits|\b402\b|billing|out of credits/i,
    'Your AI account is out of credits or needs billing set up. Top it up with the provider, or pick another AI in Settings.',
    true,
  ],
  [
    KEY_REFUSED,
    "The AI provider didn't accept your API key. Check the key in Settings > Advanced > API Keys and Connections.",
    true,
  ],
  [
    /\b403\b|permission denied|forbidden/i,
    'The AI provider refused the request. Your key may not have access to this model; check it in Settings > Advanced > API Keys and Connections.',
    true,
  ],
  [
    /\b429\b|rate limit|too many requests|resource_exhausted/i,
    'The AI provider is getting too many requests right now. It usually clears up in a minute.',
    false,
  ],
  [
    /no endpoints found|model .*(?:not found|does not exist)|unknown model|\b404\b/i,
    "The AI provider doesn't have the model you picked. Pick another model in Settings > AI Model.",
    true,
  ],
  [
    /timed? ?out|ETIMEDOUT|ESOCKETTIMEDOUT|deadline exceeded/i,
    'The AI provider took too long to answer. Try again in a moment.',
    false,
  ],
  [
    /ECONNREFUSED/,
    "Couldn't reach the AI server. If you run your own (KoboldAI, VLLM), make sure it is started.",
    false,
  ],
  [
    /ENOTFOUND|EAI_AGAIN|getaddrinfo|network error/i,
    "Couldn't reach the AI provider. Check your internet connection.",
    false,
  ],
  [
    /\b50[0-4]\b|internal server error|bad gateway|service unavailable|overloaded/i,
    'The AI provider is having trouble on its end. Try again in a moment.',
    false,
  ],
];

export function plainProviderError(raw: string): PlainProviderError {
  const rule = RULES.find(([pattern]) => pattern.test(raw));
  if (!rule) {
    return { plain: 'The AI provider returned an error.', raw, inSettings: false };
  }
  return { plain: rule[1], raw, inSettings: rule[2] };
}

// The plain sentence for an error a rule knows, else undefined
export function knownPlainError(raw: string): string | undefined {
  if (ALREADY_PLAIN.test(raw)) {
    return raw;
  }
  return RULES.find(([pattern]) => pattern.test(raw))?.[1];
}

// Sentient Sims AI is reached with the player's sign-in, never a key, so a refusal there
// means the sign-in timed out
export function plainSentientSimsError(raw: string): string {
  if (/\b401\b|unauthori[sz]ed/i.test(raw)) {
    return SIGN_IN_TIMED_OUT;
  }
  return knownPlainError(raw) ?? 'The Sentient Sims AI server returned an error. Try again in a minute.';
}

// A key test answers about the key the player just typed, so a refused key says so plainly.
// The raw text can echo the key back, so it never reaches the page.
export function plainKeyTestError(raw: string): string {
  if (KEY_REFUSED.test(raw)) {
    return "That key didn't work. Check that you copied all of it.";
  }
  return plainProviderError(raw).plain;
}
