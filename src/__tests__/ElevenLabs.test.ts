import {
  buildElevenLabsDialogueRequest,
  buildElevenLabsLineRequest,
  buildElevenLabsSpeechRequest,
  dialogueContext,
  ELEVENLABS_DIALOGUE_CONTEXT_CHARS,
  elevenLabsLineText,
  isElevenLabsV3,
  isElevenLabsV4,
  ndjsonTimestampChunks,
  parseTimestampsJson,
  resolvedVoiceSettings,
  snapStabilityForModel,
  supportsAudioTags,
  usesDialogueEndpoint,
} from 'main/sentient-sims/clients/ElevenLabsTTSRequest';
import {
  defaultElevenLabsTTSSettings,
  defaultElevenLabsVoiceSettings,
  ElevenLabsOutputFormat,
  ElevenLabsSpeechModel,
  ElevenLabsTTSSettings,
  toSpeechModel,
} from 'main/sentient-sims/models/ElevenLabsTTSSettings';
import { buildElevenLabsVoiceRequest, toElevenLabsVoiceInfo } from 'main/sentient-sims/clients/ElevenLabsVoiceRequest';
import { elevenLabsErrorMessage } from 'main/sentient-sims/clients/ElevenLabsError';
import { DialogueLine } from 'main/sentient-sims/formatter/PromptFormatter';
import { defaultElevenLabsEndpoint } from 'main/sentient-sims/constants';

const rachelVoiceId = '21m00Tcm4TlvDq8ikWAM';
const defaultStability = defaultElevenLabsVoiceSettings.stability as number;
const defaultSimilarity = defaultElevenLabsVoiceSettings.similarity_boost as number;
const ttsQuery = `?output_format=${defaultElevenLabsTTSSettings.output_format}`;

function settings(overrides?: Partial<ElevenLabsTTSSettings>): ElevenLabsTTSSettings {
  return { ...defaultElevenLabsTTSSettings, ...overrides };
}

function buildRequest(text: string, voiceId: string, ttsSettings: ElevenLabsTTSSettings) {
  return buildElevenLabsSpeechRequest({
    text,
    voiceId,
    endpoint: defaultElevenLabsEndpoint,
    apiKey: 'test-key',
    settings: ttsSettings,
  });
}

describe('ElevenLabs speech model', () => {
  it('accepts eleven_v3', () => {
    expect(toSpeechModel('eleven_v3')).toEqual(ElevenLabsSpeechModel.ELEVEN_V3);
    expect(isElevenLabsV3(ElevenLabsSpeechModel.ELEVEN_V3)).toBe(true);
    expect(isElevenLabsV3(ElevenLabsSpeechModel.ELEVEN_FLASH_V2_5)).toBe(false);
  });

  it('accepts eleven_v3_conversational and treats it as v3', () => {
    expect(toSpeechModel('eleven_v3_conversational')).toEqual(ElevenLabsSpeechModel.ELEVEN_V3_CONVERSATIONAL);
    expect(isElevenLabsV3(ElevenLabsSpeechModel.ELEVEN_V3_CONVERSATIONAL)).toBe(true);
  });

  it('accepts eleven_v4 and eleven_v4_turbo as v4, not v3', () => {
    expect(toSpeechModel('eleven_v4')).toEqual(ElevenLabsSpeechModel.ELEVEN_V4);
    expect(toSpeechModel('eleven_v4_turbo')).toEqual(ElevenLabsSpeechModel.ELEVEN_V4_TURBO);
    expect(isElevenLabsV4(ElevenLabsSpeechModel.ELEVEN_V4)).toBe(true);
    expect(isElevenLabsV4(ElevenLabsSpeechModel.ELEVEN_V4_TURBO)).toBe(true);
    expect(isElevenLabsV4(ElevenLabsSpeechModel.ELEVEN_V3)).toBe(false);
    expect(isElevenLabsV3(ElevenLabsSpeechModel.ELEVEN_V4)).toBe(false);
  });

  it('reads audio tags on v3 and v4 only', () => {
    expect(supportsAudioTags(ElevenLabsSpeechModel.ELEVEN_V3)).toBe(true);
    expect(supportsAudioTags(ElevenLabsSpeechModel.ELEVEN_V3_CONVERSATIONAL)).toBe(true);
    expect(supportsAudioTags(ElevenLabsSpeechModel.ELEVEN_V4)).toBe(true);
    expect(supportsAudioTags(ElevenLabsSpeechModel.ELEVEN_V4_TURBO)).toBe(true);
    expect(supportsAudioTags(ElevenLabsSpeechModel.ELEVEN_FLASH_V2_5)).toBe(false);
    expect(supportsAudioTags(ElevenLabsSpeechModel.ELEVEN_MULTILINGUAL_V2)).toBe(false);
  });

  it('sends only v4 to the dialogue endpoint', () => {
    expect(usesDialogueEndpoint(ElevenLabsSpeechModel.ELEVEN_V4)).toBe(true);
    expect(usesDialogueEndpoint(ElevenLabsSpeechModel.ELEVEN_V4_TURBO)).toBe(true);
    expect(usesDialogueEndpoint(ElevenLabsSpeechModel.ELEVEN_V3)).toBe(false);
    expect(usesDialogueEndpoint(ElevenLabsSpeechModel.ELEVEN_FLASH_V2_5)).toBe(false);
  });

  it('keeps flash as the default so existing users are unchanged', () => {
    expect(defaultElevenLabsTTSSettings.model).toEqual(ElevenLabsSpeechModel.ELEVEN_FLASH_V2_5);
  });

  it('rejects an unknown model', () => {
    expect(() => toSpeechModel('eleven_not_a_model')).toThrow();
  });

  it('defaults to a speed the API accepts', () => {
    expect(defaultElevenLabsVoiceSettings.speed).toBeGreaterThanOrEqual(0.7);
    expect(defaultElevenLabsVoiceSettings.speed).toBeLessThanOrEqual(1.2);
  });

  it('defaults to real stability and similarity, not the 0/0 corner', () => {
    expect(defaultStability).toBeGreaterThan(0);
    expect(defaultStability).toBeLessThanOrEqual(1);
    expect(defaultSimilarity).toBeGreaterThan(0);
    expect(defaultSimilarity).toBeLessThanOrEqual(1);
  });
});

