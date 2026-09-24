# 07 - Renderer UI (src/renderer minus voice/ and kokoro/)

Repo sentient-sims-app, branch jasmine-phase-3 @ 62b9bad. Read-only survey, 2026-09-23. Scope: 126 .ts/.tsx files, 16,823 lines, plus App.css, index.html, assets/. Every .ts/.tsx was read; the long ones (OnlineMappingBrowser, SetupWizardModal, TraitsPage, the two mapping modals) were read in full around every call site and skimmed through the layout code.

**Headline:** the renderer has almost no AUTONOMY UI. Cognition, daily plans and dispatch have no page and no settings. Only four things leak: the ConversationActions settings block, the voice "Command key", and the per-action override rows. The fourth is one label table. STREAM is one tab (Twitch), one IPC listener (scene-stop), and the updater. DEV is the debug-nav pages. Three findings matter more than the tiering:
1. **Paintings (CORE) has no page of its own.** It sits inside the DEV-only Chat page.
2. **The startup mod auto-install** in ModUpdateProvider must be killed in STREAM. Disabling the button does not stop it.
3. **Ctrl+Shift+D is a global shortcut that anyone can press.** "DEV" pages are hidden, not removed.

## 1. Pages / routes (index.tsx:42-97, createMemoryRouter; nav in MenuBar.tsx:54-67)

| Route | File | Nav | Shows | Class |
|---|---|---|---|---|
| `/` | HomePage.tsx | Home icon | Hero: ConnectionChip + ProviderHealthChip. Cards: UpdateComponent, DebugCard, MappingLeaderboard, ThankYouCardPatreon | CORE (UpdateComponent is STREAM-surgery) |
| `/sims` | SimsPage.tsx | always | DataGrid of participants: pinned voice (ElevenLabs/Kokoro), Facts button -> SimFactsDialog, description edit/delete | CORE (facts = dossier) |
| `/locations` | LocationsPage.tsx | always | DataGrid of locations, edit/delete | CORE |
| `/memories` | MemoriesPage.tsx | always | Live memory list (V-4 name tags), edit/delete; "View Prompt" (debug) -> MemoryTraceDialog | CORE, with the trace button DEV |
| `/settings` | SettingsPage.tsx | always | Tabs Settings / Voice / Twitch + Setup Wizard button | CORE, mixed (see section 2) |
| `/last-exception` | LastExceptionPage.tsx | DebugCard "Last Exceptions" button (not debug-gated) | lastException files, view and clear | CORE |
| `/chat` | ChatPage.tsx | DEBUG_NAV | Tab Chat: scenario tester, prompt editor, Send/Send 10, Play/Continue Scene, LLM exchange panels. **Tab Paintings: PaintingsPanel** | DEV host holding a CORE tab |
| `/traits` | TraitsPage.tsx | DEBUG_NAV | S4tk trait-mapping authoring and export | DEV |
| `/mapping-browser` | components/OnlineMappingBrowser.tsx | DEBUG_NAV | Browse, edit and publish interaction/animation mappings, including "Unmapped (seen in game)" and semantic search | CORE feature behind the debug nav (upstream mapper tool; Save Online gated by `isMapper()`) |
| `/ai-log` | AILogPage.tsx | DEBUG_NAV | Live list of every AI call (2 s poll) with the full prompt | DEV |
| `/offlinememory` | OfflineMemory.tsx | DEBUG_NAV | Save games in the local DB and their sims | DEV |
| `/logs` | LogViewerPage.tsx | SendLogButton "Logs" (debug only) | Live app log over ws://localhost:25146 | DEV |

Global overlays mounted in App.tsx and the providers:
- Announcements sidebar (App.tsx:37)
- PopupNotificationModal and CaughtErrorPopupNotificationModal (which leads to SendLogModal)
- AnimationMappingComponent and InteractionMappingComponent, opened by IPC from the mod's map request
- PatreonLinkingModal
- SetupWizardModal (from SetupWizardProvider)
- VoiceInputIndicator chip (VoiceInputProvider)
- Snackbar

