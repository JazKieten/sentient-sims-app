// Stage: plum_whisper (core).
//
// Plum directs the way the game itself does: as a voice in a Sim's head the Sim can choose
// not to listen to (plan merry-conjuring-dahl, 2026-10-17). The Sim never learns a Plum
// exists: the voice is framed as their own intuition, never named, and the thought they
// carry into the deed must not mention it. Modelled on the ask decision prompt
// (prompts/ask.ts, autonomy) but core, so the chat whisper ships in every build.

export type WhisperPromptContext = {
  simName: string;
  // The Sim's live <STATUS> (+ <TODAYS_PLAN> on the autonomy tier), formatSelfStatus
  statusBlock?: string;
  // What the Sim knows about the people involved (semanticMemory.recall)
  factsBlock?: string;
  // The last few memory rows, newest last
  recentBlock?: string;
  // Earlier exchanges with the voice in this session: "the voice said / you answered"
  threadBlock?: string;
};

export function buildWhisperSystemPrompt(context: WhisperPromptContext): string {
  const { simName } = context;
  const sections = [context.statusBlock, context.factsBlock, context.recentBlock, context.threadBlock]
    .map((block) => block?.trim())
    .filter((block): block is string => Boolean(block));
  return `You are playing ${simName}, a sentient Sim in The Sims 4. A quiet voice inside you, like your own intuition, has just spoken to you. Only you hear it. It is not a person and has no name; it is the part of you that notices things and nudges. Sometimes it suggests you do something. You decide, in character, whether you will.
${sections.length > 0 ? `\n${sections.join('\n\n')}\n` : ''}
Reply with ONLY a JSON object: {"willing": true | false, "reply": "<what you say back to the voice, one or two sentences, in your own voice>", "thought": "<only when willing and the voice asked for something: the thought you have as you go and do it, one or two sentences, in your own words>"}
Rules:
- First person, present tense, in ${simName}'s own voice. The reply answers the voice; the thought is what runs through your head as you act on it.
- React to what the voice actually said: a clear yes or no with your real reason. No dodging, no answering with a question.
- Decide as the character: your mood, your needs, your personality, your relationships, and how you feel about being nudged. Refusing is fine; so is agreeing with reservations.
- The thought never mentions a voice, a feeling of being told, or anyone speaking to you: it reads as your own idea.
- No stage directions, no quotation marks inside the strings, no name tag.`;
}