describe('resolvedVoiceSettings', () => {
  it('returns what the user stored', () => {
    const resolved = resolvedVoiceSettings(
      settings({
        voice_settings: { stability: 0.6, similarity_boost: 0.2, style: 0.1, use_speaker_boost: false, speed: 0.9 },
      }),
    );
    expect(resolved).toEqual({
      stability: 0.6,
      similarity_boost: 0.2,
      style: 0.1,
      use_speaker_boost: false,
      speed: 0.9,
    });
  });

  it('treats a stored object with no stability as legacy: both sliders get the defaults', () => {
    // What every pre-slider install has on disk: the old default's similarity_boost 0,
    // never chosen by anyone
    const resolved = resolvedVoiceSettings(
      settings({ voice_settings: { similarity_boost: 0, style: 0, use_speaker_boost: true, speed: 1.1 } }),
    );
    expect(resolved.stability).toEqual(defaultStability);
    expect(resolved.similarity_boost).toEqual(defaultSimilarity);
    expect(resolved.speed).toEqual(1.1);
  });

  it('fills everything from the defaults when nothing is stored', () => {
    expect(resolvedVoiceSettings({ ...defaultElevenLabsTTSSettings, voice_settings: undefined })).toEqual(
      defaultElevenLabsVoiceSettings,
    );
  });
});

describe('snapStabilityForModel', () => {
  it('snaps v3 stability to Creative, Natural or Robust', () => {
    expect(snapStabilityForModel(0.35, 'eleven_v3')).toEqual(0.5);
    expect(snapStabilityForModel(0.2, 'eleven_v3_conversational')).toEqual(0);
    expect(snapStabilityForModel(0.8, 'eleven_v3')).toEqual(1);
  });

  it('leaves every other model alone', () => {
    expect(snapStabilityForModel(0.35, 'eleven_v4')).toEqual(0.35);
    expect(snapStabilityForModel(0.35, 'eleven_flash_v2_5')).toEqual(0.35);
  });
});