All of these are CORE.

Debug mode (DebugModeProvider.tsx:28-32):
- It turns on from the IPC `debug-mode-toggle`, which main sends on a **globalShortcut Control+Shift+D** (registerDebugToggleHotkey.ts). A dev Patreon user can also turn it on by clicking the "Thank you for being a Dev!" button (PatreonComponent.tsx:64-71).
- It can never be turned off, and it is not persisted.

## 2. Settings UI inventory

| Where (file:line) | Control | SettingsEnum key(s) | Tier | CORE build |
|---|---|---|---|---|
| ModsDirectoryComponent | Mods dir picker (IPC dialog:selectDirectory) | MODS_DIRECTORY | CORE | keep |
| GameAppPathComponent (macOS only) | .app picker | GAME_APP_PATH | CORE | keep |
| settings/DirectedScenesSettingsComponent (SettingsPage:87) | checkbox | DIRECTED_SCENES_ENABLED | CORE (voiced scene pipeline). **Decision owed** | keep |
| settings/ConversationActionsSettingsComponent (SettingsPage:88) | checkbox + 1-10 slider | CONVERSATION_ACTIONS_ENABLED, CONVERSATION_ACTION_SCORE_THRESHOLD | **AUTONOMY** (CognitionService.actOnConversation) | **HIDE**. Nothing reads these once the backend is stripped |
| settings/DebugLogsSettingsComponent | checkbox | DEBUG_LOGS | CORE | keep |
| settings/ProviderConnectionSettingsComponent + ProviderConnectionPanel | per-provider accordions | OPENAI_KEY/ENDPOINT, OPENROUTER_KEY/ENDPOINT, VLLM_APIKEY/ENDPOINT, NOVELAI_KEY/ENDPOINT, KOBOLDAI_ENDPOINT, GEMINI_KEYS/ENDPOINT, SENTIENTSIMSAI_ENDPOINT | CORE | keep |
| settings/ProviderConfigsComponent x3 (text/image/embedding) | config tables, Test, Add/Edit | AI_PROVIDER_CONFIGS, DEFAULT_AI_PROVIDER_CONFIG_ID, IMAGE_PROVIDER_CONFIGS, DEFAULT_IMAGE_PROVIDER_CONFIG_ID, EMBEDDING_PROVIDER_CONFIGS, DEFAULT_EMBEDDING_PROVIDER_CONFIG_ID, SENTIENTSIMSAI_EMBEDDING_MODEL (read) | CORE | keep |
| ProviderConfigsComponent.tsx:617-655 "Per-Action Provider Overrides" | one Select per `AllAIActionTypes` (:626) | AI_ACTION_PROVIDER_OVERRIDES | CORE, but rows COGNITION, ACTION_SCENE, DAILY_PLAN, VOICE_COMMAND, ASK_TRIAGE, ASK_ACTION_MATCH, ASK_DECISION are **AUTONOMY** | **FILTER** the list (or tier-tag AllAIActionTypes in main/models/AIActionType.ts:42) |
| settings/LocalizationSettingsComponent | checkbox + text | LOCALIZATION_ENABLED, LOCALIZATION_LANGUAGE | CORE | keep |
| settings/AnimationMappingSettingsComponent (hidden for OpenAI) | checkbox | MAPPING_NOTIFICATION_ENABLED | CORE | keep |
| settings/AiMaxResponseLengthSettingsComponent (debug only) | slider 30-600 | MAX_RESPONSE_TOKENS | DEV | hide/strip |
| Voice tab: settings/VoiceSettingsComponent | TTS on, provider (SSAI / ElevenLabs only, :71-72), volume | TTS_ENABLED, TTS_API_TYPE, TTS_VOLUME | CORE | keep |
| settings/voice/SentientSimsAIVoiceSettingsComponent | model / voice blend / speed | SENTIENTSIMSAI_TTS_SETTINGS | CORE (Patreon-gated) | keep |
| settings/voice/ElevenLabsVoiceSettingsComponent | model, default voice id, key | ELEVENLABS_TTS_SETTINGS, ELEVENLABS_KEY | CORE | keep |
| settings/voice/OpenAI... and KokoroAIVoiceSettingsComponent | model/voice/local-remote | OPENAI_TTS_SETTINGS, KOKOROAI_TTS_SETTINGS, KOKOROAI_ENDPOINT | DEAD. Not selectable, and AudioContextProvider.tsx:52-59 cannot play them | delete |
| settings/voice/VoiceInputSettingsComponent | enable, hotkey + hold/toggle, persona + name + bio, follows game clock, STT endpoint/key/model/lang, mic, Test | VOICE_INPUT_ENABLED, VOICE_INPUT_HOTKEY, VOICE_INPUT_HOTKEY_MODE, PLAYER_VOICE_PERSONA(_NAME/_BIO), PLAYBACK_FOLLOWS_GAME_CLOCK, VOICE_INPUT_ENDPOINT/KEY/MODEL/LANGUAGE/DEVICE_ID | CORE (push-to-talk) | keep. The bio placeholder names "Jaz" (:216), so neutralise it |
| same file :165-184 "Command key" | select | VOICE_COMMAND_HOTKEY | **AUTONOMY** (VOICE_COMMAND action maps a spoken order onto the dispatch vocabulary) | **HIDE** |
| Twitch tab: settings/TwitchSettingsComponent (SettingsPage.tsx:30, 116-118) | 11 controls + device login | TWITCH_CHAT_ENABLED, TWITCH_CHANNEL, TWITCH_COMMAND_WORD, TWITCH_ASK_PERMISSION, TWITCH_VIEWER/GLOBAL_COOLDOWN_SECONDS, TWITCH_SIM_ALIASES, TWITCH_SPEAK_QUESTIONS, TWITCH_CHAT_VOICE_ID, TWITCH_FOLLOWERS_ONLY, TWITCH_CLIENT_ID | **STREAM** | **HIDE the tab**, since it is enum-driven (:27-31, :68) |
| Outside the settings page | ReleaseTypeSelector (UpdateComponent header); Setup wizard; TraitsPage | MOD_RELEASE; SETUP_WIZARD_PAGE, AI_API_TYPE; TRAIT_MAPPING_PATH (DEV) | CORE / CORE / DEV | |
| Written, never shown | useAuthCredentials.tsx:22 | ACCESS_TOKEN (Cognito idToken every 15 min) | CORE | keep |

