import log from 'electron-log';
import { AxiosError } from 'axios';
import OpenAI, { toFile } from 'openai';
import { GoogleGenAI, HarmBlockThreshold, HarmCategory } from '@google/genai';
import { ApiContext } from './ApiContext';
import { AIHealthCheckResponse } from '../models/AIHealthCheckResponse';
import { ApiType } from '../models/ApiType';
import { VoiceInputProvider, voiceInputProviderName } from '../models/VoiceInputProvider';
import { isOpenRouterEndpoint, openrouterAttributionHeaders } from '../models/OpenRouterModels';
import { VOICE_INPUT_LANGUAGES } from '../models/VoiceInputLanguages';
import { buildTranscriptionPrompt, keyterms, NameGroups, nameTerms, SIMS_WORLDS } from '../util/sttVocabulary';
import { isPromptEcho } from '../util/nameCorrection';
import { elevenLabsHealthCheck, elevenLabsTranscribe } from '../clients/ElevenLabsSTTRequest';
import { getRandomItem } from '../util/getRandomItem';
import { plainKeyTestError } from '../util/providerErrorWords';

export class TranscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscriptionError';
  }
}

// The server answers a bad request with its reason in the body
function errorMessage(error: unknown): string {
  if (error instanceof AxiosError) {
    const reason = (error.response?.data as { error?: unknown; message?: unknown } | undefined) ?? {};
    if (typeof reason.error === 'string') {
      return reason.error;
    }
    if (typeof reason.message === 'string') {
      return reason.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

// Local whisper servers ignore auth entirely; a placeholder keeps the SDK happy there
// while a real endpoint rejects it with a clear 401
const noKey = 'not-set';

const requestTimeoutMs = 30000;

const geminiSafetySettings = [
  HarmCategory.HARM_CATEGORY_HARASSMENT,
  HarmCategory.HARM_CATEGORY_HATE_SPEECH,
  HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
  HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
].map((category) => ({ category, threshold: HarmBlockThreshold.BLOCK_NONE }));

// Speech-to-text for the player's voice. OpenAI, OpenRouter and any custom server share
// the OpenAI /audio/transcriptions wire format and differ only in endpoint, key and
// model, so one cached OpenAI client serves all three. Gemini has no speech endpoint and
// is handed the audio inline by a text model. Sentient Sims AI speaks its own JSON
// request and login token. ElevenLabs Scribe reuses the ElevenLabs key from the Voices
// settings and is the one that takes the names in play as keyterms rather than a
// free-text hint.
export class TranscriptionService {
  private readonly ctx: ApiContext;

  private client?: OpenAI;

  private clientConfig?: string;

  constructor(ctx: ApiContext) {
    this.ctx = ctx;
  }

  get provider(): VoiceInputProvider {
    return this.ctx.settings.voiceInputProvider;
  }

  private connection(provider: VoiceInputProvider): { baseURL: string; apiKey: string } {
    const { settings } = this.ctx;
    switch (provider) {
      case ApiType.OpenAI:
        return {
          baseURL: settings.openaiEndpoint,
          apiKey: settings.openaiKey || process.env.OPENAI_KEY || noKey,
        };
      case ApiType.OpenRouter:
        return {
          baseURL: settings.openrouterEndpoint,
          apiKey: settings.openrouterKey || process.env.OPENROUTER_KEY || noKey,
        };
      default:
        return { baseURL: settings.voiceInputEndpoint, apiKey: settings.voiceInputKey || noKey };
    }
  }

  private getClient(provider: VoiceInputProvider): OpenAI {
    const { baseURL, apiKey } = this.connection(provider);
    const clientConfig = `${baseURL}:${apiKey}`;
    if (!this.client || this.clientConfig !== clientConfig) {
      this.client = new OpenAI({
        dangerouslyAllowBrowser: process.env.NODE_ENV === 'test',
        apiKey,
        baseURL,
        timeout: requestTimeoutMs,
        maxRetries: 0,
        defaultHeaders: isOpenRouterEndpoint(baseURL) ? openrouterAttributionHeaders : undefined,
      });
      this.clientConfig = clientConfig;
    }

    return this.client;
  }

  private geminiKeys(): string[] {
    return (this.ctx.settings.geminiKeys || '')
      .split(',')
      .map((key) => key.trim())
      .filter((key) => key.length > 0);
  }

  private getGeminiClient(): GoogleGenAI {
    const keys = this.geminiKeys();
    if (keys.length === 0) {
      throw new TranscriptionError('No Gemini API key set, add one under AI settings');
    }
    return new GoogleGenAI({ apiKey: getRandomItem(keys) });
  }

  // The names in play, tightest scope first. NEAR: the sims on the lot, everyone they
  // see, everyone the household knows. FAR: every participant the save has met and the
  // current location. Deliberately WIDE: the player pauses the game to talk, and a
  // paused report carries no sims, so a scene-scoped pool went empty at exactly the
  // moment it was needed (live 08-27).
  nameVocabulary(): { near: NameGroups; far: NameGroups } {
    try {
      const report = this.ctx.simStateCache.getReport();
      const onLot = (report?.sims ?? []).map((entry) => entry.sim_name ?? '').filter(Boolean);
      const perceived = (report?.sims ?? [])
        .flatMap((entry) => entry.sims.map((sim) => sim.name ?? ''))
        .filter(Boolean);
      const known = (report?.known_sims ?? []).map((sim) => sim.name ?? '').filter(Boolean);
      let participants: string[] = [];
      try {
        participants = this.ctx.participantRepository.getAllParticipants().map((participant) => participant.name ?? '');
      } catch {
        participants = [];
      }
      let locations: string[] = [];
      try {
        const lotId = report?.lot?.zone_id;
        if (lotId !== undefined) {
          locations = this.ctx.locationRepository
            .getAllLocations()
            .filter((location) => String(location.id) === String(lotId))
            .map((location) => location.name);
        }
      } catch {
        locations = [];
      }
      return { near: [onLot, perceived, known], far: [participants, locations] };
    } catch {
      return { near: [], far: [] };
    }
  }

  // V-7: the same names as one sentence, a soft transcription bias for the providers
  // that take a free-text prompt
  namePrompt(): string | undefined {
    const vocabulary = this.nameVocabulary();
    return buildTranscriptionPrompt([...vocabulary.near, ...vocabulary.far]);
  }

  async transcribe(
    audio: ArrayBuffer,
    mimeType = 'audio/webm',
    options: { namePrompt?: boolean } = {},
  ): Promise<string> {
    const language = this.ctx.settings.voiceInputLanguage;
    const withNames = options.namePrompt !== false;
    const { provider } = this;

    try {
      // Scribe takes the names as keyterms, never a prompt it could read back
      if (provider === ApiType.ElevenLabs) {
        return await this.transcribeWithScribe(audio, mimeType, language, withNames);
      }
      const prompt = withNames ? this.namePrompt() : undefined;
      let text: string;
      if (provider === ApiType.SentientSimsAI) {
        const format = mimeType.split(';')[0].split('/')[1] ?? 'webm';
        text = (
          await this.ctx.sentientSimsTranscription.transcribe(Buffer.from(audio), format, language, prompt)
        ).trim();
      } else if (provider === ApiType.Gemini) {
        text = await this.transcribeWithGemini(audio, mimeType, language, prompt);
      } else {
        text = await this.transcribeOpenAICompatible(provider, audio, mimeType, language, prompt);
      }
      return isPromptEcho(text, prompt) ? '' : text;
    } catch (error) {
      log.error(`Voice transcription failed (${voiceInputProviderName(provider)}):`, error);
      throw error instanceof TranscriptionError ? error : new TranscriptionError(errorMessage(error));
    }
  }

  private async transcribeOpenAICompatible(
    provider: VoiceInputProvider,
    audio: ArrayBuffer,
    mimeType: string,
    language: string,
    prompt: string | undefined,
  ): Promise<string> {
    const client = this.getClient(provider);
    // The filename extension is how whisper servers detect the container format
    const file = await toFile(Buffer.from(audio), 'speech.webm', { type: mimeType });
    const response = await client.audio.transcriptions.create({
      file,
      model: this.ctx.settings.voiceInputModelFor(provider) ?? '',
      ...(language ? { language } : {}),
      ...(prompt ? { prompt } : {}),
    });
    return response.text.trim();
  }

  // Scribe is told the spellings it should prefer: the names in play, then the game's
  // worlds (it spells "Del Sol Valley" as it hears it otherwise, and a sim remembers the
  // place), then the wider pool
  private async transcribeWithScribe(
    audio: ArrayBuffer,
    mimeType: string,
    language: string,
    withNames: boolean,
  ): Promise<string> {
    const apiKey = this.ctx.settings.elevenLabsKey;
    if (!apiKey) {
      throw new TranscriptionError('ElevenLabs API key is not set. Add it under Voices in Settings.');
    }
    const vocabulary = this.nameVocabulary();
    const text = await elevenLabsTranscribe({
      endpoint: this.ctx.settings.elevenLabsEndpoint,
      apiKey,
      audio: Buffer.from(audio),
      mimeType,
      languageCode: language || undefined,
      modelId: this.ctx.settings.voiceInputModelFor(ApiType.ElevenLabs),
      keyterms: withNames ? keyterms(nameTerms(vocabulary.near), SIMS_WORLDS, nameTerms(vocabulary.far)) : [],
    });
    return text.trim();
  }

  // Gemini hears the recording as an inline audio part next to a transcription
  // instruction; the names and language hints ride along as plain text
  private async transcribeWithGemini(
    audio: ArrayBuffer,
    mimeType: string,
    language: string,
    prompt: string | undefined,
  ): Promise<string> {
    const client = this.getGeminiClient();
    const model = this.ctx.settings.voiceInputModelFor(ApiType.Gemini) ?? '';
    const languageName = VOICE_INPUT_LANGUAGES.find((option) => option.code === language)?.name;
    const instruction = [
      'Transcribe the speech in this recording word for word.',
      'Reply with the transcript only, with no quotes, labels or commentary.',
      'If nothing is said, reply with nothing at all.',
      languageName ? `The speaker is speaking ${languageName}.` : undefined,
      prompt,
    ]
      .filter(Boolean)
      .join(' ');

    const response = await client.models.generateContent({
      model,
      config: {
        temperature: 0,
        safetySettings: geminiSafetySettings,
      },
      contents: [
        {
          role: 'user',
          parts: [
            { text: instruction },
            { inlineData: { mimeType: mimeType.split(';')[0], data: Buffer.from(audio).toString('base64') } },
          ],
        },
      ],
    });
    const text = response.text ?? '';
    return text
      .trim()
      .replace(/^["“](.*)["”]$/s, '$1')
      .trim();
  }

  async healthCheck(): Promise<AIHealthCheckResponse> {
    const { provider } = this;
    if (provider === ApiType.SentientSimsAI) {
      return this.ctx.sentientSimsTranscription.healthCheck();
    }

    if (provider === ApiType.ElevenLabs) {
      const apiKey = this.ctx.settings.elevenLabsKey;
      if (!apiKey) {
        return { error: 'not working, ElevenLabs API key is not set' };
      }
      try {
        await elevenLabsHealthCheck(this.ctx.settings.elevenLabsEndpoint, apiKey);
        return { status: 'OK' };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error('Error testing ElevenLabs transcription:', error);
        return { error: `not working, ${message}` };
      }
    }

    // No cheap transcription ping exists; a models listing works on every provider
    try {
      if (provider === ApiType.Gemini) {
        await this.getGeminiClient().models.list();
      } else {
        await this.getClient(provider).models.list();
      }
      return { status: 'OK' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Error testing transcription endpoint:', error);
      return { error: plainKeyTestError(message) };
    }
  }
}
