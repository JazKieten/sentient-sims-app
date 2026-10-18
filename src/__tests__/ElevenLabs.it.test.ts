import log from 'electron-log';
import {
  buildElevenLabsDialogueRequest,
  buildElevenLabsSpeechRequest,
  elevenLabsLineText,
  ndjsonTimestampChunks,
  parseTimestampsJson,
  usesDialogueEndpoint,
} from 'main/sentient-sims/clients/ElevenLabsTTSRequest';
import {
  alignmentToCharMs,
  emptyAlignment,
  mergeChunkAlignment,
  wordStartsMs,
} from 'main/sentient-sims/voice/lineTiming';
import { defaultElevenLabsTTSSettings, ElevenLabsSpeechModel } from 'main/sentient-sims/models/ElevenLabsTTSSettings';
import { castElevenLabsVoice, elevenLabsVoiceCatalog } from 'main/sentient-sims/formatter/ElevenLabsVoiceCasting';
import {
  buildElevenLabsVoiceRequest,
  ElevenLabsVoiceResponse,
  toElevenLabsVoiceInfo,
} from 'main/sentient-sims/clients/ElevenLabsVoiceRequest';
import { SentientSim } from 'main/sentient-sims/models/SentientSim';
import { SimAge } from 'main/sentient-sims/models/SimAge';
import { defaultElevenLabsEndpoint } from 'main/sentient-sims/constants';

const apiKey = process.env.ELEVENLABS_KEY;

if (!apiKey) {
  log.warn('ELEVENLABS_KEY is not set, skipping ElevenLabs integration tests');
}

async function speak(text: string, voiceId: string, model: string): Promise<Blob> {
  const { url, headers, body } = buildElevenLabsSpeechRequest({
    text,
    voiceId,
    endpoint: defaultElevenLabsEndpoint,
    apiKey: apiKey as string,
    settings: { ...defaultElevenLabsTTSSettings, model },
  });

  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!response.ok) {
    throw new Error(`ElevenLabs returned ${response.status}: ${await response.text()}`);
  }

  return response.blob();
}

async function speakDialogue(text: string, voiceId: string, model: string, previousText?: string): Promise<Blob> {
  const { url, headers, body } = buildElevenLabsDialogueRequest({
    text,
    voiceId,
    endpoint: defaultElevenLabsEndpoint,
    apiKey: apiKey as string,
    settings: { ...defaultElevenLabsTTSSettings, model },
    previousText,
  });

  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!response.ok) {
    throw new Error(`ElevenLabs returned ${response.status}: ${await response.text()}`);
  }

  return response.blob();
}