Already headless, with no renderer UI: COGNITION_* (7 keys), ASK_ACTIONS_ENABLED, SCENE_MAX_ROUNDS, PLAYER_REPLY_MAX_TOKENS, PLAYER_CONVERSATION_IDLE_MINUTES, TWITCH_AUTH. There are no moodlet-tier keys in SettingsEnum. Nothing needs hiding for these.

Reads go through HTTP `GET /settings/app/:key` (useSetting.tsx:25). Writes go through IPC `set-setting`, debounced 600 ms (useSetting.tsx:43-46). A key the stripped backend no longer defines just falls back to the default in the UI. It does not crash.

## 3. Renderer -> main calls

HTTP to localhost:25148. The clients live in main/sentient-sims/clients but execute in the renderer.

| Route | Caller (file) | Tier |
|---|---|---|
| GET `/settings/app/:key` | hooks/useSetting | CORE |
| GET `/versions/app\|mod\|game` | VersionsProvider, ModUpdateProvider | CORE |
| GET `/websocket/isconnected` | WebsocketProvider | CORE |
| GET `/debug/test-ai` (?apiType, ?configId, ?apiKey) | AISettingsProvider:52 (auto 3.5 s after start), ProviderConfigsComponent:225, :475 | CORE |
| POST `/debug/send-logs` | components/SendLogModal | CORE |
| POST `/update/mod` | ModUpdateProvider:114 | CORE / STREAM-kill |
| GET `/ai/v2/models` | useAIModels, ScenarioTesterComponent | CORE / DEV |
| POST `/ai/v2/generate` | useChatGeneration, scenarioTester/LLMExchangePanel | DEV |
| POST `/ai/v2/event/interaction` | Animation/InteractionMappingComponent test (3 in parallel); useChatGeneration.generateScenario | CORE / DEV |
| POST `/ai/v2/event/directed-scene` | useChatGeneration (scenario tester) | DEV |
| GET `/ai/exchanges`, `/ai/exchanges/:id` | hooks/useAIExchanges | DEV |
| CRUD `/memories`, `/memories/:id`; POST `/memories` | MemoriesPage; mapping modals ("Save + Add Memory") | CORE |
| GET `/memories/:id/trace` | hooks/useMemoryTrace | DEV |
| CRUD `/participants` (+save/type query) | SimsPage, OfflineMemory | CORE / DEV |
| CRUD `/locations` | LocationsPage | CORE |
| GET `/db/list` | OfflineMemory | DEV |
| GET/POST `/sims/:id/facts`, DELETE `/sims/:id/facts/:factId`, GET `/facts/predicates` | hooks/useSimFacts (SimFactsDialog) | CORE (dossier) |
| GET/DELETE `/files/last-exception`; GET `/files/:name` (patreon button, google logo, discord.png) | useLastExceptionFiles; PatreonComponent, AssetsImage, Announcements | CORE |
| GET `/announcements` (3 min poll) | components/Announcements | CORE |
| GET `/options/status`, POST `/options/fix` | SetupWizardModal EnableModsPage | CORE |
| GET `/voice/elevenlabs/voices`, POST `.../refresh` | hooks/useElevenLabsVoices | CORE |
| GET `/paintings`, `/paintings/:id/png`; POST `/ai/v2/image/generate` | PaintingsPanel:34, :213, :191 | CORE |
| GET `/traits`, POST `/traits/export` | TraitsPage:155, :322 | DEV |
| POST `/animations`, `/animations/save-locally`, `/interactions`, `/interactions/save-locally` | mapping modals | CORE |
| GET `/{interactions\|animations}/all`, POST, DELETE, DELETE `/local`, POST `/save-locally`, GET `/interactions/semantic-search` | OnlineMappingBrowser | CORE |
| Redirect targets `/login/callback`, `/login/signout`, `/patreon-redirect` | AmplifyConfig:16-17, PatreonComponent:9 | CORE |

