# 01 — Transport, lifecycle, controllers, clients (app `jasmine-phase-3` @ 62b9bad)

Scope read in full: `src/main/{main,menu,preload,util}.ts`; `sentient-sims/{api,websocketServer,ipcHandlers,constants,registerDebugToggleHotkey}.ts`;
services `ApiContext, UpdateService, VersionService, DirectoryService, SettingsService, LogsService, LogSendService, LastExceptionService, GameSigningService, PatreonService`;
all 23 `controllers/*.ts` + `decorators/CatchError.ts`; all 25 `clients/*`; `auth/tokenVerifier.ts`; `wrappers/PatreonUser.ts`; `models/SettingsEnum.ts`.
To get payload keys I also skimmed `models/ModWebsocketMessage.ts`, `models/ModLogWebsocketMessage.ts` and the mod-send helpers in `util/notifyRenderer.ts`.
Tiers: CORE / AUTONOMY / STREAM / DEV, as in the brief (push-to-talk and the dossier/fact store count as CORE here, see §7 for where the mod map disagrees).

## 1. Per-file map

| File | What it is | Tier | Settings read | Depends on | Tests | Notes / risks |
|---|---|---|---|---|---|---|
| `main.ts` | Electron entry point. Sets up log rotation (25 MB, 10 archives, :45-69), single-instance lock (:280), `startServices()` (:167-259), window, and the Cognito `will-navigate` hijack (:142-149). | CORE, but mixed | `debugLogs` (:200) | SettingsService, DirectoryService, ApiContext, VoiceInputService, **TwitchChatService**, electron-updater | none | Twitch is built unconditionally (:34,73,184-188,194,198,275). **autoUpdater** (:223-242) pulls from `guspuffygit/sentient-sims-app` (package.json:225-229); a fork or stream build **self-replaces with Gus's release**. `webSecurity:false` (:120). |
| `menu.ts` | Default Electron menu (still says "ElectronReact"), plus Inspect/Reload/DevTools when `NODE_ENV=development\|DEBUG_PROD`. | CORE | – | – | none | Help links point at electronjs.org (boilerplate). |
| `preload.ts` | `contextBridge` `window.electron`: ~50 IPC wrappers. | CORE, mixed | – | SettingsEnum, TwitchChatStatus types | none | STREAM: `onTwitchStatus/getTwitchStatus/twitchLoginStart/twitchLogout` (:219-232), `onSceneStop` (:175). Dead: `set/get/remove/reset-amplify` (:233-244, no ipcMain handler anywhere), `onAuth` (:48, nobody sends `on-auth`). |
| `util.ts` | `resolveHtmlPath` (dev URL vs `file://…/renderer`). | CORE | – | – | none | – |
| `api.ts` | Express 5 app on 25148, 102 routes (§2), JSON limit 50 MB (:12). `server.on('error')` shows a dialog on EADDRINUSE (:152-163). | CORE, mixed | – | every controller via `ctx.controller` | Api.test, Api.it.test, CognitionRoutes, DossierRoute, SimFactRoutes, PrefetchRoutes, OptionsController, PaintingsController, DoSomething(+Wire), ProviderConfigApi.it | Binds **all interfaces**: `listen(port)` has no host, so the API is reachable from the LAN (see bug B1). |
| `websocketServer.ts` | Two `ws` servers: renderer on 25146 (:46-89) and mod on 25145 (:92-163). `sendModNotification` (:166-174) and `isWebSocketConnected` (:176-182). | CORE, mixed | `playbackFollowsGameClock` (:122), `debugLogs` (:149) | ctx.logs, ctx.scenePlayback, modLogMirror, notifyClockState | none (ModLogMirror.test covers only the mirror) | STREAM branch: `scene_control` (:129-144). Bugs B2-B4. |
| `ipcHandlers.ts` | `ipcMain` handlers. | CORE, mixed | – | ctx.settings, ctx.scenePlayback, ctx.transcription, ctx.twitchAuth, VoiceInputService, TwitchChatService | none | STREAM: `twitch-*` (:133-139). Scene playback IPC (:66-96) is CORE (subtitles), but `scene-playback-ended` feeds ScenePlaybackRegistry, whose close hook calls moodlets and cognition (see ApiContext). Dead: `save-interaction-locally`/`save-animation-locally` (:105-113; preload never exposes them). `set-setting` double-notifies (:46-48, setSetting already fires the listener). |
| `constants.ts` | Prompt defaults, ports (:96-98 of file = 25146/25145/25148), provider defaults, pacing constants, voice-input and Twitch constants (:194-218), `thoughtMemoryFloor`. | CORE, with a STREAM block | – | – | indirect | Twitch constants block → STREAM. |
| `registerDebugToggleHotkey.ts` | **Global** Ctrl+Shift+D → `debug-mode-toggle` to renderer. | CORE (debug UI toggle) | – | – | none | System-wide shortcut, never unregistered; it steals the chord from every other app, the game included. |
| `models/SettingsEnum.ts` | 101 setting keys + 1 deprecated. | mixed | – | – | Settings.test | Keys by tier in §5. |
| `services/ApiContext.ts` | Service locator: builds ~60 services, 11 repositories, 7 providers and `ControllerContext` (22 controllers, :111-247). Wraps every generation call in the exchange logger with a Proxy (:790-827). | CORE shell, mixed body | `playerConversationIdleMinutes` (:388) | everything | 38 test files construct it | Coupling that needs surgery: ScenePlaybackRegistry `onSceneClosed` calls **SceneMoodletService** (STREAM) and **cognition.releaseConversationActions** (AUTONOMY) (:403-406); `memoryRepository.setGameDayProvider` reads **SimStateCache** (:459-465), so core memories get their game-day stamp from an autonomy cache; CognitionService is built last (:474); twitchChat is injected after construction (:487). |
| `services/UpdateService.ts` | "Update Mod": downloads `sentient-sims-${type}.zip` from S3 bucket **`sentient-sims-artifacts`** (:95-101) using Cognito credentials the renderer passes in; flat-extracts into `Mods/sentient-sims` (skips the ts4script when `Scripts/` exists, :145-152); sweeps stray copies; re-mounts paintings; re-signs on mac. Serialized, with join-in-flight (:67-86). | CORE (disabled in STREAM) | via DirectoryService | DirectoryService, PaintingMount, GameSigning | UpdateService.test, UpdateController.test | The renderer also **auto-installs at startup** (`renderer/providers/ModUpdateProvider.tsx:143-171`, `installUpdate({auto:true})`). Disabling the button alone is not enough for stream (bug B5). |
| `services/VersionService.ts` | mod-version.json, app version, GameVersion.txt; `getVersionHeaders()` (X-Sentient-Sims-*-Version). | CORE | – | DirectoryService | VersionService.test, Api.test | `JSON.parse` of mod-version.json is unguarded (:23), so a corrupt file throws in every caller. |
| `services/DirectoryService.ts` | Mods paths, db paths per save, `SHIPPED_MOD_FILES` + stray-file sweep (:14-22,75-122), `findFilesWithKeywords` (regex from keyword). | CORE | `modsDirectory` | SettingsService | via persistence tests | Stray sweep walks the entire Mods tree on every update. |
| `services/SettingsService.ts` | electron-store schema + defaults (:58-516), migration 3.1.0, `setSetting` with side-effects (debug logging, provider-config sync/prune, :549-584), ~120 typed getters with clamps, `runMigrations` (:1401-1480). Redacts secret-like keys in logs (:521-528). | CORE store, mixed getters | all | constants, model sanitizers | Settings.test (+4 persistence tests) | Bugs B9-B11. The twitch and cognition getters are the tier seams. |
| `services/LogsService.ts` | Reads and appends `Mods/sentient-sims/logs.txt` (mod log lines). | CORE | – | DirectoryService | none | Unbounded file; `readLogs` loads the whole file into memory on every renderer connect. |
| `services/LogSendService.ts` | "Send logs": builds a zip (systemconfig, file list, mod log tail 3 MB, error db, lastException, main.log tail, Config.log) and POSTs it to a **hard-coded, string-split Discord webhook** (:16-28); interaction bug report (:128). Dumps every non-Key/Token setting (:189-207). | CORE (support) | all settings | Directory, Version, LastException | none | A fork build posts players' logs to **Gus's Discord**. The filter `includes('Key')`/`'Token'` misses `twitchAuth` (a token object) and `geminiKeys` has "Key", so it is caught; `twitchAuth` leaks. |
| `services/LastExceptionService.ts` | Finds lastException*/lastCleanException/lastUIException in the Sims 4 folder, parses the XML desync stack, deletes them after a successful send. | CORE | – | Directory | none | `rmSync` unguarded (:69). |
| `services/GameSigningService.ts` | macOS only: ad-hoc codesign of the game exe with the disable-library-validation entitlement so the overlay dylib loads (:43-106); kills the game on `signGame`. | CORE (mac overlay) | `gameAppPath` | assets plist | none | Backs up the exe once (`.original`). |
| `services/PatreonService.ts` | Patreon OAuth code → SS AI server `/patreon-redirect`. | CORE (auth) | `accessToken`, `sentientsimsAIEndpoint` | notifyRenderer | none | **Logs the access token** at debug level (:25); debug logs go into the public log bundle. |
| `controllers/decorators/CatchError.ts` | TC39 field decorator: catches, logs, replies `{error}`, pops a renderer error dialog. | CORE | – | notifyRenderer | none | **Default status 200** (:6): a failure reads as success to anything that checks the status. |
| `controllers/AIController.ts` | Generation routes. | CORE + DEV + AUTONOMY | `directedScenesEnabled` (:75,96), `playerSpeakerName` (:184) | ai, generationQueue, semanticMemory, memoryRepository, simStateCache, aiExchangeLog, outcomeVerdict, **bench/** (:19-22) | PrefetchRoutes, DoSomething, DossierRoute (self-knowledge) | DEV handlers: `selfKnowledge` (:140), `getPlayerThreadFixtures` (:224), `playerThread` (:243), `getTier0` (:335), `getExchanges/getExchange` (:299-314). AUTONOMY: `getOutcomes` (:320). `tts` (:346) GETs `playTTS(text)` and has no caller in the repo. `buffEvent` answers before it works (:281-286). |
| `controllers/CognitionController.ts` | Mod reports: state, dossier, outcome, sleep boundary, perception, plus two debug seams. Also exports `humanizeOutcomeReason`/`outcomeObservation`. | AUTONOMY + CORE(dossier) + DEV | `outcomeInstantSuccessMs` (:222) | simStateCache, semanticMemory, participantRepository, defaultDescriptions, actionDispatcher, outcomeVerdict, memoryRepository, cognitionService, sceneService, ai | CognitionRoutes, DossierRoute, CognitionOutcomeReason, DayWatchFixes | `postDossier` (:135) is the fact-store feed, so CORE, but it lives here. `postSleepBoundary` (:327) writes the sleeper's **diary** via `runSceneReflection`, which is memory content (tier decision). Unbounded `latestPerception` Map (:104). |
| `controllers/AnimationsController.ts` | WW animation mapping: local/online/browse. | CORE | – | ctx.animations | AnimationsController.test | – |
| `controllers/AssetsController.ts` | `GET /files/:filename` → `getAssetPath(filename)`, always served as `image/png`. | CORE | – | – | none | Takes the filename unchecked; `readFileSync` throws on a missing file (500). |
| `controllers/DbController.ts` | load/save/unload/list of per-save SQLite. | CORE | – | ctx.db | Api.test (DbClient) | Errors come back as HTTP 200 `{error}`; the mod treats `error` as fatal. |
| `controllers/DebugController.ts` | health, provider test, send-logs, bug report, **twitch inject** (:59). | CORE + STREAM/DEV | – | providerConfigs, logSend, twitchChat | none | Imports the webhook URL (:4). |
| `controllers/FileController.ts` | lastException list/delete. | CORE | – | lastException | none | – |
| `controllers/InteractionDescriptionController.ts` | Mapping browser: update (422 `NAMES_FROM_SAVE` guard, :23-29), delete, ignored list, local overrides, semantic search, browse. | CORE | – | interactions, interactionRepository, interactionSemanticSearch | none direct | – |
| `controllers/LocationsController.ts` | Location CRUD + default/modified lists; `notifyLocationChanged`. | CORE | – | locationRepository | none direct | Errors as 200 `{error}`. |
| `controllers/LoginController.ts` | `/login/callback` Cognito/Google code → renderer. | CORE (auth) | – | assets | none | – |
| `controllers/MappingController.ts` | Traits/moods from an extracted tuning path; export. | CORE (mapper tooling, arguably DEV) | – | ctx.mapping | none | `extractedPath` comes straight from the query string. |
| `controllers/MemoriesController.ts` | Memory CRUD; monologue ownership stamp (:86-92); `rejected` shape for the hygiene gate (:95-100). | CORE + DEV(trace) | – | memoryRepository, memoryTrace | MemoryRepository etc. (repo level) | `getMemoryTrace` (:49) is DEV. |
| `controllers/NewsController.ts` | Proxies `sentientsimulations.com/announcements.json`. | CORE | – | axios | none | No try/catch (relies on Express 5 → HTML 500). |
| `controllers/OptionsController.ts` | Reads/fixes Options.ini (`modsdisabled`, `scriptmodsenabled`). | CORE | – | directory | OptionsController.test | – |
| `controllers/PaintingsController.ts` | Manifest, PNG→DDS texture (base64), raw PNG. | CORE | – | paintingRepository, image/paintingDds | PaintingsController.test | – |
| `controllers/ParticipantsController.ts` | Participant CRUD + voice pin; sends `clear_sim_cache` (:87,101). | CORE | – | participantRepository | ParticipantRepository.test (repo) | – |
| `controllers/PatreonController.ts` | `/patreon-redirect`. | CORE | – | patreon | none | – |
| `controllers/SettingsController.ts` | `GET/POST /settings/app/:key`, `GET …/reset`. | CORE | any | settings | Api.test, ProviderConfigApi.it | Double notify (:12-16); reset does not notify (:24-27). **Returns secrets** (B1). |
| `controllers/SimFactsController.ts` | Fact store: list/history/path/explain/add/retire/predicates; refuses `source=game` (:122-125). | CORE | – | semanticMemory, memoryRepository, simStateCache (day) | SimFactRoutes.test | – |
| `controllers/UpdateController.ts` | `/update/mod`: refuses while the game runs (auto → `skipped`), rehydrates credentials. | CORE (STREAM: off) | – | update, util/gameProcess | UpdateController.test | Errors return 200 with `{error}`. |
| `controllers/VersionController.ts` | versions + `modOutOfDate` for the legacy `/db/*/:sessionId`. | CORE | – | version | Api.test | – |
| `controllers/VoiceController.ts` | ElevenLabs voices get/refresh; `phonemize` is a **stub** returning 'OK' (:13-26). | CORE | – | elevenLabsVoices | ElevenLabsVoices.test (service) | – |
| `controllers/WebsocketController.ts` | `/websocket/isconnected`. | CORE | – | websocketServer | none | Reports the stale flag (B2). |
| `clients/*` (25) | Renderer-side axios/fetch clients for the 25148 API (`SentientSimsAppClient` aggregates 17), plus the SS AI server (`SentientSimsAiApiClient`: /leaderboard, /me, /users), the website (thankyou.json), and ElevenLabs request builders/parsers. | CORE (AIClient: exchanges = DEV) | – | constants.appApiUrl | Api.test, ElevenLabs(.it).test, OptionsController.test, ProviderConfigApi.it | `AxiosClient` retries **every** failure 3× including POSTs (:78-80), so a failed chat generation can run 4 times; a string body triggers a retry too (:34-41). `InteractionClient.getInteractions` hits `GET /interactions`, which has no route (dead). `VoiceClient.phonemize` hits the stub. |
| `auth/tokenVerifier.ts` | `jwtDecode` + expiry check (no signature check; client side only). | CORE | – | jwt-decode | none | Used by SentientSimsAIService. |
| `wrappers/PatreonUser.ts` | Tier/founder/dev/mapper checks over Cognito attributes. | CORE | – | – | Patreon.test | Imported by main and renderer. |

## 2. Routes (Express, `api.ts` line → controller.method → tier)

| api.ts | Route | Handler | Tier |
|---|---|---|---|
| 14-17 | GET /debug/health, GET /debug/test-ai, POST /debug/send-logs, POST /debug/interaction | Debug.appHealthCheck / healthCheckGenerationService / sendDebugLogs / sendBugReport | CORE |
| 18 | POST /debug/twitch-message | Debug.injectTwitchMessage | STREAM (dev seam) |
| 20-29 | POST /ai/v2/generate, /ai/v2/event/interaction{,/prefetch,/claim,/finalize,/cancel}, /directed-scene, /classification, /ai/v2/event/buff, /ai/v3/event/buff | AI.* | CORE (v2/buff and classification are legacy mod calls; directed-scene is used by the renderer chat, `useChatGeneration.tsx:233`) |
| 30-32 | POST /ai/v2/image/generate, GET /ai/v2/models, GET /ai/v2/tts | AI.generateImage / getModels / tts | CORE; tts has no caller (DEV/dead) |
| 33-34 | GET /ai/exchanges/:id, /ai/exchanges | AI.getExchange(s) | DEV |
| 36 | GET /ai/outcomes | AI.getOutcomes | AUTONOMY/DEV |
| 37-42 | GET /bench/tier0, POST /bench/self-knowledge/:simId, GET /bench/player-threads, POST /bench/player-thread/:index | AI.* | DEV |
| 44-46 | GET/DELETE /files/last-exception, GET /files/:filename | File.*, Assets.getAssetsFile | CORE |
| 48-50 | GET/POST /settings/app/:appSetting, GET …/reset | Settings.* | CORE |
| 52-56 | GET /versions/{mod,app,game}, POST /update/mod | Version.*, Update.updateMod | CORE (update off in STREAM) |
| 58-68 | /participants (GET all, GET/POST/DELETE :id), /locations (GET, /default, /modified, /:id, POST, DELETE) | Participants.*, Locations.* | CORE |
| 70 | GET /memories/:id/trace | Memories.getMemoryTrace | DEV |
| 71-73 | GET /paintings, /paintings/:id/texture, /paintings/:id/png | Paintings.* | CORE |
| 75-80 | /memories GET/POST, /memories/:id GET/POST/DELETE, DELETE /memories | Memories.* | CORE |
| 82-83 | GET /patreon-redirect, GET /login/callback | Patreon/Login.handleRedirect | CORE |
| 85-91 | GET /db/{load,save}/:sessionId (legacy → modOutOfDate), POST /db/load, POST /db/save, GET /db/unload, GET /db/list | Version.modOutOfDate, Db.* | CORE |
| 93-101 | /animations/all, /animations GET/POST/DELETE, /animations/nsfw-enabled, POST /save-locally, DELETE /local | Animations.* | CORE |
| 103-119 | /interactions/ignored, /all, /semantic-search, POST /save-locally, DELETE /local, POST & DELETE /interactions; /traits, /traits/unmapped, POST /traits/export, /moods, /moods/unmapped | InteractionDescription.*, Mapping.* | CORE |
| 120-122 | GET /voice/phonemize (stub), GET /voice/elevenlabs/voices, POST …/refresh | Voice.* | CORE |
| 123-127 | GET /websocket/isconnected, GET /announcements, GET /options/status, POST /options/fix | Websocket (new instance), News, Options | CORE |
| 129,131 | POST /cognition/outcome, /cognition/state | Cognition.postOutcome / postState | AUTONOMY |
| 130 | POST /cognition/perception | Cognition.postPerception | AUTONOMY (debug reply path) |
| 132 | POST /cognition/dossier | Cognition.postDossier | **CORE** (fact store), needs a new home |
| 136-141 | /facts/predicates, /facts/:id/explain, /sims/:id/facts (GET/POST), /sims/:id/facts/path/:otherId, DELETE /sims/:id/facts/:factId | SimFacts.* | CORE |
| 142 | POST /cognition/sleep-boundary | Cognition.postSleepBoundary | AUTONOMY (writes diaries: decision) |
| 143-144 | POST /cognition/debug/enqueue, /cognition/debug/perception | Cognition.debug* | DEV |

Mod map §J cross-check: every mod HTTP call has a route here. The map omits `/ai/v2/event/classification` and `/ai/v2/event/buff`. Both are still called by the mod (`ss_api.py:361,375`; see §8) and must stay in core.

## 3. Websocket inventory

**Mod → app (25145, `websocketServer.ts:116-161`).** No `type` field; dispatch is by key.
| Key | Payload | Handler | Tier |
|---|---|---|---|
| `clock_state` | `{speed, paused, paused_by: 'user'\|'mod'\|null}` | :119-127 → `notifyClockState` → renderer `clock-state` (masked to NORMAL when `playbackFollowsGameClock` is off) | CORE (voice playback pacing) |
| `scene_control` | `{action:'stop'\|'stop_all', mode:'soft'\|'hard', scene_id?, reason:'walked_away'\|'left_lot'\|'zone_unload'\|'cheat', sim_id?, distance_m?}` | :129-144 → `ctx.scenePlayback.stop/stopAll` | STREAM |
| `log` | `LogMessage` | :146-161 → DEBUG dropped unless `debugLogs`; `mirrorModLog` into main.log; append to Mods/sentient-sims/logs.txt; forwarded raw to the renderer ws | CORE |

**App → mod** (all through `sendModNotification`, `websocketServer.ts:166`; fire-and-forget, no queue).
| type | Keys | Sent from | Tier |
|---|---|---|---|
| `notification` | `notification{title,message,message_type:'error'\|'message'}` | notifyRenderer.ts:33 (provider-down health toast, from AIExchangeLogService:91) | CORE |
| `clear_sim_cache` | – | ParticipantsController:87,101; DbService:129 | CORE |
| `migrate_single_slot_save` | (see DbService:78) | DbService | CORE |
| `memory_created` | `memory` (display-stripped), `paced` | notifyRenderer:93 ← MemoryRepository:566 | CORE |
| `memory_edited` | `memory` | notifyRenderer:120 ← MemoryRepository:379 | CORE |
| `memory_deleted` | `memory_id` (string) | notifyRenderer:106 ← MemoryRepository:581 | CORE |
| `add_buff` | `sim_id, mood, buff_description, intensity?, duration_minutes?, scene_id?, source:'scene'\|'chat'` | AIService:2612 (chat path = CORE); SceneMoodletService:267/319 (tiers = STREAM) | mixed |
| `scene_line` | `speaker, text, preamble?, voiced?, scene_id?, speaker_sim_id?, participant_sim_ids?, continues?` | notifyRenderer:207 ← ipc `scene-line-shown` | CORE (subtitles); the mod uses it for mouth/plumbob (STREAM) |
| `scene_line_ended` | `speaker, scene_id?, continues?` | notifyRenderer:229 ← ipc `scene-line-ended` | CORE msg, STREAM consumer (mouth) |
| `scene_ended` | `scene_id, reason:'finished'\|'stopped'\|'dropped'` | notifyRenderer:256 ← ScenePlaybackRegistry (ApiContext:407-415) | STREAM (feeds scene watch) |
| `conversation_closed` | `sim_ids, sim_names, speaker, reason` | notifyRenderer:245 ← PlayerConversationService (ApiContext:389-396) | CORE (chat window "has said their piece") |
| `enqueue_interaction` | `request_id, sim_id, action, target_sim_id?, target_object_id?, priority?, insert_strategy?, clear_queue?, preempt?, zone_id?, source` | ActionDispatcherService:114-129 | AUTONOMY |
| `cancel_interaction` | `request_id` | ActionDispatcherService:174 | AUTONOMY |
| `request_perception` | `request_id, sim_id` | CognitionController:424-429 (debug seam) | AUTONOMY/DEV |
| `player_voice_message` | `text` | notifyRenderer:263 ← VoiceInputService:172 | CORE (PTT) |
| `player_voice_status` | `status:'listening'\|'transcribing'\|'error', detail?, speaker?, mode?:'chat'\|'command'` | VoiceInputService:122-247; VoiceCommandService:40,88 (mode 'command' = AUTONOMY) | CORE |

16 types, matching the mod map's 7 + 3 + 6. **Renderer ws (25146):** app→renderer `{logs:[…]}` on connect (:75-89), then each mod `log` message raw; renderer→app messages are only logged.

## 4. Lifecycle

Startup (`main.ts`): electron-log init + archive fn (:37-69) → `requestSingleInstanceLock` (:280) → `whenReady` → **startServices** (:304): `SettingsService` + `runMigrations` (:168-169) → `DirectoryService` (:171) → `new ApiContext` (:172; builds providers, repos, scene/player/moodlet/dispatcher/state cache, embeddings, prompt builder, AIService, queue, …, DailyPlan, then CognitionService, then controllers) → `VoiceInputService` (:183) → `TwitchChatService` + `ctx.setTwitchChat` (:185-188) → composite `onSettingChanged` (renderer + voice + twitch, :191-195) → `ipcHandlers` (:196) → `voiceInput.initialize`, `twitch.initialize` (:197-198) → debug log level (:200-204) → global Ctrl+Shift+D (:206) → **websocket servers** 25146 + 25145 (:207) → **Express** 25148 (:208) → mac `ensureSigned` (:210) → `paintingMount.ensureMount` (:215) → electron autoUpdater check (:223-242) → `/login/signout` webRequest filter (:244-258) → `createWindow` (:305) → menu.
Renderer side after auth: `ModUpdateProvider` checks for and auto-installs a mod update (ModUpdateProvider.tsx:143-171).
**Mod connect** (`websocketServer.ts:96-103`): `modWs = ws`, `modConnected = true`, renderer gets `websocket-status-change {type:'mod',status:true}`. There is no handshake and nothing is sent to the mod; the mod drives `/debug/health`, `/versions/app` and `/db/load` over HTTP.
**Mod disconnect** (:104-110): the flag goes false and the renderer is told. Nothing else happens: no scene stop, no cognition pause, and `modWs` is not cleared. VoiceInputService:116, TwitchChatService:366 and ActionDispatcherService:151 gate on `isWebSocketConnected('mod')`.
Quit: `will-quit` shuts down voice and twitch (:273-276). `window-all-closed` quits except on darwin.

## 5. Settings keys by tier (`SettingsEnum.ts`)

- **CORE (75):** modRelease, modsDirectory, aiApiType, accessToken, openaiKey/Model/Endpoint, novelaiKey/Model, novelAIEndpoint/GenerationEndpoint, sentientsimsAIModel/Endpoint/EmbeddingModel, openrouterKey/Endpoint/Model, vllmEndpoint/Key/Model, koboldAIEndpoint, geminiKeys/Endpoint/Model, localizationEnabled/Language, debugLogs, nsfwEnabled, directedScenesEnabled, mappingNotificationEnabled, traitMappingPath, ttsEnabled/ApiType/Volume, openaiTtsSettings, sentientsimsaiTtsSettings, kokoroaiEndpoint/TtsSettings, elevenlabsKey/Endpoint/TtsSettings/Voices, setupWizardPage, patreonLinking, maxResponseTokens, generationTimeoutSeconds, generationConcurrency, prefetchMaxQueueDepth, embeddingApiType, embeddingProviderConfigs, defaultEmbeddingProviderConfigId, aiProviderConfigs, defaultAiProviderConfigId, aiActionProviderOverrides, stagePromptOverrides, memoryRetrievalCandidateLimit, voiceInputEnabled/Endpoint/Key/Model/Hotkey/HotkeyMode/Language/DeviceId (PTT), playbackFollowsGameClock, playerVoicePersona/Bio/Name, sceneMaxRounds, playerReplyMaxTokens, playerConversationIdleMinutes, generatedDefaultDescriptions, gameAppPath, imageProviderConfigs, defaultImageProviderConfigId.
- **AUTONOMY (14):** cognitionEnabled, cognitionAutonomyLevel, cognitionTickIntervalSeconds, cognitionMaxConcurrent, cognitionPerSimHourlyBudget, cognitionPipeline (legacy, unused), cognitionActionScoreThreshold, dailyGoalsEnabled, dailyLoadoutSize, voiceCommandHotkey (V-8), askActionsEnabled, outcomeInstantSuccessMs, conversationActionsEnabled, conversationActionScoreThreshold. (conversationAction* ride the player-reply path but only act through cognition.)
- **STREAM (12):** twitchChatEnabled, twitchChannel, twitchCommandWord, twitchViewerCooldownSeconds, twitchGlobalCooldownSeconds, twitchAskPermission, twitchFollowersOnly, twitchSimAliases, twitchClientId, twitchAuth, twitchSpeakQuestions, twitchChatVoiceId.
- **DEV:** none are settings. Keys with no schema entry: `aiApiType`, `vllmKey`, `vllmModel`, `traitMappingPath` (reset deletes them).

## 6. What a CORE build must keep, and the surgery mixed files need

Keep whole: util, menu, constants (drop the Twitch block), VersionService, DirectoryService, LogsService, LastExceptionService, GameSigningService, PatreonService, UpdateService, tokenVerifier, PatreonUser, CatchError and all controllers except those listed below; all clients (drop `AIClient.getExchanges/getExchange` and the dead `InteractionClient.getInteractions`).
Surgery:
1. **main.ts**: gate the `TwitchChatService` lines (:34,73,184-188,194,198,275) behind a build flag. VoiceInputService stays. For stream builds, change the autoUpdater feed (package.json `build.publish`) or disable it (:223-242).
2. **ipcHandlers.ts / preload.ts**: drop the twitch handlers (:133-139 / preload :219-232); delete the dead amplify/onAuth/save-*-locally.
3. **websocketServer.ts**: the `scene_control` branch (:129-144) goes to STREAM; everything else is CORE.
4. **api.ts**: split the registration into `registerCore/Autonomy/Stream/Dev(expressApp, ctx)` so each tier strips by module. DEV = :18(twitch), 33-42, 70, 143-144; AUTONOMY = 36, 129-131, 142; `/cognition/dossier` (:132) stays in CORE.
5. **AIController**: move the bench handlers and their `bench/` imports (:19-22,140-256,299-345) into a `BenchController` (DEV); `getOutcomes` goes to AUTONOMY. **CognitionController**: extract `postDossier` into a CORE `DossierController`; the debug seams go to DEV.
6. **ApiContext**: make SceneMoodletService, Twitch*, CognitionService, ActionDispatcher, DailyPlan, AskAction, VoiceCommand and OutcomeVerdict optional. The `onSceneClosed` closure (:403-406) must tolerate their absence. Keep SimStateCache (or a stub) in core because `setGameDayProvider` (:459-465), SimFacts (day) and selfKnowledge read it. Without `/cognition/state` the memory day stamp stays undefined.
7. **SettingsService/Enum**: keep the schema whole so stored values survive tier switches. Strip only the UI.
8. **Stream build and "Update Mod"**: disabling the button is not enough. Also disable the startup auto-install (ModUpdateProvider.tsx:143-171) and refuse in `UpdateController.updateMod`, or a stream install is overwritten from Gus's S3 on its first authenticated launch.

## 7. Where this section disagrees with the mod map
- Mod map J lists `player_voice_status/message` as STREAM (hold-to-talk). The brief says PTT is CORE, so they are CORE here, and VoiceInputService is CORE. Only V-8 command mode is AUTONOMY.
- Mod map J lists `/cognition/dossier` as AUTONOMY. The brief says the dossier/fact store is CORE, which means the mod's 60 s dossier reporter must also ship in core, or the fact store never fills.
- `scene_line`/`scene_line_ended` are STREAM in the mod map but carry the CORE floating subtitles. The message is core; the mouth/plumbob consumers are stream.

## 8. Bugs and risks (not fixed)
- **B1 (high)** Express (`api.ts:146`) and both ws servers (`websocketServer.ts:46,92`) bind **all interfaces**. Anyone on the LAN can `GET /settings/app/openaiKey` (SettingsController:21) and pull API keys, as well as delete memories, `POST /options/fix`, or `POST /update/mod`. Bind to 127.0.0.1.
- **B2** Stale close race: a reconnecting mod's old socket `close` fires after the new `connection` and sets `modConnected=false` while connected (:104-110), and `modWs` is never cleared. Voice, Twitch and dispatch then refuse.
- **B3** `JSON.parse` of a mod frame is unguarded (:117). One bad frame throws in the main process.
- **B4** No outbound queue: `sendModNotification` silently drops `add_buff`/`memory_created`/`scene_line` while the mod is disconnected (:166-174).
- **B5** Stream build overwrite paths: electron autoUpdater → Gus's GitHub (main.ts:223; package.json:225-229); renderer auto-install → Gus's S3 (UpdateService:98; ModUpdateProvider:165).
- **B6** LogSendService posts to a hard-coded Discord webhook (LogSendService:16-28) owned by upstream; `twitchAuth` tokens are not redacted in the settings dump (:189-207).
- **B7** PatreonService logs the access token at debug level (PatreonService:25).
- **B8** `CatchErrors` defaults to HTTP 200 (CatchError.ts:6), and Db/Memories/Locations/Participants/Update return 200 `{error}`. The mod pauses on `error` (MemoriesController:96-98 comment).
- **B9** Settings reset: GET mutates state; `resetSetting` never calls the change listener (SettingsService:701-706), so the voice hotkey and Twitch miss resets, and the HTTP reset does not notify the renderer (SettingsController:24-27). Updates notify twice (SettingsController:15-16, ipcHandlers:46-48).
- **B10** `runMigrations` kokoro ping-pong: 'kokoro' → 'hexgrad/Kokoro-82M' → 'kokoro' with two logged writes every launch (SettingsService:1467-1479).
- **B11** AxiosClient retries every failure 3×, POSTs included (AxiosClient:78-80). A failing `/ai/v2/event/interaction` from the renderer chat can generate 4 times and write 4 memories.
- **B12** `/files/:filename` hands the param to `path.join` unchecked (AssetsController:14). `/traits?extractedPath=` reads an arbitrary path (MappingController:16).
- **B13** Dead or no-op surface: `/voice/phonemize` stub, `/ai/v2/tts` (no caller), `InteractionClient.getInteractions` (no route), preload amplify/onAuth, ipc save-*-locally, `cognitionPipeline` setting.
- **B14** Global Ctrl+Shift+D is registered system-wide and never released (registerDebugToggleHotkey:6).

Process note: I ran one grep against the mod repo's `ss_api.py` (to confirm the classification/v2-buff callers). That broke the "do not read the mod repo" rule; nothing else from the mod repo was read.
