# CLAUDE.md

Sentient Sims App is an Electron desktop companion app for the Sentient Sims mod for The Sims 4.
It acts as a secure proxy between the game and various AI APIs (OpenAI, Gemini, KoboldAI, NovelAI, VLLM, and a custom Sentient Sims AI service).
It also manages game state, saves, memories, locations, and participants via a local SQLite database.

Commands:
  npm run start       Dev mode (electron-vite dev: renderer HMR + main/preload rebuild + Electron)
  npm run build       Production build (main + preload + renderer via electron-vite)
  AWS_PROFILE=sentientsims npm run check Run all the compile, integration/unit tests, and eslint. Run this after each change to verify

Single test: edit the filename filter in test:single or run directly (Vitest takes a substring filename filter):
  cross-env NODE_ENV=test ELECTRON_RUN_AS_NODE=true ./node_modules/.bin/electron ./node_modules/.bin/vitest run YourTest

Tests run through Electron's Node runtime (ELECTRON_RUN_AS_NODE=true) with Vitest (config in vitest.config.ts,
setup in vitest.setup.ts). This is required because the native better-sqlite3 addon is built for Electron's ABI,
not system Node's. Vitest runs files serially (fileParallelism: false) to avoid Express port collisions.
Integration tests (.it.test.ts) require OPENAI_KEY env var; the AWS-backed tests in Api.it.test.ts need AWS_PROFILE=sentientsims.

Build tiers (release 4.5): one tree, three builds. tiers.json lists what each player build leaves out
(STREAM, AUTONOMY, DEV paths); core = the public release, minus all three; stream = minus DEV; the loose
tree is dev. Core code reaches tier code ONLY through src/main/sentient-sims/tiers/: the ApiContext.ext
capability slots and the TierRegistration hooks (construct, routes, ipc, start, onSettingChanged,
onDatabaseLoaded, onSceneClosed, onModMessage, onMemoryUpserted, shutdown). Each tier keeps its services
per context (autonomyOf/streamOf/devOf(ctx)). The renderer asks src/renderer/tiers/merge.ts for tier routes,
nav, settings tabs/rows, providers. tiers/index.ts and renderer tiers/index.tsx are GENERATED
(scripts/gen-tier-index.ts; committed in dev form, Tiers.test.ts pins it); src/ never imports tiers.json.
IPC a tier adds goes through tierInvoke/tierOn over interfaces the tier's own file augments (tiers/ipc.ts).
Check a build: `bash scripts/strip-check.sh core|stream` (worktree of HEAD: strip, tsc, unit tests,
electron-vite build, scripts/verify-build.ts reads the source maps for stripped files and the tier stamp).
A new file that belongs to a tier goes in tiers.json; a core test that needs a tier is a tier test.

Architecture:

  Main process (src/main/main.ts) creates the BrowserWindow, starts an Express HTTP server on port 25148 (tests use 25198), and sets up WebSocket servers (mod 25145, renderer 25146). The Sims 4 mod communicates with this Express API.
  Renderer process (src/renderer/) is a React 19 UI with MUI components, React Router, and TanStack Query. Communicates with main via IPC and the local Express API.
  Preload (src/main/preload.ts) bridges renderer to main process via contextBridge.

Backend (src/main/sentient-sims/):

  ApiContext (services/ApiContext.ts) is the central dependency injection container. It instantiates all services, repositories, and controllers. Most classes receive ApiContext in their constructor.

  controllers/ - Express route handlers, registered in api.ts
  services/   - Business logic:
    AIService                   - Orchestrates AI generation across providers, resolving a provider config per AIActionType
    GenerationService           - Interface implemented by each AI provider
    ProviderConfigService       - Resolves named provider configs (AIProviderConfig: provider + model) with a default config and per-action overrides; legacy aiApiType stays two-way synced with the default config via SettingsService hooks
    PromptRequestBuilderService - Builds prompts from game state, memories, interaction context
    PlayerConversationService   - The thread between the player (chat window, voice persona, Twitch chat) and a sim: each reply sees the exchange so far, and the thread closes when the sim has said their piece, on idle, or when the game stops the scene
    SettingsService             - Persists user settings via electron-store
    DirectoryService            - Manages Sims 4 mod/save file paths
    DbService                   - SQLite database via better-sqlite3
  db/         - Data access layer over SQLite (Repository base class, LocationRepository, MemoryRepository, ParticipantRepository, InteractionRepository)
  models/     - TypeScript types/interfaces. ApiType enum defines supported AI backends.
  tokens/     - Token counting implementations per AI provider