External calls made directly from the renderer:
- S3 HeadObject `sentient-sims-artifacts/sentient-sims-{main\|develop}.zip`, using Cognito identity-pool credentials (versions.ts:20-30)
- `https://ai.sentientsimulations.com/leaderboard|/me|/users`, with the Cognito idToken (useMappingLeaderboardStats)
- `https://www.sentientsimulations.com/thankyou.json` (useThankYous)
- Cognito, hosted UI and Google (Amplify)

IPC. The preload bridge is main/preload.ts. Channels marked (voice/) are used only from renderer/voice.

| Direction | Channel | Consumer in this section | Tier |
|---|---|---|---|
| main->R | debug-mode-toggle | DebugModeProvider | DEV |
| main->R | setting-changed | useSetting | CORE |
| main->R | popup-notification, caught-error-popup-notification | PopupNotification, CaughtErrorPopupNotificationModal | CORE |
| main->R | refresh-auth, refresh-user-attributes, google-auth-complete, on-linking-patreon | useAuthCredentials, AuthProvider, LoginModal, PatreonLinkingModal | CORE |
| main->R | on-new-memory-added, on-memory-deleted, on-memory-edited | MemoriesPage | CORE |
| main->R | on-sims-changed, on-location-changed, on-database-loaded, on-database-unloaded | SimsPage, LocationsPage, MemoriesPage, useOnDatabaseLoaded | CORE |
| main->R | on-map-animation, on-map-interaction, on-online-mappings-changed | mapping modals, OnlineMappingBrowser | CORE |
| main->R | on-api-key-paste-from-clipboard | APIKeyInput | CORE |
| main->R | websocket-status-change | WebsocketProvider (Home chip, Sims/Locations/Memories gating, wizard) | CORE |
| main->R | provider-health | HomePage ProviderHealthChip (O-6) | CORE |
| main->R | on-voice, clock-state, voice-record-start | AudioContextProvider | CORE |
| main->R | **scene-stop** | AudioContextProvider.tsx:319 | **STREAM** (scene control); harmless if never sent |
| main->R | on-chat-generation | useChatGeneration (global provider) | DEV |
| main->R | twitch-status | TwitchSettingsComponent | STREAM |
| R->main send | set-setting, reset-setting, open-browser-link, paste-clipboard-to-api-key-button-click | useSetting, links, APIKeyInput | CORE |
| R->main send | scene-line-shown, scene-line-ended, scene-dropped | AudioContextProvider (subtitle/mouth pacing) | CORE |
| R->main send | **scene-playback-ended** | AudioContextProvider.tsx:242 (ScenePlaybackRegistry) | STREAM-ish; harmless |
| R->main invoke | dialog:selectDirectory, dialog:selectGameApp | useModsDirectory, useGameAppPath | CORE |
| R->main invoke | voice-transcribe-test | VoiceInputSettingsComponent:98 | CORE |
| R->main invoke | twitch-status-get, twitch-login-start, twitch-logout | TwitchSettingsComponent | STREAM |
| (voice/) | voice-record-stop, voice-transcript, voice-transcribe, voice-record-error | renderer/voice/useVoiceRecorder | CORE |

