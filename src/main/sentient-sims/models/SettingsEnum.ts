export enum SettingsEnum {
  MOD_RELEASE = 'modRelease',
  OPENAI_MODEL = 'openaiModel',
  NOVELAI_MODEL = 'novelaiModel',
  SENTIENTSIMSAI_MODEL = 'sentientsimsAIModel',
  MODS_DIRECTORY = 'modsDirectory',
  AI_API_TYPE = 'aiApiType',
  ACCESS_TOKEN = 'accessToken',
  OPENAI_KEY = 'openaiKey',
  NOVELAI_KEY = 'novelaiKey',
  LOCALIZATION_ENABLED = 'localizationEnabled',
  LOCALIZATION_LANGUAGE = 'localizationLanguage',
  DEBUG_LOGS = 'debugLogs',
  NSFW_ENABLED = 'nsfwEnabled',
  DIRECTED_SCENES_ENABLED = 'directedScenesEnabled',
  MAPPING_NOTIFICATION_ENABLED = 'mappingNotificationEnabled',
  OPENAI_ENDPOINT = 'openaiEndpoint',
  OPENROUTER_KEY = 'openrouterKey',
  OPENROUTER_ENDPOINT = 'openrouterEndpoint',
  OPENROUTER_MODEL = 'openrouterModel',
  VLLM_ENDPOINT = 'vllmEndpoint',
  VLLM_APIKEY = 'vllmKey',
  VLLM_MODEL = 'vllmModel',
  KOBOLDAI_ENDPOINT = 'koboldAIEndpoint',
  SENTIENTSIMSAI_ENDPOINT = 'sentientsimsAIEndpoint',
  NOVELAI_ENDPOINT = 'novelAIEndpoint',
  NOVELAI_GENERATION_ENDPOINT = 'novelAIGenerationEndpoint',
  GEMINI_KEYS = 'geminiKeys', // Supports multiple keys separated by commas (e.g., "key1,key2,key3")
  GEMINI_ENDPOINT = 'geminiEndpoint',
  GEMINI_MODEL = 'geminiModel',
  TRAIT_MAPPING_PATH = 'traitMappingPath',
  TTS_ENABLED = 'ttsEnabled',
  TTS_API_TYPE = 'ttsApiType',
  TTS_VOLUME = 'ttsVolume',
  OPENAI_TTS_SETTINGS = 'openaiTtsSettings',
  SENTIENTSIMSAI_TTS_SETTINGS = 'sentientsimsaiTtsSettings',
  KOKOROAI_ENDPOINT = 'kokoroaiEndpoint',
  KOKOROAI_TTS_SETTINGS = 'kokoroaiTtsSettings',
  ELEVENLABS_KEY = 'elevenlabsKey',
  ELEVENLABS_ENDPOINT = 'elevenlabsEndpoint',
  ELEVENLABS_TTS_SETTINGS = 'elevenlabsTtsSettings',
  ELEVENLABS_VOICES = 'elevenlabsVoices',
  SETUP_WIZARD_PAGE = 'setupWizardPage',
  PATREON_LINKING = 'patreonLinking',
  MAX_RESPONSE_TOKENS = 'maxResponseTokens',
  GENERATION_TIMEOUT_SECONDS = 'generationTimeoutSeconds',
  GENERATION_CONCURRENCY = 'generationConcurrency',
  PREFETCH_MAX_QUEUE_DEPTH = 'prefetchMaxQueueDepth',
  // Legacy single-provider embedding selection; migrated into EMBEDDING_PROVIDER_CONFIGS
  EMBEDDING_API_TYPE = 'embeddingApiType',
  SENTIENTSIMSAI_EMBEDDING_MODEL = 'sentientsimsAIEmbeddingModel',
  EMBEDDING_PROVIDER_CONFIGS = 'embeddingProviderConfigs',
  DEFAULT_EMBEDDING_PROVIDER_CONFIG_ID = 'defaultEmbeddingProviderConfigId',
  AI_PROVIDER_CONFIGS = 'aiProviderConfigs',
  DEFAULT_AI_PROVIDER_CONFIG_ID = 'defaultAiProviderConfigId',
  AI_ACTION_PROVIDER_OVERRIDES = 'aiActionProviderOverrides',
  // Cognition (Block 9): the autonomous per-sim tick loop
  COGNITION_ENABLED = 'cognitionEnabled',
  COGNITION_AUTONOMY_LEVEL = 'cognitionAutonomyLevel', // off | suggest | full
  COGNITION_TICK_INTERVAL_SECONDS = 'cognitionTickIntervalSeconds',
  COGNITION_MAX_CONCURRENT = 'cognitionMaxConcurrent',
  COGNITION_PER_SIM_HOURLY_BUDGET = 'cognitionPerSimHourlyBudget',
  COGNITION_PIPELINE = 'cognitionPipeline', // legacy review dial; unused since the Action Scene pipeline
  // Full Autonomy: a tick/scene action score at or above this stages an Action Scene
  COGNITION_ACTION_SCORE_THRESHOLD = 'cognitionActionScoreThreshold',
  // Daily plans: nightly goals-from-pool + persona sentence + discretionary action loadout
  DAILY_GOALS_ENABLED = 'dailyGoalsEnabled',
  DAILY_LOADOUT_SIZE = 'dailyLoadoutSize',
  // Voice input: hold-to-talk mic capture transcribed via an OpenAI-compatible
  // /audio/transcriptions endpoint, injected into the game as the active sim speaking
  VOICE_INPUT_ENABLED = 'voiceInputEnabled',
  VOICE_INPUT_ENDPOINT = 'voiceInputEndpoint',
  VOICE_INPUT_KEY = 'voiceInputKey',
  VOICE_INPUT_MODEL = 'voiceInputModel',
  VOICE_INPUT_HOTKEY = 'voiceInputHotkey',
  VOICE_INPUT_HOTKEY_MODE = 'voiceInputHotkeyMode', // hold | toggle
  VOICE_INPUT_LANGUAGE = 'voiceInputLanguage', // ISO-639-1 hint, empty = auto-detect
  VOICE_INPUT_DEVICE_ID = 'voiceInputDeviceId', // empty = system default mic
  // V-1: voice/subtitle playback pauses with a user pause and paces with speed 2/3
  PLAYBACK_FOLLOWS_GAME_CLOCK = 'playbackFollowsGameClock',
  // V-3: who the player IS when they speak into the game (The Voice, guardian angel, ...)
  PLAYER_VOICE_PERSONA = 'playerVoicePersona',
  PLAYER_VOICE_PERSONA_BIO = 'playerVoicePersonaBio',
  // V-8: a second hotkey where speech is an ORDER to the sim, not talk
  VOICE_COMMAND_HOTKEY = 'voiceCommandHotkey',
  // V-5a: how many rounds a directed scene may continue itself
  SCENE_MAX_ROUNDS = 'sceneMaxRounds',
  // V-6: write a first description for undescribed sims/lots instead of the stock default
  GENERATED_DEFAULT_DESCRIPTIONS = 'generatedDefaultDescriptions',
  GAME_APP_PATH = 'gameAppPath',
  IMAGE_PROVIDER_CONFIGS = 'imageProviderConfigs',
  DEFAULT_IMAGE_PROVIDER_CONFIG_ID = 'defaultImageProviderConfigId',
}

export enum DeprecatedSettingsEnum {
  CUSTOM_LLM_ENABLED = 'customLLMEnabled',
}
