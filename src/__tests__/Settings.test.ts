import { ApiType } from 'main/sentient-sims/models/ApiType';
import { SettingsEnum } from 'main/sentient-sims/models/SettingsEnum';
import { defaultTwitchChatVoiceId } from 'main/sentient-sims/constants';
import { ApiContext } from 'main/sentient-sims/services/ApiContext';
import { NovelAIService } from 'main/sentient-sims/services/NovelAIService';
import { OpenAIService } from 'main/sentient-sims/services/OpenAIService';
import { SentientSimsAIService } from 'main/sentient-sims/services/SentientSimsAIService';
import { LLaMaTokenCounter } from 'main/sentient-sims/tokens/LLaMaTokenCounter';
import { NovelAITokenCounter } from 'main/sentient-sims/tokens/NovelAITokenCounter';
import { OpenAITokenCounter } from 'main/sentient-sims/tokens/OpenAITokenCounter';
import { mockEnvironment } from './util';

describe('Settings', () => {
  let ctx: ApiContext;

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const getAssetPath = (...paths: string[]) => {
      return '';
    };
    const { directoryService, settingsService } = mockEnvironment();
    ctx = new ApiContext({
      getAssetPath,
      port: 25198,
      settingsService,
      directoryService,
      appVersion: '1.0.0',
    });
  });

  it('should return default value', () => {
    const model = ctx.settings.openaiModel;
    expect(model).toEqual('gpt-4o-mini');
  });

  it('twitch chat voice defaults: speaking on, empty voice id falls back to the built-in voice', () => {
    expect(ctx.settings.twitchSpeakQuestions).toBe(true);
    expect(ctx.settings.twitchChatVoiceId).toEqual(defaultTwitchChatVoiceId);
    ctx.settings.set(SettingsEnum.TWITCH_CHAT_VOICE_ID, '  voice-abc  ');
    expect(ctx.settings.twitchChatVoiceId).toEqual('voice-abc');
    ctx.settings.set(SettingsEnum.TWITCH_SPEAK_QUESTIONS, false);
    expect(ctx.settings.twitchSpeakQuestions).toBe(false);
  });

  it('Plum defaults: on, no key, Opus, writes allowed, 30 director ticks an hour', () => {
    expect(ctx.settings.plumEnabled).toBe(true);
    expect(ctx.settings.plumApiKey).toBe('');
    expect(ctx.settings.plumModel).toBe('claude-opus-5-5');
    expect(ctx.settings.plumAllowWrites).toBe(true);
    expect(ctx.settings.plumDirectorMaxTicksPerHour).toBe(30);
    ctx.settings.set(SettingsEnum.PLUM_API_KEY, '  sk-ant-x  ');
    ctx.settings.set(SettingsEnum.PLUM_MODEL, '   ');
    expect(ctx.settings.plumApiKey).toBe('sk-ant-x');
    expect(ctx.settings.plumModel).toBe('claude-opus-5-5');
  });

  it('autonomy parts 6 and 7 defaults: legacy tick off, night call on, the why voiced', () => {
    ctx.settings.set(SettingsEnum.JEV_DAY_AUTONOMY, true);
    expect(ctx.settings.cognitionLegacyTick).toBe(false);
    expect(ctx.settings.intentionNightCallEnabled).toBe(true);
    expect(ctx.settings.intentionVoiceWhy).toBe(true);
    ctx.settings.set(SettingsEnum.COGNITION_LEGACY_TICK, true);
    ctx.settings.set(SettingsEnum.INTENTION_NIGHT_CALL_ENABLED, false);
    ctx.settings.set(SettingsEnum.INTENTION_VOICE_WHY, false);
    expect(ctx.settings.cognitionLegacyTick).toBe(true);
    expect(ctx.settings.intentionNightCallEnabled).toBe(false);
    expect(ctx.settings.intentionVoiceWhy).toBe(false);
  });

  it('get ai type openai', () => {
    ctx.settings.aiApiType = ApiType.OpenAI;
    expect(ctx.tokenCounter instanceof OpenAITokenCounter).toBeTruthy();

    expect(ctx.genai instanceof OpenAIService).toBeTruthy();
  });

  it('get ai type novelai', () => {
    ctx.settings.aiApiType = ApiType.NovelAI;
    expect(ctx.tokenCounter instanceof NovelAITokenCounter).toBeTruthy();

    expect(ctx.genai instanceof NovelAIService).toBeTruthy();
  });

  it('get ai type custom', () => {
    ctx.settings.aiApiType = ApiType.CustomAI;
    expect(ctx.tokenCounter instanceof LLaMaTokenCounter).toBeTruthy();

    expect(ctx.genai instanceof SentientSimsAIService).toBeTruthy();
  });

  it('get ai type sentient sims', () => {
    ctx.settings.aiApiType = ApiType.SentientSimsAI;
    expect(ctx.tokenCounter instanceof LLaMaTokenCounter).toBeTruthy();

    expect(ctx.genai instanceof SentientSimsAIService).toBeTruthy();
  });

  it('ai api type from get returns correct value', () => {
    expect(ctx.settings.aiApiType).toEqual(ApiType.OpenAI);
  });

  it('ai api type from get returns correct value after set', () => {
    ctx.settings.aiApiType = ApiType.ElevenLabs;
    expect(ctx.settings.aiApiType).toEqual(ApiType.ElevenLabs);
  });

  it('pets, babies and infants speak unless the player switches them off', () => {
    expect(ctx.settings.nonControllableSimsSpeak).toBe(true);
    ctx.settings.set(SettingsEnum.NON_CONTROLLABLE_SIMS_SPEAK, false);
    expect(ctx.settings.nonControllableSimsSpeak).toBe(false);
  });
});