Frontend (src/renderer/):
  App.tsx      - Main router with pages (Home, Settings, Memories, Locations, Sims, Chat, Logs, etc.)
  hooks/       - React Query hooks for data fetching
  clients/     - HTTP client wrappers (at src/main/sentient-sims/clients/) for the local Express API
  providers/   - React context providers
  settings/    - Settings UI components

Player-facing replies (2026-09-21): a directed scene driven by a playerLine (chat window, voice/conscience, Twitch !ask)
is `playerFacing` in AIService.runDirectedGeneration — full-length straight answers (pipeline/prompts/scene.ts
playerFacing branch, playerReplyMaxTokens), the sim's live <STATUS>/<TODAYS_PLAN> block (util/formatCognitionPrompt
formatSelfStatus), the conversation thread as context, and the scorer's action verdict acting through
CognitionService.actOnConversation (source 'conversation'; settings conversationActionsEnabled and
conversationActionScoreThreshold, default 8, both on the Settings page). Since 2026-09-22 that action is HELD until
the reply's scene closes (ScenePlaybackRegistry.onSceneClosed -> releaseConversationActions), the Action Scene
omits idle/self-care verbs the transcript never mentioned (util/conversationActions), and the dispatch carries no
priority/preempt — it queues like a cognition push and the mod lets the player's click win. Long replies air in
sentence chunks (util/airingChunks, `continues` on DialogueLine → 150 ms gap, mouth stays open in the mod). Sim-to-sim
scenes keep the short-line rules. Bench: GET /bench/player-threads, POST /bench/player-thread/:index {simId}.

