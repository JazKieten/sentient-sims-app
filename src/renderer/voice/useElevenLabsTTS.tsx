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
  usesDialogueEndpoint,
} from 'main/sentient-sims/clients/ElevenLabsTTSRequest';
import { elevenLabsErrorMessage } from 'main/sentient-sims/clients/ElevenLabsError';
import { DialogueLine } from 'main/sentient-sims/formatter/PromptFormatter';
import { AudioPlaybackHandle, playAudioStream, playAudioUrl } from './audioPlayback';
import { pacedDelay } from './playbackClock';
import { TTSHook } from './TTSHook';

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

// Logged once per app run: the header's absence is a finding, not a per-line event
let requestIdHeaderMissingLogged = false;

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

  // v4 goes to Text to Dialogue (one line per request, neighbours as context); every
  // other model to Text to Speech. Both builders return the full URL, /stream included.
  const buildRequest = useCallback(
    (text: string, voiceId: string, options?: FetchOptions, stream?: boolean) =>
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

      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      log.info(`[TTS] ElevenLabs response voice=${voiceId} status=${response.status} in ${Date.now() - startedAt}ms`);
      options?.onRequestId?.(response.ok ? readRequestId(response, voiceId) : undefined);

      if (!response.ok) {
        throw new Error(elevenLabsErrorMessage(response.status, await response.text().catch(() => '')));
      }

      return URL.createObjectURL(await response.blob());
    },
    [buildRequest, elevenLabsTTSSettings.value.model, endpointName],
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

      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
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

  const playUrl = useCallback(
    async (audioUrl: string): Promise<void> => {
      try {
        const handle = await playAudioUrl(audioUrl, aiSettings.ttsVolume);
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
    async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      try {
        const handle = await playAudioStream(stream, aiSettings.ttsVolume);
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

  const speakLines = useCallback(
    async (
      lines: DialogueLine[],
      onLineStart?: (line: DialogueLine, voiced: boolean) => void,
      onLineEnd?: (line: DialogueLine) => void,
      shouldContinue?: () => boolean,
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
      ): Promise<string | null> => {
        const line = speakable[index];
        return fetchAudioUrl(lineText(line), lineVoice(line), {
          context: lineContext(index),
          previousRequestIds,
          onRequestId,
        }).catch((err: unknown) => {
          const errorMessage = `TTS request failed: ${err instanceof Error ? err.message : String(err)}`;
          log.error(errorMessage);
          setError(errorMessage);
          onRequestId?.(undefined);
          return null;
        });
      };
      const audioPromises: (Promise<string | null> | undefined)[] = [];
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

      for (let i = 0; i < speakable.length; i += 1) {
        if (playSessionRef.current !== session) break;
        // The conversation ended while the previous line was playing; that line got
        // to finish, this one never starts
        if (shouldContinue && !shouldContinue()) break;
        startFetch(i + 1);

        let played = false;
        if (i === 0) {
          try {
            const stream = await fetchAudioStream(lineText(speakable[0]), lineVoice(speakable[0]), {
              context: lineContext(0),
              onRequestId: resolveFirstRequestId,
            });
            if (playSessionRef.current !== session) {
              stream.cancel().catch(() => {});
              break;
            }
            onLineStart?.(speakable[0], true);
            try {
              await playStream(stream);
            } finally {
              onLineEnd?.(speakable[0]);
            }
            played = true;
          } catch (err: any) {
            // Fall back to the buffered path below
            const errorMessage = `TTS stream failed, retrying buffered: ${err instanceof Error ? err.message : String(err)}`;
            log.error(errorMessage);
            audioPromises[0] = fetchLine(0, [], resolveFirstRequestId);
          }
        }

        if (!played) {
          if (!audioPromises[i]) audioPromises[i] = fetchLine(i, []);
          const audioUrl = (await audioPromises[i]) ?? null;
          if (playSessionRef.current !== session) {
            if (audioUrl) URL.revokeObjectURL(audioUrl);
            break;
          }

          onLineStart?.(speakable[i], audioUrl !== null);
          try {
            if (audioUrl) {
              try {
                await playUrl(audioUrl);
              } catch (err: any) {
                const errorMessage = `TTS playback failed: ${err instanceof Error ? err.message : String(err)}`;
                log.error(errorMessage);
                setError(errorMessage);
              }
            } else {
              // No audio to time the subtitle — hold for its reading time instead
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
      const leftovers = await Promise.allSettled(audioPromises.filter(Boolean) as Promise<string | null>[]);
      leftovers.forEach((settled) => {
        if (settled.status === 'fulfilled' && settled.value && playSessionRef.current !== session) {
          URL.revokeObjectURL(settled.value);
        }
      });
    },
    [
      fetchAudioUrl,
      fetchAudioStream,
      playUrl,
      playStream,
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

  return { speak: tts, speakLines, stop: stopTTS, isPlaying: !!playback, error };
}
