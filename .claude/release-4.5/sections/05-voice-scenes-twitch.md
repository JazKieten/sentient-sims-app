# 05 · Voice, scenes, push-to-talk, Twitch (app side)

Baseline: `sentient-sims-app` `jasmine-phase-3` @ `62b9bad`, read-only. Compared against `upstream/main`
(`cf65dab`, 4.1.0; the repo has no `upstream/develop` ref). Upstream 4.1.0 already had paced `scene_line`
{speaker,text,preamble}, the renderer scene queue (max 3), SS-AI + ElevenLabs TTS and `scene-line-shown`/`scene-dropped`
IPC. Everything else in this section is fork-only. Key: **CORE / AUTONOMY / STREAM / DEV**.

## 1. Files

| File (lines) | Up? | Class | What it is / sends / consumes | Deps, timers, tests |
|---|---|---|---|---|
| services/SceneService.ts (88) | up, unchanged | CORE | Location "scene" (id = ms timestamp); `checkSceneBoundary` / `endCurrentScene` / `reset`. Not the playback scene. | used by AIService.handleSceneBoundary, Twitch runAsk (location id). SceneService.test (4) |
| services/ScenePlaybackRegistry.ts (332) | new | CORE (+STREAM entry point) | Bookkeeping of airing conversations: `roundQueued`, `generationStarted/Finished`, `lineShown`, `playbackEnded`, `stop(soft/hard)`, `stopAll`, `isStopped`, `attachMemory`, trim cut rows, `onSceneClosed` hook. Emits (via deps) `scene_ended {scene_id, reason:'finished'\|'stopped'}` and renderer `scene-stop`. | TTL 10 min live / 5 min stopped (sweep on `entry()`). ScenePlaybackRegistry.test (17), SceneStopGating (1) |
| services/SceneMoodletService.ts (326) | new | STREAM | Appraises a closed scene (≥4 heard lines) with one `runOneShot('Scene Moodlets', AIActionType.BUFF, StageId.BUFF)`; sends `add_buff {sim_id, mood, buff_description, intensity 1-3, duration_minutes, scene_id, source:'scene'}` per moved sim. 15 emotions + ~70 synonyms, tier hour bands. | only caller ApiContext.ts:404. SceneMoodletService.test (14) |
| services/PlayerConversationService.ts (183) | new | CORE | Player↔sim thread keyed `sortedSimIds\|speaker`; `begin` (resume within idle window, else new UUID sceneId seeded with last 4 lines), `contextLines` (16), `record(landed)`, `onSceneStopped`, `closeAll`. `notifyClosed` → `conversation_closed {sim_ids, sim_names, speaker, reason:'landed'\|'idle'}` (stop/boundary/reset are silent). | setting `playerConversationIdleMinutes` (5). No timer: idle is detected lazily in `sweep()` from `begin()`. PlayerConversationService.test (7) |
| services/ElevenLabsVoicesService.ts (55) | up, unchanged | CORE | GET `{elevenLabsEndpoint}/voices` with `xi-api-key`, caches to setting `elevenlabsVoices`. | ElevenLabsVoices.test (3) |
| services/TranscriptionService.ts (127) | new | CORE (PTT) | OpenAI SDK `audio.transcriptions.create` against any OpenAI-compatible STT (OpenAI, Groq, local whisper). Key = `voiceInputKey`, else `openaiKey` only when endpoint == OpenAI default, else `'not-set'`. `namePrompt()` biases with on-lot/known/participant/location names. `healthCheck` = `models.list`. | settings voiceInputEndpoint/Key/Model(`whisper-1`)/Language; 30 s timeout, 0 retries. VoiceInput.test (TranscriptionService block) |
| services/VoiceHotkeyService.ts (334) | new | CORE (PTT) + AUTONOMY (command chord) | Global hotkey via lazy `uiohook-napi` (true hold, keyup); falls back to Electron `globalShortcut` toggle. Second chord `armCommand` for V-8 orders. | native dep uiohook-napi; `shutdown()` on will-quit. `parseHotkey` tested (VoiceInput.test) |
| services/VoiceInputService.ts (267) | new | CORE (PTT) | State machine idle→listening→transcribing. Sends `player_voice_status {status:'listening', speaker, mode}` / `{status:'transcribing'}` / `{status:'error', detail}` and `player_voice_message {text}`; IPC `voice-record-start/stop`, `voice-transcript`. `correctNames` post-pass. Command mode hands text to VoiceCommandService. | timers: force-stop 60 s (`voiceInputMaxRecordMs`), delivery 45 s; drops <1000 B. VoiceInput.test (20 total) |
| services/VoiceCommandService.ts (113) | new | AUTONOMY | V-8: one-shot maps an utterance onto the active sim's OFFERED vocab (`offeredActions`, `validateIntent`) → `actionDispatcher.dispatch({priority:'critical', source:'player_command'})` → `enqueue_interaction`. Needs `simStateCache` report. Toasts + `player_voice_status error` on miss. | lazy `ctx.voiceCommand` (ApiContext.ts:576). No dedicated test |
| services/TwitchAuthService.ts (254) | new | STREAM | OAuth Device Code flow (scope `moderator:read:followers`) with the streamer's own Client ID; Helix `/users`, `/channels/followers`; refresh; follower cache 10 min, cap 500. | settings twitchClientId, twitchAuth; poll interval timer. Covered inside TwitchChat.test |
| services/TwitchChatService.ts (648) | new | STREAM | Anonymous IRC (`justinfan`) over `wss://irc-ws.chat.twitch.tv`; `!ask` parse, permission/cooldown/follower gates, queue cap 25, one in flight; resolves a named sim from the roster; builds its own 1-sim chat event and calls `ai.runDirectedGeneration` on `generationQueue.runSpeech` (never via the mod). Also **feeds the sim-alias registry** (`setSimAliases`, :114, :141). | timers reconnect(backoff ≤60 s), idle 6 min, fallback 60 s, settle 1 s, modRetry 5 s, reconfigure 500 ms. TwitchChat.test (46) |
| controllers/VoiceController.ts (37) | up, unchanged | CORE (+dead) | `GET /voice/phonemize` (stub, returns `OK`: dead Kokoro-local remnant), `GET /voice/elevenlabs/voices`, `POST .../refresh`. | api.ts:120-122 |
| controllers/WebsocketController.ts (13) | up | CORE | `GET /websocket/isconnected` → {mod, renderer}. Sends nothing. | api.ts:123 |
| websocketServer.ts (182) | up +31 | CORE + STREAM branch | Mod socket: `clock_state` → renderer `clock-state` (gated `playbackFollowsGameClock`, CORE); `scene_control {action stop\|stop_all, mode, scene_id, reason, sim_id, distance_m}` → registry.stop/stopAll (**STREAM**, :129-144); `log`. `sendModNotification`, `isWebSocketConnected`. | no try/catch on JSON.parse (:117) |
| util/notifyRenderer.ts | up +158 | CORE mostly | All mod senders listed in §2; renderer `on-voice`, `scene-stop`, `clock-state`, `twitch-status` (STREAM, :55-58). `setSceneMemoryObserver` → registry.attachMemory. | PlayTTS.test (14), SceneLineMessages.test (5) |
| ipcHandlers.ts | up +54 | CORE + STREAM | see §3. Twitch IPC :133-139, signature takes TwitchChatService (:39). | |
| renderer/providers/AudioContextProvider.tsx (363) | up +166 | CORE (+STREAM stop listener) | The playback engine: scene queue (3, priority unshift), picks SS-AI or ElevenLabs hook, reports lines (`scene-line-shown/ended`), `scene-playback-ended {sceneId, completed}`, `scene-dropped`. Pre-empt on `voice-record-start` (CORE PTT). `scene-stop` listener :318-342 (fed by STREAM scene_control and by core boundary stops). | |
| renderer/voice/audioPlayback.ts (284) | up +89 | CORE | Shared AudioContext, decoded-buffer and MediaSource-stream players; V-1 pause/rate hooks. | |
| renderer/voice/playbackClock.ts (98) | new | CORE | V-1: user pause (paused_by 'user' only) holds audio + queue; SPEED2/3 → 1.25/1.5x; `pacedDelay`. | |
| renderer/voice/TTSHook.tsx (24) | up | CORE | Hook interface (`speakLines` with onLineStart/End/shouldContinue). | |
| renderer/voice/useElevenLabsTTS.tsx (261) | up +39 | CORE | ElevenLabs `/text-to-speech/{voice}` (+`/stream` for line 1), prefetch next line. **API key used in the renderer.** | ElevenLabs.test (26), ElevenLabs.it.test |
| renderer/voice/useSentientSimsTTS.tsx (372) | up +38 | CORE | SS AI TTS `POST {sentientsimsaiEndpoint}/v2/audio/speech` (Kokoro/Orpheus models, `Authentication` = Patreon access token), `/sent-tokenize` for plain speak; one retry on 5xx. | |
| renderer/voice/useVoiceRecorder.tsx (112) | new | CORE (PTT) | MediaRecorder `audio/webm;codecs=opus` on `voice-record-start/stop`, device `voiceInputDeviceId`; invokes `voice-transcribe`; `voice-record-error`. Mounted by providers/VoiceInputProvider (floating "Listening…" chip). | |
| renderer/voice/useVoiceTestPlayback.tsx (124) | up | DEV | Chat page "Voice Test Mode" per-line SS-AI fetch. | |
| renderer/voice/useElevenLabsVoiceInfo.tsx (124) | up | CORE | Settings voice-card lookup (GET voice by id). | |
| renderer/kokoro/voices.ts (315) | up | CORE (+dead) | `VOICES` table = SS-AI Kokoro voice ids (used by SS-AI settings/Kokoro pickers). `getVoiceData/getVoiceFile` (HuggingFace `.bin` + Cache API) have **no callers** — dead. | |