Dead bridge entries that the renderer never calls: onAuth, onSuccessfulAuth, onInteractionsChanged, setAmplify, getAmplify, removeAmplify, clearAmplify.

**WebSocket port 25146 (renderer server).** The only consumer is LogViewerPage.tsx:93, a DEV page. It receives `{logs: string[]}` (the backlog on connect) and `{log: LogMessage}` per line (models/RendererWebsocketMessage.ts). Every other main->renderer push travels over IPC (util/notifyRenderer.ts). **If DEV is stripped, the 25146 server has no consumer left.**

## 4. Auth flow and what a fork build must configure

1. `Amplify.configure(AmplifyConfig)` (index.tsx:40) runs with **hard-coded upstream Cognito** values (AmplifyConfig.ts:7-19):
   - user pool `us-east-1_qRTW6SLkg`
   - client `2cjmpeg1ie22sfud6ddbsgvjpl`
   - identity pool `us-east-1:2d20518d-...`
   - hosted UI `sentientsimulations.auth.us-east-1.amazoncognito.com`
   - Google IdP
   - redirects to `localhost:25148/login/callback` and `/login/signout`
2. Login is LoginModal -> LoginComponent. It is either the Amplify `<Authenticator>` (email/password) or Google, via `signInWithRedirect`, which opens the system browser. Main receives the callback and sends `google-auth-complete(code, state)`. LoginModal.tsx:13-21 then rewrites `window.location` so `enable-oauth-listener` finishes the exchange.
3. AuthProvider (useQuery) reads four attributes:
   - `custom:subscription_level`
   - `custom:founderstatus`
   - `preferred_username` (the Patreon id)
   - `cognito:groups`

   It refreshes them on the IPC `refresh-user-attributes`. useAuthCredentials (mounted in MenuBar:76) pushes the idToken into the ACCESS_TOKEN setting every 15 minutes and on `refresh-auth`, so main can call SS AI.
