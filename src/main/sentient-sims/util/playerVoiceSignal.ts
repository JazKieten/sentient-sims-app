// Fired when a player-voice chat generation finishes (success or error). The Twitch !ask
// queue paces one viewer question per answered generation on this signal; the voice hotkey
// path fires it too, which is harmless — the queue only reacts while it has a question
// in flight.
import log from 'electron-log';

type Listener = () => void;

const listeners = new Set<Listener>();

export function onPlayerVoiceAnswerComplete(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitPlayerVoiceAnswerComplete(): void {
  [...listeners].forEach((listener) => {
    try {
      listener();
    } catch (err) {
      log.error('player-voice answer-complete listener failed', err);
    }
  });
}
