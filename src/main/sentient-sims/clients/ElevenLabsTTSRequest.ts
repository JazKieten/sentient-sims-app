import { DialogueLine } from '../formatter/PromptFormatter';
import {
  defaultElevenLabsVoiceSettings,
  ElevenLabsSpeechModel,
  ElevenLabsTTSSettings,
  ElevenLabsVoiceSettings,
} from '../models/ElevenLabsTTSSettings';
import { decodeBase64, ElevenLabsAlignment, isAlignment } from '../voice/lineTiming';

export type ElevenLabsSpeechRequest = {
  url: string;
  headers: Record<string, string>;
  body: {
    text: string;
    model_id: string;
    voice_settings: {
      stability: number;
      similarity_boost: number;
      // Not sent on v4, which has no speed setting
      speed?: number;
      // Only the v2-era models take these; v3/v4 reject or ignore them
      style?: number;
      use_speaker_boost?: boolean;
    };
    previous_text?: string;
    next_text?: string;
    // Request ids of the lines just before this one in the same voice, so the model
    // keeps the delivery continuous across them (the chunks of one long reply)
    previous_request_ids?: string[];
  };
};

export type ElevenLabsDialogueRequest = {
  url: string;
  headers: Record<string, string>;
  body: {
    inputs: { text: string; voice_id: string }[];
    model_id: string;
    // Text to Dialogue names it `similarity`, not `similarity_boost`
    settings: { stability: number; similarity: number };
    previous_text?: string;
    future_text?: string;
    previous_request_ids?: string[];
  };
};

// ElevenLabs keeps at most three earlier requests as continuity context
export const ELEVENLABS_MAX_PREVIOUS_REQUEST_IDS = 3;

// Text to Dialogue accepts at most 100 chars of context on each side
export const ELEVENLABS_DIALOGUE_CONTEXT_CHARS = 100;

// Both v3 models read inline audio tags; v3 Conversational is v3 tuned for realtime
export function isElevenLabsV3(model: string): boolean {
  return (
    model === ElevenLabsSpeechModel.ELEVEN_V3.toString() ||
    model === ElevenLabsSpeechModel.ELEVEN_V3_CONVERSATIONAL.toString()
  );
}

// v4 and v4 Turbo: audio tags, no style or speed, and the Text to Dialogue endpoint
export function isElevenLabsV4(model: string): boolean {
  return (
    model === ElevenLabsSpeechModel.ELEVEN_V4.toString() || model === ElevenLabsSpeechModel.ELEVEN_V4_TURBO.toString()
  );
}

export function supportsAudioTags(model: string): boolean {
  return isElevenLabsV3(model) || isElevenLabsV4(model);
}

/**
 * v4 is built for Text to Dialogue: one request per line still, but with the
 * neighbouring lines as context so the delivery carries across the scene.
 */
export function usesDialogueEndpoint(model: string): boolean {
  return isElevenLabsV4(model);
}

/**
 * The text to actually send for a dialogue line. v3 and v4 understand inline audio tags
 * like [nervous], so a parenthetical delivery note becomes one; older models would read
 * the note aloud, so they only ever get the spoken text.
 */
export function elevenLabsLineText(line: DialogueLine, model: string): string {
  const spoken = line.ttsText ?? line.text;
  return supportsAudioTags(model) && line.deliveryNote ? `[${line.deliveryNote}] ${spoken}` : spoken;
}

/**
 * The stored voice settings with every gap filled from the defaults. A stored object
 * with no `stability` predates the sliders (2026-10-03): the app then hard-coded
 * stability 0 / similarity 0 on every request while storing similarity_boost 0 from the
 * old default, so that object's similarity is NOT a choice the user made and both get
 * the new defaults.
 */
export function resolvedVoiceSettings(settings: ElevenLabsTTSSettings): Required<ElevenLabsVoiceSettings> {
  const stored = settings.voice_settings;
  const defaultStability = defaultElevenLabsVoiceSettings.stability as number;
  const defaultSimilarity = defaultElevenLabsVoiceSettings.similarity_boost as number;
  const legacy = stored?.stability === undefined;
  return {
    stability: legacy ? defaultStability : (stored.stability as number),
    similarity_boost: legacy ? defaultSimilarity : (stored.similarity_boost ?? defaultSimilarity),
    style: stored?.style ?? defaultElevenLabsVoiceSettings.style,
    use_speaker_boost: stored?.use_speaker_boost ?? defaultElevenLabsVoiceSettings.use_speaker_boost,
    speed: stored?.speed ?? defaultElevenLabsVoiceSettings.speed,
  };
}