4. Patreon linking uses the OAuth URL with **upstream client id** (PatreonComponent.tsx:10) and redirects to `localhost:25148/patreon-redirect`. The wizard's SentientSimsAISetupPage shows a stepper (login -> link -> subscribe) and polls the user attributes every 10 s (PatreonSubscribingComponent:53).
5. The `PatreonUser` gates are:
   - `isMember()` gates SSAI readiness (useProviderConnectionStatus:76, ProviderConnectionPanel:22) and the SSAI TTS test button.
   - `isMapper()` gates Save Online in the mapping browser.
   - `getNightlyAccess` gates the "develop" release channel.
   - `isDev()` unlocks debug mode.
   - Installing the mod needs a signed-in Cognito identity (ModUpdateProvider.tsx:104-107).

**Fork needs:** every value above is a literal. There are no env vars or build flags. A fork build either keeps Gus's pool (fine for an upstream CORE PR) or replaces AmplifyConfig.ts, PatreonComponent.tsx:10, versions.ts:26-27 (bucket and key), constants `defaultSentientSimsAIHost`, and the wiki and Discord URLs (MenuBar:86, Announcements:265, HelpButtons). Without a login, the app still works with BYO-key providers. SSAI, the leaderboard, Save Online and mod install all go dead.

## 5. Home page cards and status components

