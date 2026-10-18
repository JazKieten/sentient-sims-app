import { useState, useCallback, useRef } from 'react';
import log from 'electron-log';
import { useAISettings } from 'renderer/providers/AISettingsProvider';
import { SettingsEnum } from 'main/sentient-sims/models/SettingsEnum';
import {
  defaultElevenLabsEndpoint,
  sceneChunkGapMs,
  sceneLineGapMs,
  sceneLineReadingHoldMs,
} from 'main/sentient-sims/constants';
import useSetting from 'renderer/hooks/useSetting';
import { defaultElevenLabsTTSSettings, ElevenLabsTTSSettings } from 'main/sentient-sims/models/ElevenLabsTTSSettings';
import {
  buildElevenLabsLineRequest,
  ELEVENLABS_MAX_PREVIOUS_REQUEST_IDS,
  elevenLabsLineText,
  ndjsonTimestampChunks,
  parseTimestampsJson,
  usesDialogueEndpoint,
} from 'main/sentient-sims/clients/ElevenLabsTTSRequest';
import { elevenLabsErrorMessage } from 'main/sentient-sims/clients/ElevenLabsError';
import { DialogueLine } from 'main/sentient-sims/formatter/PromptFormatter';
import {
  alignmentToCharMs,
  ElevenLabsAlignment,
  emptyAlignment,
  mergeChunkAlignment,
  toArrayBuffer,
} from 'main/sentient-sims/voice/lineTiming';
import { AudioPlaybackHandle, PlaybackStart, playAudioStream, playAudioUrl } from './audioPlayback';
import { pacedDelay } from './playbackClock';
import { LineReveal, TTSHook } from './TTSHook';

type LineContext = { previousText?: string; nextText?: string };

type FetchOptions = {
  context?: LineContext;
  // request-id headers of the lines just before this one in the same voice (the
  // chunks of one long reply): ElevenLabs carries the delivery across them
  previousRequestIds?: string[];
  // Called as soon as the response headers are in, with this request's own id, so the
  // next chunk's request can be built while this one's audio is still downloading
  onRequestId?: (requestId: string | undefined) => void;
};

// A fetched line: its audio as an object URL and, when the with-timestamps endpoint
// answered, the start time of every codepoint of the line's text
type LineAudio = { url: string; charMs: number[] | null };

// A streamed line with timestamps: the audio bytes to play and the alignment as it grows.
// onTiming fires after every chunk with the codepoint times so far (null until the
// alignment lines up with the text) and once more with final = true at the end.
type TimedStream = {
  bytes: ReadableStream<Uint8Array>;
  onTiming: (listener: (charMs: number[] | null, final: boolean) => void) => void;
};

// Logged once per app run: the header's absence is a finding, not a per-line event
let requestIdHeaderMissingLogged = false;

// A prefetched line that nobody speaks is let go after this long
const prefetchTtlMs = 60_000;

type PrefetchedLine = {
  key: string;
  audio: Promise<LineAudio | null>;
  requestId: Promise<string | undefined>;
  expiry: ReturnType<typeof setTimeout>;
};

