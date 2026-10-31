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
    ProviderConfigService       - Resolves named provider configs (AIProviderConfig: provider + model) with a default config and per-action overrides; legacy aiApiType stays two-way synced with the default config via SettingsService hooks. Per-Sim overrides (`aiSimProviderOverrides`, sim id -> config id; Settings > AI > "Per-Sim Provider Overrides") win over every action and stage override for that Sim's SPOKEN line only (the actor call, OneShotOptions.simId; Jaz 2026-10-30: cognition, director, scores, memory and buff calls stay on the usual pick). Log `[Provider] <label>: sim <id> is pinned to <config>` on every routed call. A config may carry `contextTokens` ("Context window (tokens)" in the config dialog): AIService.modelSettingsFor caps the model's max_tokens to it, so a self-hosted endpoint with an input cap gets prompts trimmed to fit (prompt_overflow warn) instead of a 400.
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

Lean voice pipeline (2026-10-27, DEFAULT): setting `scenePipelineMode` 'lean' | 'full' (SettingsEnum, a select
under Directed Scenes on the Settings page; SettingsService.scenePipelineMode reads anything but 'full' as lean). Lean
runs ONE actor call per Sim per round in AIService.runDirectedGeneration and nothing else: no Director Briefing, no
Director Review, no Scene Scores on pair / 3+ / monologue scenes, fixed rounds (`wantsMore` is always true, so
sceneMaxRounds, partnerless, gameWaiting, the 50 s budget and saveMemory are the only stops), and
PromptRequestBuilderService skips the director-only material (lot roster, <DIRECTOR>/<SCENE_GUIDANCE>, diaries,
retrieval + its embedding query, the scene facts list) under `options.lean`. The actor prompt is
pipeline/prompts/scene.ts buildLeanActorSystemPrompt: [rules][You are playing <name> + own <CHARACTER_IN_INTERACTION>
(ownCharacterBlock)][<LOCATION>][<KNOWN_FACTS> computed on round 1 and carried in DirectedGenerationOptions.factsBySim
so the text is identical every round][<STATUS>, player-facing only]; the USER message
(buildLeanActorUserMessage) is the now-block (<DATE>/<SEASON>/<WEATHER>/postures, moved out of the system prompt),
"Previously in this scene:" with THIS scene's aired lines only on rounds 2+, the beat, then "The conversation so
far". THE one real change: the game's beat rides into every round PER SIM (`frameBeat`, `carriedBeat`: "This scene:
<the Sim's own round-1 beat, opener stripped>" + the continuation line), so the liar keeps the lie and the dupe the
cover beat on rounds 2-3; in 4.6 only the director re-stated it and without one the actors drifted to the transcript's
tail (series 2, insight 1). The rules text is speechRules(kind, {simName?, lean?}), shared with the 4.6
buildSpeechSystemPrompt (pinned byte for byte by SpeechPromptFixture.test.ts); `leanNameFreeRules` (default true,
series 3) drops the name from the rules ("Stay in character at all times", "your character's voice") so [rules] is
one prefix for every Sim and every user, and lean says "in the tone of the scene" (no director). A reply to the
player still runs Scene Scores once (the thread's `landed`, the conversation action); a pair scene's empty score map
makes actOnConversation / armCognitionDesires no-ops and the monologue row gets its importance from the idle-lane
annotator. Why (three of Jaz's streams + two offline series, .claude/voice-pipeline-tests in the mod repo): director
51% of directed tokens for nothing a judge could see on ordinary scenes, reviewer 18% changing 2-5% of rounds (and a
parser bug dropped most of those), scores 6% saying "continue" 92% of the time; series 3 (RESULTS-LEAN-2026-10-27.md)
LEAN +0.85/10 over FULL at -66% tokens/scene, the lie kept through round 3 in every sample. 'full' is the whole 4.6
pipeline, untouched, for an A/B (tests that mock stages by label set it). Log: `[Pipeline] lean round N: <cast>,
<ms>, <lines>`. LeanPipeline.test.ts pins the contract. LIVE 2026-10-27 night (game 1.129.39.1030, dev app):
a pushed chat ran three lean rounds (1.4-2.9 s each, round 1's first line 2.2 s after the round began), round
2's message carried `This scene:` and only round 1's lines, the system prompt was the same 4,261 chars every
round; a pie-clicked LieAboutCareer kept the lie through round 3 with the dupe's message holding only the
cover beat; a chat-window line ran one actor + one Scene Scores (action 8 -> actOnConversation fired,
partnerless stop); solo beats ran one THINK call and no scores; flipping to 'full' brought Director Briefing,
reviewer's cut and scores back. A lean monologue row has no scorer's memory score, so its memory_index row is
stamped heuristicImportance('monologue') (3) at creation (AIService storeMonologues / finishMonologueScene;
a real score still wins): the idle-lane annotator only runs after the queue has been quiet for
backgroundIdleDelayMs, which the 5 s cognition tick never allows while the game runs (3 of 34 rows rated
in 12 min, 2026-10-27), and it keeps any numeric stamp as final, so the stamp is the row's rating.
LeanPipeline.test.ts (i) pins it. Nothing on release/4.6 reads the column raw; the autonomy branch's
ExperienceService ranks a Sim's day by it, which is why no NULL may land there.

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
The dialog's layout is util/factGroups.groupFacts (pure, tested in FactGroups.test.ts): a summary line (age, gender,
species or occult, ghost, home, household members, job, aspiration), then "Custom (Player Added)" first in the info colour (always
shown, even empty; the add box is its own component so typing never re-renders the rows), then categories A to Z
with rows A to Z, one Accordion each,
"People met" folded, Likes/Dislikes/Turn-ons/Turn-offs split under sub-headings (factWords.preferenceParts: Colors,
Activities, Conversation Topics, Types of Sims...), pets inside "Household Members", exes in Partners marked "(ex)"
from the romantic-Divorced bit. The dialog adds only `note` facts (shown as "Custom (Player Added)"); the route still
takes any predicate for the bench. Skills: every one the mod sends (its top 8), level 1 included, and the prompt has a
"your skills:" line since 2026-10-13. NLS = Natural Living (factWords ABBREVIATIONS).
Home (2026-10-19): the mod's dossier household carries `home` {lot_id, name, world} from household.home_zone_id
(ss_sim_dossier.build_home; mod builds from 2026-10-19). dossierFacts.homeText makes the single-valued `home` fact
'Inner Circle, Mirage Park, Del Sol Valley' (neighborhood from descriptions/lotNeighborhoods, else the reported world);
it is the FIRST line of the prompt's "About you" ("your home is ...") and a Home tag on the Facts dialog's summary.
The household's NAME (a Manage Worlds label, often not a surname: "BFF") is stored but shown nowhere: the prompt says
"you live with A and B" or "you live alone", and the dialog's summary lists the household members by name.
Traits beyond Create a Sim (2026-10-13): the dossier's `reward_traits` (aspiration rewards like Business Savvy, child
skill rewards, Top-Notch Infant/Toddler) become `reward_trait` facts and ride the prompt's personality line; `phases`
(childhood phases and a child's confidence level, mod builds from 2026-10-13) become `phase` facts and a "right now:"
line. The mod's dossier builder (sentient-sims-code-subtitles ss_sim_dossier.build_trait_groups) keeps PERSONALITY, FEAR,
ASPIRATION, CHILD_REWARD, PHASE, name-matched TopNotch/Reward traits, and the WickedWhims MAJOR personality archetype
(Lover, Sinister...) as a personality trait. On-screen names: trait_Insane is "Erratic", Characteristic_Idealist is
"Artsy", HomestyleCooking is "Cooking", Bartending is "Mixology" (factWords TRAIT_NAMES / CHARACTERISTIC_NAMES / SKILL_NAMES - every on-screen alias lives in those three tables and is
pinned by FactWords.test.ts; Lovestruck=Lovebug, Temperature_IceMan=Iceproof, BurningMan=Heatproof, TheKnack=Handy).
WickedWhims archetypes read as the bare word, major or minor. The Sims page ID column is hidden outside the dev build.
Exes: `ex_partner` edge from the dossier relationship bits romantic-Broken_Up / romantic-Divorced (objectText 'broke up' /
'divorced'), in the prompt's life people and the dialog's Partners below the current ones. GET /sims/:id/facts also returns
`relationships` (live scores + bits from the stored dossier) so the dialog's "Sims Met" splits into Best Friends / Good
Friends / Friends / Acquaintances / On Bad Terms by the friendship bit. The mod sends every GAMEPLAY-typed trait minus a
six-fragment plumbing list and both WickedWhims archetype tiers; the app keeps every reward it gets (the descriptions'
`ignored` flag is NOT a reward filter - it marks Top-Notch Infant).
Lovestruck turn-ons/turn-offs (trait_Attraction_*_TurnOn/Off, filed under likes/dislikes by the
mod) are their own categories and their own prompt lines ("your turn-ons: ...", factWords.preferenceKind).
Aspirations, career branches, businesses (2026-10-13): the base game names aspiration tracks by letter
(Track_Family_A = Successful Lineage; factWords ASPIRATION_NAMES, read as the bare name "Successful Lineage"
with no category after it; an unknown letter falls back to the category alone). The dialog's summary tags carry a heading each (Age, Gender,
Home, Household Members, Career, Business, Aspiration; FactSummaryItem.title) and there is no Aspiration category. The mod
sends `track` per career (Athletic_Track3_BodyBuilder; mod builds from 2026-10-13) and the claim becomes
`career_Adult_Athletic/Athletic_Track3_BodyBuilder (level 10)` ONLY once a branch is chosen (careerBranchWords
ignores Track1 and NPC tracks), read as "Bodybuilder (Athletic, level 10)" and "the Athletic career
(Bodybuilder branch)". `business` facts come from the mod's `businesses` (BusinessService.get_business_manager_for_sim
for a Businesses & Hobbies small business, named by itself; get_business_managers_for_household for a retail
store, restaurant or vet clinic, named after its lot): objectText is the name, with "(restaurant)" etc. after
it unless it is a small business (businessText/businessParts); the prompt says "you own a small business,
Vale Curios" and a business owner is never told "you have no job". Fears read as the panel names them
(FEAR_NAMES: The Dark, Unfulfilled Dreams, Dead-End Job); WickedWhims rewards drop their system prefix
(TURBODRIVER:WickedWhims_Trait_Nudity_NoSweat_Reward -> "Doesn't Sweat"). trait_Legendary is Beloved and
trait_NosyNeighbor is Confidante on the panel. The game types WickedWhims' FertilityIssues ("Hypofertile") as a
PHASE: factWords.isChildPhase tells a real childhood phase/confidence from it, and a non-child `phase` fact is
shown and prompted as a plain personality trait. Turn-on/turn-off sub-headings follow the Lovestruck panel
(ATTRACTION_GROUPS: Way of Life, Characteristics, Fashion, Hair Color, Outfit Color, Skills, Romance Styles;
Performer is filed under Way of Life although the files put it in SkillArchetypes). Likes keep "Types of Sims".

