import log from 'electron-log';
import { currentRate, isUserPaused, onPauseChange, onRateChange, waitWhileUserPaused } from './playbackClock';

export type AudioPlaybackHandle = {
  finished: Promise<void>;
  stop: () => void;
  // V-1: driven by the playback clock (user pause / game speed); playAudio* wire them
  pause?: () => void;
  resume?: () => void;
  setRate?: (rate: number) => void;
};

// The moment a line's audio starts sounding, for whoever keeps a display in step with it
// (the mod's word-by-word subtitle): the wall clock at the first sample, the rate it plays
// at, and its length when known (a complete file; a stream has no length yet).
export type PlaybackStart = {
  startedAtMs: number;
  rate: number;
  durationMs?: number;
};

export type PlaybackOptions = {
  onStart?: (start: PlaybackStart) => void;
};

// V-1: a user pause suspends the shared context (every line, WebAudio and media
// element alike); resume brings it back. Registered once, survives every line.
let clockWired = false;
function wirePlaybackClock(context: AudioContext) {
  if (clockWired) {
    return;
  }
  clockWired = true;
  onPauseChange((paused) => {
    if (paused && context.state === 'running') {
      void context.suspend();
    } else if (!paused && context.state === 'suspended') {
      void context.resume();
    }
  });
}

// One AudioContext shared by all TTS playback. Spinning up a fresh HTMLAudioElement per
// line lets the output device go idle between lines, and the first fraction of a second
// gets clipped while it wakes back up — a persistent context keeps the device warm.
let sharedContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!sharedContext) {
    sharedContext = new AudioContext();
  }
  return sharedContext;
}

// Start playback slightly in the future so the first syllable isn't swallowed
// while the output stream is still waking up.
const playbackLeadInSeconds = 0.1;

async function readyContext(): Promise<AudioContext> {
  const context = getAudioContext();
  wirePlaybackClock(context);
  // A user pause holds the line before it starts (never resume the context over a pause)
  await waitWhileUserPaused();
  if (context.state === 'suspended' && !isUserPaused()) {
    await context.resume();
  }
  return context;
}

type ElementPlayback = {
  audio: HTMLAudioElement;
  context: AudioContext;
  // Settles `finished`; the element's own 'ended'/'error' and stop() all go through it
  settle: () => void;
  // Disconnects the graph and the clock listeners; safe to call twice
  cleanup: () => void;
  finished: Promise<void>;
  handle: AudioPlaybackHandle;
};

/**
 * The one way every line is played: an <audio> element routed through the shared
 * AudioContext. The element's playbackRate preserves PITCH at game speed 2/3 (it
 * time-stretches); an AudioBufferSourceNode's playbackRate does not, which is why
 * buffered lines (line 2+) used to come out higher-pitched than the streamed first
 * line (measured 2026-10-03). Wires the user pause and the game-speed rate, the gain,
 * cleanup and the `finished` settlement; the caller supplies the element's source and
 * decides when to call play().
 */
function wireElementPlayback(
  context: AudioContext,
  audio: HTMLAudioElement,
  volume: number,
  label: string,
): ElementPlayback {
  audio.playbackRate = currentRate();
  // Chromium pitch-corrects playbackRate on media elements by default; make it explicit
  audio.preservesPitch = true;
  const offRate = onRateChange((rate) => {
    audio.playbackRate = rate;
  });
  // The element keeps its own transport: pause/resume it with the user pause too
  const offPause = onPauseChange((paused) => {
    if (paused) {
      audio.pause();
    } else {
      void audio.play().catch((err: unknown) => {
        log.debug('resume after user pause failed', err);
      });
    }
  });

  const element = context.createMediaElementSource(audio);
  const gain = context.createGain();
  gain.gain.value = volume;
  element.connect(gain);
  gain.connect(context.destination);

  // stop() and the element's own 'ended'/'error' can each fire; the second must not
  // disconnect nodes twice or revoke an already-revoked URL
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    offRate();
    offPause();
    element.disconnect();
    gain.disconnect();
    URL.revokeObjectURL(audio.src);
  };

  // audio.pause() in stop() fires neither 'ended' nor 'error', so stop() must settle
  // this itself — a caller awaiting `finished` (the scene drain loop) would otherwise
  // hang forever after the player pre-empts a line, and no later scene would ever play
  let settle: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    settle = resolve;
    audio.addEventListener(
      'ended',
      () => {
        // currentTime near zero at 'ended' is the smoking gun for a silent death —
        // observed live: a line logged 'playback started' and produced no audio, and
        // with no completion logging the failure was invisible
        const played = audio.currentTime;
        if (played < 0.5) {
          log.warn(
            `[TTS] ${label} playback ENDED after only ${played.toFixed(2)}s — likely silent failure (context state: ${context.state})`,
          );
        } else {
          log.info(`[TTS] ${label} playback finished after ${played.toFixed(2)}s`);
        }
        cleanup();
        resolve();
      },
      { once: true },
    );
    audio.addEventListener(
      'error',
      () => {
        log.error(`[TTS] ${label} audio element error: ${audio.error?.message}`);
        cleanup();
        resolve();
      },
      { once: true },
    );
  });

  const handle: AudioPlaybackHandle = {
    finished,
    stop: () => {
      audio.pause();
      log.info(`[TTS] ${label} playback stopped after ${audio.currentTime.toFixed(2)}s`);
      cleanup();
      settle();
    },
    pause: () => {
      audio.pause();
    },
    resume: () => {
      void audio.play();
    },
    setRate: (rate: number) => {
      audio.playbackRate = rate;
    },
  };

  return { audio, context, settle, cleanup, finished, handle };
}