describe('buildElevenLabsSpeechRequest', () => {
  it('targets the voice on the text-to-speech endpoint', () => {
    const request = buildRequest('Hello there.', rachelVoiceId, settings());
    expect(request.url).toEqual(`${defaultElevenLabsEndpoint}/text-to-speech/${rachelVoiceId}${ttsQuery}`);
    expect(request.headers['xi-api-key']).toEqual('test-key');
    expect(request.headers['Content-Type']).toEqual('application/json');
  });

  it('sends model_id so the configured model is not ignored', () => {
    const request = buildRequest('Hello there.', rachelVoiceId, settings({ model: ElevenLabsSpeechModel.ELEVEN_V3 }));
    expect(request.body.model_id).toEqual('eleven_v3');
  });

  it('sends a custom voice model id verbatim', () => {
    const request = buildRequest('Hello there.', rachelVoiceId, settings({ model: 'eleven_turbo_v2_5' }));
    expect(request.body.model_id).toEqual('eleven_turbo_v2_5');
  });

  it('uses the configured speed', () => {
    const request = buildRequest(
      'Hello there.',
      rachelVoiceId,
      settings({
        voice_settings: { ...defaultElevenLabsVoiceSettings, speed: 0.9 },
      }),
    );
    expect(request.body.voice_settings.speed).toEqual(0.9);
  });

  it('falls back to the default speed for settings saved before the field existed', () => {
    const legacySettings: ElevenLabsTTSSettings = {
      model: ElevenLabsSpeechModel.ELEVEN_FLASH_V2_5,
      voice: rachelVoiceId,
      output_format: ElevenLabsOutputFormat.mp3_44100_128,
    };
    const request = buildRequest('Hello there.', rachelVoiceId, legacySettings);
    expect(request.body.voice_settings.speed).toEqual(defaultElevenLabsVoiceSettings.speed);
  });

  it('sends the text unchanged', () => {
    const request = buildRequest('Been fishing here for years.', rachelVoiceId, settings());
    expect(request.body.text).toEqual('Been fishing here for years.');
  });

  it('sends no speed on v4, which has no speed setting', () => {
    const request = buildRequest('Hello there.', rachelVoiceId, settings({ model: ElevenLabsSpeechModel.ELEVEN_V4 }));
    expect(request.body.voice_settings).toEqual({ stability: defaultStability, similarity_boost: defaultSimilarity });
    expect('speed' in request.body.voice_settings).toBe(false);

    const turbo = buildRequest(
      'Hello there.',
      rachelVoiceId,
      settings({ model: ElevenLabsSpeechModel.ELEVEN_V4_TURBO }),
    );
    expect('speed' in turbo.body.voice_settings).toBe(false);
  });

  it('keeps sending speed on flash', () => {
    const request = buildRequest('Hello there.', rachelVoiceId, settings());
    expect(request.body.voice_settings.speed).toEqual(defaultElevenLabsVoiceSettings.speed);
  });

  it('sends the stored stability and similarity', () => {
    const request = buildRequest(
      'Hello there.',
      rachelVoiceId,
      settings({ voice_settings: { ...defaultElevenLabsVoiceSettings, stability: 0.7, similarity_boost: 0.4 } }),
    );
    expect(request.body.voice_settings.stability).toEqual(0.7);
    expect(request.body.voice_settings.similarity_boost).toEqual(0.4);
  });

  it('applies the new defaults to a legacy stored object instead of its similarity 0', () => {
    const request = buildRequest(
      'Hello there.',
      rachelVoiceId,
      settings({ voice_settings: { similarity_boost: 0, style: 0, use_speaker_boost: true, speed: 1.2 } }),
    );
    expect(request.body.voice_settings.stability).toEqual(defaultStability);
    expect(request.body.voice_settings.similarity_boost).toEqual(defaultSimilarity);
  });

  it('sends style and speaker boost on the v2-era models only', () => {
    const flash = buildRequest('Hello there.', rachelVoiceId, settings());
    expect(flash.body.voice_settings.style).toEqual(defaultElevenLabsVoiceSettings.style);
    expect(flash.body.voice_settings.use_speaker_boost).toEqual(true);

    const multilingual = buildRequest(
      'Hello there.',
      rachelVoiceId,
      settings({ model: ElevenLabsSpeechModel.ELEVEN_MULTILINGUAL_V2 }),
    );
    expect('style' in multilingual.body.voice_settings).toBe(true);

    const v3 = buildRequest('Hello there.', rachelVoiceId, settings({ model: ElevenLabsSpeechModel.ELEVEN_V3 }));
    expect('style' in v3.body.voice_settings).toBe(false);
    expect('use_speaker_boost' in v3.body.voice_settings).toBe(false);

    const v4 = buildRequest('Hello there.', rachelVoiceId, settings({ model: ElevenLabsSpeechModel.ELEVEN_V4 }));
    expect('style' in v4.body.voice_settings).toBe(false);
    expect('use_speaker_boost' in v4.body.voice_settings).toBe(false);
  });

  it('snaps stability to a v3 preset on v3 only', () => {
    const v3 = buildRequest('Hello there.', rachelVoiceId, settings({ model: ElevenLabsSpeechModel.ELEVEN_V3 }));
    expect([0, 0.5, 1]).toContain(v3.body.voice_settings.stability);

    const v4 = buildRequest('Hello there.', rachelVoiceId, settings({ model: ElevenLabsSpeechModel.ELEVEN_V4 }));
    expect(v4.body.voice_settings.stability).toEqual(defaultStability);
  });

  it('sends at most the last three previous_request_ids, and none when there are none', () => {
    const none = buildRequest('Hello there.', rachelVoiceId, settings());
    expect('previous_request_ids' in none.body).toBe(false);

    const stitched = buildElevenLabsSpeechRequest({
      text: 'Hello there.',
      voiceId: rachelVoiceId,
      endpoint: defaultElevenLabsEndpoint,
      apiKey: 'test-key',
      settings: settings(),
      previousRequestIds: ['a', 'b', 'c', 'd'],
    });
    expect(stitched.body.previous_request_ids).toEqual(['b', 'c', 'd']);
  });

  it('drops previous_text when stitching ids are sent: the API takes one or the other', () => {
    // 2026-10-05: both together got a 400 on the second chunk of every long reply
    const stitched = buildElevenLabsSpeechRequest({
      text: 'Never caught a thing, mind you.',
      voiceId: rachelVoiceId,
      endpoint: defaultElevenLabsEndpoint,
      apiKey: 'test-key',
      settings: settings(),
      previousText: 'Been fishing here for years.',
      nextText: 'Come in, then.',
      previousRequestIds: ['a'],
    });
    expect(stitched.body.previous_request_ids).toEqual(['a']);
    expect('previous_text' in stitched.body).toBe(false);
    expect(stitched.body.next_text).toEqual('Come in, then.');

    // Blank ids are not stitching, so the text stays
    const unstitched = buildElevenLabsSpeechRequest({
      text: 'Never caught a thing, mind you.',
      voiceId: rachelVoiceId,
      endpoint: defaultElevenLabsEndpoint,
      apiKey: 'test-key',
      settings: settings(),
      previousText: 'Been fishing here for years.',
      previousRequestIds: ['', ''],
    });
    expect(unstitched.body.previous_text).toEqual('Been fishing here for years.');
    expect('previous_request_ids' in unstitched.body).toBe(false);
  });

  it('omits previous_text and next_text unless given', () => {
    const request = buildRequest('Hello there.', rachelVoiceId, settings());
    expect('previous_text' in request.body).toBe(false);
    expect('next_text' in request.body).toBe(false);
  });

  it('sends the neighbouring lines as previous_text and next_text', () => {
    const request = buildElevenLabsSpeechRequest({
      text: 'Hello there.',
      voiceId: rachelVoiceId,
      endpoint: defaultElevenLabsEndpoint,
      apiKey: 'test-key',
      settings: settings(),
      previousText: 'Who goes there?',
      nextText: 'Come in, then.',
    });
    expect(request.body.previous_text).toEqual('Who goes there?');
    expect(request.body.next_text).toEqual('Come in, then.');
  });

  it('targets /stream when asked to', () => {
    const request = buildElevenLabsSpeechRequest({
      text: 'Hello there.',
      voiceId: rachelVoiceId,
      endpoint: defaultElevenLabsEndpoint,
      apiKey: 'test-key',
      settings: settings(),
      stream: true,
    });
    expect(request.url).toEqual(`${defaultElevenLabsEndpoint}/text-to-speech/${rachelVoiceId}/stream${ttsQuery}`);
  });

  it('sends no context on v3, which the API rejects with a 400', () => {
    const request = buildElevenLabsSpeechRequest({
      text: 'Hello there.',
      voiceId: rachelVoiceId,
      endpoint: defaultElevenLabsEndpoint,
      apiKey: 'test-key',
      settings: settings({ model: ElevenLabsSpeechModel.ELEVEN_V3 }),
      previousText: 'Who goes there?',
      nextText: 'Come in, then.',
    });
    expect(request.body.previous_text).toBeUndefined();
    expect(request.body.next_text).toBeUndefined();
  });

  it('targets the with-timestamps variants, buffered and streamed', () => {
    const base = {
      text: 'Hello there.',
      voiceId: rachelVoiceId,
      endpoint: defaultElevenLabsEndpoint,
      apiKey: 'test-key',
      settings: settings(),
    };
    expect(buildElevenLabsSpeechRequest({ ...base, timestamps: true }).url).toEqual(
      `${defaultElevenLabsEndpoint}/text-to-speech/${rachelVoiceId}/with-timestamps?output_format=mp3_44100_128`,
    );
    expect(buildElevenLabsSpeechRequest({ ...base, stream: true, timestamps: true }).url).toEqual(
      `${defaultElevenLabsEndpoint}/text-to-speech/${rachelVoiceId}/stream/with-timestamps?output_format=mp3_44100_128`,
    );
  });
});