Mapping review (2026-10-21): after Test in the interaction and animation mapping dialogs, the renderer POSTs
/mappings/review (MappingController.reviewMapping -> MappingReviewService.review) with the token-form template, the
three narrated samples, and the cast (name + gender); MappingReviewPanel shows the answer above the samples. The
review informs and never blocks Save. Two layers: util/mappingLint runs without a model (unknown or out-of-range
tokens against PromptFormatter ACTOR_WORD_PAIRS / MAPPING_SCENE_TOKENS, the dialog's own prefill, unclosed braces,
`{actor.N.his/her}'s`, bare pronouns, pasted tuning identifiers, directive phrases, names from the loaded save via
InteractionService.namesFromSaveIn, length), then one runOneShot on AIActionType / StageId MAPPING_REVIEW
(`interactive`, so a failed review never raises the provider-health toast) reads the template AND the samples for
what the checks cannot see (UNWARRANTED_CONTEXT, NON_ENGLISH) and offers a one-sentence rewrite. Flags are the
guideline's: AI_DIRECTIVE, UNWARRANTED_CONTEXT, HARDCODED_NAME, RAW_PRONOUN, NON_ENGLISH, BROKEN, VERBOSE, each
high/medium/low (models/MappingReview.ts). mergeFindings keeps a check over an AI finding with the same flag;
mappingVerdict is bad on any high BROKEN/AI_DIRECTIVE/HARDCODED_NAME/RAW_PRONOUN/NON_ENGLISH, needs_work on anything
else, good when empty. A suggestion that fails a high non-VERBOSE check, or equals the original, is dropped; the
dialog's "Use it" converts it to sim-name form. A provider error becomes plainProviderError text with "Open Settings"
(aiError / inSettings) and the checks still answer; an empty mapping never calls the model. The ACTOR_WORD_PAIRS table
is the one list of gendered actor words formatAction fills. Tests: MappingLint, MappingReview.

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