describe('ElevenLabsIT', () => {
  it.skipIf(!apiKey)('generates audio for a dialogue line', async () => {
    const audio = await speak(
      'Been fishing here for years.',
      defaultElevenLabsTTSSettings.voice,
      defaultElevenLabsTTSSettings.model,
    );

    expect(audio.size).toBeGreaterThan(0);
    expect(audio.type).toContain('audio');
  });

  it.skipIf(!apiKey)('generates audio for a v3 line with an audio tag', async () => {
    const text = elevenLabsLineText(
      { speaker: 'Ricky', text: 'Been fishing here for years.', deliveryNote: 'nervous' },
      ElevenLabsSpeechModel.ELEVEN_V3,
    );
    expect(text).toEqual('[nervous] Been fishing here for years.');

    const audio = await speak(text, defaultElevenLabsTTSSettings.voice, ElevenLabsSpeechModel.ELEVEN_V3);
    expect(audio.size).toBeGreaterThan(0);
  });

  // v4 has no speed setting; this proves the API takes the v4 voice_settings shape on text-to-speech
  it.skipIf(!apiKey)('generates audio for eleven_v4 on text-to-speech without speed', async () => {
    const audio = await speak(
      'Been fishing here for years.',
      defaultElevenLabsTTSSettings.voice,
      ElevenLabsSpeechModel.ELEVEN_V4,
    );
    expect(audio.size).toBeGreaterThan(0);
    expect(audio.type).toContain('audio');
  });

  // The dialogue endpoint has its own body shape (inputs[], settings.similarity, future_text)
  it.skipIf(!apiKey)('generates audio for a v4 dialogue line with an audio tag and context', async () => {
    const text = elevenLabsLineText(
      { speaker: 'Ricky', text: 'Been fishing here for years.', deliveryNote: 'nervous' },
      ElevenLabsSpeechModel.ELEVEN_V4,
    );
    expect(text).toEqual('[nervous] Been fishing here for years.');

    const audio = await speakDialogue(
      text,
      defaultElevenLabsTTSSettings.voice,
      ElevenLabsSpeechModel.ELEVEN_V4,
      'How long have you been coming here?',
    );
    expect(audio.size).toBeGreaterThan(0);
    expect(audio.type).toContain('audio');
  });

  // v4 Turbo on the same HTTP dialogue endpoint, with the real voice settings values
  it.skipIf(!apiKey)('generates audio for a v4 turbo dialogue line', async () => {
    const audio = await speakDialogue(
      '[cheerful] Been fishing here for years.',
      defaultElevenLabsTTSSettings.voice,
      ElevenLabsSpeechModel.ELEVEN_V4_TURBO,
      'How long have you been coming here?',
    );
    expect(audio.size).toBeGreaterThan(0);
    expect(audio.type).toContain('audio');
  });

  // The API accepts previous_request_ids on both endpoints: the second request of a
  // stitched chain names the first by its request-id header
  it.skipIf(!apiKey)('accepts previous_request_ids on the dialogue endpoint', async () => {
    const first = buildElevenLabsDialogueRequest({
      text: 'Been fishing here for years.',
      voiceId: defaultElevenLabsTTSSettings.voice,
      endpoint: defaultElevenLabsEndpoint,
      apiKey: apiKey as string,
      settings: { ...defaultElevenLabsTTSSettings, model: ElevenLabsSpeechModel.ELEVEN_V4 },
    });
    const firstResponse = await fetch(first.url, {
      method: 'POST',
      headers: first.headers,
      body: JSON.stringify(first.body),
    });
    expect(firstResponse.ok).toBe(true);
    const requestId = firstResponse.headers.get('request-id');
    expect(requestId).toBeTruthy();
    await firstResponse.blob();

    // Built exactly as the renderer builds a stitched chunk: the line before rides along as
    // previousText too. The builder must send only the ids; both together is a 400.
    const second = buildElevenLabsDialogueRequest({
      text: 'Never caught a thing, mind you.',
      voiceId: defaultElevenLabsTTSSettings.voice,
      endpoint: defaultElevenLabsEndpoint,
      apiKey: apiKey as string,
      settings: { ...defaultElevenLabsTTSSettings, model: ElevenLabsSpeechModel.ELEVEN_V4 },
      previousText: 'Been fishing here for years.',
      nextText: 'Not once.',
      previousRequestIds: [requestId as string],
    });
    expect('previous_text' in second.body).toBe(false);
    expect(second.body.previous_request_ids).toEqual([requestId]);
    const secondResponse = await fetch(second.url, {
      method: 'POST',
      headers: second.headers,
      body: JSON.stringify(second.body),
    });
    expect(secondResponse.ok).toBe(true);
    expect((await secondResponse.blob()).size).toBeGreaterThan(0);
  });

  it.skipIf(!apiKey)('generates audio with the voice cast for a sim', async () => {
    const sim: SentientSim = {
      careers: [],
      name: 'Ricky Rickerson',
      age: SimAge.ADULT,
      sim_id: '1',
      gender: 'Male',
      traits: ['trait_Evil'],
      moods: [],
      is_ghost: false,
      grubby: false,
      in_pool: false,
      is_at_home: false,
      is_dying: false,
      is_human: true,
      is_inside_building: false,
      is_outside: false,
      is_pet: false,
      on_fire: false,
      on_home_lot: false,
      sleeping: false,
      is_pregnant: false,
      is_player_sim: true,
    };

    const audio = await speak(
      'Been fishing here for years.',
      castElevenLabsVoice(sim),
      ElevenLabsSpeechModel.ELEVEN_V3,
    );
    expect(audio.size).toBeGreaterThan(0);
  });

  it.skipIf(!apiKey)('looks up the details shown after a voice test', async () => {
    const { url, headers } = buildElevenLabsVoiceRequest({
      voiceId: defaultElevenLabsTTSSettings.voice,
      endpoint: defaultElevenLabsEndpoint,
      apiKey: apiKey as string,
    });

    const response = await fetch(url, { headers });
    expect(response.ok).toBe(true);

    const voice = toElevenLabsVoiceInfo(
      defaultElevenLabsTTSSettings.voice,
      (await response.json()) as ElevenLabsVoiceResponse,
    );

    expect(voice.voiceId).toEqual(defaultElevenLabsTTSSettings.voice);
    expect(voice.name).not.toEqual(defaultElevenLabsTTSSettings.voice);
    expect(voice.labels.length).toBeGreaterThan(0);
  });

  // with-timestamps: the alignment lines up with the text as sent, tag prefix included,
  // so the mod's word reveal can trust it (voice/lineTiming.ts alignmentToCharMs)
  async function speakTimed(sentText: string, lineText: string, model: string, stream = false) {
    const params = {
      text: sentText,
      voiceId: defaultElevenLabsTTSSettings.voice,
      endpoint: defaultElevenLabsEndpoint,
      apiKey: apiKey as string,
      settings: { ...defaultElevenLabsTTSSettings, model },
      stream,
      timestamps: true,
    };
    const { url, headers, body } = usesDialogueEndpoint(model)
      ? buildElevenLabsDialogueRequest(params)
      : buildElevenLabsSpeechRequest(params);
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!response.ok) {
      throw new Error(`ElevenLabs returned ${response.status}: ${await response.text()}`);
    }
    if (!stream) {
      const chunk = parseTimestampsJson(await response.json());
      return { bytes: chunk.bytes.length, chunks: 1, charMs: alignmentToCharMs(chunk.alignment, sentText, lineText) };
    }
    const reader = (response.body as ReadableStream<Uint8Array>).pipeThrough(ndjsonTimestampChunks()).getReader();
    const acc = emptyAlignment();
    let bytes = 0;
    let chunks = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks += 1;
      bytes += value.bytes.length;
      if (value.alignment) mergeChunkAlignment(acc, value.alignment);
    }
    return { bytes, chunks, charMs: alignmentToCharMs(acc, sentText, lineText) };
  }

  it.skipIf(!apiKey)('times a plain line with the buffered endpoint', async () => {
    const line = 'Been fishing here for years.';
    const timed = await speakTimed(line, line, ElevenLabsSpeechModel.ELEVEN_V3);
    expect(timed.bytes).toBeGreaterThan(0);
    expect(timed.charMs).toHaveLength(line.length);
    const words = wordStartsMs(line, timed.charMs as number[]);
    expect(words.partial).toBe(false);
    expect(words.word_ms).toHaveLength(5);
    expect(words.word_ms[4]).toBeGreaterThan(words.word_ms[0]);
    log.info(`[IT] buffered v3 word_ms=${JSON.stringify(words.word_ms)}`);
  });

  it.skipIf(!apiKey)('times a v3 line behind its audio tag', async () => {
    const line = 'Been fishing here for years.';
    const sent = elevenLabsLineText(
      { speaker: 'Ricky', text: line, deliveryNote: 'nervous' },
      ElevenLabsSpeechModel.ELEVEN_V3,
    );
    const timed = await speakTimed(sent, line, ElevenLabsSpeechModel.ELEVEN_V3);
    expect(timed.charMs).toHaveLength(line.length);
    log.info(`[IT] tagged v3 word_ms=${JSON.stringify(wordStartsMs(line, timed.charMs as number[]).word_ms)}`);
  });

  it.skipIf(!apiKey)('times a v4 dialogue line', async () => {
    const line = 'Been fishing here for years.';
    const sent = elevenLabsLineText(
      { speaker: 'Ricky', text: line, deliveryNote: 'nervous' },
      ElevenLabsSpeechModel.ELEVEN_V4,
    );
    const timed = await speakTimed(sent, line, ElevenLabsSpeechModel.ELEVEN_V4);
    expect(timed.bytes).toBeGreaterThan(0);
    expect(timed.charMs).toHaveLength(line.length);
    log.info(`[IT] v4 dialogue word_ms=${JSON.stringify(wordStartsMs(line, timed.charMs as number[]).word_ms)}`);
  });

  it.skipIf(!apiKey)('times a streamed v3 line chunk by chunk', async () => {
    const line = 'Been fishing here for years, and I will keep coming back until the lake runs dry.';
    const timed = await speakTimed(line, line, ElevenLabsSpeechModel.ELEVEN_V3, true);
    expect(timed.bytes).toBeGreaterThan(0);
    expect(timed.chunks).toBeGreaterThan(0);
    expect(timed.charMs).toHaveLength(line.length);
    const words = wordStartsMs(line, timed.charMs as number[]);
    expect(words.partial).toBe(false);
    // the time base is settled by mergeChunkAlignment: strictly forward across chunks
    expect(words.word_ms.every((t, i) => i === 0 || t >= words.word_ms[i - 1])).toBe(true);
    log.info(`[IT] streamed v3 chunks=${timed.chunks} word_ms=${JSON.stringify(words.word_ms)}`);
  });

  // The catalog hardcodes voice ids; this catches ElevenLabs dropping one entirely.
  // Membership in GET /voices is the wrong check — that only lists the account's own voices.
  it.skipIf(!apiKey)(
    'every cast voice id still resolves',
    async () => {
      const unresolved: string[] = [];

      for (const voice of elevenLabsVoiceCatalog) {
        const { url, headers } = buildElevenLabsVoiceRequest({
          voiceId: voice.voiceId,
          endpoint: defaultElevenLabsEndpoint,
          apiKey: apiKey as string,
        });

        const response = await fetch(url, { headers });
        if (!response.ok) {
          unresolved.push(`${voice.name} (${voice.voiceId}): ${response.status}`);
        }
      }

      expect(unresolved).toEqual([]);
    },
    60000,
  );
});
