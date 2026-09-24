# Sentient Sims app: component map of `jasmine-phase-3` (2026-09-23)

Baseline: `62b9bad` ("Moodlet tooltips read like the game's own"). Companion to the mod map at
`sentient-sims-code/.claude/release-4.5/COMPONENT-MAP-2026-09-23.md`. Eight Opus subagents read
the app in full, one per section (`sections/01..08`); this file condenses them. Tiers as decided
by Scott on 2026-09-23 (see the mod repo's `ACTION-PLAN-2026-09-23.md`):

- **CORE**: base product + voice-mode playback with subtitles + PUSH-TO-TALK mic input + dossier /
  fact store + AI paintings + string-table labels.
- **AUTONOMY**: the cognition tick, action dispatch, ask-actions, daily plans, outcome verdicts,
  the voice COMMAND chord, conversation-to-action.
- **STREAM**: Twitch, moodlet tiers (`SceneMoodletService`), scene control (`scene_control`),
  stream review tooling.
- **DEV**: bench, scenario tester, debug pages and routes, exchange/trace persistence.
- **KILL**: CORE code that must be switched off in every build Gus does not publish himself
  (the updaters).

Sizes: main process ~28k lines (59 services, 23 controllers, 24 db files, 71 models, 35 utils),
renderer 135 files / 18.5k lines, 108 test files (all run under Electron; none cover the renderer).

---

## 0. Git baseline (section 08)

- Remotes: `origin` = `Scott-Bott/sentient-sims-app-lab` (private), `upstream` =
  `guspuffygit/sentient-sims-app`, default branch **`main`** (no `develop`).
- Merge-base `21b6640` = **v4.0.8**, the same release point as the mod. This branch is **143
  commits** ahead (104 Scott, 39 Jaz). Upstream has **8 commits** since, up to `cf65dab`
  **v4.1.0** "retire mythomax" (09-04). **10 files overlap** and need a real merge: `AIService`,
  `SettingsService`, `DbService`, `api.ts`, `constants.ts`, `App.tsx`, `MenuBar.tsx`,
  `MemoryRetrieval.test.ts`, `release/app/package{,-lock}.json`. Upstream 4.0.9..4.1.0 also adds
  `POST /paintings/mount` + button, "Sign in to install", username login.
- `release/app/package.json` = **4.0.8**; the root package.json carries no version;
  `update-version.ts <v>` bumps it. The mod's `APP_VERSION_REQUIRED` reads `/versions/app`.
- Upstream already holds fork history: Gus merged `pr/sentience-voices-subtitles` on 08-16 (40
  Scott + 11 Jaz commits public). The rebuild covers the 143 after that.
- `sentience-phase-3` (local + origin) is **27 ahead, 13 behind** HEAD: the research line
  (dispositions, triggers, tones, harness, miss-rate) and **migrations 021-026**, which
  jasmine-phase-3 lacks. Stream copy = sentience-phase-3 + the 13, same shape as the mod.
- `origin/jasmine-rollback` is Jaz's baseline, never touch. Everything else is history.
- Untracked, never public: `TODO_STREAM_REVIEW_FIXES.md` (six 09-21 stream-review fixes incl.
  the reviewer `1:` parser bug), `make them look at us when we talk t.txt` (Jaz's wish-list).
- Secrets: no live key in any commit. The ignored `.env` holds a live OpenRouter key in plain
  text (rotate if the folder is shared). Cognito pool/client/identity ids, the S3 bucket and
  `ai.sentientsimulations.com` are Gus's, hard-coded, and public already.

---

## A. Transport, lifecycle, controllers (section 01)

Startup (`main.ts`): log rotation → single-instance lock → `SettingsService` + migrations →
`DirectoryService` → `new ApiContext` (≈60 services, 11 repos, 22 controllers; `CognitionService`
built last, Twitch injected after) → `VoiceInputService` → `TwitchChatService` → IPC handlers →
global Ctrl+Shift+D → websocket servers 25146 (renderer) + 25145 (mod) → Express 25148 →
mac codesign → `paintingMount.ensureMount` → **electron-updater check** → window.

**Mod connect/disconnect:** no handshake; the mod drives `/debug/health`, `/versions/app`,
`/db/load` over HTTP. Disconnect only flips a flag; `modWs` is never cleared (B2).

**Routes:** 102 in `api.ts`. DEV: `/bench/*`, `/ai/exchanges*`, `/memories/:id/trace`,
`/cognition/debug/*`, `/debug/twitch-message`, `/ai/v2/event/directed-scene`. AUTONOMY:
`/cognition/{state,outcome,perception,sleep-boundary}`, `/ai/outcomes`. **CORE but homed in the
autonomy controller:** `/cognition/dossier` (the fact store's only feed). The mod also still calls
`/ai/v2/event/classification` and `/ai/v2/event/buff` (omitted from the mod map §J): keep both.

**Websocket, mod → app** (dispatch by key, no `type`): `clock_state` (CORE, voice playback pacing),
`scene_control` (STREAM), `log` (CORE). **App → mod** (16 types, fire-and-forget, dropped while
disconnected): CORE `notification`, `clear_sim_cache`, `migrate_single_slot_save`,
`memory_created{memory,paced}`, `memory_edited`, `memory_deleted`, `scene_line`,
`scene_line_ended`, `conversation_closed` (typed chat window: **CORE, not STREAM as the mod map
says**), `player_voice_message`, `player_voice_status`; split `add_buff` (bare 3-key chat path
CORE, tiered `SceneMoodletService` STREAM); `scene_ended` (sent by CORE, consumed by STREAM scene
watch; a core mod must ignore it); AUTONOMY `enqueue_interaction`, `cancel_interaction`,
`request_perception`.

**Settings (101 keys):** 75 CORE, 14 AUTONOMY (`cognition*`, `daily*`, `voiceCommandHotkey`,
`askActionsEnabled`, `outcomeInstantSuccessMs`, `conversationAction*`), 12 STREAM (`twitch*`).
Keep the enum and schema whole in every build (values persist); hide tier-only UI.

**Security and support findings:** Express and both websocket servers bind **all interfaces**;
anyone on the LAN can `GET /settings/app/openaiKey`, delete memories, or trigger a mod install
(B1, release blocker). `CatchErrors` returns HTTP 200 on error. `AxiosClient` retries POSTs 3×
(a failed chat can generate 4 times). Send Logs posts to a **hard-coded Discord webhook** owned
by upstream and its settings dump does not redact `twitchAuth`; `PatreonService` logs the access
token at debug level. Global Ctrl+Shift+D is registered system-wide and never released.

---

## B. Generation, prompts, providers (section 02)

`AIService` (2743 lines) is every pipeline: event dispatcher, directed scene (director → actors →
reviewer → scorer), monologue beats, classic single pass, reflections + nightly plan, one-shot
seam, classification/buff, images, TTS casting. `PromptRequestBuilderService` builds the request:
`<CHARACTER_IN_INTERACTION>`, `<RELATIONSHIPS>`, `<ALSO_PRESENT>` (from the state cache),
`<PAST_REFLECTIONS>`, `<KNOWN_FACTS>` (from the fact store), `<RELEVANT_MEMORIES>`, location,
date, season, weather, postures. `GenerationQueueService`: prefetch/claim/finalize/cancel + four
lanes (speech, foreground, cognition, idle). Providers: OpenAI, OpenRouter, Gemini, NovelAI,
KoboldAI, vLLM, Sentient Sims AI (all CORE). `descriptions/` is 33k lines of data. Dead:
`allTraits.ts`, `filters/`, `geminiEndpoint`. DEV: `MappingService` + `/traits*`, `/moods*`.

**Trace:** prefetch (mapping lookup; unmapped → `synthesizeInteractionDescription` from the mod's
string-table label → Mapping Browser "Unmapped (seen in game)") → `runDirectedGeneration` →
claim → `play()` → mod `POST /memories` → `memory_created {paced}`.

**`runDirectedGeneration` callers (10):** interaction, continue, do-something, typed chat, solo
push-to-talk (persona flavour), chat-continue = CORE; Twitch = STREAM; directed-scene route and
two bench routes = DEV. `playerFacing` adds the `<STATUS>/<TODAYS_PLAN>` block (from the state
cache + daily plan), 400-token actor budget, thread record, and `actOnConversation` (AUTONOMY).

**The raw-context leak is unfixed, now at `AIService.ts:1678-1681`.** When the director's
briefing throws or lacks a section for an actor, that actor gets the WHOLE scene context: every
performer's character block, labelled private diaries, facts, `<ALSO_PRESENT>` and retrieved
owned memories. No test covers it. Fix: fall back to the actor's own block + location/date only,
or NOOP the scene.

**What a CORE mod that never reports state loses (silently, nothing throws):** `<ALSO_PRESENT>`,
venue/ownership facts in generated lot descriptions, `<STATUS>` in player replies (the 09-21
"I don't know" regression returns for push-to-talk), the game-day stamp on every memory
(retrieval decays on wall clock), the no-diary-below-child check, voice name correction's on-lot
bias. `<KNOWN_FACTS>` is fed ONLY by `/cognition/dossier`.

**Core → other-tier imports that block a strip:** `AIService.ts:95` imports `bench/tier0`
(diary prose gate); `:80` imports `formatSelfStatus` from `formatCognitionPrompt` (drags
perception + cognition prompts); `:94-98` `DailyPlanService`, `isBelowChild` from
`ActionLoadout`. Unguarded optional-service calls (`askAction`, `scenePlayback`,
`playerConversations.record`) mean a strip must STUB those services, not delete them.

**AI exchange log:** 200-entry ring + `ai_exchange` table pruned 5000..5499 rows of full prompts
(~100 MB) in the per-save DB that is copied on every game save, containing other sims' private
text. Image generation bypasses the logger entirely (painting spend invisible).

Bugs: solo thought floor only on app-saved beats; solo beat's thought keyed by name, read by id;
`localizationEnabled` translates JSON replies (parse failures); NovelAI failure text returned as
a success; `/moods` path is `''`; unknown models fall to a 3900-token limit; `storeMonologues`
loses importance on first-name scorer keys.

---

## C. Memory, fact store, DB (section 03)

**Migrations 001-020 on this branch; 021-026 only on sentience-phase-3.** The runner applies
`known − applied` in sorted name order and **silently ignores names it does not know**, and every
migration is additive or a guarded rebuild, so a DB can move between builds in either direction.
**Recommendation: every build carries the full list; never strip or reuse a name.** Tables: CORE
participant, location, memory, memory_participants, memory_index, memory_embedding, painting,
participant_voice, sim_fact, sim_dossier; AUTONOMY daily_plan, action_outcome; DEV ai_exchange,
memory_trace; STREAM none.

**Fact store end to end:** mod dossier every 60 s → `CognitionController.postDossier` →
`SemanticMemoryService.ingestDossier` (diff by fact key, single-valued predicates supersede,
absent facts invalidated) → `SimFactRepository` (bi-temporal) → `recall` → `renderKnownFacts` →
`<KNOWN_FACTS>` in director/actor/reviewer/diary/non-directed prompts. Identity change clears the
generated description. Read/correct routes `/facts/*`, `/sims/:id/facts*` (CORE, SimsPage dialog).
Gaps: `HIPPOCAMPUS_ENCODE` has no caller; hearsay never carries a speaker.

**Memory kinds:** shared event memories (CORE); owner-stamped `monologue` and `reflection` (CORE;
sleep-triggered reflection rides the AUTONOMY sleep watcher, travel reflection is CORE); `thought`
and `outcome` rows (AUTONOMY). "Paced" is presentation, not a kind. Isolation: shared transcripts
exclude inner rows; retrieval admits owned rows only in `ownerScope`.

**CORE bugs here:**
- **B1 (high):** `MemoryIndexRepository.upsertIndex` is `INSERT OR REPLACE` naming only
  importance/owner, so every annotated memory loses `game_day` (live save: 11,474/11,499 NULL).
  Fix is **c02d582 on sentience-phase-3 only**; cherry-pick.
- **B2:** the dossier "hash" is `JSON.length` in production (mod never sends one); a wedding that
  keeps the length (fiance_id → spouse_id) is skipped. Untested path. Fix: canonical hash, or
  the mod sends `dossier_hash`.
- **B3:** re-posting a memory with an existing id does REPLACE → cascade deletes index/owner; a
  re-posted private diary becomes SHARED unless `index` is re-sent.
- Failed migration leaves a half-migrated handle reporting loaded; `getDb(saveGame)` opens and
  migrates a committed save in place and never closes it; thought rows store zone id as lot id.

---

## D. Cognition, autonomy, bench (section 04)

`CognitionService` has **no timer of its own**: the tick runs only when a state report arrives.
With no reports it idles cleanly (no LLM calls, dispatches or errors). Two CORE call-outs still
log INFO noise: `armDesireFromScene` on every directed scene and `actOnConversation` on player
replies (holds a promise 5 min, spends nothing). `ActionDispatcherService` is the only sender of
push traffic. `AskActionService` (solo player line → talk-vs-do triage → `player_ask` dispatch at
critical + preempt) returns before triage without a state entry. `DailyPlanService` is AUTONOMY
but its `parsePlannerJson` / `extractDiaryProse` serve the CORE diary path. `SimStateCache` is a
CORE-able container fed only by the AUTONOMY reporter. `VoiceCommandService` (`player_command`)
is **AUTONOMY, not push-to-talk**: it dispatches from the offered vocabulary in the state report.

**Push contract as sent:** `cognition` (priority omitted → mod default critical, no preempt,
one-in-flight app-side), `conversation` (omitted, no preempt since 09-22), `player_ask` (critical,
preempt true), `player_command` (critical, no preempt). `cancel_interaction` only on pending
timeout. `motivation` never reaches the mod.

**`clock_state` decision closes:** it is its own channel (`websocketServer` → renderer
`playbackClock`) and never touches the state cache. `clock_state` is CORE; the state reporter is
whatever the state-report decision says (section G below).

Bugs: `actOnConversation` ignores `cognitionEnabled`; one-in-flight covers `cognition` only; an
outcome with no `request_id` can close another request; the debug enqueue route sends
`cognition` but grades as owned; `askActionsEnabled` and `dailyGoalsEnabled` default TRUE while
`cognitionEnabled` defaults false (ask triage and the 900-token sleep planner run for users who
never enabled autonomy); bench `closeAll('reset')` closes live player threads.
`bench/playerThreadFixtures.ts` ships five verbatim stream conversations with real sim names.

---

## E. Voice, scenes, push-to-talk, Twitch (section 05)

**Playback timeline:** `runDirectedGeneration` → `play()` → `roundQueued` → IPC `on-voice` →
renderer scene queue (3, priority unshift) → per line: fetch audio → `scene-line-shown` →
**`scene_line`** → audio (or reading hold, `voiced:false`) → **`scene_line_ended`** → gap 700 ms
(150 ms after a `continues` chunk) → `scene-playback-ended` → `registry.playbackEnded` →
**`scene_ended {finished}`** + `onSceneClosed` (moodlet appraisal STREAM + release conversation
actions AUTONOMY). Stops: `scene_control` (STREAM), `handleSceneBoundary` zone unload (CORE),
`/db/load|unload` (CORE), push-to-talk pre-empt (CORE). **Keep `ScenePlaybackRegistry` in CORE**
(~330 lines of bookkeeping the pre-empt, memory trim, paced-row observer and threads hang off);
only the `scene_control` branch is STREAM. Without it a conversation keeps airing after the sims
separate, for ≤ `sceneMaxRounds` (3) rounds: upstream 4.1.0 behaviour.

**Push-to-talk end to end (CORE):** uiohook hold / globalShortcut toggle → `player_voice_status
listening` → renderer pre-empts playback → MediaRecorder webm/opus → `voice-transcribe` →
`TranscriptionService` (any OpenAI-compatible STT; key `voiceInputKey`) → `correctNames` →
`player_voice_message {text}` → the mod POSTs a chat event `source:'player_voice'` → speech lane
→ `handleChat` → thread + `playerFacing` reply → playback. Twitch never touches the mod, mic or
transcription; it shares the speech lane, `runDirectedGeneration`, threads, ask triage, playback.

**Threads converge in `PlayerConversationService`** keyed by sims + speaker: typing and talking
to one sim continue one thread; Twitch gets its own per target sim. `conversation_closed` serves
the typed chat window (CORE). Idle close has no timer (sent only when the next line arrives).

**`SceneMoodletService` is a clean STREAM cut:** one call site in `ApiContext.onSceneClosed`;
make that hook a composed list (CORE registers nothing). The appraisal currently runs on EVERY
closed scene, sim-to-sim ones included.

**Hidden coupling:** the sim-alias registry (service-NPC names such as the Grim Reaper, pinned
voices) is filled ONLY by `TwitchChatService` (`setSimAliases`), but CORE voice casting and
`AIService` read it. Move that call into core init or names silently break when Twitch is
stripped. **Twitch requires the state report** for its roster.

Bugs: rounds flushed by the talk hotkey or dropped on overflow never send `scene-playback-ended`
(no `scene_ended`, no moodlet, held actions wait their TTL); registry sweep drops entries
silently; `JSON.parse` on mod frames unguarded; ElevenLabs key used in the renderer; a
disconnect during transcription drops `player_voice_message` silently. Dead: `/voice/phonemize`,
Kokoro-local voice download, unreachable Kokoro/OpenAI TTS settings panels.

---

## F. Images, paintings, updaters (section 06)

**Paintings (CORE, upstream):** `POST /ai/v2/image/generate` → provider (OpenAI / SSAI / Gemini;
NOT wrapped by the exchange logger) → PNG stored in the per-save DB (1-3 MB each, copied on every
game save) → **512×512 DXT1 DDS returned when `format:'dds'`** (+ `textureInstanceId`) →
manifest `/paintings`, heal `/paintings/:id/texture` (re-encodes on the main-process event loop
every call). The mod map §H says the mod converts PNG→DDS in Python: **verify which side actually
encodes before cutting either.** The paintings mount (`Resource.cfg` DirectoryFiles block) is
created at app start and after each install; AI paintings and the STREAM plumbob texture both
depend on it: **never tier-strip the mount.** Fork is behind upstream's `POST /paintings/mount`
route + button. **PaintingsPanel lives only as a tab of the DEBUG-only Chat page: a CORE build
ships AI paintings with no UI unless it gets its own route.**

**OneDrive hazard:** `modsDirectory` defaults to the NON-redirected Documents; on a redirected box
the mount, DBs, `mod-version.json` and update extraction land where the game never reads.

**Every mod download goes through ONE route,** `POST /update/mod` → `UpdateService.installMod`
(S3 `sentient-sims-artifacts` / `sentient-sims-{main|develop}.zip`, Gus's Cognito identity
pool). Four triggers: (A) Update button, (B) **Reinstall button, always enabled**, (C) first-run
Install, (D) **unprompted startup auto-install** in `ModUpdateProvider.tsx:147-171` whenever the
S3 version string `!==` local `mod-version.json` (every fork launch with the game closed; `none`
counts). An install replaces `sentient-sims.package`, the overlay DLL/dylib, `_ctypes.dylib` and
`mod-version.json`; the ts4script is spared only when `Scripts/` exists. **Kill switch:** a build
flag in `UpdateController.updateMod` (`{skipped:'disabled'}`), hide `UpdateComponent` (HomePage
and the setup wizard), no-op the provider's effect and `checkForUpdates`.

**App self-updater:** `main.ts:222-242` checks Gus's GitHub releases on every packaged launch
(`build.publish = github guspuffygit/sentient-sims-app`; same appId
`com.sentientsimulations.sentientsimsapp`). **A packaged fork at 4.0.8 downloads v4.1.0 and
replaces itself.** Dev mode is unaffected (why this never bit). `publish.yml` from the fork would
try Gus's repo with the fork's token and fail. Fix: gate the block, repoint or null `publish`,
version above 4.1.0, consider a distinct appId.

Other: `/files/:filename` probably path-traverses; SSAI and Gemini ignore `size` (stretched);
OpenAI images go to whatever `openaiEndpoint` is; `NewsController` shows Gus's announcements in a
fork build.

---

## G. Renderer (section 07)

Routes: `/` Home (ConnectionChip, ProviderHealthChip, UpdateComponent, DebugCard, leaderboard,
thank-you), `/sims` (participants, pinned voices, **Facts dialog**), `/locations`, `/memories`
(trace button DEV), `/settings` (Settings / Voice / **Twitch** tabs), `/last-exception`; DEBUG
nav: `/chat` (scenario tester + **Paintings tab**), `/traits`, `/mapping-browser` (upstream
mapper tool), `/ai-log`, `/offlinememory`, `/logs` (the only consumer of port 25146).

**Debug mode is a global Ctrl+Shift+D that anyone can press and never turn off; DEV pages are
hidden, not removed.** A stripped build must delete the routes and `DEBUG_NAV_ITEMS`.

**AUTONOMY barely touches the renderer:** the ConversationActions settings block, the voice
"Command key", seven per-action override rows (Cognition, Action Scene, Daily Plan, Voice Command,
Ask×3), two labels in the trace dialog. STREAM: the Twitch tab, one inert `scene-stop` listener,
the updater card. Cognition and daily plans have no page and no settings.

**Fork needs code changes, not config:** Cognito pool/client/identity pool, the Patreon client
id, the S3 bucket and the AI host are literals (`AmplifyConfig.ts`, `PatreonComponent.tsx:10`,
`versions.ts`). Without a login, BYO-key providers work; SSAI, leaderboard, Save Online and mod
install go dead.

**Zero renderer tests.** Bugs: `PopupNotification` adds an IPC listener every render;
Twitch Connect throws an unhandled rejection if main strips the handlers but the tab stays;
Sims and Locations fetch twice per DB load; the voice bio placeholder names "Jaz".

---

## H. Build, CI, tests (section 08)

- `compile-lint.yml` and `test.yml` run on every push (test = full suite + `npm run package`,
  needs OpenAI, AWS and test-user secrets; fails in a fork without them). `publish.yml` on
  main/develop uploads installers to **guspuffygit's** releases (fails from the fork).
- `release/app/package.json` externalizes better-sqlite3, sharp, node-gyp, uiohook-napi (MIT).
- 108 test files, 52 added here, all under Electron; 28 touch the DB; 5 integration. The repo
  records no known-failure count (memory's "~57 failures / ~108 lint errors" are machine
  observations); `npm run check` in the packaging session settles it.
- Tracked but unreferenced: `src/main/sentient-sims/sentient-sims/` (13.6 MB of mod binaries,
  already upstream). Delete. Also `scripts/repair-memories.*` (NUL byte, diffs as binary),
  `test-import.ts`, CLAUDE.md's removed `test:e2e`.
- Licences: MIT (Gus); no bundled models or fonts; NovelAI tokenizer JSONs are upstream.

---

## I. The split, as the app map shows it

**Cleanly STREAM (whole files):** `TwitchAuthService`, `TwitchChatService`, `SceneMoodletService`,
`util/{twitchIrc,twitchSimTarget}`, `models/TwitchChatStatus`, `settings/TwitchSettingsComponent`,
the Twitch constants block, `/debug/twitch-message`, the `scene_control` branch.

**Cleanly AUTONOMY (whole files):** `CognitionService`, `ActionDispatcherService`, `AskActionService`,
`DailyPlanService` (after extracting its two CORE helpers), `OutcomeVerdictService`,
`VoiceCommandService`, `db/{DailyPlanRepository,ActionOutcomeRepository}`, `models/{CognitionIntent,
ActionLoadout,DailyPlan,SimStateReport}` (type-only files can stay), `pipeline/prompts/{cognition,
action,ask}`, `util/{conversationActions,formatPerception}`, `settings/ConversationActionsSettingsComponent`,
the Command key field, `/cognition/{outcome,perception,sleep-boundary?}`, `/ai/outcomes`.

**Cleanly DEV:** `bench/*` (after moving `assertDiaryIsProse`/`repairDiary` to a util), `MappingService`
+ `/traits*` `/moods*`, `/bench/*`, `/ai/exchanges*`, `/memories/:id/trace`, `/cognition/debug/*`,
`/ai/v2/event/directed-scene`, `MemoryTraceService`, renderer ChatPage (minus Paintings), scenarioTester,
AILogPage, OfflineMemory, LogViewerPage, TraitsPage, trace dialog, `AiMaxResponseLength`, the 25146 server.

**KILL in every non-Gus build:** `UpdateController/Service/Client`, `UpdateComponent`,
`ModUpdateProvider`, `versions.ts` S3 check, `main.ts:222-242` autoUpdater, `build.publish`,
`publish.yml`.

**Mixed files that need surgery (file:line in the sections):**
- `AIService.ts`: bench/tier0 import (:95), `formatSelfStatus` import (:80), DailyPlan imports
  (:94-98), sleep-plan branch (:527-585, :678-740), ask-action fork (:1478-1495), Twitch options
  (:317-333, :2073-2086), `actOnConversation`/`armCognitionDesires` (:1905-1922, :2412-2495),
  the leak (:1678-1681), unguarded `scenePlayback`/`playerConversations` calls.
- `ApiContext.ts`: `onSceneClosed` composed list (:403-406); optional construction of moodlets,
  Twitch, cognition, dispatcher, daily plan, ask, voice command, outcome verdict; keep
  `SimStateCache` + game-day provider (:458-465).
- `CognitionController.ts`: extract `postDossier` (CORE) to its own controller; `postState`
  per the state-report decision; strip outcome/perception/debug.
- `AIController.ts`: bench handlers to a `BenchController`; `getOutcomes` AUTONOMY.
- `api.ts`: split into `registerCore/Autonomy/Stream/Dev`.
- `main.ts`, `ipcHandlers.ts`, `preload.ts`, `notifyRenderer.ts`: Twitch lines; `setSimAliases`
  moves into core init.
- `VoiceInputService.ts` / `VoiceHotkeyService.ts`: command chord out.
- `websocketServer.ts`: `scene_control` branch out; try/catch the parse; clear `modWs` on close.
- `DbService.ts`: `outcomeVerdict.pruneOnLoad`, `scenePlayback.stopAll`, `aiExchangeLog.onDatabaseLoaded`
  become optional hooks.
- `util/formatCognitionPrompt.ts`: move `firstJsonBlock(+Loose)` and `formatSelfStatus*` to CORE utils.
- `pipeline/prompts/consolidation.ts`: diary builders (CORE) from plan builders (AUTONOMY).
- Renderer: `index.tsx` routes + `MenuBar` nav; `SettingsPage` tabs; `ProviderConfigsComponent:626`
  filter; `VoiceInputSettingsComponent` command key + "Jaz" placeholder; new `/paintings` route.

---

## J. Bugs and risks by severity (not fixed)

**Release blockers (any public build):** LAN-bound servers exposing API keys (A);
raw-context leak `AIService.ts:1678` (B); `game_day` wiped by upsert, fix c02d582 (C); Paintings
with no UI in a CORE build (G); the four mod-install paths and the app self-updater in any fork
build (F).

**Should fix for 4.5:** dossier length-hash (C); memory REPLACE cascade making diaries shared (C);
`CatchErrors` 200 (A); Axios POST retries (A); `JSON.parse` on mod frames (A/E); `modWs` never
cleared / stale close race (A); flushed rounds never closing scenes (E); `askActionsEnabled` and
`dailyGoalsEnabled` default true with cognition off (D); `localizationEnabled` translating JSON (B);
NovelAI error-as-success (B); ai_exchange ~100 MB in the save DB (B); DXT1 encode on the event loop
(F); Send Logs Discord webhook + unredacted `twitchAuth`, Patreon token in debug log (A).

**Hygiene:** dead code lists in sections 01, 02, 05, 07; `PopupNotification` listener leak;
sim-alias registry moves out of Twitch (E); Ctrl+Shift+D global hotkey (A/G).

---

## K. Where this map disagrees with the mod map

- `player_voice_*`, `VoiceInputService`: CORE (push-to-talk decision).
- `/cognition/dossier` and the mod's dossier reporter: CORE (fact store decision).
- `scene_line` / `scene_line_ended`: CORE messages (floating subtitles); only mouth/plumbob
  consumers are STREAM.
- `conversation_closed`: CORE (typed chat window), not STREAM.
- `scene_ended`: a core app still sends it; a core mod must ignore it harmlessly.
- Paintings: the app returns DXT1 DDS; the mod map says Python encodes. Verify.