Lot descriptions (2026-10-15): every scene prompt carries one LOCATION line, `{name} ({type}), {description}`. The
shipped defaults (descriptions/locationDescriptions.ts, 181 lots + 2 stock; lots that ship empty, every Newcrest lot
included, have none, and a player's own builds never belong there) are in the CARD shape: 3-4 present-tense
sentences, what kind of place and where, then the real things in it, nobody in the text. The shape won a 360-scene
blind-judged experiment against stock/minimal/long/flowery/key-value (harness src/__tests__/LotFormatExperiment.test.ts,
gated on LOT_FORMAT_EXPERIMENT, not in tiers.json); the stock "suburban residence" placeholder was the worst of all, so
an undescribed lot costs more than any shape choice. BuiltInDescriptions.test.ts holds every built-in to
util/lotDescription.placeDescriptionProblems (1-4 sentences, "Mt." is not a sentence end, no person, no moment) and a
no-people scrub; edit the file directly (the lot sheet it was first generated from is retired).
"Auto-Generate Description" on the Locations page: POST /locations/:id/describe (LocationsController.describeLocation
-> DefaultDescriptionService.describeLocation, the same facts and writer as the fire-and-forget fallback) returns
{description, versions, facts, lotType} for the editor and stores nothing (the page fills Lot Type when it is empty or
the Residence placeholder); 409 until the lot has been reported this app run (SimStateCache.getLotBlock keeps every
reported lot block by lot id). Since 2026-10-18 a press writes THREE drafts in parallel, each through the gate, and
`versions` holds them in util/lotDescription.orderDrafts order (first-try passes before retries, then the card closest
to four sentences; description is versions[0]); a "Draft 1 of 3" stepper under the editor's Description field swaps
them and asks before dropping an edit. There is NO ranking call: checked in LotTraitExperiment's rank mode (14 lots,
3 judged drafts each): llama-3.3-70b ranking with the card rules matched a sonnet-4.5 blind judge's top 36% / 50%
depending on the order shown vs 43% for the first draft, took position B 19 of 27 times, and the judge agreed with its
own other-order pick on only 50% of lots - the drafts are near-equal, so the player chooses. The fallback writer still
asks for one draft. The mod's lot block carries the zone record's `description` (EA blurb), `bedrooms`,
`bathrooms`, `lot_traits` (ss_lot_state.zone_record_facts; the game's names, zoneModifier_lotTrait_FreshAir is
Bracing Breezes, and they only ARRIVE from mod builds of 2026-10-17: before that the mod asked for a resource type
that does not exist; lot challenges such as Heist Havoc ride the same list and are repeated under `lot_challenges`;
util/lotTraitWords reads every one as the Build mode panel names it, with one clause in the lot's own terms, see
below) and, from 2026-10-16,
`world_name`, `street`, `furnishings` (every object tuning name on the lot), `floors` and `music` (stereo station
states) from ss_lot_state.furnishing_facts, cached per zone for 5 minutes (the app reads no decor style: the mod's
catalog tag lookup found no Style_* tags live, so `styles` was dropped until one works); mod builds
from 2026-10-16 add `floor_furnishings` (names per level; util/lotFurnishings.roomFloors counts a level only with 2+
real furnishing kinds, so a roof of vents is no story, and one story is never mentioned) and `venue_type`, the lot
type set in Manage Worlds, which lotVenue prefers (Ward Park's active venue is venue_Generic). Mod builds from
2026-10-17 add `rooms` (level, the game's room id from build_buy.get_room_id, 0 outdoors and null when the lookup
failed, tuning name -> count; capped at 40 rooms x 60 kinds, biggest first): util/lotRooms names each room from what
is in it (a bed makes a bedroom whatever else is there; appliances a kitchen, with sofa + TV an open-plan kitchen and
living room; lockers a locker room; a toilet a bathroom at home and a restroom at a venue; desk + computer a study;
3+ bookshelves a library; machines a home gym / workout room; at a venue gym gear and then desk + computer (an
office) name a room before lockers or a kitchen corner, and dining chairs alone name nothing; a whirlpool tub is a
bathtub, never a pool), hides what the name already says (the bed, the stove,
the toilet), merges a level's outdoor groups into "outside: ..." (labelled a pool anywhere, a patio or a garden only
at a home, so a park gets no invented rooms), shows a room nothing defines as "a room with ..." only when it holds 2+
kinds, collapses same-name rooms ("two bedrooms, one with a desk"), reads a floor's rooms kitchen and living room
first and bathrooms last (ROOM_ORDER), and leaves a bare bathroom out at a home (the bedroom/bathroom counts say it).
Paintings and sculptures are home decor (HOME_BASICS): never listed at a home, kept at a venue. lotFacts writes one line per room floor, or
a single "Rooms:" line on a one-story lot with a named room; a lot with no named room keeps "Furnished with:" (old
mod blocks without `rooms` render as before). Words are singular or plural by count, never a number ("an easel",
"lockers"; a bare name list reads plural because it has no counts); dining chairs are structural. Lot traits
(2026-10-18): util/lotTraitWords maps the tuning name (prefixes, creator, WickedWhims plumbing and pro/con/PetWorld
category words stripped, traitKey) to the panel name and a short clause (FreshAir = "Bracing Breezes (oodles of
fresh air, bracing for exercise)", BurglarTime = Heist Havoc, CelebrityHangOut_LowFame = Up-and-Coming Hotspot,
zoneModifiers_lotTrait_CelebrityHomeLotTrait = Celebrity Home, con_Haunted = the Haunted apartment but
lotTrait_Haunted = the Spooky challenge; names from the Sims wiki "Lot traits and challenges" page, 2026-10-18, the
game's own string tables are a binary format the app does not read); a name the table lacks falls back to the tuning
words (Casual Nudity). The facts line is `Lot traits: Name (clause), ...; lot challenges: Heist Havoc (clause)`, a
challenge told by the mod's `lot_challenges` OR the table, and the clause says what the place is like, never a
mechanic (the prompt lets a trait colour the last sentence lightly and forbids explaining a game rule). Harness
src/__tests__/LotTraitExperiment.test.ts (gated on LOT_TRAIT_EXPERIMENT=dry|live, not in tiers.json): 15 lots x
none / names / names with clause, blind judge; 2026-10-18 on llama-3.3-70b, 45 runs each: the trait's character
reached the card 51% / 98% / 100% of the time (felt 0.31 / 1.00 / 1.42 of 2), a game rule was explained in 0 / 0 / 2%,
so the clause ships; downstream it reached 1 of 6 "what do you think of this place" replies (LotFormatExperiment
cardtrait), none of the chats, as on 2026-10-16. Furnishing depth (src/__tests__/LotDepthExperiment.test.ts, LOT_DEPTH_EXPERIMENT=dry|live|summary, not in
tiers.json; 2026-10-19, stopped after the cards, 15 lots x 3 depths x 2 drafts, sonnet-4.5 judge): grounded 97 / 73 / 33%
and invented 3 / 27 / 63% for full rooms / defining objects only / no furnishings, worst at venues, so mapping stays;
the scenes were never judged. Thin facts made the writer copy the prompt's own examples (a stage with a violin, the
pool), hence the prompt's "examples show the shape only" rule. Tests: LotTraitWords, LotRooms, LotFurnishings, LotDescription. The writer goes floor
by floor and ends on what the place is like and who it is for: in the 2026-10-16 test (160 scenes, scratchpad data)
no reply named a furnishing, but a place's character ("only celebrities get in") did carry into dialogue. lotFacts says
them in plain words (util/lotFurnishings: kinds, never counts; a venue keeps its showers and restrooms, a home does
not; names no rule knows are logged as "furnishings with no plain words", and the dev build's Lot Words panel under the
Locations editor lists them for every lot visited this run: services/LotWordsService, GET/PUT /lot-words, the player's
words saved to Mods/sentient-sims/lot-words.json win over FURNISHING_WORDS by exact name, and "Copy for Claude" hands
them over to fold into the table; each unmapped name carries a first guess, read off the name or from one
StageId.LOT_WORDS call per 40 names (POST /lot-words/suggest, kept in lot-word-suggestions.json, never used by a
description until the player accepts it), an a/an/none toggle sets the article, and saved rows leave the queue for a
Done list) and names the place by
descriptions/lotNeighborhoods.ts (lot id -> neighborhood + world, generated from the sheet's Neighborhood column),
else the reported world (also the Locations page's Neighborhood column; LocationEntity.neighborhood). Lot types
read as Manage Worlds names them (util/lotDescription VENUES + VENUE_PATTERNS: Café, National Park for
venue_ForestPark, Recreation Center...), except homes, which read Residence / Haunted House Residence / Tiny Home
Residence (Jaz's choice; also the placeholder, so a home's lot type never changes). A stereo's station is its
StereoChannel_* state. The button names the lot by the app's name, not the in-game one, so a rename made in game never
leaks into a shared default. Lot screenshots were removed 2026-10-17 as too complex for players (the generic
OpenAIMessage.images plumbing stays). The button's calls are runOneShot `interactive`: logged, but outside provider
health (AIExchangeLogService LabelContext.health), so failed presses never raise the in-game "provider has failed"
toast. Provider errors reach the player in plain words (util/providerErrorWords.plainProviderError: the editor's
message, with "Open Settings" when the fix is there, the health chip and the mod toast); the raw text stays in
main.log. Gemini thinking counts against maxOutputTokens (a 220-token description spent 209 thinking on
gemini-3.8-flash), so GeminiService sends thinkingBudget 0, else thinkingLevel LOW, else nothing, the last two with
1024 tokens of headroom, and remembers per model which one it accepted. Publishing refuses text naming a sim in the
save (findSavedNames); everyday words a townie is called (savedNames COMMON_WORDS: story, blue, white, house, street,
bright, someone) only count inside a full name.

ElevenLabs mood delivery (2026-10-03): an automatically cast voice is scored on the sim's traits only
(CastableVoice), so an unpinned sim keeps one voice all day; the mood shapes the delivery instead. playTTSLines
gives each line a deliveryNote from the speaker's current mood (util/moodDeliveryTags: Anxious -> nervous, Happy
-> cheerful...) unless the line already has one from the screenplay, and v3/v4 send it as a leading `[tag]`
(elevenLabsLineText); other models ignore it. Tag words are voice qualities only, since v4 plays a noun tag as a
sound effect, and bookkeeping moods (fine, asleep, possessed, recharging, hyper) get none. Switch: moodTags on
the ElevenLabs settings (checkbox on the ElevenLabs tab, on by default). Tests: moodDeliveryTags, PlayTTS.

The Jev day (branch jev-day off autonomy, 2026-10-27): the day-time actions pipeline primarily on Jev,
the OpenRouter Decisions API, for a one-day comparison with release/4.6's autonomy. services/DecisionService.ts
(core; `ctx.decisions`): `decide(state, questions, {label, stageId, timeoutMs 4 s})` POSTs
https://openrouter.ai/api/alpha/decisions with the OpenRouter key (settings, else OPENROUTER_KEY), model
`decisionModel` (typesafe/jev-1.13); questions are `choice {criteria: {key: label}}`, `noul {true,false}` and
`score [levels]`, answers `choice` / `probabilities` / `noul` (P true) / `score` (0-based), all answered in
parallel (a dependent pick is two calls). Logged under AIActionType.DECISION (StageId.BASAL_GANGLIA_DECISION)
with a synthetic chat-shaped request and `usage.cost` in the response text (no cost column). `enabled()` =
`decisionProvider` 'jev' and a key; off, every caller takes the path it took before. CognitionService:
`fireRowDecided` (the row lane when enabled: `IntentionService.candidates` lists the eligible rows in order,
`recordPick` logs the chosen one; a choice over the first 6 + none with an importance score, a lone row a
yes-no; none = cooldown, no attempt; a failed call = the first row), `jevHands` (runActionScene on a pie
vocabulary: targets then items, `validateIntent` on the row id, no text stages), `armSceneImpulses` (through
`ctx.ext.conversationActions.armSceneImpulses` from AIService when a scene has no scores: noul >= 0.6 arms a
scene row with a templated reason; setting `jevSceneImpulse`), and the thought tiers: `runtime.lastDecision`
carries the importance to the dispatch; at `thoughtShowScore` (3) `queueThought` makes ONE text call after the
click (AIActionType.BEAT_THOUGHT, StageId.BEAT_THOUGHT, prompt BEAT_THOUGHT_SYSTEM_PROMPT) and stores it as a
monologue row (`noteToSelf`, memories window only); at `thoughtVoiceScore` (5) it is voiced (`sayToSelf`, the
former voiceWhy body); an important decline is thought about too; under the threshold the row's `say` is voiced
as before. BudgetGate: `recordLatency(ms, minMs)` and `seed(ms)` so sub-2 s Jev deliberations count. Tests:
DecisionService.test.ts, the Jev-day block in CognitionAutonomy.test.ts, IntentionService.test.ts
(candidates/recordPick), StoryClicks.test.ts (seed), JevDayToggle.test.ts. THE ONE SWITCH: `jevDayAutonomy`
(SettingsEnum.JEV_DAY_AUTONOMY, default false since 2026-10-31 for the public testing cut; renderer/settings/JevDaySettingsComponent.tsx, a Switch on the
autonomy tier's settings rows): off = release/4.6's autonomy in this same build, because the getters
`cognitionLegacyTick` (true), `intentionRowsEnabled`, `cognitionGateEnabled`, `intentionNightCallEnabled`,
`jevSceneImpulse` (false), `cognitionVocabulary` ('whitelist') and `decisionProvider` ('off') all answer from
it; on, the stored per-feature values apply. The cognition lanes read the getters each tick, so a flip takes
effect without a restart. The other Jev settings have no UI.
