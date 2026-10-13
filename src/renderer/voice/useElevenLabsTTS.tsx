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
    (text: string, voiceId: string, context?: LineContext, stream?: boolean, timestamps?: boolean) =>
      buildElevenLabsLineRequest({
        text,
        voiceId,
        endpoint: elevenLabsEndpointSetting.value,
        apiKey: elevenLabsKeySetting.value,
        settings: elevenLabsTTSSettings.value,
        previousText: context?.previousText,
        nextText: context?.nextText,
        stream,
        timestamps,
      }),
    [elevenLabsEndpointSetting.value, elevenLabsKeySetting.value, elevenLabsTTSSettings.value],
  );
  const endpointName = usesDialogueEndpoint(elevenLabsTTSSettings.value.model) ? 'dialogue' : 'tts';

  const fetchAudioUrl = useCallback(
    async (text: string, voiceId: string, context?: LineContext): Promise<string> => {
      const { url, headers, body } = buildRequest(text, voiceId, context);
      const startedAt = Date.now();
      log.info(
        `[TTS] ElevenLabs request voice=${voiceId} model=${elevenLabsTTSSettings.value.model} endpoint=${endpointName} chars=${text.length}`,
      );

      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      log.info(`[TTS] ElevenLabs response voice=${voiceId} status=${response.status} in ${Date.now() - startedAt}ms`);

      if (!response.ok) {
        throw new Error(elevenLabsErrorMessage(response.status, await response.text().catch(() => '')));
      }

      return URL.createObjectURL(await response.blob());
    },
    [buildRequest, elevenLabsTTSSettings.value.model, endpointName],
  );

  // The buffered with-timestamps call: the audio plus when each character of the line
  // is spoken, so the mod can reveal the words with the voice. Any failure there falls
  // back to the plain audio call (a line is never silent for want of timing).
  const fetchLineAudio = useCallback(
    async (sentText: string, lineText: string, voiceId: string, context?: LineContext): Promise<LineAudio> => {
      try {
        const { url, headers, body } = buildRequest(sentText, voiceId, context, false, true);
        const startedAt = Date.now();
        log.info(
          `[TTS] ElevenLabs timestamps request voice=${voiceId} model=${elevenLabsTTSSettings.value.model} endpoint=${endpointName} chars=${sentText.length}`,
        );
        const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
        if (!response.ok) {
          throw new Error(elevenLabsErrorMessage(response.status, await response.text().catch(() => '')));
        }
        const chunk = parseTimestampsJson(await response.json());
        if (chunk.bytes.length === 0) {
          throw new Error('with-timestamps response carried no audio');
        }
        const charMs = alignmentToCharMs(chunk.alignment, sentText, lineText);
        log.info(
          `[TTS] ElevenLabs timestamps response voice=${voiceId} status=${response.status} in ${Date.now() - startedAt}ms aligned=${charMs ? charMs.length : 'none'}`,
        );
        return { url: URL.createObjectURL(new Blob([toArrayBuffer(chunk.bytes)], { type: 'audio/mpeg' })), charMs };
      } catch (err: unknown) {
        log.warn(
          `[TTS] ElevenLabs timestamps failed, fetching plain audio: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { url: await fetchAudioUrl(sentText, voiceId, context), charMs: null };
      }
    },
    [buildRequest, fetchAudioUrl, elevenLabsTTSSettings.value.model, endpointName],
  );

  // The /stream endpoint starts returning audio bytes ~0.6-0.8s in even on v3 (vs ~2-4s
  // for the whole file), so the first spoken line can start playing 1-3s sooner.
  const fetchAudioStream = useCallback(
    async (text: string, voiceId: string, context?: LineContext): Promise<ReadableStream<Uint8Array>> => {
      const { url, headers, body } = buildRequest(text, voiceId, context, true);
      const startedAt = Date.now();
      log.info(
        `[TTS] ElevenLabs stream request voice=${voiceId} model=${elevenLabsTTSSettings.value.model} endpoint=${endpointName} chars=${text.length}`,
      );

      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      log.info(
        `[TTS] ElevenLabs stream first byte voice=${voiceId} status=${response.status} in ${Date.now() - startedAt}ms`,
      );

      if (!response.ok || !response.body) {
        throw new Error(elevenLabsErrorMessage(response.status, await response.text().catch(() => '')));
      }

      return response.body;
    },
    [buildRequest, elevenLabsTTSSettings.value.model, endpointName],
  );

  // The streamed with-timestamps call: JSON chunks, each with audio bytes and the
  // alignment of the characters they cover. The bytes go to the player as they arrive;
  // the alignment accumulates and is reported after every chunk.
  const fetchAudioTimestampStream = useCallback(
    async (sentText: string, lineText: string, voiceId: string, context?: LineContext): Promise<TimedStream> => {
      const { url, headers, body } = buildRequest(sentText, voiceId, context, true, true);
      const startedAt = Date.now();
      log.info(
        `[TTS] ElevenLabs timestamps stream request voice=${voiceId} model=${elevenLabsTTSSettings.value.model} endpoint=${endpointName} chars=${sentText.length}`,
      );
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      log.info(
        `[TTS] ElevenLabs timestamps stream first byte voice=${voiceId} status=${response.status} in ${Date.now() - startedAt}ms`,
      );
      if (!response.ok || !response.body) {
        throw new Error(elevenLabsErrorMessage(response.status, await response.text().catch(() => '')));
      }

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
      const lineVoice = (line: DialogueLine): string => {
        const voiceId = line.voiceId ?? elevenLabsTTSSettings.value.voice;
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

      // Conversation pacing: each line runs for exactly its audio's duration. The first
      // line streams (playback starts on the first audio chunk); later lines prefetch
      // as full files while the previous line plays, so lines flow back-to-back.
      const fetchLine = (index: number): Promise<LineAudio | null> => {
        const line = speakable[index];
        return fetchLineAudio(lineText(line), line.text, lineVoice(line), lineContext(index)).catch((err: unknown) => {
          const errorMessage = `TTS request failed: ${err instanceof Error ? err.message : String(err)}`;
          log.error(errorMessage);
          setError(errorMessage);
          return null;
        });
      };
      const audioPromises: (Promise<LineAudio | null> | undefined)[] = [];
      const startFetch = (index: number) => {
        if (index > 0 && index < speakable.length && !audioPromises[index]) {
          audioPromises[index] = fetchLine(index);
        }
      };

      // Streams a line with timestamps: the subtitle starts with the words timed so far
      // (partial) and grows as chunks arrive, then settles on the final list. Returns
      // false when the timestamps stream could not be opened (the caller falls back).
      const playTimedStream = async (line: DialogueLine, index: number): Promise<boolean> => {
        let timed: TimedStream;
        try {
          timed = await fetchAudioTimestampStream(lineText(line), line.text, lineVoice(line), lineContext(index));
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
        if (i === 0) {
          try {
            played = await playTimedStream(speakable[0], 0);
            if (!played) {
              const stream = await fetchAudioStream(lineText(speakable[0]), lineVoice(speakable[0]), lineContext(0));
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
            audioPromises[0] = fetchLine(0);
          }
        }

        if (!played) {
          if (!audioPromises[i]) audioPromises[i] = fetchLine(i);
          const audio = (await audioPromises[i]) ?? null;
          if (playSessionRef.current !== session) {
            if (audio) URL.revokeObjectURL(audio.url);
            break;
          }

          const state = { started: false };
          try {
            if (audio) {
              try {
                // The subtitle appears when the first sample sounds, not when decoding
                // starts (100-300 ms earlier), with the line's word timing when it has one
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