// v3 only takes stability as one of its three presets (Creative 0, Natural 0.5, Robust 1)
// and rejects anything else with a 422, so the slider value snaps to the nearest one
export function snapStabilityForModel(stability: number, model: string): number {
  if (!isElevenLabsV3(model)) {
    return stability;
  }
  return [0, 0.5, 1].reduce((best, preset) =>
    Math.abs(preset - stability) < Math.abs(best - stability) ? preset : best,
  );
}

/**
 * Voice settings the model accepts. "Style and Speed sliders are not available in
 * Eleven v4", so v4 gets stability and similarity only; v3 adds the configured speed
 * (API range 0.7-1.2); the v2-era models (flash, multilingual) take style and speaker
 * boost as well.
 */
export function elevenLabsVoiceSettings(
  settings: ElevenLabsTTSSettings,
): ElevenLabsSpeechRequest['body']['voice_settings'] {
  const resolved = resolvedVoiceSettings(settings);
  const stability = snapStabilityForModel(resolved.stability, settings.model);
  if (isElevenLabsV4(settings.model)) {
    return { stability, similarity_boost: resolved.similarity_boost };
  }
  if (isElevenLabsV3(settings.model)) {
    return { stability, similarity_boost: resolved.similarity_boost, speed: resolved.speed };
  }

  return {
    stability,
    similarity_boost: resolved.similarity_boost,
    style: resolved.style,
    use_speaker_boost: resolved.use_speaker_boost,
    speed: resolved.speed,
  };
}

function previousRequestIdsField(ids: string[] | undefined): { previous_request_ids?: string[] } {
  const kept = (ids ?? []).filter(Boolean).slice(-ELEVENLABS_MAX_PREVIOUS_REQUEST_IDS);
  return kept.length > 0 ? { previous_request_ids: kept } : {};
}

/**
 * What came before this line, for continuity of delivery: EITHER the ids of the requests
 * just spoken (the chunks of one long reply, stitched) OR the plain text of the line
 * before - never both. ElevenLabs rejects a request carrying both with a 400 ("Provide
 * only one of previous_request_ids or previous_text"), which on the 2026-10-05 stream
 * silenced the second chunk of every long reply. The ids win when there are any: they
 * are the stronger signal, and the text they replace is the very chunk they name.
 */
function previousContextFields(
  previousText: string | undefined,
  previousRequestIds: string[] | undefined,
): { previous_text?: string; previous_request_ids?: string[] } {
  const ids = previousRequestIdsField(previousRequestIds);
  if (ids.previous_request_ids) {
    return ids;
  }
  return previousText ? { previous_text: previousText } : {};
}

/**
 * Clamps a neighbouring line to what the dialogue endpoint accepts: the TAIL of the
 * line before (what was just said), the HEAD of the line after (what comes next).
 */
export function dialogueContext(text: string | undefined, side: 'previous' | 'next'): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= ELEVENLABS_DIALOGUE_CONTEXT_CHARS) return trimmed;

  return side === 'previous'
    ? trimmed.slice(trimmed.length - ELEVENLABS_DIALOGUE_CONTEXT_CHARS)
    : trimmed.slice(0, ELEVENLABS_DIALOGUE_CONTEXT_CHARS);
}

function elevenLabsHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'xi-api-key': apiKey,
  };
}

export type ElevenLabsLineRequestParams = {
  text: string;
  voiceId: string;
  endpoint: string;
  apiKey: string;
  settings: ElevenLabsTTSSettings;
  // The plain text of the lines either side, for continuity of delivery
  previousText?: string;
  nextText?: string;
  // Target the /stream variant (audio bytes start arriving before the file is done)
  stream?: boolean;
  // Target the /with-timestamps variant: JSON (audio_base64 + per-character alignment)
  // instead of raw audio, buffered or as a stream of JSON chunks. The mod reveals the
  // subtitle's words from the alignment (voice/lineTiming.ts).
  timestamps?: boolean;
  // `request-id` headers of the lines just spoken in this voice (oldest first), for
  // stitching the chunks of one long line; only the last three are sent
  previousRequestIds?: string[];
};

/**
 * Builds the ElevenLabs text-to-speech call. `model_id` matters: without it the API falls
 * back to its own default and the configured model is silently ignored.
 */
