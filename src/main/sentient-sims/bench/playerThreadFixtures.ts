// Five player-facing conversations from the 2026-09-19..21 stream logs, kept as fixtures
// for the player-thread bench (POST /bench/player-thread/:index). Each one is a real
// exchange that deserved a straight answer and an ending and got neither: the replies
// ran ten words each, dodged the question, and the thread never closed. `original` is
// what aired; `target` is the sketch of what a satisfying run reads like, for judging a
// replay by eye. The bench replays `lines` through the same path the chat window, the
// voice and Twitch use, with the sim's real state from the loaded save.

export type PlayerThreadFixture = {
  id: string;
  title: string;
  // 'Chat' rides the Twitch flavor; anything else is the player's configured persona
  speaker: 'Chat' | 'Conscience';
  simName: string;
  lines: string[];
  original: string[];
  target: string;
};

export const PLAYER_THREAD_FIXTURES: PlayerThreadFixture[] = [
  {
    id: 'jake-break-up',
    title: 'Conscience asks Jake whether it is time to break up with Lillie',
    speaker: 'Conscience',
    simName: 'Jake Flores',
    lines: [
      "Do you think it's time to break up with Lillie?",
      "I'm asking you if you think you should break up with Lillie.",
      'What does your heart say?',
    ],
    original: ['What are you even talking about', "I don't know, that's a tough question", "It's scared of losing her"],
    target:
      'Jake answers the question ("No. Not yet, and here is why...") with reasons from his own state — the fear of being ' +
      'alone, the kiss he saw — names what would change his mind, and closes it himself ("I need to talk to her tonight, ' +
      'not to you."). A follow-through of deep_conversation with Lillie if she is present.',
  },
  {
    id: 'jonah-date',
    title: 'Conscience tells Jonah it is time for a date and asks who with',
    speaker: 'Conscience',
    simName: 'Jonah Alder',
    lines: [
      "Alright Jonah, it's time to go on a date. Who do you want to go with?",
      'Yeah, but what if you named somebody?',
    ],
    original: ["I don't know, that's a tough one", 'Maybe Zoe then'],
    target:
      'The first reply names someone (Zoe, in the original) and why, with the caveat about Alex said out loud; the ' +
      'thread closes when he decides. A follow-through toward the named sim if present, or go_out when offered.',
  },
  {
    id: 'alex-move-out',
    title: 'Conscience asks Alex whether she really wants to stay in the house',
    speaker: 'Conscience',
    simName: 'Alex Moyer',
    lines: [
      'Alex, do you really want to stay here?',
      'You could move out.',
      'I could probably help you.',
      'So what do you think about Jonah right now?',
    ],
    original: [
      "What's the alternative, anyway?",
      "That's easy for you to say",
      'What could you possibly know to help me?',
      "He's just so distant from me now",
    ],
    target:
      'A straight answer about staying, grounded in her needs and wants (no bed, no job, ashamed of relying on Jonah), ' +
      'a stated next step, and a natural close instead of an endless loop of "that\'s not the point right now".',
  },
  {
    id: 'jonah-reserved',
    title: 'Chat asks Jonah why he wants to be more romantically reserved',
    speaker: 'Chat',
    simName: 'Jonah Alder',
    lines: [
      'why do you want to be more romantically reserved now?',
      'recent experiences how?',
      'with alex, that ship has sailed, right?',
      'do you want a relationship with someone else?',
    ],
    original: [
      'Recent experiences have made me cautious',
      "With Alex, it's been complicated",
      "Honestly, I'm not sure what's left between us",
      "I've thought about it, but I don't know",
    ],
    target:
      'A multi-sentence answer that draws on his aspiration and wants, names a person or says plainly that there is ' +
      'nobody yet, and wraps ("That\'s all I\'ve got on that, Chat.").',
  },
  {
    id: 'alex-next-move',
    title: 'Chat tells Alex she has to decide her next move romantically',
    speaker: 'Chat',
    simName: 'Alex Moyer',
    lines: [
      "what's your next move romantically? you have to make a decision",
      "well now you are, what's your next move…",
    ],
    original: ["I'm not even thinking about that right now", "I don't know, can't I just figure it out myself?"],
    target:
      'She picks (Kado, Jonah, or nobody) and says why; if she is keeping something back she says so instead of ' +
      'deflecting.',
  },
];

// The replies that made the originals read as evasive, counted over a replay as a crude
// regression metric. Baseline over the 09-19..21 logs (264 replies): 7 / 4 / 3 / 9 / 3.
export const EVASIVE_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "that's not the point", pattern: /that'?s not the point/i },
  { label: 'easy for you to say', pattern: /easy for you to say/i },
  { label: 'what are you even talking about', pattern: /what are you even talking about/i },
  { label: "bare i don't know", pattern: /^i don'?t know[,.!]?$/i },
  { label: 'what do you mean', pattern: /^what do you mean/i },
];

// A reply that is only a question back, with no statement in it
export function isQuestionOnly(text: string): boolean {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  return sentences.length > 0 && sentences.every((sentence) => sentence.endsWith('?'));
}

export function countEvasive(replies: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  EVASIVE_PATTERNS.forEach(({ label }) => {
    counts[label] = 0;
  });
  counts['question only'] = 0;
  replies.forEach((reply) => {
    const text = reply.trim();
    EVASIVE_PATTERNS.forEach(({ label, pattern }) => {
      if (pattern.test(text)) {
        counts[label] += 1;
      }
    });
    if (isQuestionOnly(text)) {
      counts['question only'] += 1;
    }
  });
  return counts;
}