describe('with-timestamps responses', () => {
  const alignment = {
    characters: ['H', 'i'],
    character_start_times_seconds: [0, 0.2],
    character_end_times_seconds: [0.2, 0.4],
  };

  it('parses the audio bytes and prefers the alignment of the text as sent', () => {
    const chunk = parseTimestampsJson({
      audio_base64: 'AQID',
      alignment,
      normalized_alignment: { ...alignment, characters: ['h', 'i'] },
    });
    expect(Array.from(chunk.bytes)).toEqual([1, 2, 3]);
    expect(chunk.alignment?.characters).toEqual(['H', 'i']);
  });

  it('falls back to the normalized alignment, and to none', () => {
    expect(parseTimestampsJson({ audio_base64: 'AQID', normalized_alignment: alignment }).alignment).toEqual(alignment);
    const bare = parseTimestampsJson({ audio_base64: 'AQID' });
    expect(bare.alignment).toBeNull();
    expect(parseTimestampsJson(null).bytes).toHaveLength(0);
  });

  it('splits a newline-delimited stream into chunks, the last line without a newline too', async () => {
    const lines = [
      JSON.stringify({ audio_base64: 'AQ==', alignment }),
      'not json',
      JSON.stringify({ audio_base64: 'Ag==', alignment: null }),
    ];
    const body = new TextEncoder().encode(`${lines[0]}\n${lines[1]}\n${lines[2]}`);
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        // split mid-object to prove buffering across reads
        controller.enqueue(body.slice(0, 20));
        controller.enqueue(body.slice(20));
        controller.close();
      },
    });
    const reader = source.pipeThrough(ndjsonTimestampChunks()).getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    expect(chunks).toHaveLength(2);
    expect(Array.from(chunks[0].bytes)).toEqual([1]);
    expect(chunks[0].alignment?.characters).toEqual(['H', 'i']);
    expect(Array.from(chunks[1].bytes)).toEqual([2]);
    expect(chunks[1].alignment).toBeNull();
  });
});

