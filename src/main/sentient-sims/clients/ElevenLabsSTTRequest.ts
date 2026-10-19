// ElevenLabs Scribe speech-to-text: POST {endpoint}/speech-to-text, multipart. Field
// names checked against the API reference 2026-10-12: `file`, `model_id`,
// `language_code` (ISO-639-1 or -3, omitted = auto-detect), `tag_audio_events` and
// `keyterms` (repeated; up to 1000, under 50 chars and 5 words each; a 20% surcharge,
// and a 20 s minimum bill per request above 100 terms). The reply carries `text`.

export const ELEVENLABS_STT_MODEL = 'scribe_v2';

// A held key is a few seconds of audio; a stuck request must not hold the mic state
export const ELEVENLABS_STT_TIMEOUT_MS = 30000;

export type ElevenLabsSTTParams = {
  endpoint: string;
  apiKey: string;
  audio: Buffer;
  mimeType: string;
  // Empty = let the model detect it
  languageCode?: string;
  keyterms?: string[];
  // Omitted = ELEVENLABS_STT_MODEL
  modelId?: string;
};

export type ElevenLabsSTTRequest = {
  url: string;
  headers: Record<string, string>;
  body: FormData;
};

// The container is what the recorder produced ("audio/webm;codecs=opus"); the filename
// extension is a hint the server reads when the type is ambiguous
function fileExtension(mimeType: string): string {
  const subtype = mimeType.split(';')[0].split('/')[1]?.trim();
  return subtype && /^[a-z0-9]+$/i.test(subtype) ? subtype : 'webm';
}

export function buildElevenLabsSTTRequest(params: ElevenLabsSTTParams): ElevenLabsSTTRequest {
  const { endpoint, apiKey, audio, mimeType, languageCode, keyterms, modelId } = params;
  const body = new FormData();
  body.append('model_id', modelId?.trim() || ELEVENLABS_STT_MODEL);
  // A copy into a plain Uint8Array: Buffer's backing store may be a SharedArrayBuffer
  // as far as the types know, and Blob only takes ArrayBuffer-backed views
  const bytes = new Uint8Array(audio);
  body.append('file', new Blob([bytes], { type: mimeType.split(';')[0] }), `speech.${fileExtension(mimeType)}`);
  // "(laughs)" must never reach a sim as something the player said
  body.append('tag_audio_events', 'false');
  if (languageCode) {
    body.append('language_code', languageCode);
  }
  (keyterms ?? []).forEach((term) => {
    body.append('keyterms', term);
  });
  return {
    url: `${endpoint.replace(/\/+$/, '')}/speech-to-text`,
    // No Content-Type: fetch sets the multipart boundary itself
    headers: { 'xi-api-key': apiKey },
    body,
  };
}

// The API answers a bad request with {"detail": {"status": ..., "message": ...}} or a
// plain {"detail": "..."}; surface the message, else the status line
async function errorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(text) as { detail?: unknown };
    const { detail } = parsed;
    if (typeof detail === 'string') {
      return detail;
    }
    if (detail && typeof detail === 'object' && typeof (detail as { message?: unknown }).message === 'string') {
      return (detail as { message: string }).message;
    }
  } catch {
    // not JSON
  }
  return `${response.status} ${response.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`;
}

export async function elevenLabsTranscribe(params: ElevenLabsSTTParams): Promise<string> {
  const request = buildElevenLabsSTTRequest(params);
  const response = await fetch(request.url, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(ELEVENLABS_STT_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(await errorMessage(response));
  }
  const reply = (await response.json()) as { text?: unknown };
  return typeof reply.text === 'string' ? reply.text : '';
}

// The cheapest authenticated call: a bad or missing key is a 401 here too
export async function elevenLabsHealthCheck(endpoint: string, apiKey: string): Promise<void> {
  const response = await fetch(`${endpoint.replace(/\/+$/, '')}/user`, {
    headers: { 'xi-api-key': apiKey },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    throw new Error(await errorMessage(response));
  }
}