| Element | Backend polled | Notes |
|---|---|---|
| ConnectionChip (HomePage:9) | GET /websocket/isconnected once, then IPC websocket-status-change | CORE |
| ProviderHealthChip (HomePage:40) | IPC provider-health (after 3 failures) | CORE |
| UpdateComponent | S3 HeadObject (versions.ts) + /versions/mod; POST /update/mod | Update (:72-82) and Reinstall (:86-97) buttons; ReleaseTypeSelector. STREAM: disable (see section 8) |
| DebugCard | /versions/*, /debug/test-ai | App/Mod/Game versions, AI status, PatreonDebug + WebGpuDebug (both self-hide), SendLogButton (Send Logs, Last Exceptions, Logs[debug]) |
| MappingLeaderboardComponent | ai.sentientsimulations.com /leaderboard, /me (renders null when logged out or on error) | CORE, upstream-service dependent |
| ThankYouCardPatreon + PatreonComponent | sentientsimulations.com/thankyou.json | CORE |
| Announcements sidebar | GET /announcements every 3 min | CORE |

## 6. Scenario tester / debug surfaces

scenarioTester/ is 4 files, 525 lines, all DEV, and is rendered only inside ChatPage when debug mode is on (:152).
- It builds a fake 2-sim InteractionEvent from trait, mood, career, location and interaction pickers, using random 18-digit sim ids. These synthetic participants are written to the live DB.
- Run Directed Scene posts `/ai/v2/event/directed-scene` with per-role model overrides. Single-Pass posts `/ai/v2/event/interaction`. LLMExchangePanel re-runs each stage via `/ai/v2/generate`.
- scenarioOptions.ts imports five `main/sentient-sims/descriptions/*` tables into the renderer bundle, which is heavy.

Other DEV surfaces:
- AILogPage, OfflineMemory, TraitsPage and LogViewerPage
- MemoryTraceDialog with TextDiffView, PromptTextBlock and LLMExchangeDetail
- AiMaxResponseLength, PatreonDebug and WebGpuDebug
- ChatPage voice-test mode (useChatGeneration -> renderer/voice/useVoiceTestPlayback)

MemoryTraceDialog.tsx:24-31 has pipeline labels for `cognition` and `ask_action`. They are an AUTONOMY vocabulary, but only as labels.

## 7. Tests

**Zero.** None of the 108 files in src/__tests__ imports anything from src/renderer, and no renderer test files exist. The first candidates if tests are wanted:
- pure functions `memoryNameTag` (MemoriesPage:29)
- `parseBlocks` (PromptTextBlock)
- `splitDirection` (MemoryTraceDialog)
- `replaceKeyValuePairs` (mapping modals)
- the AudioContextProvider scene queue: drop-oldest, priority unshift, soft/hard stop

## 8. Bugs and risks (ordered)

1. **HIGH, STREAM.** ModUpdateProvider.tsx:147-171 auto-installs at startup: `installUpdate({auto:true})` at :165.
   - It fires when you are signed in and the S3 `version` string differs from the local one (versions.ts:34 uses string inequality).
   - A fork mod always differs, so this overwrites the stream mod with upstream's zip.
   - Disabling the buttons does not help. Gate `installUpdate` and `checkForUpdates` in the provider; section 06 also puts a server-side kill in UpdateController.
   - UpdateComponent is also embedded in SetupWizardModal InstallModPage (:362), as well as HomePage:108.
2. **HIGH, CORE packaging.** PaintingsPanel is reachable only through ChatPage (:423-427), and Chat is in DEBUG_NAV_ITEMS (MenuBar:56). CORE ships AI paintings with no visible UI unless PaintingsPanel gets its own route and NAV_ITEMS entry.
3. **MED.** Debug mode is a global Ctrl+Shift+D that can't be turned off, so "DEV" UI is exposed to every user. A stripped build must delete the routes (index.tsx:51-54, 63-70, 87-94) and DEBUG_NAV_ITEMS, not rely on the flag.
4. **MED.** PopupNotification.tsx:11 calls `onPopupNotification` on every render and never removes it, so listeners accumulate (MaxListeners warning, repeated setState). DebugModeProvider:29 also has no cleanup.
5. **MED.** If main strips the Twitch IPC handlers but the tab stays, `twitchLoginStart` rejects inside a try/finally with no catch (TwitchSettingsComponent:93-100). That is an unhandled rejection. `staleBridge` only covers a missing preload method.
6. **LOW.** AISettingsProvider:53-60 can put an OpenAI key in the query string and `log.debug`s the URL. No caller passes a key today.
7. **LOW.** Default mismatch for AI_API_TYPE: useChatGeneration:76 uses OpenAI, AISettingsProvider:85 uses SentientSimsAI. This only matters before the first load.
8. **LOW.** LocationsPage:181 shows "Not connected to The Sims 4" when connected but no locations exist.
9. **LOW.** SimsPage:109-121 and LocationsPage:68-80 register onDatabaseLoaded twice, so they fetch twice per load.
10. **LOW.** Animation/InteractionMappingComponent handleSave POSTs the mapping, then dereferences `testResults[0]` (:274, :299). It is safe only because Save appears after Test.
11. **LOW.** VoiceSettingsComponent still wires Kokoro and OpenAI panels (:17-24). A legacy stored TTS_API_TYPE shows settings for a provider that AudioContextProvider plays as silence.

## 9. Stale / dead

- `hooks/useMe.tsx`: 0 bytes.
- `hooks/useVersionHook.tsx`: type only, never imported.
- `CustomLLMWorkersModal.tsx`, `LogsSentInformationComponent.tsx`, `components/GlowingGreenOrb.tsx`: never imported.
- `ThankYouCard` default export returns null.
- `settings/voice/OpenAIVoiceSettingsComponent.tsx`, `KokoroAIVoiceSettingsComponent.tsx`, `components/WebGpuDebug.tsx` (Kokoro WebGPU only): unreachable.
- `assets/patreon-medium-button.png` duplicates `/assets` (served via `/files/:name`).
- ChatPage "Count"/"Tokens: 0" (`countTokens` is a TODO, useChatGeneration:214).
- Preload methods listed at the end of section 3.
- index.tsx:7 imports PatternFly base.css globally, only for LogViewerPage.

## 10. What a CORE build keeps and what the mixed files need

**Keep as-is:**
- index.html, theme.ts, App.css, preload.d.ts, AmplifyConfig.ts, versions.ts, App.tsx
- HomePage, SimsPage, LocationsPage, LastExceptionPage, PaintingsPanel
- all auth, Patreon, login, wizard, update, send-log, mapping, voice-select and fact components
- providers: AISettings, Audio, Auth, ModUpdate, SetupWizard, SnackBar, Versions, VoiceInput, Websocket, DebugMode
- CORE hooks and CORE settings files

**Strip (DEV):**
- ChatPage, ChatBoxComponent, ChatResultsModal, TraitsPage, AILogPage, OfflineMemory, LogViewerPage
- scenarioTester/*
- LLMExchangeDetail, PromptTextBlock, MemoryTraceDialog, TextDiffView, PatreonDebug, WebGpuDebug
- useAIExchanges, useMemoryTrace, useChatGeneration, ChatGenerationProvider
- AiMaxResponseLengthSettingsComponent

**Strip (AUTONOMY):** ConversationActionsSettingsComponent.
**Strip (STREAM):** TwitchSettingsComponent.

| File:line | Surgery |
|---|---|
| index.tsx imports :16, 19, 22, 28, 31, 37; routes :51-54 (/traits), 63-66 (/chat), 67-70 (/offlinememory), 87-90 (/logs), 91-94 (/ai-log); provider wrapper :123/:127 | Drop the DEV routes and the ChatGenerationProvider wrapper. Keep /mapping-browser (decide), and add a `/paintings` route |
| MenuBar.tsx:54-60, 155 | Remove DEBUG_NAV_ITEMS. Add Paintings (and Mapping Browser if kept) to NAV_ITEMS:62-67 |
| SettingsPage.tsx:13, 88 | Remove ConversationActions (AUTONOMY) |
| SettingsPage.tsx:19, 30, 116-118 | Remove the Twitch enum entry and tab (STREAM) |
| SettingsPage.tsx:21, 111 | Remove AiMaxResponseLength (DEV) |
| ProviderConfigsComponent.tsx:626 | Filter the AUTONOMY action types out of the override rows |
| VoiceInputSettingsComponent.tsx:54, 164-184 | Remove the Command key (AUTONOMY). Neutralise the "Jaz" placeholder at :216 |
| MemoriesPage.tsx:14, 71, 341-352, 441-447 | Remove the View Prompt button and MemoryTraceDialog (DEV) |
| SendLogButton.tsx:30-41 | Remove the debug "Logs" button (the /logs route is gone) |
| DebugCard.tsx:10-11, 56-57 | Remove PatreonDebug and WebGpuDebug |
| AudioContextProvider.tsx:316-342 (onSceneStop), :238-243 | May stay: inert without scene control. Strip them in CORE for cleanliness |
| ChatPage.tsx:35, 423-427 -> new page | Move PaintingsPanel to its own route |
| STREAM only: ModUpdateProvider.tsx:147-171 + installUpdate, UpdateComponent.tsx:72-97, ReleaseTypeSelector | Disable install/check at the provider (the single choke point), grey out Update/Reinstall, hide the channel select |

## 11. What shows empty or broken in a CORE build if left in

- **Paintings tab**: gone with Chat. If Chat is left in, the scenario tester pages post to `/ai/v2/event/directed-scene`, which may be stripped.
- **Settings > "Conversations can lead to actions"**: the toggle and slider write keys that nothing reads.
- **Settings > Voice > "Command key"**: registers a hotkey whose VOICE_COMMAND path is stripped. It either does nothing or errors.
- **Per-Action Provider Overrides**: seven rows (Cognition, Action Scene, Daily Plan, Voice Command, Ask x3) route to actions that never run.
- **Settings > Twitch tab**: the chip stays "Off" or seeding fails silently. Connect gives an unhandled rejection, and "Restart the app" error text appears when the preload lacks the bridge.
- **AI Log** (if kept): shows only surviving actions, which is fine. **MemoryTraceDialog** (if kept) is empty for autonomy traces, which is fine.
- **LogViewerPage** (if kept while the 25146 server is stripped): stuck on "Waiting for log output" forever.
- **OfflineMemory** (if kept): fine, since it is CORE backend.
- **STREAM only**: UpdateComponent buttons must read disabled with a reason. The wizard's Install Mod step also shows UpdateComponent, so it needs a "skip" note.