describe('buildElevenLabsDialogueRequest', () => {
  const v4 = settings({ model: ElevenLabsSpeechModel.ELEVEN_V4 });

  function buildDialogue(overrides?: {
    previousText?: string;
    nextText?: string;
    stream?: boolean;
    timestamps?: boolean;
  }) {
    return buildElevenLabsDialogueRequest({
      text: '[nervous] Been fishing here for years.',
      voiceId: rachelVoiceId,
      endpoint: defaultElevenLabsEndpoint,
      apiKey: 'test-key',
      settings: v4,
      ...overrides,
    });
  }

  it('targets text-to-dialogue with the output format as a query parameter', () => {
    const request = buildDialogue();
    expect(request.url).toEqual(
      `${defaultElevenLabsEndpoint}/text-to-dialogue?output_format=${defaultElevenLabsTTSSettings.output_format}`,
    );
    expect(request.headers['xi-api-key']).toEqual('test-key');
    expect(request.headers['Content-Type']).toEqual('application/json');
  });

  it('targets the stream variant before the query string', () => {
    const request = buildDialogue({ stream: true });
    expect(request.url).toEqual(
      `${defaultElevenLabsEndpoint}/text-to-dialogue/stream?output_format=${defaultElevenLabsTTSSettings.output_format}`,
    );
  });

  it('targets the with-timestamps variants before the query string', () => {
    expect(buildDialogue({ timestamps: true }).url).toEqual(
      `${defaultElevenLabsEndpoint}/text-to-dialogue/with-timestamps?output_format=${defaultElevenLabsTTSSettings.output_format}`,
    );
    expect(buildDialogue({ stream: true, timestamps: true }).url).toEqual(
      `${defaultElevenLabsEndpoint}/text-to-dialogue/stream/with-timestamps?output_format=${defaultElevenLabsTTSSettings.output_format}`,
    );
  });

  it('sends one voiced input, the model, and dialogue-style settings without speed', () => {
    const request = buildDialogue();
    expect(request.body.inputs).toEqual([{ text: '[nervous] Been fishing here for years.', voice_id: rachelVoiceId }]);
    expect(request.body.model_id).toEqual('eleven_v4');
    expect(request.body.settings).toEqual({ stability: defaultStability, similarity: defaultSimilarity });
    expect('similarity_boost' in request.body.settings).toBe(false);
    expect(JSON.stringify(request.body)).not.toContain('speed');
    expect(JSON.stringify(request.body)).not.toContain('style');
  });

  it('sends the stored stability and similarity as dialogue settings', () => {
    const request = buildElevenLabsDialogueRequest({
      text: 'Hello there.',
      voiceId: rachelVoiceId,
      endpoint: defaultElevenLabsEndpoint,
      apiKey: 'test-key',
      settings: settings({
        model: ElevenLabsSpeechModel.ELEVEN_V4,
        voice_settings: { ...defaultElevenLabsVoiceSettings, stability: 0.5, similarity_boost: 0.9 },
      }),
    });
    expect(request.body.settings).toEqual({ stability: 0.5, similarity: 0.9 });
  });

  it('sends at most the last three previous_request_ids', () => {
    expect('previous_request_ids' in buildDialogue().body).toBe(false);
    const stitched = buildElevenLabsDialogueRequest({
      text: 'Hello there.',
      voiceId: rachelVoiceId,
      endpoint: defaultElevenLabsEndpoint,
      apiKey: 'test-key',
      settings: v4,
      previousRequestIds: ['a', 'b', 'c', 'd'],
    });
    expect(stitched.body.previous_request_ids).toEqual(['b', 'c', 'd']);
  });

  it('drops previous_text when stitching ids are sent, and keeps future_text', () => {
    const stitched = buildElevenLabsDialogueRequest({
      text: 'Never caught a thing, mind you.',
      voiceId: rachelVoiceId,
      endpoint: defaultElevenLabsEndpoint,
      apiKey: 'test-key',
      settings: v4,
      previousText: 'Been fishing here for years.',
      nextText: 'Come in, then.',
      previousRequestIds: ['a'],
    });
    expect(stitched.body.previous_request_ids).toEqual(['a']);
    expect('previous_text' in stitched.body).toBe(false);
    expect(stitched.body.future_text).toEqual('Come in, then.');
  });

  it('omits context unless given', () => {
    const request = buildDialogue();
    expect('previous_text' in request.body).toBe(false);
    expect('future_text' in request.body).toBe(false);
  });

  it('sends the neighbouring lines as previous_text and future_text', () => {
    const request = buildDialogue({ previousText: 'Who goes there?', nextText: 'Come in, then.' });
    expect(request.body.previous_text).toEqual('Who goes there?');
    expect(request.body.future_text).toEqual('Come in, then.');
  });

  it('clamps context to 100 chars: the tail of the line before, the head of the line after', () => {
    const long = `${'a'.repeat(150)}END`;
    const request = buildDialogue({ previousText: long, nextText: `START${'b'.repeat(150)}` });
    expect(request.body.previous_text).toHaveLength(ELEVENLABS_DIALOGUE_CONTEXT_CHARS);
    expect(request.body.previous_text?.endsWith('END')).toBe(true);
    expect(request.body.future_text).toHaveLength(ELEVENLABS_DIALOGUE_CONTEXT_CHARS);
    expect(request.body.future_text?.startsWith('START')).toBe(true);
  });

  it('treats blank context as absent', () => {
    expect(dialogueContext('   ', 'previous')).toBeUndefined();
    expect(dialogueContext(undefined, 'next')).toBeUndefined();
    expect(dialogueContext(' short ', 'next')).toEqual('short');
  });
});