// Reports the first sample to whoever keeps a display in step with the audio (the mod's
// word reveal). The element's 'playing' event is the first moment sound is actually
// leaving it, so a listener's own work can never land before the line is audible.
function reportStart(audio: HTMLAudioElement, options: PlaybackOptions | undefined, onPlaying?: () => void) {
  audio.addEventListener(
    'playing',
    () => {
      onPlaying?.();
      try {
        const duration = Number.isFinite(audio.duration) ? audio.duration * 1000 : undefined;
        options?.onStart?.({
          startedAtMs: Date.now(),
          rate: currentRate(),
          ...(duration !== undefined ? { durationMs: duration } : {}),
        });
      } catch (err) {
        log.debug('[TTS] onStart listener failed', err);
      }
    },
    { once: true },
  );
}

/**
 * Plays audio from a (blob) URL. The file is complete before this is called, so nothing
 * is dropped to buffering; the element path keeps the pitch at game speed (see
 * wireElementPlayback). The blob URL is revoked when the line ends; a caller revoking
 * it again is harmless.
 */
export async function playAudioUrl(
  audioUrl: string,
  volume: number,
  options?: PlaybackOptions,
): Promise<AudioPlaybackHandle> {
  const context = await readyContext();

  const audio = new Audio();
  audio.src = audioUrl;
  const playback = wireElementPlayback(context, audio, volume, 'Buffered');

  audio.addEventListener(
    'loadedmetadata',
    () => {
      log.info(`[TTS] Playing audio: duration=${audio.duration.toFixed(2)}s volume=${volume}`);
    },
    { once: true },
  );
  reportStart(audio, options);

  // The lead-in used to be a scheduled AudioBufferSourceNode start; a delayed play()
  // does the same job for the element
  await new Promise<void>((resolve) => {
    setTimeout(resolve, playbackLeadInSeconds * 1000);
  });
  try {
    await audio.play();
  } catch (err) {
    playback.cleanup();
    playback.settle();
    throw err;
  }

  return playback.handle;
}

/**
 * Plays an mp3 byte stream as it arrives via MediaSource, so playback starts on the
 * first chunk instead of after the full file has downloaded. ElevenLabs v3 renders at
 * ~3x realtime after its first chunk, so play-on-first-chunk never underruns. The
 * element is routed through the shared AudioContext to keep the output device warm.
 */
export async function playAudioStream(
  stream: ReadableStream<Uint8Array>,
  volume: number,
  options?: PlaybackOptions,
): Promise<AudioPlaybackHandle> {
  const context = await readyContext();
  if (context.state !== 'running') {
    log.warn(`[TTS] AudioContext not running after resume: ${context.state} — stream will be silent`);
  }

  const mediaSource = new MediaSource();
  const audio = new Audio();
  audio.src = URL.createObjectURL(mediaSource);
  const playback = wireElementPlayback(context, audio, volume, 'Streaming');

  // Ref-object rather than a bare boolean so the flag set by stop() stays visible
  // inside the pump loop without TS narrowing it to its initial value
  const stopState = { current: false };

  await new Promise<void>((resolve) => {
    mediaSource.addEventListener(
      'sourceopen',
      () => {
        resolve();
      },
      { once: true },
    );
  });
  // MediaSource only takes mp3 here: a PCM output_format would need a different
  // SourceBuffer type, which is why the settings UI offers mp3 formats only
  const sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');

  const appendChunk = (chunk: Uint8Array) =>
    new Promise<void>((resolve, reject) => {
      sourceBuffer.addEventListener(
        'updateend',
        () => {
          resolve();
        },
        { once: true },
      );
      sourceBuffer.addEventListener(
        'error',
        () => {
          reject(new Error('SourceBuffer append failed'));
        },
        { once: true },
      );
      // slice() re-copies so the append covers only this chunk's bytes, not the
      // chunk's whole (possibly shared) underlying buffer
      sourceBuffer.appendBuffer(chunk.slice().buffer);
    });

  const reader = stream.getReader();
  const startedAt = Date.now();
  // Feed the buffer in the background while the element plays from it
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || stopState.current) break;
        await appendChunk(value);
      }
      if (!stopState.current && mediaSource.readyState === 'open') {
        mediaSource.endOfStream();
      }
    } catch (err) {
      log.error('[TTS] Stream pump failed', err);
      try {
        if (mediaSource.readyState === 'open') mediaSource.endOfStream();
      } catch (endErr) {
        log.debug('MediaSource already closed', endErr);
      }
    }
  })();

  reportStart(audio, options, () => {
    log.info(`[TTS] Streaming playback started ${Date.now() - startedAt}ms after fetch, volume=${volume}`);
  });
  await audio.play();

  return {
    ...playback.handle,
    stop: () => {
      stopState.current = true;
      reader.cancel().catch((err: unknown) => {
        log.debug('Stream reader already cancelled', err);
      });
      playback.handle.stop();
    },
  };
}
