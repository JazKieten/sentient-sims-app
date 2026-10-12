import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildElevenLabsSTTRequest,
  elevenLabsHealthCheck,
  elevenLabsTranscribe,
} from '../main/sentient-sims/clients/ElevenLabsSTTRequest';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('buildElevenLabsSTTRequest', () => {
  it('posts a multipart form with the audio, model, keyterms and no audio-event tags', async () => {
    const request = buildElevenLabsSTTRequest({
      endpoint: 'https://api.elevenlabs.io/v1/',
      apiKey: 'xi-key',
      audio: Buffer.from([1, 2, 3, 4]),
      mimeType: 'audio/webm;codecs=opus',
      languageCode: 'en',
      keyterms: ['Anker Solheim', 'Anker', 'Halley'],
    });

    expect(request.url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect(request.headers).toEqual({ 'xi-api-key': 'xi-key' });
    expect(request.body.get('model_id')).toBe('scribe_v2');
    expect(request.body.get('tag_audio_events')).toBe('false');
    expect(request.body.get('language_code')).toBe('en');
    expect(request.body.getAll('keyterms')).toEqual(['Anker Solheim', 'Anker', 'Halley']);

    const file = request.body.get('file') as File;
    expect(file.name).toBe('speech.webm');
    expect(file.type).toBe('audio/webm');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('omits the language when auto-detecting and sends no keyterms field when there are none', () => {
    const request = buildElevenLabsSTTRequest({
      endpoint: 'https://api.elevenlabs.io/v1',
      apiKey: 'xi-key',
      audio: Buffer.from([1]),
      mimeType: 'audio/webm',
    });
    expect(request.body.has('language_code')).toBe(false);
    expect(request.body.getAll('keyterms')).toEqual([]);
  });
});

describe('elevenLabsTranscribe', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the transcript text', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { language_code: 'en', text: 'Anker, how are you?', words: [] }));

    const text = await elevenLabsTranscribe({
      endpoint: 'https://api.elevenlabs.io/v1',
      apiKey: 'xi-key',
      audio: Buffer.from([1, 2]),
      mimeType: 'audio/webm',
      keyterms: ['Anker'],
    });

    expect(text).toBe('Anker, how are you?');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['xi-api-key']).toBe('xi-key');
    expect(init?.body).toBeInstanceOf(FormData);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('surfaces the API error detail', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } }),
    );

    await expect(
      elevenLabsTranscribe({ endpoint: 'https://x', apiKey: 'bad', audio: Buffer.from([1]), mimeType: 'audio/webm' }),
    ).rejects.toThrow('Invalid API key');
  });

  it('falls back to the status line on a non-JSON failure', async () => {
    fetchMock.mockResolvedValue(new Response('gateway down', { status: 502, statusText: 'Bad Gateway' }));

    await expect(
      elevenLabsTranscribe({ endpoint: 'https://x', apiKey: 'k', audio: Buffer.from([1]), mimeType: 'audio/webm' }),
    ).rejects.toThrow('502 Bad Gateway: gateway down');
  });

  it('health-checks the key against /user', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { subscription: {} }));
    await elevenLabsHealthCheck('https://api.elevenlabs.io/v1', 'xi-key');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.elevenlabs.io/v1/user');

    fetchMock.mockResolvedValue(jsonResponse(401, { detail: 'Unauthorized' }));
    await expect(elevenLabsHealthCheck('https://api.elevenlabs.io/v1', 'bad')).rejects.toThrow('Unauthorized');
  });
});