describe('buildElevenLabsLineRequest', () => {
  const params = {
    text: 'Hello there.',
    voiceId: rachelVoiceId,
    endpoint: defaultElevenLabsEndpoint,
    apiKey: 'test-key',
  };

  it('picks the dialogue endpoint for v4', () => {
    const request = buildElevenLabsLineRequest({ ...params, settings: settings({ model: 'eleven_v4_turbo' }) });
    expect(request.url).toContain('/text-to-dialogue?');
    expect('inputs' in request.body).toBe(true);
  });

  it('picks text-to-speech for everything else', () => {
    const request = buildElevenLabsLineRequest({ ...params, settings: settings({ model: 'eleven_v3' }) });
    expect(request.url).toEqual(`${defaultElevenLabsEndpoint}/text-to-speech/${rachelVoiceId}${ttsQuery}`);
    expect('text' in request.body).toBe(true);
  });
});

describe('buildElevenLabsVoiceRequest', () => {
  it('looks the voice up on the voices endpoint', () => {
    const request = buildElevenLabsVoiceRequest({
      voiceId: rachelVoiceId,
      endpoint: defaultElevenLabsEndpoint,
      apiKey: 'test-key',
    });
    expect(request.url).toEqual(`${defaultElevenLabsEndpoint}/voices/${rachelVoiceId}`);
    expect(request.headers['xi-api-key']).toEqual('test-key');
  });

  it('escapes a voice id that would otherwise change the path', () => {
    const request = buildElevenLabsVoiceRequest({
      voiceId: '../user/subscription',
      endpoint: defaultElevenLabsEndpoint,
      apiKey: 'test-key',
    });
    expect(request.url).toEqual(`${defaultElevenLabsEndpoint}/voices/..%2Fuser%2Fsubscription`);
  });
});