function discardPrefetched(entry: PrefetchedLine) {
  clearTimeout(entry.expiry);
  void entry.audio.then((audio) => {
    if (audio) URL.revokeObjectURL(audio.url);
    return null;
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

// One retry on a gateway error, or on a rate limit after its Retry-After (capped at 2 s).
// Any other 4xx fails fast: a bad key or a bad request is not going to get better.
async function fetchWithRetry(url: string, init: RequestInit, label: string): Promise<Response> {
  let response = await fetch(url, init);
  if (response.status >= 500 || response.status === 429) {
    const retryAfterHeader = Number(response.headers.get('retry-after'));
    const waitMs =
      response.status === 429
        ? Math.min(Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader * 1000 : 1000, 2000)
        : 500;
    log.warn(`[TTS] ElevenLabs ${label} returned ${response.status}; retrying once in ${waitMs}ms`);
    await response.text().catch(() => '');
    await sleep(waitMs);
    response = await fetch(url, init);
  }
  return response;
}

function readRequestId(response: Response, voiceId: string): string | undefined {
  const requestId = response.headers.get('request-id') ?? undefined;
  if (requestId) {
    log.info(`[TTS] ElevenLabs request-id=${requestId} voice=${voiceId}`);
  } else if (!requestIdHeaderMissingLogged) {
    requestIdHeaderMissingLogged = true;
    log.warn('[TTS] ElevenLabs response carried no request-id header; chunked lines will not be stitched');
  }
  return requestId;
}

export function useElevenLabsTTS(): TTSHook {
  const aiSettings = useAISettings();
  const elevenLabsKeySetting = useSetting<string>(SettingsEnum.ELEVENLABS_KEY, '');
  const elevenLabsEndpointSetting = useSetting<string>(SettingsEnum.ELEVENLABS_ENDPOINT, defaultElevenLabsEndpoint);
  const elevenLabsTTSSettings = useSetting<ElevenLabsTTSSettings>(
    SettingsEnum.ELEVENLABS_TTS_SETTINGS,
    defaultElevenLabsTTSSettings,
  );
  const [playback, setPlayback] = useState<AudioPlaybackHandle | null>(null);
  const [error, setError] = useState<string | undefined>();
  // Bumped by stop() and by each new speakLines run so an in-flight loop knows to bail out
  const playSessionRef = useRef(0);
  // The one line fetched ahead of its scene (TTSHook.prefetch)
  const prefetchedRef = useRef<PrefetchedLine | null>(null);

  // v4 goes to Text to Dialogue (one line per request, neighbours as context); every
  // other model to Text to Speech. Both builders return the full URL, /stream included.
  const buildRequest = useCallback(
    (text: string, voiceId: string, options?: FetchOptions, stream?: boolean, timestamps?: boolean) =>
      buildElevenLabsLineRequest({
        text,
        voiceId,
        endpoint: elevenLabsEndpointSetting.value,
        apiKey: elevenLabsKeySetting.value,
        settings: elevenLabsTTSSettings.value,
        previousText: options?.context?.previousText,
        nextText: options?.context?.nextText,
        previousRequestIds: options?.previousRequestIds,
        stream,
        timestamps,
      }),
    [elevenLabsEndpointSetting.value, elevenLabsKeySetting.value, elevenLabsTTSSettings.value],
  );
  const endpointName = usesDialogueEndpoint(elevenLabsTTSSettings.value.model) ? 'dialogue' : 'tts';

  const fetchAudioUrl = useCallback(
    async (text: string, voiceId: string, options?: FetchOptions): Promise<string> => {
      const { url, headers, body } = buildRequest(text, voiceId, options);
      const startedAt = Date.now();
      const stitched = options?.previousRequestIds?.length ? ` stitched=${options.previousRequestIds.length}` : '';
      log.info(
        `[TTS] ElevenLabs request voice=${voiceId} model=${elevenLabsTTSSettings.value.model} endpoint=${endpointName} chars=${text.length}${stitched}`,
      );

      const response = await fetchWithRetry(url, { method: 'POST', headers, body: JSON.stringify(body) }, 'request');
      log.info(`[TTS] ElevenLabs response voice=${voiceId} status=${response.status} in ${Date.now() - startedAt}ms`);
      options?.onRequestId?.(response.ok ? readRequestId(response, voiceId) : undefined);

      if (!response.ok) {
        throw new Error(elevenLabsErrorMessage(response.status, await response.text().catch(() => '')));
      }

      return URL.createObjectURL(await response.blob());
    },
    [buildRequest, elevenLabsTTSSettings.value.model, endpointName],
  );

  // The buffered with-timestamps call: the audio plus when each character of the line
  // is spoken, so the mod can reveal the words with the voice. Any failure there falls
  // back to the plain audio call (a line is never silent for want of timing); the
  // request id is reported by whichever call answered, never twice.
  const fetchLineAudio = useCallback(
    async (sentText: string, lineText: string, voiceId: string, options?: FetchOptions): Promise<LineAudio> => {
      try {
        const { url, headers, body } = buildRequest(sentText, voiceId, options, false, true);
        const startedAt = Date.now();
        const stitched = options?.previousRequestIds?.length ? ` stitched=${options.previousRequestIds.length}` : '';
        log.info(
          `[TTS] ElevenLabs timestamps request voice=${voiceId} model=${elevenLabsTTSSettings.value.model} endpoint=${endpointName} chars=${sentText.length}${stitched}`,
        );
        const response = await fetchWithRetry(
          url,
          { method: 'POST', headers, body: JSON.stringify(body) },
          'timestamps request',
        );
        if (!response.ok) {
          throw new Error(elevenLabsErrorMessage(response.status, await response.text().catch(() => '')));
        }
        const chunk = parseTimestampsJson(await response.json());
        if (chunk.bytes.length === 0) {
          throw new Error('with-timestamps response carried no audio');
        }
        options?.onRequestId?.(readRequestId(response, voiceId));
        const charMs = alignmentToCharMs(chunk.alignment, sentText, lineText);
        log.info(
          `[TTS] ElevenLabs timestamps response voice=${voiceId} status=${response.status} in ${Date.now() - startedAt}ms aligned=${charMs ? charMs.length : 'none'}`,
        );
        return { url: URL.createObjectURL(new Blob([toArrayBuffer(chunk.bytes)], { type: 'audio/mpeg' })), charMs };
      } catch (err: unknown) {
        log.warn(
          `[TTS] ElevenLabs timestamps failed, fetching plain audio: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { url: await fetchAudioUrl(sentText, voiceId, options), charMs: null };
      }
    },
    [buildRequest, fetchAudioUrl, elevenLabsTTSSettings.value.model, endpointName],
  );

  // The /stream endpoint starts returning audio bytes ~0.6-0.8s in even on v3 (vs ~2-4s
  // for the whole file), so the first spoken line can start playing 1-3s sooner.
  const fetchAudioStream = useCallback(
    async (text: string, voiceId: string, options?: FetchOptions): Promise<ReadableStream<Uint8Array>> => {
      const { url, headers, body } = buildRequest(text, voiceId, options, true);
      const startedAt = Date.now();
      log.info(
        `[TTS] ElevenLabs stream request voice=${voiceId} model=${elevenLabsTTSSettings.value.model} endpoint=${endpointName} chars=${text.length}`,
      );

      const response = await fetchWithRetry(url, { method: 'POST', headers, body: JSON.stringify(body) }, 'stream');
      log.info(
        `[TTS] ElevenLabs stream first byte voice=${voiceId} status=${response.status} in ${Date.now() - startedAt}ms`,
      );
      options?.onRequestId?.(response.ok ? readRequestId(response, voiceId) : undefined);

      if (!response.ok || !response.body) {
        throw new Error(elevenLabsErrorMessage(response.status, await response.text().catch(() => '')));
      }

      return response.body;
    },
    [buildRequest, elevenLabsTTSSettings.value.model, endpointName],
  );

  // The streamed with-timestamps call: JSON chunks, each with audio bytes and the
  // alignment of the characters they cover. The bytes go to the player as they arrive;
  // the alignment accumulates and is reported after every chunk. A failed open throws
  // without reporting a request id: the plain stream the caller falls back to reports it.
  const fetchAudioTimestampStream = useCallback(
    async (sentText: string, lineText: string, voiceId: string, options?: FetchOptions): Promise<TimedStream> => {
      const { url, headers, body } = buildRequest(sentText, voiceId, options, true, true);
      const startedAt = Date.now();
      log.info(
        `[TTS] ElevenLabs timestamps stream request voice=${voiceId} model=${elevenLabsTTSSettings.value.model} endpoint=${endpointName} chars=${sentText.length}`,
      );
      const response = await fetchWithRetry(
        url,
        { method: 'POST', headers, body: JSON.stringify(body) },
        'timestamps stream',
      );
      log.info(
        `[TTS] ElevenLabs timestamps stream first byte voice=${voiceId} status=${response.status} in ${Date.now() - startedAt}ms`,
      );
      if (!response.ok || !response.body) {
        throw new Error(elevenLabsErrorMessage(response.status, await response.text().catch(() => '')));
      }
      options?.onRequestId?.(readRequestId(response, voiceId));

      const reader = response.body.pipeThrough(ndjsonTimestampChunks()).getReader();
      const acc: ElevenLabsAlignment = emptyAlignment();
      let listener: ((charMs: number[] | null, final: boolean) => void) | undefined;
      let chunks = 0;
      const report = (final: boolean) => {
        const charMs = alignmentToCharMs(acc, sentText, lineText);
        if (final) {
          log.info(
            `[TTS] ElevenLabs timestamps stream done voice=${voiceId} chunks=${chunks} aligned=${charMs ? charMs.length : 'none'}`,
          );
        }
        listener?.(charMs, final);
      };
      const bytes = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            report(true);
            return;
          }
          chunks += 1;
          if (value.alignment) {
            mergeChunkAlignment(acc, value.alignment);
          }
          if (value.bytes.length > 0) {
            controller.enqueue(value.bytes);
          }
          report(false);
        },
        cancel(reason) {
          reader.cancel(reason).catch(() => {});
        },
      });
      return {
        bytes,
        onTiming: (next) => {
          listener = next;
        },
      };
    },
    [buildRequest, elevenLabsTTSSettings.value.model, endpointName],
  );

  const playUrl = useCallback(
    async (audioUrl: string, onStart?: (start: PlaybackStart) => void): Promise<void> => {
      try {
        const handle = await playAudioUrl(audioUrl, aiSettings.ttsVolume, { onStart });
        setPlayback(handle); // Store reference for stopping
        await handle.finished;
      } finally {
        setPlayback(null);
        URL.revokeObjectURL(audioUrl);
      }
    },
    [aiSettings.ttsVolume],
  );

  const playStream = useCallback(
    async (stream: ReadableStream<Uint8Array>, onStart?: (start: PlaybackStart) => void): Promise<void> => {
      try {
        const handle = await playAudioStream(stream, aiSettings.ttsVolume, { onStart });
        setPlayback(handle); // Store reference for stopping
        await handle.finished;
      } finally {
        setPlayback(null);
      }
    },
    [aiSettings.ttsVolume],
  );

  const tts = useCallback(
    async (text: string): Promise<void> => {
      setError(undefined);

      if (!text.trim()) return;

      try {
        await playStream(await fetchAudioStream(text, elevenLabsTTSSettings.value.voice));
      } catch (err: any) {
        const errorMessage = `TTS request failed: ${err instanceof Error ? err.message : String(err)}`;
        log.error(errorMessage);
        setError(errorMessage);
      }
    },
    [fetchAudioStream, playStream, elevenLabsTTSSettings.value.voice],
  );

  // What identifies a prefetched line: the exact text the voice would read, in that voice,
  // on that model. Anything else and it is a different request.
  const prefetchKey = useCallback(
    (line: DialogueLine): string =>
      `${elevenLabsTTSSettings.value.model}|${line.voiceId ?? elevenLabsTTSSettings.value.voice}|${elevenLabsLineText(
        line,
        elevenLabsTTSSettings.value.model,
      )}`,
    [elevenLabsTTSSettings.value.model, elevenLabsTTSSettings.value.voice],
  );

  const prefetch = useCallback(
    (line: DialogueLine) => {
      if (!line.text.trim() || !elevenLabsKeySetting.value) return;
      const key = prefetchKey(line);
      if (prefetchedRef.current?.key === key) return;
      if (prefetchedRef.current) discardPrefetched(prefetchedRef.current);

      let resolveRequestId: (id: string | undefined) => void = () => {};
      const requestId = new Promise<string | undefined>((resolve) => {
        resolveRequestId = resolve;
      });
      const voiceId = line.voiceId ?? elevenLabsTTSSettings.value.voice;
      log.info(`[TTS] Prefetching next scene's first line for ${line.speaker}`);
      // Fetched with its word timing, so the prefetched line reveals like any other
      const audio = fetchLineAudio(elevenLabsLineText(line, elevenLabsTTSSettings.value.model), line.text, voiceId, {
        onRequestId: resolveRequestId,
      }).catch((err: unknown) => {
        log.warn(`[TTS] Prefetch failed, the line will fetch when its scene starts: ${String(err)}`);
        resolveRequestId(undefined);
        return null;
      });
      const entry: PrefetchedLine = {
        key,
        audio,
        requestId,
        expiry: setTimeout(() => {
          if (prefetchedRef.current === entry) {
            prefetchedRef.current = null;
            discardPrefetched(entry);
          }
        }, prefetchTtlMs),
      };
      prefetchedRef.current = entry;
    },
    [
      prefetchKey,
      fetchLineAudio,
      elevenLabsKeySetting.value,
      elevenLabsTTSSettings.value.model,
      elevenLabsTTSSettings.value.voice,
    ],
  );

  // Hands over the prefetched audio for this line, if it is the one that was prefetched
  const takePrefetched = useCallback(
    (line: DialogueLine): PrefetchedLine | undefined => {
      const entry = prefetchedRef.current;
      if (!entry || entry.key !== prefetchKey(line)) return undefined;
      prefetchedRef.current = null;
      clearTimeout(entry.expiry);
      return entry;
    },
    [prefetchKey],
  );

  const speakLines = useCallback(
    async (
      lines: DialogueLine[],
      onLineStart?: (line: DialogueLine, voiced: boolean, reveal?: LineReveal) => void,
      onLineEnd?: (line: DialogueLine) => void,
      shouldContinue?: () => boolean,
      onLineRevealUpdate?: (line: DialogueLine, reveal: Pick<LineReveal, 'charMs' | 'wordMs' | 'partial'>) => void,
    ): Promise<void> => {
      setError(undefined);
      playSessionRef.current += 1;
      const session = playSessionRef.current;

      const speakable = lines.filter((line) => line.text.trim());

      const lineText = (line: DialogueLine): string => elevenLabsLineText(line, elevenLabsTTSSettings.value.model);
      const voiceOf = (line: DialogueLine): string => line.voiceId ?? elevenLabsTTSSettings.value.voice;
      const lineVoice = (line: DialogueLine): string => {
        const voiceId = voiceOf(line);
        // Voice inconsistencies are only debuggable if the cast is visible in the log
        log.info(`[TTS] Line for ${line.speaker}: voice=${voiceId}${line.voiceId ? '' : ' (default, no cast voice)'}`);
        return voiceId;
      };
      // The plain spoken text either side of a line (no tags): what the voice just said
      // and what it is about to say, so v4 carries the delivery across the scene
      const lineContext = (index: number): LineContext => ({
        previousText: speakable[index - 1]?.text,
        nextText: speakable[index + 1]?.text,
      });

      // One long reply airs as sentence chunks flagged `continues`; each chunk is its own
      // request, and ElevenLabs only joins them seamlessly when a chunk names the ids of
      // the chunks before it. Each line's id settles when its response HEADERS arrive, so
      // a chunk's request waits for the previous chunk's headers, never its audio.
      const requestIds: (Promise<string | undefined> | undefined)[] = [];
      let resolveFirstRequestId: (id: string | undefined) => void = () => {};
      requestIds[0] = new Promise<string | undefined>((resolve) => {
        resolveFirstRequestId = resolve;
      });
      const chainIdsFor = async (index: number): Promise<string[]> => {
        const ids: string[] = [];
        for (let j = index - 1; j >= 0 && ids.length < ELEVENLABS_MAX_PREVIOUS_REQUEST_IDS; j -= 1) {
          // `continues` on line j means line j+1 is more of the same line
          if (!speakable[j].continues || voiceOf(speakable[j]) !== voiceOf(speakable[index])) break;
          const id = await requestIds[j];
          if (!id) break;
          ids.unshift(id);
        }
        return ids;
      };

      // Conversation pacing: each line runs for exactly its audio's duration. The first
      // line streams (playback starts on the first audio chunk); later lines prefetch
      // as full files while the previous line plays, so lines flow back-to-back.
      const fetchLine = (
        index: number,
        previousRequestIds: string[],
        onRequestId?: (id: string | undefined) => void,
      ): Promise<LineAudio | null> => {
        const line = speakable[index];
        const text = lineText(line);
        const voiceId = lineVoice(line);
        const context = lineContext(index);
        return fetchLineAudio(text, line.text, voiceId, { context, previousRequestIds, onRequestId })
          .catch((err: unknown) => {
            // Stitching is a nicety; the chunk airing is not. Whatever the API disliked
            // about the chain (2026-10-05: ids and previous_text together, a 400 on the
            // second chunk of every long reply), the chunk goes out once more on its own.
            if (!previousRequestIds.length) throw err;
            log.warn(
              `[TTS] stitched request failed (${err instanceof Error ? err.message : String(err)}); retrying unstitched`,
            );
            return fetchLineAudio(text, line.text, voiceId, { context, previousRequestIds: [], onRequestId });
          })
          .catch((err: unknown) => {
            const errorMessage = `TTS request failed: ${err instanceof Error ? err.message : String(err)}`;
            log.error(errorMessage);
            setError(errorMessage);
            onRequestId?.(undefined);
            return null;
          });
      };
      const audioPromises: (Promise<LineAudio | null> | undefined)[] = [];
      const startFetch = (index: number) => {
        if (index > 0 && index < speakable.length && !audioPromises[index]) {
          let resolveRequestId: (id: string | undefined) => void = () => {};
          requestIds[index] = new Promise<string | undefined>((resolve) => {
            resolveRequestId = resolve;
          });
          audioPromises[index] = (async () => {
            // Only a continuation waits; an ordinary line goes out at once as before
            const chain = speakable[index - 1].continues ? await chainIdsFor(index) : [];
            if (playSessionRef.current !== session) {
              resolveRequestId(undefined);
              return null;
            }
            return fetchLine(index, chain, resolveRequestId);
          })();
        }
      };

      // Streams a line with timestamps: the subtitle starts with the words timed so far
      // (partial) and grows as chunks arrive, then settles on the final list. Returns
      // false when the timestamps stream could not be opened (the caller falls back).
      const playTimedStream = async (line: DialogueLine, index: number): Promise<boolean> => {
        let timed: TimedStream;
        try {
          timed = await fetchAudioTimestampStream(lineText(line), line.text, lineVoice(line), {
            context: lineContext(index),
            onRequestId: resolveFirstRequestId,
          });
        } catch (err: unknown) {
          log.warn(
            `[TTS] ElevenLabs timestamps stream failed, streaming plain audio: ${err instanceof Error ? err.message : String(err)}`,
          );
          return false;
        }
        if (playSessionRef.current !== session) {
          timed.bytes.cancel().catch(() => {});
          return true;
        }
        let latest: number[] | null = null;
        let latestFinal = false;
        // An object, not a bare boolean: the flag is set inside the onStart callback and
        // read after, which TS's flow analysis would otherwise fold to "never started"
        const state = { started: false };
        const reveal = (charMs: number[], final: boolean): LineReveal => ({
          charMs,
          partial: !final,
          startedAtMs: 0,
          rate: 1,
          source: 'elevenlabs',
        });
        timed.onTiming((charMs, final) => {
          latest = charMs;
          latestFinal = final;
          if (state.started && charMs && playSessionRef.current === session) {
            onLineRevealUpdate?.(line, { charMs, partial: !final });
          }
        });
        try {
          await playStream(timed.bytes, (start) => {
            state.started = true;
            if (latest) {
              onLineStart?.(line, true, {
                ...reveal(latest, latestFinal),
                startedAtMs: start.startedAtMs,
                rate: start.rate,
              });
            } else {
              onLineStart?.(line, true);
            }
          });
        } finally {
          if (!state.started) {
            // The stream never played (an error before the first sample): the subtitle
            // still shows, unvoiced
            onLineStart?.(line, false);
          }
          onLineEnd?.(line);
        }
        return true;
      };

      for (let i = 0; i < speakable.length; i += 1) {
        if (playSessionRef.current !== session) break;
        // The conversation ended while the previous line was playing; that line got
        // to finish, this one never starts
        if (shouldContinue && !shouldContinue()) break;
        startFetch(i + 1);

        let played = false;
        // A line fetched ahead of its scene plays from the buffer at once: no first-byte
        // wait, and it is already complete so nothing is lost to streaming either
        const prefetched = i === 0 ? takePrefetched(speakable[0]) : undefined;
        if (prefetched) {
          log.info(`[TTS] Using prefetched audio for ${speakable[0].speaker}`);
          audioPromises[0] = prefetched.audio;
          void prefetched.requestId.then(resolveFirstRequestId);
        } else if (i === 0) {
          try {
            played = await playTimedStream(speakable[0], 0);
            if (!played) {
              const stream = await fetchAudioStream(lineText(speakable[0]), lineVoice(speakable[0]), {
                context: lineContext(0),
                onRequestId: resolveFirstRequestId,
              });
              if (playSessionRef.current !== session) {
                stream.cancel().catch(() => {});
                break;
              }
              const state = { started: false };
              try {
                await playStream(stream, () => {
                  state.started = true;
                  onLineStart?.(speakable[0], true);
                });
              } finally {
                if (!state.started) onLineStart?.(speakable[0], false);
                onLineEnd?.(speakable[0]);
              }
              played = true;
            }
          } catch (err: any) {
            // Fall back to the buffered path below
            const errorMessage = `TTS stream failed, retrying buffered: ${err instanceof Error ? err.message : String(err)}`;
            log.error(errorMessage);
            audioPromises[0] = fetchLine(0, [], resolveFirstRequestId);
          }
        }

        if (!played) {
          if (!audioPromises[i]) audioPromises[i] = fetchLine(i, []);
          const audio = (await audioPromises[i]) ?? null;
          if (playSessionRef.current !== session) {
            if (audio) URL.revokeObjectURL(audio.url);
            break;
          }

          const state = { started: false };
          try {
            if (audio) {
              try {
                // The subtitle appears when the first sample sounds, not when the element
                // is handed its file (100-300 ms earlier), with the line's word timing
                // when it has one
                await playUrl(audio.url, (start) => {
                  state.started = true;
                  onLineStart?.(
                    speakable[i],
                    true,
                    audio.charMs
                      ? {
                          charMs: audio.charMs,
                          partial: false,
                          startedAtMs: start.startedAtMs,
                          rate: start.rate,
                          source: 'elevenlabs',
                        }
                      : undefined,
                  );
                });
              } catch (err: any) {
                const errorMessage = `TTS playback failed: ${err instanceof Error ? err.message : String(err)}`;
                log.error(errorMessage);
                setError(errorMessage);
              }
              if (!state.started) onLineStart?.(speakable[i], false);
            } else {
              // No audio to time the subtitle — hold for its reading time instead
              onLineStart?.(speakable[i], false);
              await pacedDelay(sceneLineReadingHoldMs(speakable[i].text));
            }
          } finally {
            // Whatever ended the line (audio done, error, stop()), the mod hears it
            onLineEnd?.(speakable[i]);
          }
        }

        if (i < speakable.length - 1 && playSessionRef.current === session) {
          await pacedDelay(speakable[i].continues ? sceneChunkGapMs : sceneLineGapMs);
        }
      }

      // Nothing may wait on the first line's id past this point (a chain that never got
      // its headers must not hold the cleanup below)
      resolveFirstRequestId(undefined);

      // Release any prefetched audio that never played (cancelled session)
      const leftovers = await Promise.allSettled(audioPromises.filter(Boolean) as Promise<LineAudio | null>[]);
      leftovers.forEach((settled) => {
        if (settled.status === 'fulfilled' && settled.value && playSessionRef.current !== session) {
          URL.revokeObjectURL(settled.value.url);
        }
      });
    },
    [
      fetchLineAudio,
      fetchAudioStream,
      fetchAudioTimestampStream,
      playUrl,
      playStream,
      takePrefetched,
      elevenLabsTTSSettings.value.voice,
      elevenLabsTTSSettings.value.model,
    ],
  );

  const stopTTS = useCallback(() => {
    playSessionRef.current += 1;
    if (playback) {
      playback.stop();
      setPlayback(null);
    }
  }, [playback]);

  return { speak: tts, speakLines, prefetch, stop: stopTTS, isPlaying: !!playback, error };
}