Other hits of the grep (kokoro/elevenlabs/orpheus/tts/transcrib/twitch/hotkey), classified: CORE — clients/ElevenLabs{TTSRequest,VoiceRequest,Error}, clients/VoiceClient, formatter/{VoiceCasting,ElevenLabsVoiceCasting,KokoroVoiceCasting}, models/{ElevenLabs*,SentientSimsAITTSSettings,VoiceType,PlayerVoicePersona,ApiType}, db/ParticipantRepository + migrations (per-sim voice pins, `participant_voice` sidecar), util/{airingChunks,pacedScenes,nameCorrection,simAliases}, pipeline/prompts/scene.ts (playerFacing), renderer SimsPage/SimVoiceSelect/KokoroSimVoiceSelect/VoiceTestButton/useActiveVoiceType/useElevenLabsVoices/AISettingsProvider, settings VoiceSettingsComponent + ElevenLabs/SentientSimsAI/VoiceInput components. Dead in CORE — KokoroAIVoiceSettingsComponent, OpenAIVoiceSettingsComponent, models/KokoroAITTSSettings, OpenAITTSSettings, WebGpuDebug (dropdown offers only SS-AI and ElevenLabs; AudioContextProvider.tsx:52-59 routes only those two). STREAM — models/TwitchChatStatus, util/twitchIrc (182), util/twitchSimTarget (123), settings/TwitchSettingsComponent, SettingsPage Twitch tab (:19,:30,:116-117), constants.ts:194-218. AUTONOMY — models/AIActionType ask/voice-command entries, pipeline/prompts/ask.ts, AskActionService (other section). DEV — bench/playerThreads(+Fixtures) (imports `TWITCH_CHAT_SPEAKER` from STREAM twitchSimTarget), DebugController.injectTwitchMessage (`POST /debug/twitch-message`, api.ts:18), AIController.tts (`GET /ai/v2/tts`), registerDebugToggleHotkey. False positives: GeminiService model list, tokens/*, interactionDescriptions.

## 2. Websocket traffic this section owns

| Direction | Message | Payload keys | Sender (file:line) | Tier |
|---|---|---|---|---|
| app→mod | `scene_line` | speaker, text, preamble, voiced, scene_id, speaker_sim_id, participant_sim_ids, continues | notifyRenderer.ts:199 via ipcHandlers.ts:79 (per aired line); AIService.ts play() player-line echo (no scene_id); AskActionService.ts:403 | CORE (ids used by STREAM mod) |
| app→mod | `scene_line_ended` | speaker, scene_id, continues | notifyRenderer.ts:228 via ipcHandlers.ts:84 | CORE send, STREAM consumer (mouth) |
| app→mod | `scene_ended` | scene_id, reason finished\|stopped ('dropped' declared, never sent) | ApiContext.ts:414 ← registry | CORE send, STREAM consumer (scene watch) |
| app→mod | `conversation_closed` | sim_ids, sim_names, speaker, reason landed\|idle | ApiContext.ts:390 ← PlayerConversationService | CORE (typed chat window shows it) |
| app→mod | `player_voice_status` | status listening\|transcribing\|error, detail, speaker, mode chat\|command | VoiceInputService.ts:122,139,155,176,247; VoiceCommandService.ts:40,88 | CORE (PTT) |
| app→mod | `player_voice_message` | text | VoiceInputService.ts:172 | CORE (PTT) |
| app→mod | `add_buff` | sim_id, mood, buff_description (+intensity, duration_minutes, scene_id, source) | AIService.runBuff (bare 3 keys, CORE); SceneMoodletService.ts:319 (tiered, STREAM) | split |
| app→mod | `memory_created` | memory, paced | notifyRenderer.ts:93 (paced via pacedScenes) | CORE |
| mod→app | LOG `{clock_state}` | speed, paused, paused_by | websocketServer.ts:119 → IPC `clock-state` | CORE |
| mod→app | LOG `{scene_control}` | action, mode, scene_id, reason, sim_id, distance_m | websocketServer.ts:129-144 | STREAM |
| mod→app HTTP | `POST /ai/v2/event/interaction` `event_type chat`, `source:'player_voice'` | ChatInteractionEvent | AIController.ts:63-70 (speech lane) → AIService.handleChat :1094 | CORE |

## 3. IPC (main⇄renderer) and external services

IPC: main→renderer `on-voice` (lines, {paced, preamble, pacedText, priority, sceneId, participantSimIds}), `scene-stop` {sceneId, mode}, `clock-state`, `voice-record-start`, `voice-record-stop`, `voice-transcript`, `twitch-status` (STREAM), `popup-notification`, `setting-changed`. renderer→main `scene-line-shown`, `scene-line-ended`, `scene-playback-ended`, `scene-dropped`, `voice-record-error`; invoke `voice-transcribe`, `voice-transcribe-test`, `twitch-status-get`/`twitch-login-start`/`twitch-logout` (STREAM). Preload: preload.ts:147-231.

| Service | Where | Credential / setting | Tier |
|---|---|---|---|
| Sentient Sims AI TTS (Kokoro 82M / Orpheus 3B models, `/v2/audio/speech`, `/sent-tokenize`) | renderer useSentientSimsTTS | `accessToken` (Patreon), `sentientsimsaiEndpoint`, `sentientsimsaiTtsSettings` | CORE (default TTS) |
| ElevenLabs TTS + `/voices` | renderer useElevenLabsTTS, main ElevenLabsVoicesService | `elevenlabsKey` (read in renderer), `elevenlabsEndpoint`, `elevenlabsTtsSettings` | CORE (BYO key) |
| STT (OpenAI/Groq/local whisper) | main TranscriptionService | `voiceInputKey` (or `openaiKey` for OpenAI only) | CORE (PTT, off by default) |
| Twitch IRC (anon) + OAuth device flow + Helix | main Twitch* | `twitchClientId`, `twitchAuth` tokens | STREAM |
| Local Kokoro (HuggingFace voice .bin, WebGPU) | renderer kokoro/voices.ts getVoiceData | none | dead |

Settings read: CORE `ttsEnabled`, `ttsApiType`, `ttsVolume`, `directedScenesEnabled`, `sceneMaxRounds`(3), `playbackFollowsGameClock`(true), `playerVoicePersona`('voice')/`Bio`/`Name`, `playerReplyMaxTokens`(400), `playerConversationIdleMinutes`(5), `voiceInput*` (Enabled false, Endpoint, Key, Model, Hotkey Ctrl+Space, HotkeyMode hold, Language, DeviceId). AUTONOMY `voiceCommandHotkey`(''), `askActionsEnabled`(true), `conversationActionsEnabled`(true), `conversationActionScoreThreshold`. STREAM `twitch*` (13 keys incl. `twitchSpeakQuestions`, `twitchChatVoiceId`, `twitchSimAliases`).

## 4. (1) Scene playback timeline

1. A generation (autonomous interaction, chat, voice, Twitch) reaches `AIService.runDirectedGeneration` (:1465). `sceneId = options.sceneId ?? thread.sceneId ?? randomUUID()` (:1497). Continuations check `scenePlayback.isStopped` first (:1500-1504) and again before scoring (:1883-1886).
2. Director → actors → reviewer → scorer. `play()` (:2043) is called now or deferred (prefetch/claim: `deferPlayback`/`onPlaybackReady`). It bails if stopped; stores monologues; `markScenePaced(finalText)`; `playerConversations.record(...landed)`; echoes the player's line as a bare `scene_line`; splits long lines (`splitLinesForAiring`, 160 chars, `continues`); tags `simId`; `scenePlayback.roundQueued(...)` (:2103); `playTtsLines` → IPC `on-voice` (paced, priority, sceneId, participantSimIds).
3. If the scorer wants more and rounds/budget allow (and not partnerless, not saveMemory), round N+1 runs fire-and-forget bracketed by `generationStarted/Finished` (:2120-2139).
4. Renderer (AudioContextProvider): drops rounds of already-stopped scenes; priority → front, else push (drop OLDEST past 3, reporting `scene-dropped`). Drain loop waits out user pauses; `speakLines` per line: fetch audio → `onLineStart` → IPC `scene-line-shown` → main `lineShown` + **`scene_line`** → audio plays (or reading hold `sceneLineReadingHoldMs` when TTS off/failed, `voiced:false`) → `onLineEnd` → **`scene_line_ended`** → gap 700 ms (150 ms after a `continues` chunk). `shouldContinue()` false after a soft stop.
5. Round done → IPC `scene-playback-ended {completed: !stopped}` → `registry.playbackEnded`: completed=false with no stop yet = pre-empt → `stop('preempted','hard')`; else `finishIfIdle` → no pending rounds and nothing generating → **`scene_ended {finished}`** + `onSceneClosed` (SceneMoodletService.appraise + cognition.releaseConversationActions).
6. Meanwhile the mod POSTs the transcript to `/memories` → `notifyNewMemoryAdded` → `consumePacedScene` → `attachMemory` (so a later cut can trim the row) → `memory_created {paced:true}`.
7. Stops: `registry.stop` → IPC `scene-stop` (renderer drops queued rounds; hard also `tts.stop()`), trim row to heard lines (soft = aired, hard = aired-1), **`scene_ended {stopped}`**, `playerConversations.onSceneStopped`, `close()`. Sources: STREAM `scene_control` (walked_away/left_lot/zone_unload/cheat); CORE `handleSceneBoundary` `stopAll('zone_unload')` (AIService.ts:503), DbService.ts:123/232 on db load/unload, and the PTT pre-empt.

**CORE without scene_control:** only step 7's STREAM source disappears. A conversation keeps airing after its sims walk apart or one leaves the lot, until its rounds run out (≤ `sceneMaxRounds` 3) — upstream 4.1.0 behaviour. Travel is still hard-stopped, but only when the first event from the new location arrives (boundary), not at zone unload. `scene_ended` keeps being sent; a core mod must ignore it. Keep ScenePlaybackRegistry in CORE: AIService, PTT pre-empt, memory trim, the paced-row observer and `conversation_closed` threads all hang off it; it is ~330 lines of pure bookkeeping.

## 5. (2) Push-to-talk end to end, and what Twitch shares

| Step | Code | Shared with Twitch? |
|---|---|---|
| Hotkey arm (uiohook hold / globalShortcut toggle) | main.ts:183,197 → VoiceInputService.ts:69 → VoiceHotkeyService.arm | no |
| Key down: mod-connected check, `voice-record-start`, `player_voice_status listening {speaker, mode}`, 60 s backstop | VoiceInputService.ts:111-130 | no |
| Renderer pre-empts playback (current round hard-stopped, queue flushed) | AudioContextProvider.tsx:306-314 → registry `preempted` | no |
| Mic capture webm/opus | useVoiceRecorder.tsx:40-90 | no |
| Key up: `voice-record-stop`, `player_voice_status transcribing`, 45 s delivery timer | VoiceInputService.ts:132-144 | no |
| Transcribe (+ name prompt) → `correctNames` | ipcHandlers.ts:117 → VoiceInputService.ts:147-165 → TranscriptionService | nameCorrection's `phonetic/levenshtein` reused by twitchSimTarget |
| `player_voice_message {text}` → mod builds ChatInteractionEvent `source:'player_voice'` → `POST /ai/v2/event/interaction` | VoiceInputService.ts:172; mod ss_voice_service | no (Twitch builds its event app-side: twitchSimTarget.buildTwitchAskEvent) |
| Speech lane | AIController.ts:63-68 `generationQueue.runSpeech` | **yes** (TwitchChatService.ts:478) |
| handleChat: 1 sim → speaker = persona label (`playerSpeakerName`); ≥2 sims (locked target) → speaker = the player's sim | AIService.ts:1094-1133 | Twitch calls runDirectedGeneration directly, speaker `Chat`, `playerLineFlavor`, `playerLineDisplaySpeaker`, `saveMemory:true`, optional `speakPlayerLine` (ElevenLabs only) |
| Ask-action triage (solo line) | AIService.ts:1479-1495 → AskActionService (AUTONOMY) | **yes** |
| Thread + playerFacing reply (status block, 400 tokens, "done" verdict, conversation action) | :1479, :1551, :1907-1920 | **yes** |
| Playback + scene_line/ended/ended | §4 | **yes** |
| Memory row | mod POSTs `/memories` | Twitch saves in-app (owner-indexed) |

## 6. (3) Where typed chat, a spoken line and a Twitch line converge

All three become `runDirectedGeneration(event, {playerLine})` with `playbackOptions.priority`, and `conversationFor` (AIService.ts:2336) keys a thread on performers' sim ids + `playerLine.speaker`:
- Typed chat, solo → speaker = persona label → **same key as the voice line**: typing and talking to one sim continue one thread.
- Typed chat or voice with a locked partner (≥2 sims) → speaker = the player's own sim name; performers are the others.
- Twitch → speaker `Chat` → its own thread per target sim (`Chat (viewer)` is display-only).
- Chat-window Continue (`handleChatContinue` :1135) resumes an open thread without starting one.
Threads close on the scorer's `done`/landed (→ `conversation_closed landed`), idle (lazy, see bug 3), a stopped scene, a location boundary (:493) or reset; the next line starts a new thread seeded with 4 lines. The bench (`/bench/player-thread`) reuses the same path (DEV).

## 7. (4) SceneMoodletService as a clean STREAM branch

Only one call site: ApiContext.ts:398 (construct), :404 (`void appraise(closed)` inside `onSceneClosed`), getter :567-569, import :90, field :272. It depends on registry types, `runOneShot`, `AIActionType.BUFF`/`StageId.BUFF` (shared with core runBuff) and `sendModNotification`; nothing imports it back. Surgery: make `onSceneClosed` a composed list — CORE registers nothing (AUTONOMY adds `cognitionService.releaseConversationActions`, :405; STREAM adds `sceneMoodlets.appraise`) — and delete the file, its getter and SceneMoodletService.test (14). Core keeps `AIService.runBuff` (`POST /ai/v3/event/buff`, bare `add_buff`). `ModAddBuff`'s optional intensity/duration/scene_id/source fields can stay (inert). Note the appraisal runs on every closed scene, autonomous sim-to-sim scenes included, not only voice mode.

## 8. (5) The voice command path (`player_command`)

Physically part of push-to-talk (second chord in VoiceHotkeyService, same capture and transcription, `mode:'command'` on `player_voice_status`), but its output is an `enqueue_interaction` through ActionDispatcherService at `critical` priority, bound to the OFFERED vocabulary from the `/cognition/state` report (`simStateCache`, `offeredActions`, `validateIntent`). Without the AUTONOMY state report it always toasts "no sim to command yet"; without the mod push engine the dispatch cannot land. It has nothing to do with Twitch. Classify **AUTONOMY**; default hotkey `''` keeps it inert, but the import chain (VoiceInputService → ctx.voiceCommand → CognitionIntent/actionDispatcher) must be cut for a core strip.

## 9. What a CORE build keeps, and the surgery

Keep: SceneService, ScenePlaybackRegistry, PlayerConversationService, ElevenLabsVoicesService, TranscriptionService, VoiceHotkeyService (chat chord), VoiceInputService (chat mode), VoiceController (drop phonemize stub), WebsocketController, all of renderer/voice except useVoiceTestPlayback (DEV), kokoro/voices.ts `VOICES` (drop getVoiceData/getVoiceFile), AudioContextProvider incl. the `scene-stop` listener (core stops use it), playbackClock + `clock_state` forwarding, util/{airingChunks,pacedScenes,nameCorrection,simAliases}.

| Mixed file | Surgery (file:line) | Tier removed |
|---|---|---|
| websocketServer.ts | drop `scene_control` branch :129-144 (and `SceneControl` in models/ModLogWebsocketMessage.ts:9-22) | STREAM |
| services/ApiContext.ts | :90,:272,:398,:404,:567-569 moodlets; :405 releaseConversationActions; :97-98,:294-298,:445,:479-489 Twitch; :43,:276,:576-581 voiceCommand | STREAM / AUTONOMY |
| main.ts | :34,:73,:184-188,:194,:198,:275 TwitchChatService; **move `setSimAliases(settings.twitchSimAliases)` (TwitchChatService.ts:114,:141) into core init + setting listener**, else service-NPC names and pinned voices silently stop working (VoiceCasting.ts:32, AIService.ts:1173/1472) | STREAM |
| ipcHandlers.ts | :11,:39 param, :133-139 twitch IPC | STREAM |
| preload.ts | :219-231 twitch bridges | STREAM |
| util/notifyRenderer.ts | :55-58 `notifyTwitchStatus` | STREAM |
| VoiceInputService.ts | :90-105 `armCommand`, :109 captureMode, :166-171 command branch, :63 VOICE_COMMAND_HOTKEY watch | AUTONOMY |
| VoiceHotkeyService.ts | command members :80-87, `armCommand` :131-170, disarm :176-186, keydown :293-304, keyup :317-323 | AUTONOMY |
| AIService.ts | ask-action fork :1479-1495; `actOnConversation` :1907-1919 and `armCognitionDesires` :1921; `selfStatusBlock` :2371 (degrades to '' without state reports; keep or strip); Twitch-only options `speakPlayerLine`/`playerLineFlavor`/`playerLineDisplaySpeaker` (:315-333, :2076-2090) inert, may stay | AUTONOMY / STREAM |
| DebugController.ts:59-78 + api.ts:18 | `/debug/twitch-message` | STREAM(+DEV) |
| bench/playerThreads.ts:8-9,:66 | imports `TWITCH_CHAT_SPEAKER` from STREAM util; move the constant or strip the bench (DEV) | DEV |
| SettingsService.ts | twitch keys :43-46, :396-450, getters :1322-1387; voiceCommandHotkey | STREAM / AUTONOMY |
| renderer | SettingsPage.tsx :19,:30,:116-117 Twitch tab; VoiceInputSettingsComponent command-hotkey field; ConversationActionsSettingsComponent (AUTONOMY) | STREAM / AUTONOMY |
| constants.ts | :194-218 Twitch constants | STREAM |

Mod-side decision to raise: `conversation_closed` is listed STREAM in the mod map, but threads serve the typed chat window (CORE) too; `scene_ended`/`scene_line_ended` will still be sent by a core app and must be ignored harmlessly by a core mod.

## 10. Bugs and risks (not fixed)

1. **Flushed/dropped rounds never report back.** AudioContextProvider.tsx:138 (PTT flush) and :287-293 (queue overflow) only send `scene-dropped`, never `scene-playback-ended`, so the registry entry keeps `pendingRounds>0`: no `scene_ended`, no `onSceneClosed` (no moodlet, held conversation action waits its TTL), and `sweep()` later deletes it without `close()`.
2. `ScenePlaybackRegistry.sweep()` (:322) drops expired entries silently (no scene_ended, no close).
3. Idle thread close has no timer: `sweep()` runs only inside `begin()`, so `conversation_closed idle` is sent at the moment the player's NEXT line arrives, just before a new thread opens.
4. websocketServer.ts:117 `JSON.parse` without try/catch inside the socket handler; `modWs` is never cleared on close, so `sendModNotification` writes to a dead socket.
5. `stoppedScenesRef` (AudioContextProvider.tsx:121) is never pruned.
6. `SceneEndedReason 'dropped'` declared, never sent.
7. Memory trim rebuilds rows from airing CHUNKS (ScenePlaybackRegistry.ts:311-314): a trimmed reply becomes one `Speaker: chunk` line per chunk.
8. Twitch needs AUTONOMY: the roster comes only from `simStateCache` (/cognition/state); without it every ask loops "Waiting: no sims reported yet" every 5 s. STREAM therefore implies AUTONOMY's state report. `speakPlayerLine` only works with ElevenLabs; default chat voice id is hard-coded (constants.ts:218). The class comment still says asks ride "the player-voice pipeline"; they bypass the mod.
9. ElevenLabs key is used from the renderer (useElevenLabsTTS.tsx:22,:38), unlike the STT key (main only).
10. Command chord fallback registers the raw string (no `Backquote`/`ScrollLock` translation, VoiceHotkeyService.ts:158) and in toggle mode reads the chat chord's `mode`.
11. Dead code shipping: `/voice/phonemize` stub, kokoro getVoiceData (HuggingFace fetch), Kokoro/OpenAI TTS settings components and WebGpuDebug unreachable from the TTS dropdown.
12. PTT `startListening` refuses when the mod is disconnected, but a disconnect during transcription drops `player_voice_message` silently.
