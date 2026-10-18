import { DialogueLine } from 'main/sentient-sims/formatter/PromptFormatter';

// When each word of a line is spoken, measured from the moment its audio started: either
// ElevenLabs' per-codepoint start times (charMs, a prefix while the line streams in) or
// word start times synthesized from the audio's duration (wordMs). The main process turns
// it into the mod's scene_line.reveal (util/notifyRenderer.ts sceneLineReveal).
export type LineReveal = {
  charMs?: number[];
  wordMs?: number[];
  partial: boolean;
  // Date.now() when the first sample sounded (the mod and the app share a clock)
  startedAtMs: number;
  // The playback rate at start (playbackClock.ts)
  rate: number;
  source: 'elevenlabs' | 'estimate';
};

export interface TTSHook {
  speak: (text: string) => Promise<void>;
  // onLineStart fires as each line begins playing so callers can sync external
  // displays (the in-game subtitle) to the audio; voiced is false when the line has no
  // audio and is only held for reading time; reveal carries the line's word timing when
  // there is one. onLineRevealUpdate fires when a streamed line's timing grows (more
  // words timed, or the final list). onLineEnd fires when its playback (or
  // hold) is over, including after a playback error or a cancelled session.
  // shouldContinue is consulted between lines: false ends the scene after the line
  // playing right now, without cutting it off (a sim walking away ends the
  // conversation, it does not glitch the audio). stop() is the mid-word version.
  speakLines?: (
    lines: DialogueLine[],
    onLineStart?: (line: DialogueLine, voiced: boolean, reveal?: LineReveal) => void,
    onLineEnd?: (line: DialogueLine) => void,
    shouldContinue?: () => boolean,
    onLineRevealUpdate?: (line: DialogueLine, reveal: Pick<LineReveal, 'charMs' | 'wordMs' | 'partial'>) => void,
  ) => Promise<void>;
  stop: () => void;
  // Start fetching a line's audio ahead of time (the first line of the next queued
  // scene) so it plays the moment its scene starts. One line is remembered; a line that
  // is never spoken is forgotten after a minute.
  prefetch?: (line: DialogueLine) => void;
  isPlaying: boolean;
  clearQueue?: () => void;
  isProcessing?: boolean;
  queueLength?: number;
  error?: string;
}