export function buildElevenLabsSpeechRequest(params: ElevenLabsLineRequestParams): ElevenLabsSpeechRequest {
  const { text, voiceId, endpoint, apiKey, settings, previousText, nextText, stream, timestamps, previousRequestIds } =
    params;
  const path = `text-to-speech/${voiceId}${stream ? '/stream' : ''}${timestamps ? '/with-timestamps' : ''}`;
  // The API answers 400 "Providing previous_text or next_text is not yet supported with
  // the 'eleven_v3' model" on every text-to-speech variant (measured 2026-10-13), which
  // silenced every v3 line that had a neighbour; v3 gets no text context at all (the
  // stitching ids are a different field and still go)
  const v3 = isElevenLabsV3(settings.model);
  const context = {
    ...previousContextFields(v3 ? undefined : previousText, previousRequestIds),
    ...(nextText && !v3 ? { next_text: nextText } : {}),
  };

  return {
    // output_format is a query parameter on this endpoint too; the renderer's streaming
    // player decodes 'audio/mpeg' (audioPlayback.ts), so the UI only offers mp3 formats
    url: `${endpoint}/${path}?output_format=${encodeURIComponent(settings.output_format)}`,
    headers: elevenLabsHeaders(apiKey),
    body: {
      text,
      model_id: settings.model,
      voice_settings: elevenLabsVoiceSettings(settings),
      ...context,
    },
  };
}

/**
 * Builds the Text to Dialogue call for one line. The endpoint takes up to ten voiced
 * inputs, but the app sends ONE line per request on purpose: speakLines fires
 * onLineStart/onLineEnd per line and those drive the mod's subtitle, mouth, plumbob and
 * scene_line_ended. The lines around it ride as previous_text / future_text instead.
 * There is no speed here at all; output_format is a query parameter on this endpoint.
 */
export function buildElevenLabsDialogueRequest(params: ElevenLabsLineRequestParams): ElevenLabsDialogueRequest {
  const { text, voiceId, endpoint, apiKey, settings, previousText, nextText, stream, timestamps, previousRequestIds } =
    params;
  const previous = dialogueContext(previousText, 'previous');
  const future = dialogueContext(nextText, 'next');
  const path = `text-to-dialogue${stream ? '/stream' : ''}${timestamps ? '/with-timestamps' : ''}`;
  const resolved = resolvedVoiceSettings(settings);

  return {
    url: `${endpoint}/${path}?output_format=${encodeURIComponent(settings.output_format)}`,
    headers: elevenLabsHeaders(apiKey),
    body: {
      inputs: [{ text, voice_id: voiceId }],
      model_id: settings.model,
      settings: { stability: resolved.stability, similarity: resolved.similarity_boost },
      ...previousContextFields(previous, previousRequestIds),
      ...(future ? { future_text: future } : {}),
    },
  };
}

/** One switch for callers: the request shape the configured model should get. */
export function buildElevenLabsLineRequest(
  params: ElevenLabsLineRequestParams,
): ElevenLabsSpeechRequest | ElevenLabsDialogueRequest {
  return usesDialogueEndpoint(params.settings.model)
    ? buildElevenLabsDialogueRequest(params)
    : buildElevenLabsSpeechRequest(params);
}

// One JSON object of a with-timestamps response: the audio bytes it carries (base64 in
// the API) and the per-character alignment, when present. Both endpoints answer with the
// same shape; the streamed variants send one such object per chunk.
export type ElevenLabsTimestampChunk = {
  bytes: Uint8Array;
  alignment: ElevenLabsAlignment | null;
};

/**
 * Parses a with-timestamps body (buffered) or one streamed chunk. `alignment` (the text
 * as sent) is preferred over `normalized_alignment` (the text as spoken, with numbers
 * and abbreviations expanded), since the subtitle shows the text as sent.
 */
export function parseTimestampsJson(json: unknown): ElevenLabsTimestampChunk {
  const record = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const audio = typeof record.audio_base64 === 'string' ? record.audio_base64 : '';
  const alignment = isAlignment(record.alignment)
    ? record.alignment
    : isAlignment(record.normalized_alignment)
      ? record.normalized_alignment
      : null;
  return { bytes: audio ? decodeBase64(audio) : new Uint8Array(0), alignment };
}

/**
 * Splits a /stream/with-timestamps body (newline-delimited JSON objects) into parsed
 * chunks. A trailing object without a newline is parsed at the end of the stream; a line
 * that is not JSON is dropped, never fatal (the audio still plays, the words just stop
 * revealing).
 */
export function ndjsonTimestampChunks(): TransformStream<Uint8Array, ElevenLabsTimestampChunk> {
  const decoder = new TextDecoder();
  let pending = '';
  const emit = (line: string, controller: TransformStreamDefaultController<ElevenLabsTimestampChunk>) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      controller.enqueue(parseTimestampsJson(JSON.parse(trimmed)));
    } catch {
      // a partial or malformed object: skipped
    }
  };
  return new TransformStream<Uint8Array, ElevenLabsTimestampChunk>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        emit(pending.slice(0, newline), controller);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
    },
    flush(controller) {
      pending += decoder.decode();
      emit(pending, controller);
      pending = '';
    },
  });
}