describe('toElevenLabsVoiceInfo', () => {
  it('reads the name, description, category and labels', () => {
    const voice = toElevenLabsVoiceInfo(rachelVoiceId, {
      voice_id: rachelVoiceId,
      name: 'Rachel',
      description: 'A calm narration voice.',
      category: 'premade',
      preview_url: 'https://example.com/preview.mp3',
      labels: { accent: 'american', age: 'young', gender: 'female', use_case: 'narration' },
    });

    expect(voice.name).toEqual('Rachel');
    expect(voice.description).toEqual('A calm narration voice.');
    expect(voice.category).toEqual('premade');
    expect(voice.previewUrl).toEqual('https://example.com/preview.mp3');
    expect(voice.labels).toEqual([
      { name: 'Accent', value: 'american' },
      { name: 'Age', value: 'young' },
      { name: 'Gender', value: 'female' },
      { name: 'Use case', value: 'narration' },
    ]);
  });

  it('keeps the requested id when a retired voice redirects to a replacement', () => {
    const voice = toElevenLabsVoiceInfo(rachelVoiceId, {
      voice_id: 'eLDc7xhWxG2FElT3kUTj',
      name: 'Janet',
      category: 'professional',
      labels: { accent: 'en-american' },
    });

    expect(voice.voiceId).toEqual(rachelVoiceId);
    expect(voice.redirectedTo).toEqual('eLDc7xhWxG2FElT3kUTj');
    expect(voice.name).toEqual('Janet');
  });

  it('reports no redirect when the requested voice answers for itself', () => {
    const voice = toElevenLabsVoiceInfo(rachelVoiceId, { voice_id: rachelVoiceId, name: 'Rachel' });

    expect(voice.redirectedTo).toBeUndefined();
  });

  it('takes the photo from the sharing block', () => {
    const voice = toElevenLabsVoiceInfo(rachelVoiceId, {
      name: 'Rachel',
      sharing: { image_url: 'https://example.com/rachel.jpg' },
    });

    expect(voice.imageUrl).toEqual('https://example.com/rachel.jpg');
  });

  it('falls back to shared details for a voice copied from the library', () => {
    const voice = toElevenLabsVoiceInfo(rachelVoiceId, {
      voice_id: rachelVoiceId,
      name: null,
      description: null,
      labels: {},
      sharing: {
        name: 'Ricky',
        description: 'A gravelly fisherman.',
        labels: { accent: 'southern' },
      },
    });

    expect(voice.name).toEqual('Ricky');
    expect(voice.description).toEqual('A gravelly fisherman.');
    expect(voice.labels).toEqual([{ name: 'Accent', value: 'southern' }]);
  });

  it('drops empty labels instead of rendering blank chips', () => {
    const voice = toElevenLabsVoiceInfo(rachelVoiceId, {
      name: 'Rachel',
      labels: { accent: 'american', age: '', gender: null },
    });

    expect(voice.labels).toEqual([{ name: 'Accent', value: 'american' }]);
  });

  it('falls back to the voice id when the response has no name at all', () => {
    const voice = toElevenLabsVoiceInfo(rachelVoiceId, {});

    expect(voice.voiceId).toEqual(rachelVoiceId);
    expect(voice.name).toEqual(rachelVoiceId);
    expect(voice.labels).toEqual([]);
    expect(voice.imageUrl).toBeUndefined();
  });
});

