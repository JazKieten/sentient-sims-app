import { DialogueLine } from '../formatter/PromptFormatter';
import {
  defaultElevenLabsVoiceSettings,
  ElevenLabsSpeechModel,
  ElevenLabsTTSSettings,
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
    };
    previous_text?: string;
    next_text?: string;
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
  };
};

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
  return supportsAudioTags(model) && line.deliveryNote ? `[${line.deliveryNote}] ${line.text}` : line.text;
}

/**
 * Voice settings the model accepts. "Style and Speed sliders are not available in
 * Eleven v4", so v4 gets stability and similarity only; every other model keeps the
 * configured speed (API range 0.7-1.2).
 */
export function elevenLabsVoiceSettings(
  settings: ElevenLabsTTSSettings,
): ElevenLabsSpeechRequest['body']['voice_settings'] {
  if (isElevenLabsV4(settings.model)) {
    return { stability: 0, similarity_boost: 0 };
  }

  return {
    stability: 0,
    similarity_boost: 0,
    speed: settings.voice_settings?.speed ?? defaultElevenLabsVoiceSettings.speed,
  };
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
};

/**
 * Builds the ElevenLabs text-to-speech call. `model_id` matters: without it the API falls
 * back to its own default and the configured model is silently ignored.
 */
export function buildElevenLabsSpeechRequest(params: ElevenLabsLineRequestParams): ElevenLabsSpeechRequest {
  const { text, voiceId, endpoint, apiKey, settings, previousText, nextText, stream, timestamps } = params;
  // The API answers 400 "Providing previous_text or next_text is not yet supported with
  // the 'eleven_v3' model" on every text-to-speech variant (measured 2026-10-13), which
  // silenced every v3 line that had a neighbour; v3 gets no context at all
  const context = isElevenLabsV3(settings.model)
    ? {}
    : {
        ...(previousText ? { previous_text: previousText } : {}),
        ...(nextText ? { next_text: nextText } : {}),
      };

  return {
    url: `${endpoint}/text-to-speech/${voiceId}${stream ? '/stream' : ''}${timestamps ? '/with-timestamps' : ''}`,
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
  const { text, voiceId, endpoint, apiKey, settings, previousText, nextText, stream, timestamps } = params;
  const previous = dialogueContext(previousText, 'previous');
  const future = dialogueContext(nextText, 'next');
  const path = `text-to-dialogue${stream ? '/stream' : ''}${timestamps ? '/with-timestamps' : ''}`;

  return {
    url: `${endpoint}/${path}?output_format=${encodeURIComponent(settings.output_format)}`,
    headers: elevenLabsHeaders(apiKey),
    body: {
      inputs: [{ text, voice_id: voiceId }],
      model_id: settings.model,
      settings: { stability: 0, similarity: 0 },
      ...(previous ? { previous_text: previous } : {}),
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