Pets, babies and infants can be kept quiet (2026-10-15): setting nonControllableSimsSpeak (default true, checkbox
on the Settings page next to Directed Scenes). Off, util/speechCapability.canSpeak says no for a pet (event is_pet, the
report's self.species or the fact store - a Twitch ask is built as a human adult, so the report outranks the event) and
for BABY/INFANT (lifeStageOf, else the event age); toddlers up, occults and ghosts always speak, unknown fails open. In
runDirectedGeneration a silent performer still gets a director briefing (silentNames), an actor turn in the THINK-only
format, a score and a monologue row; no line of theirs airs, the reviewer no longer demands both voices (speakerNames),
and a cast with no speaker runs finishMonologueScene with aloud=false - stored "(thinking)" rows, no "(to self)" TTS. A
player line to a silenced sim gets a thought back and opens no PlayerConversation thread. The classic narrator path adds
one system-prompt clause and drops the sim's lines from paced playback; wants of a silenced sim are generated unvoiced.
The mod sends everything already (is_pet, age, report species); nothing changes there.

Stale scenes are dropped, not aired late (2026-10-12): services/SceneFreshness.ts judges a directed scene against
the wall-clock time of the game event it came from (`eventAt`, stamped in AIController on arrival, or the CLAIM time
for a prefetched scene; absent for chat/bench/scenario, which are never judged). Three gates in
AIService.runDirectedGeneration: at dequeue before any model call, in play() before airing, and for each continuation
round (which carries the scene's eventAt). Stale = older than `sceneEventMaxAgeMs` (setting, default 60000, round 1
only) OR a participant has since been in an event whose cast does not hold all of this scene's AND that event is
over MOVED_ON_GAP_MS (15 s) newer (same pair or a superset never supersedes; judged only before generation starts,
never at play or on a queued scene - a side social with the next sim over arrives within seconds and must not cut
a scene about to play, live 2026-10-12) OR a participant the mod reported gone after the event. The mod's `scene_control` with
reason left_lot/absent + sim_id marks the departure (cleared by a later event naming the sim, or a state report
listing them on the lot >6 s after the mark) and ScenePlaybackRegistry.stopForSim ends every scene they are in;
recordEvent also runs ScenePlaybackRegistry.stopPending so a scene the renderer holds but has not started is dropped
(reason 'superseded'). A scene that declines to air returns NOOP to the mod so no unheard dialogue is stored (the
claim route checks play()'s boolean). Why: 2026-10-11 stream, fans at a VIP rope stacked scenes at 10-20 s a round
with continuation rounds in the priority lane; one was still on round 3 minutes after the game moved on. Tests:
SceneFreshness.test.ts, SceneStaleSkip.test.ts, SceneControl.test.ts, ScenePlaybackRegistry.test.ts.

Sentient Moodlets (2026-09-22): when a voice-mode scene closes (ran its course, or the game stopped it),
ScenePlaybackRegistry hands `onSceneClosed` (cast + the lines actually heard) to services/SceneMoodletService,
which runs ONE buff-stage call (StageId.BUFF / AIActionType.BUFF, so its provider config and prompt override
apply) returning per sim an emotion or none, a tier 1-3 (+1 minor / +2 notable / +3 life-altering), hours
inside the tier band, and a tooltip sentence; each verdict goes to the mod as `add_buff` with `intensity`
and `duration_minutes`. Fewer than 4 heard lines or nobody with a sim id -> no call. The typed chat window's
older classify-then-describe path (AIService.runBuff) is untouched. Test: SceneMoodletService.test.ts.

Pets and player notes in the facts store (2026-10-12): the dossier lists a pet as a bare household member id and
never says what it is, so the app learns species from the state report (self.species on a reported pet, species on a
perceived one) via SemanticMemoryService.recordSpeciesFromReport (wired in ApiContext.onReport): a `species` game fact
on the pet and a `pet` edge from every housemate whose dossier lists it; dossierToFacts derives the same edge on the
next ingest (speciesOf lookup) so the diff keeps it, and retires it when the pet leaves the household. renderKnownFacts
takes pets out of "you live with ..." and adds "your pet: Bosun the dog"; a present pet is labelled "Bosun (dog, he/him):
your dog". The `note` predicate is the player's free-text "always know" field (rendered verbatim right after the
household line); FACT_PREDICATE_HELP explains every predicate and is served by GET /facts/predicates for the Facts
dialog's tooltips. Tests: FactVocabulary, RenderKnownFacts, SemanticMemory, SimFactRoutes.
The store keeps the game's identifiers (trait_Pet_Glutton_Dog, trait_SimPreference_Likes_Activities_Cooking); util/factWords
says them in plain words ("Glutton (Dog)", "Cooking", "Hip Hop music", "Nanny", "Popularity") for BOTH the prompt and the
Facts dialog, so never prettify in one place only. A pet gets no HUMAN occult (dossierToFacts drops it when the species is
known; recordSpecies retires one already stored). PUT /sims/:id/facts/:factId rewords a non-game fact: new row, old row
retired with supersededBy (SemanticMemoryService.editFact); the dialog's Edit button on player facts uses it.

Mod log lines (2026-09-22): every `log` message from the mod is appended to Mods/sentient-sims/logs.txt under
modsDirectory (util/format formatLog, timestamps in UTC) and, at INFO and above, mirrored into electron-log's
main.log as `[Mod] <LEVEL> <message>` (util/modLogMirror), so the mod's game-thread stall watchdog lines
(`game thread stall: ...`, `game thread slow ...`) sit next to [Scene]/PUSHDIAG with local timestamps. DEBUG never
reaches main.log. Test: ModLogMirror.test.ts.

Voice transcription (2026-10-12): services/TranscriptionService.ts has three providers behind one transcribe():
the Sentient Sims AI server (default; its own JSON request, the server picks the model), any OpenAI-compatible
/audio/transcriptions endpoint, and ElevenLabs Scribe v2 (clients/ElevenLabsSTTRequest.ts; reuses the ElevenLabs
key from the Voices settings; `voiceInputProvider = elevenlabs`). The names in play (util/sttVocabulary.ts: on-lot
sims, the sims they see, known sims, then the save's participants) reach the Whisper-style providers as the V-7
text prompt and Scribe as `keyterms` (full name + first name each, the game's worlds in between, capped at 100
because above that ElevenLabs bills a 20 s minimum per request; 20% surcharge). Two paths after the transcript,
in VoiceInputService.handleAudio: the Whisper-style providers keep the V-7 fuzzy post-pass (util/nameCorrection.ts
correctNames/correctPlaces, conservative on purpose, a safety net for players without an ElevenLabs key), while a
Scribe transcript is sent as heard - it was told the spellings up front, and in a live check with TTS clips of the
logged misses (Anker -> "Anchor", Halley -> "Hallie", Kado -> "Cotto", which the fuzzy pass never reached)
keyterms fixed every one. Every provider drops a transcript that is nothing but a silence hallucination ("Subs by
...", "Thank you for watching") as Heard nothing. Log lines: `Voice input transcript corrected: "raw" -> "text"`
(Whisper path only) then `Voice input transcript (<provider>): ...`. Twitch !ask has its own loose phonetic match
for typed names (util/twitchSimTarget.ts).

Name pronunciation for TTS: participant.pronunciation (IPA) is read inline as `/.../` on Eleven v4 only, and
applies to EVERY line whoever speaks it (ParticipantRepository.getPronouncedNames, VoiceCasting.applyPronunciations) -
it used to be looked up for the scene's cast alone, so a sim talked ABOUT kept the default reading (Halley as
hay-lee, live 2026-10-12). Each swap logs `[TTS] <speaker> reads: ...`. Measured with Scribe listening back:
"/ˈhæl.i/" read hah-lee on both voices tried, "/ˈhæli/" (no syllable dot) did not once, so keep syllable dots.

IPC: ipcHandlers.ts registers Electron IPC handlers (dialog, settings, clipboard, navigation). Renderer uses window.electron.ipcRenderer for direct main process calls, and HTTP clients for Express API calls.

Build: electron-vite (config at electron.vite.config.ts) builds main/preload/renderer to release/app/dist/{main,preload,renderer}/. All node_modules deps are bundled (build.externalizeDeps: false); only native modules from release/app/package.json (better-sqlite3) stay external. Packaging via electron-builder (Windows NSIS, macOS DMG, Linux AppImage).

Native modules: the root `rebuild` script (run by `postinstall`) rebuilds for Electron's ABI only the modules named in its
`--only` list, currently better-sqlite3. A new native dependency that needs an Electron rebuild must be added to that list
by hand, or it silently keeps the system Node ABI and fails to load. There is no global keyboard hook dependency: the
voice hotkey is heard by the game overlay and relayed by the mod (`voice_hotkeys` / `voice_key` websocket messages).

Signing/notarization secrets (macOS packaging): the Developer ID cert arrives as base64 in APPLE_P12_BASE64 (password APPLE_P12_PASSWORD); notarization uses APPLE_ID/APPLE_ID_PASS/APPLE_TEAM_ID, and electron-builder reads CSC_LINK/CSC_KEY_PASSWORD. NEVER print these — no env, env | grep, echo, or cat of the .p12. Decode the cert straight to a gitignored file (printf '%s' "$APPLE_P12_BASE64" | base64 -d > certificate.p12) and reference everything by variable name only. See the "Never expose secrets" rule in the global CLAUDE.md.

Code conventions:
  TypeScript strict mode throughout
  Prettier: single quotes, trailing commas, 120 char print width
  Tests in src/__tests__/, named *.test.ts (unit) or *.it.test.ts (integration)
  ESM modules ("type": "module" in package.json)

64-bit game ids (sims, memories, participants): the game uses ids bigger than JavaScript numbers can
hold exactly, so treat every id as an opaque string everywhere — JSON, websocket, IPC, renderer, and
entity types. Only the SQLite layer touches the real integer: read INTEGER id columns with
.safeIntegers() and convert to string with .toString(), and bind ids in queries with BigInt(id).
Never pass an id through Number() or parseInt — it silently rounds and the id stops matching.