describe('elevenLabsErrorMessage', () => {
  it('unwraps the message instead of showing the raw JSON envelope', () => {
    const body = JSON.stringify({
      detail: {
        type: 'authentication_error',
        code: 'unauthorized',
        message: 'Invalid API key',
        status: 'invalid_api_key',
        request_id: '4de962550b3acb8c31066745d73cf13a',
      },
    });

    expect(elevenLabsErrorMessage(401, body)).toEqual('Invalid API key');
  });

  it('handles a plain string detail', () => {
    expect(elevenLabsErrorMessage(422, JSON.stringify({ detail: 'voice_id is required' }))).toEqual(
      'voice_id is required',
    );
  });

  it('explains an unauthorized response with no usable body', () => {
    expect(elevenLabsErrorMessage(401, '')).toEqual('Invalid ElevenLabs key');
    expect(elevenLabsErrorMessage(401, JSON.stringify({ detail: {} }))).toEqual('Invalid ElevenLabs key');
  });

  it('falls back to the status when the body is not ElevenLabs JSON', () => {
    expect(elevenLabsErrorMessage(500, '')).toEqual('ElevenLabs returned 500');
    expect(elevenLabsErrorMessage(502, '<html>Bad Gateway</html>')).toEqual('<html>Bad Gateway</html>');
  });
});

describe('elevenLabsLineText', () => {
  const line: DialogueLine = { speaker: 'Ricky', text: 'Been fishing here for years.', deliveryNote: 'nervous' };

  it('turns a delivery note into a v3 audio tag', () => {
    expect(elevenLabsLineText(line, ElevenLabsSpeechModel.ELEVEN_V3)).toEqual('[nervous] Been fishing here for years.');
  });

  it('never speaks the delivery note on models without audio tags', () => {
    expect(elevenLabsLineText(line, ElevenLabsSpeechModel.ELEVEN_FLASH_V2_5)).toEqual('Been fishing here for years.');
    expect(elevenLabsLineText(line, ElevenLabsSpeechModel.ELEVEN_MULTILINGUAL_V2)).toEqual(
      'Been fishing here for years.',
    );
  });

  it('turns a delivery note into a v4 audio tag', () => {
    expect(elevenLabsLineText(line, ElevenLabsSpeechModel.ELEVEN_V4)).toEqual('[nervous] Been fishing here for years.');
    expect(elevenLabsLineText(line, ElevenLabsSpeechModel.ELEVEN_V4_TURBO)).toEqual(
      '[nervous] Been fishing here for years.',
    );
  });

  it('reads ttsText over text when a line carries one, tag included', () => {
    const phonetic: DialogueLine = {
      speaker: 'Ricky',
      text: 'Zorvath!',
      ttsText: '/ˈzɔːrvæθ/!',
      deliveryNote: 'excited',
    };
    expect(elevenLabsLineText(phonetic, ElevenLabsSpeechModel.ELEVEN_V4)).toEqual('[excited] /ˈzɔːrvæθ/!');
    expect(elevenLabsLineText(phonetic, ElevenLabsSpeechModel.ELEVEN_FLASH_V2_5)).toEqual('/ˈzɔːrvæθ/!');
  });

  it('leaves a line without a delivery note alone on v3', () => {
    const plain: DialogueLine = { speaker: 'Ricky', text: 'Been fishing here for years.' };
    expect(elevenLabsLineText(plain, ElevenLabsSpeechModel.ELEVEN_V3)).toEqual('Been fishing here for years.');
  });
});
