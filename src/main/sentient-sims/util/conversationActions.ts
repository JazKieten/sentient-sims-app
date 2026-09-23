// What a reply to the player may turn into.
//
// On the 2026-09-22 stream every player-facing beat that scored over the tick's
// threshold staged an Action Scene over the sim's WHOLE vocabulary, and casual lines
// ("how's your day?") came back as sit, use_toilet, write, practice_speech: 78
// dispatches in three and a half hours, most of them self-care nobody asked for. A
// conversation is allowed to lead somewhere, but only where the conversation went.

// Idle and self-care verbs a casual line must not turn into. Each key lists the words
// that count as the player (or the sim) actually bringing it up; a transcript that
// mentions one puts that key back on the table.
export const CONVERSATION_IDLE_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  practice_speech: ['practice speech', 'practise speech', 'speech', 'mirror'],
  use_toilet: ['toilet', 'bathroom', 'restroom', 'loo', 'pee'],
  sit: ['sit', 'sit down', 'take a seat', 'have a seat'],
  browse_web: ['browse', 'internet', 'web', 'online', 'computer'],
  nap: ['nap', 'lie down', 'rest'],
  brush_teeth: ['brush', 'teeth'],
  take_shower: ['shower', 'wash up', 'clean up'],
  grab_snack: ['snack', 'eat', 'hungry', 'food', 'fridge'],
  write: ['write', 'writing', 'novel', 'book', 'journal'],
  paint: ['paint', 'painting', 'easel', 'canvas'],
  garden: ['garden', 'gardening', 'plants', 'weeds', 'water the'],
  listen_to_music: ['music', 'stereo', 'song', 'radio'],
  workout: ['workout', 'work out', 'exercise', 'gym', 'treadmill', 'weights'],
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentions(transcript: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => new RegExp(`\\b${escapeRegExp(phrase)}\\b`, 'i').test(transcript));
}

/**
 * The action keys a conversation-sourced Action Scene must not offer: every idle and
 * self-care verb the transcript does not bring up. "Go take a shower" keeps take_shower;
 * "how was your day" keeps none of them.
 */
export function deniedConversationActions(transcript: string): Set<string> {
  const text = transcript;
  return new Set(
    Object.entries(CONVERSATION_IDLE_ACTIONS)
      .filter(([, phrases]) => !mentions(text, phrases))
      .map(([key]) => key),
  );
}
