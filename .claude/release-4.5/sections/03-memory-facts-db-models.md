# Section 03: memory, fact store, DB layer, models (app `jasmine-phase-3` @ 62b9bad)

Read in full: `db/` (12 repos + migrations.ts + 7 entities + 4 dtos = 24), the 10 memory/embedding/description
services, `pipeline/` (facts x2, prompts x7, stages.ts), `models/` (71), and 5 controllers (routes). Paths below are
relative to `src/main/sentient-sims/` unless they start with `src/__tests__`. Nothing in the repo was changed.

## 0. Headline findings (read these first)

1. **This branch does not carry migrations 021-026.** They exist only on `sentience-phase-3` (371bc35, 27 commits
   not in jasmine-phase-3; merge-base a557bac, 09-06): `021-create-sentience` (+`ai_exchange.sim_id`),
   `022-ai-exchange-finish-reason`, `023-daily-plan-disposition-triggers`, `024-trigger-fire`,
   `025-daily-plan-disposition-why`, `026-intent-miss`. So per-sim Sentience, dispositions/triggers, L2 tones and the
   L3 `intent_miss` instrument are **absent** from the 4.5 baseline app. Any DB Scott ran L2/L3 against already has
   those rows in `migrations`; see section 4 for why that is harmless here.
2. **CORE bug present here, fixed only on sentience-phase-3 (c02d582):** `MemoryIndexRepository.upsertIndex`
   (db/MemoryIndexRepository.ts:60) is `INSERT OR REPLACE` naming only importance/owner, so every annotated memory
   loses its `game_day` a moment after `createMemory` stamps it (MemoryRepository.ts:531-541). Game-day recency decay
   and `getOwnDayMemories` therefore run on almost nothing (live: 11,474/11,499 rows NULL). Cherry-pick c02d582
   into the core cut.
3. **Dossier hash is a length hash in production.** `CognitionController.postDossier` (controllers/CognitionController.ts:152)
   never passes a hash, so `ingestDossier` falls back to `JSON.stringify(dossier).length.toString(36)`
   (services/SemanticMemoryService.ts:109). A structural change that keeps the JSON length (fiance_id->spouse_id on a
   wedding: `"spouse_id":null,"fiance_id":"X"` vs `"spouse_id":"X","fiance_id":null`; a same-length trait swap; a new
   spouse id of equal digit count) is skipped and only re-derived when some later score changes the length. Tests
   always pass an explicit hash (src/__tests__/SemanticMemory.test.ts:47-88), so this path is untested.
4. **The only CORE entry point for the fact store lives in the AUTONOMY controller** (`CognitionController.postDossier`,
   route api.ts:132). A core build must keep that handler (or move it to a `DossierController`).
5. **No DB table is STREAM-only.** Twitch, moodlet tiers, scene control and voice keep no rows; every table on this
   branch is CORE, AUTONOMY or DEV.

## 1. File classification

| File | Tier | Notes |
|---|---|---|
| db/Repository.ts, LocationRepository, MemoryRepository, MemoryIndexRepository, ParticipantRepository, PaintingRepository, InteractionRepository | CORE | InteractionRepository is file/HTTP backed (online mappings, `user_interaction_overrides.json`, `seen_unmapped_interactions.json`), not SQL |
| db/SimFactRepository.ts | CORE | fact store + `sim_dossier`; bi-temporal, invalidate-never-delete; `pathBetween` recursive CTE :201 |
| db/MemoryTraceRepository.ts, AIExchangeRepository.ts | DEV | provenance for bench/watches; written on every provider call via AIExchangeLogService |
| db/ActionOutcomeRepository.ts | AUTONOMY | imports `OutcomeVerdict` type from services/OutcomeVerdictService (strip together) |
| db/DailyPlanRepository.ts | AUTONOMY | `savePlan` is INSERT OR REPLACE naming 7 columns (would null 023/025 columns if a sentience-line build wrote them) |
| db/entities/* (7), db/dto/* (4) | CORE | `MemoryEntity` is the mod-facing row; `ParticipantVoiceEntity` = TTS pins (upstream has it) |
| db/migrations.ts | CORE (carries AUTONOMY/DEV DDL) | keep whole, see section 3 |
| services/DbService.ts | CORE, mixed | `loadDatabase` calls `aiExchangeLog.onDatabaseLoaded` (DEV) :114, `outcomeVerdict.pruneOnLoad` (AUTONOMY) :117, `scenePlayback.stopAll` (STREAM) :123/:232 |
| services/MemoryRetrievalService.ts | CORE | recency+importance+cosine, owner scope, focus window, `maxSelfAuthored` cap |
| services/MemoryAnnotationService.ts | CORE | idle-lane importance+embedding, backfill; calls `memoryTrace.appendExchange` (DEV, try/caught) |
| services/MemoryTraceService.ts | DEV | wired into `setOnMemoryUpserted` (ApiContext.ts:466-469); inert-safe |
| services/SemanticMemoryService.ts | CORE | the hippocampus: ingest, addFact, recall -> `<KNOWN_FACTS>` |
| services/EmbeddingService.ts (+OpenAI/Noop), EmbeddingProviderConfigService, GeminiEmbeddingService, SentientSimsEmbeddingService | CORE | all degrade to undefined vectors |
| services/DefaultDescriptionService.ts | CORE | V-6 one-shot descriptions; lot facts come from the state cache (AUTONOMY) and degrade to name/lot_type |
| pipeline/facts/dossierFacts.ts, predicates.ts | CORE | pure |
| pipeline/stages.ts | CORE registry, AUTONOMY entries | stage enum is data; keep whole (settings `stagePromptOverrides` keyed by it) |
| pipeline/prompts/index.ts, utility.ts, scene.ts | CORE | utility.ts also holds `COMMAND_SYSTEM_PROMPT` (voice command, STREAM/AUTONOMY); scene.ts `playerFacing`/`statusBlock` branches are player-conversation (STREAM) and read cognition status (AUTONOMY), both optional |
| pipeline/prompts/consolidation.ts | MIXED | diary builders (`buildDiaryRules`, `buildReflectionFraming`, `buildDiaryOnlySystemPrompt`) CORE; consolidation + lazy plan AUTONOMY |
| pipeline/prompts/cognition.ts, action.ts | AUTONOMY | tick monologue/scores; action scene options/choice/review |
| pipeline/prompts/ask.ts | AUTONOMY (fed by STREAM inputs) | Voice/Twitch ask triage/match/decide |
| controllers/SimFactsController.ts | CORE | reads `simStateCache` only for a default day (degrades) |
| controllers/MemoriesController.ts | CORE | `/memories/:id/trace` is DEV |
| controllers/ParticipantsController.ts, LocationsController.ts, DbController.ts | CORE | |

## 2. Models (71)

| Tier | Files |
|---|---|
| CORE, plain types | ChatCompletionMessageRole, DeleteLocationRequest, GetLocationRequest, IgnoredInteractionsResponse, MappingSource, PromptHistoryMode, SentenceTokenize{Request,Response}, DecodedPayload, SendLogs{Request,Response}, UserInfo, UserMappingInfo, LogLevel, LogMessage, SentientMemory, SentientSimCareer, SentientSimsHTTPStatusCode, TraitDescription, TraitType, GetParticipantsRequest, LLMWorker, RendererWebsocketMessage, SimsGenerateResponse, VLLMError, VLLMChatCompletionRequest, MessageInputProps, OpenAIMessage, OpenAICompatibleRequest, OpenAIRequestBuilder, InteractionBugReport, WebsocketStatusResponse, AIHealthCheckResponse, CaughtError, SimAge, Animation, WizardPage, GetMemoryRequest, InteractionEventResult, AIModel, AIProviderConfig, ApiType, OpenRouterModels, EmbeddingModels, ImageGeneration, DatabaseSession, SaveGame, SentientSim, InteractionEvents, SimDossier |
| CORE, TTS (upstream has TTS) | VoiceType, OpenAITTSSettings, ElevenLabsTTSSettings (incl. `eleven_v3_conversational`), ElevenLabsVoice, KokoroAITTSSettings, SentientSimsAITTSSettings |
| MIXED enums/unions (keep whole, hide members) | AIActionType (COGNITION/ACTION_SCENE/DAILY_PLAN = AUTONOMY; VOICE_COMMAND/ASK_* = AUTONOMY+STREAM; values are persisted in `aiActionProviderOverrides`), SettingsEnum (cognition/daily/voice/twitch/conversation keys), ModWebsocketMessage (see 6), ModLogWebsocketMessage (`log` CORE, `clock_state` voice playback, `scene_control` STREAM) |
| AUTONOMY | SimStateReport (but `LotBlock`/`LotClock` types are imported by DefaultDescriptionService and the game-day provider), PerceptionSnapshot, ActionIntent (+`InteractionOutcomeEvent`), ActionLoadout, CognitionIntent, DailyPlan |
| STREAM | PlayerVoicePersona (speaker label must match mod `PLAYER_SPEAKER` byte-for-byte), TwitchChatStatus |
| DEV | AIExchangeLog, MemoryTrace, DirectedSceneRequest (scene tester) |

## 3. Migrations table (applied in `sort()`ed name order, not map order)

| Name | Creates / alters | Tier | Core may carry? |
|---|---|---|---|
| 001-create-participant-table | participant(id, description) | CORE | required |
| 002-create-location-table | location(id, name, lot_type, description) | CORE | required |
| 003-create-memory-table | memory(id, pre_action, observation, content, timestamp, location_id) | CORE | required |
| 004-create-memory-participants-table | memory_participants(id, participant_id, memory_id FK CASCADE) | CORE | required |
| 005-create-timestamps-for-null-timestamps | backfills NULL memory.timestamp (fn) | CORE | required |
| 006-add-participant-name | participant.name | CORE | required |
| 007-add-action-memories | memory.action | CORE | required |
| 008-add-memories-event-type | memory.event_type | CORE | required |
| 009-add-interaction-name-to-memory | memory.interaction_name | CORE | required |
| 010-create-painting-table | painting(uuid, instance_id UNIQUE, prompt, image BLOB, metadata, created_at) | CORE | required |
| 011-remove-memory-scene-id | drops memory.scene_id if present (fn, no-op normally) | CORE | yes |
| 012-create-memory-index | memory_index(memory_id PK FK CASCADE, importance, embedding, embedding_model) | CORE | required |
| 013-create-participant-voice | participant_voice(participant_id PK, voice_id, voice_name), deliberately no FK | CORE (TTS) | required (upstream 4.1.0 has it) |
| 014-add-memory-index-owner | memory_index.owner_participant_id (private rows) | CORE | required |
| 014-move-embeddings-to-memory-embedding | memory_embedding(memory_id, embedding_model PK, embedding, FK CASCADE); copies; DROPs 2 memory_index columns | CORE | required (upstream has it) |
| 015-create-daily-plan | daily_plan(sim_id, absolute_day PK, goals, persona, loadout, source, review, created_at) | AUTONOMY | yes, empty table |
| 015-participant-voice-per-voice-type | rebuilds participant_voice with PK(participant_id, voice_type) | CORE (TTS) | required (upstream has it) |
| 016-create-ai-exchange-and-memory-trace | ai_exchange(15 cols + idx on memory_id), memory_trace(memory_id PK, pipeline, director_direction, review, exchanges) | DEV | yes, and core code writes ai_exchange anyway |
| 017-create-action-outcome | action_outcome(22 cols, 3 indexes) | AUTONOMY | yes, empty |
| 018-create-sim-fact | sim_fact(12 cols, 4 indexes), sim_dossier(sim_id PK, hash, json, updated_day, updated_at) | CORE | required |
| 019-memory-index-game-day | memory_index.game_day | CORE | required |
| 020-participant-description-generated | participant.description_generated | CORE | required |
| (021-026, sentience-phase-3 only) | sentience table + ai_exchange.sim_id; ai_exchange.finish_reason; daily_plan.disposition/triggers; trigger_fire; daily_plan.disposition_why; intent_miss | AUTONOMY/DEV | all ADD COLUMN / CREATE IF NOT EXISTS: safe either way |

Verdict: every migration is additive or a guarded rebuild; none is dangerous to carry. **Recommendation: a CORE build
carries the full list** so DB files stay interchangeable across tiers, and future tier-only migrations go into the
shared list too (never strip, never reuse a name).

## 4. Migration runner with unknown ids (db/migrations.ts:430-452)

`migrate` enables FKs + WAL, `CREATE TABLE IF NOT EXISTS migrations`, reads applied **names**, and applies
`known - applied` in sorted order, each in its own transaction with its `INSERT INTO migrations`. Applied names it does
not know are **ignored silently** (no error, no log). Consequences:
- Stream/sentience DB opened by a core build: extra rows, tables and columns simply sit there. Core writes that name
  their columns (ai_exchange insert, memory, participant upsert) leave extra columns NULL. Safe.
- Core DB later opened by a fuller build: missing migrations apply in order; 023/025 `ALTER daily_plan` are safe
  because 015 sorts first. Safe.
- Hazards: (a) a name reused with different SQL is never re-run; (b) a REPLACE write from an older build on a table a
  newer build widened nulls the new columns (`DailyPlanRepository.savePlan` vs 023/025); (c) no down-migrations, so
  014-move-embeddings' DROPs are one-way (upstream already has it, so no regression); (d) a failed migration throws out
  of `loadDatabase` after `this.db` was assigned (DbService.ts:96-108) and before `databaseSession` is updated, leaving
  a half-migrated handle that `isLoaded()` reports as loaded.

## 5. Table / column inventory by tier (this branch)

| Tier | Tables |
|---|---|
| CORE | participant(id, description, name, description_generated), location, memory(id, pre_action, observation, content, timestamp, location_id, action, event_type, interaction_name), memory_participants, memory_index(memory_id, importance, owner_participant_id, game_day), memory_embedding, painting, participant_voice(participant_id, voice_type, voice_id, voice_name), sim_fact, sim_dossier, migrations |
| AUTONOMY | daily_plan, action_outcome |
| DEV | ai_exchange, memory_trace (bounded by prune on load) |
| STREAM | none |

## 6. Everything that crosses the mod boundary

| Direction | Shape (file) | Fields |
|---|---|---|
| HTTP in `POST /memories` | CreateMemoryRequest (models/GetMemoryRequest.ts) | memory: MemoryEntity, participants: ParticipantDTO[], index?{owner, importance} (mod never sends index; controller stamps owner for 1-participant `monologue`, MemoriesController.ts:86-92) |
| HTTP in/out `/memories[/:id]` | MemoryEntity (db/entities/MemoryEntity.ts) | id (string, 64-bit), pre_action, observation, content, location_id, timestamp, action, event_type, interaction_name, owner_participant_id, owner_name; `participant_names` stripped by `toModMemory`; `withDisplayContent` forces string content + `<>`->guillemets |
| HTTP `/participants/:id?fullName=` | GetParticipantRequest / ParticipantDTO | id, fullName -> {id, description, name, voices?} (GET upserts name as a side effect) |
| HTTP `/locations` | LocationEntity | id, name, lot_type, description, is_generic?, is_default? |
| HTTP `/db/load`, `/db/save` | DatabaseSession | saveId, sessionId, action? (`perform_migrate_single_slot_save`) |
| HTTP `/cognition/dossier` (CORE memory) | DossierReport / SimDossier (models/SimDossier.ts) | type, seq, reason, clock{absolute_day,hour,minute}, dossiers[]: version, sim_id, name, age, gender, pronouns{raw,subjective,objective,possessive,possessive_independent,reflexive}, occult{types,current}, is_ghost, death_type, household{id,name,member_ids}, family{parents,siblings,children,grandparents,spouse_id,fiance_id,steady_ids}, family_bits{id:bit}, traits, fears, reward_traits, likes, dislikes, aspiration{track,aspiration,objective}, careers[{career,level,performance,at_work,next_shift}], top_skills[{skill,level,raw}], relationships[{sim_id,name,has_met,friendship,romance,bits}] |
| HTTP `/ai/v2/event/*` | InteractionEvents (SSEvent + WW/Interaction/Chat/DoSomething) | event_id, event_type, location_id, environment{location_id, world_id, time, weather, season}, sentient_sims: SentientSim[], relationships; InteractionEvent adds interaction_name, interaction_display_name(_template), testing_action, interaction_category, valence -> InteractionEventResult{status, memory, text, request, exchanges, result_source} |
| HTTP (AUTONOMY) | SimStateReport, InteractionOutcomeEvent, PerceptionSnapshot | see files; `/cognition/state`, `/cognition/outcome`, `/cognition/perception` |
| HTTP (CORE) | ImageGenerationRequest/Response | prompt, configId, model, size, format png/dds, metadata -> imageBase64, model, apiType, textureInstanceId |
| WS out, CORE | ModWebsocketMessage family | notification{title,message,message_type}, clear_sim_cache, migrate_single_slot_save, memory_created{memory, paced}, memory_edited{memory}, memory_deleted{memory_id}, add_buff{sim_id, mood, buff_description, intensity?, duration_minutes?, scene_id?, source?} |
| WS out, AUTONOMY | same file | enqueue_interaction{request_id, sim_id, action, target_*, priority, insert_strategy, clear_queue, preempt, zone_id, source}, cancel_interaction{request_id}, request_perception{request_id, sim_id} |
| WS out, STREAM | same file | scene_line{speaker, text, preamble, voiced, scene_id, speaker_sim_id, participant_sim_ids, continues}, scene_line_ended{speaker, scene_id, continues}, scene_ended{scene_id, reason}, conversation_closed{sim_ids, sim_names, speaker, reason}, player_voice_message{text}, player_voice_status{status, detail, speaker, mode} |
| WS in | ModLogWebsocketMessage | log{level,timestamp,message}, clock_state{speed,paused,paused_by}, scene_control{action, mode, scene_id, reason, sim_id, distance_m} (STREAM) |

## 7. Fact store end to end

1. Mod `ss_dossier_reporter` POSTs every 60 s (hash-gated mod-side) -> `api.ts:132` -> `CognitionController.postDossier`
   (controllers/CognitionController.ts:135). Day = `report.clock.absolute_day ?? simStateCache` (:144).
2. Per dossier `SemanticMemoryService.ingestDossier` (services/SemanticMemoryService.ts:92): length-hash fallback :109;
   same hash -> only rewrite `sim_dossier` (:173); else `dossierToFacts` (pipeline/facts/dossierFacts.ts:25; relationship
   scores deliberately NOT facts, `knows` edge only; skills >= 3), diff by `factKey` (:21) against current `game` facts.
3. New fact -> `SimFactRepository.insert` (db/SimFactRepository.ts:82); single-valued predicates
   (pipeline/facts/predicates.ts:63) retire contradictions via `canSupersede` (:103; rank game4 > player3 > reflection2 >
   told/inferred1); facts no longer asserted -> `invalidate` (:188, `valid_to_day = day ?? -1`). `saveDossier` (:235).
4. Identity change (age_stage/gender/occult_current/alive) -> `ParticipantRepository.clearGeneratedDescription`
   (CognitionController.ts:164) + `DefaultDescriptionService.forget`, so V-6 rewrites the description.
5. Recall: `SemanticMemoryService.recall` (:256) = current facts + stored dossier scores (snake->camel), mentioned
   people, life people (family/partners, top-3 friends >= 15, strongest romance >= 10; cap `MAX_LIFE_PEOPLE` 6,
   util/renderKnownFacts.ts:75), last 3 told facts -> `renderKnownFacts` (util/renderKnownFacts.ts:314) -> `<KNOWN_FACTS>`
   or '' (byte-identical prompt when empty).
6. Consumers: AIService.ts:658 (director/diary pov), :1708 (actor, via `buildSpeechSystemPrompt` factsBlock and
   reviewer `factsBySim`, pipeline/prompts/scene.ts:185-218), PromptRequestBuilderService.ts:304/:620 (non-directed),
   AskActionService.ts:294 (AUTONOMY), CognitionService.ts:1679 + util/formatCognitionPrompt.ts:275 (AUTONOMY).
7. Read/correct: `/facts/predicates`, `/facts/:id/explain`, `/sims/:id/facts[?all&about]`, `/sims/:id/facts/path/:other`,
   `POST /sims/:id/facts` (source player|told|inferred|reflection; `game` refused), `DELETE` = retire (api.ts:136-141).
Gaps: `HIPPOCAMPUS_ENCODE` (stages.ts:24) has no caller, so nothing writes told/inferred/reflection facts except the
POST route; `speakerLookup` (SemanticMemoryService.ts:425) is never set, so hearsay never carries a speaker.

## 8. Memory kinds (`memory.event_type`) and privacy

| Kind | Written by | Owner stamped? | Tier |
|---|---|---|---|
| interaction / chat / chat_continue / wants / dosomething / wickedwhims / continue | mod event memories, AIService.ts:925/:1199/:1995; Twitch replies ride `chat` | no (shared) | CORE (Twitch origin STREAM) |
| monologue (scene inner voice, "Name (thinking): ...") | AIService.ts:2208/:2517, AskActionService.ts:375, mod-posted solo monologue (MemoriesController.ts:86) | yes | CORE (ask path AUTONOMY) |
| reflection (private diary, "Name (diary): ...") | AIService.runSceneReflection :587; travel boundary :506 (CORE), sleep boundary CognitionController.ts:381 (AUTONOMY) | yes (J1) | CORE + AUTONOMY trigger |
| thought (tick inner voice) | CognitionService.ts:1662 | yes | AUTONOMY |
| outcome (action result, text in observation) | CognitionController.ts:253 | no; never embedded | AUTONOMY |
| paced lines | not a kind: `memory_created{paced:true}` + `scene_line` stream | - | STREAM presentation |

Isolation: `getSceneMemories` excludes reflection/thought/monologue from shared transcripts (MemoryRepository.ts:185);
retrieval admits an owned row only inside `ownerScope` (MemoryIndexRepository.ts:121-123, fails closed); reflections
for prompts come per owner (MemoryRepository.ts:226). Store-time echo suppression for inner rows: trigram >= 0.85 within
30 min (:394/:491). Hygiene gate rejects refusals/scaffolding with a non-fatal `{rejected:true}` (MemoriesController.ts:95).

## 9. `/db/load` and `/db/save` (services/DbService.ts)

Load: skip if same session+save and no action (:42); optional one-time single-slot migration; copy
`<saveId>-sentient-sims.db` -> `<sessionId>-sentient-sims-unsaved.db` if the working copy is missing; close old handle;
open working copy; `migrate`; set session; prune ai_exchange/action_outcome; flush generation queue; reset scenes; stop
playback; send `clear_sim_cache`; notify renderer; start embedding backfill. Save: `db.backup(savedDb)` from the loaded
handle, then delete every other session's unsaved files. Unload (`GET /db/unload`) deletes ALL unsaved files. The saved
file is the only durable copy; unsaved work dies on quit without a game save (by design).

## 10. Tests (src/__tests__)

MemoryRepository.test (13, incl. migration 011 re-run), MemoryIndex.test (11, migration 014-move re-run, annotator),
MemoryRetrieval.test (15), MemoryFocusWindow, MemoryHygiene, Reflections, DirectedSceneMonologue, FactsInPrompts (8),
SemanticMemory.test (17), DossierRoute.test (6), SimFactRoutes.test (10), FactVocabulary.test (16), RenderKnownFacts.test (17),
DbService.test (3), ParticipantRepository.test (3), LocationRepository.test (2), PaintingRepository, InteractionRepository,
DefaultDescription.test (10), DailyPlan.test (36), ActionOutcomePersistence (6), AIExchangePersistence (5), AIExchangeLog,
MemoryTrace / MemoryTracePersistence (5) / MemoryTraceEndToEnd, EmbeddingProviderConfig, GeminiEmbedding,
SentientSimsEmbedding, EmbeddingService.it, Stages.test (14), StagePromptRouting. **Untested directly:** the five
controllers (except via route tests), DailyPlanRepository, the length-hash path, `getDb(saveGame)`, migration failure.

## 11. Bugs and risks (not fixed)

| # | Sev | Where | What |
|---|---|---|---|
| B1 | High (CORE) | db/MemoryIndexRepository.ts:60 | upsertIndex REPLACE drops game_day; fix = cherry-pick c02d582 |
| B2 | Med (CORE) | SemanticMemoryService.ts:109 + CognitionController.ts:152 | length hash skips same-length structural changes (wedding). Fix: hash a canonical JSON, or have the mod send `dossier_hash` and pass it |
| B3 | Med (CORE) | MemoryRepository.ts:505 | `INSERT OR REPLACE INTO memory` with an existing id deletes the row first; with FKs on this cascades memory_participants, memory_index (owner, game_day) and memory_embedding. A re-posted owned reflection becomes SHARED (privacy leak) unless the request re-sends `index` |
| B4 | Med | DbService.ts:96-108 | failed migration leaves `this.db` set (half-migrated) with the old session key |
| B5 | Med | DbService.ts:140-162 / ParticipantRepository.getAllParticipants | `getDb(saveGame)` opens AND migrates a committed save file in place and never closes it (Windows lock, handle leak) |
| B6 | Low | CognitionService.ts:1662 | thought rows use `Number(location.zone_id)`: zone not lot id (SimStateReport says they differ) and a 64-bit id through float64 |
| B7 | Low | SemanticMemoryService.ts:425 / stages.ts:24 | hearsay never attributed; encode stage unimplemented |
| B8 | Low | api.ts `DELETE /memories` | wipes every memory with no confirmation, any local caller |
| B9 | Low | models/ModWebsocketMessage.ts ModAddBuff | comment says absent duration = 240; CLAUDE.md says tier caps 360/720/1440 |
| B10 | Low | MemoryAnnotationService.annotate | keeps a pre-existing importance after the text is edited (only embeddings are dropped) |

## 12. What a CORE build must keep, and the surgery

Keep verbatim: all of db/ except the three non-core repos, migrations.ts **whole**, entities/dtos, the 10 services,
pipeline/facts, prompts index/utility/scene, stages.ts (data), SimFacts/Memories/Participants/Locations/Db controllers,
util/renderKnownFacts + lifeStageWords + relationshipWords + memoryHygiene + memoryRecallText, and the model files in the
CORE rows of section 2. Keep AIExchangeRepository/AIExchangeLogService too unless the provider seam is re-plumbed
(every call is logged through it) - cheapest to ship it and hide the UI.

Surgery:
1. Move `postDossier` out of CognitionController (or keep the controller with only that route) and keep
   `/cognition/dossier` in api.ts; its fallback day read of `simStateCache` must tolerate a missing cache.
2. Game-day stamping (`setGameDayProvider`, ApiContext.ts:459) reads the AUTONOMY state cache. In a core build it is
   always undefined, so recency falls back to wall-clock. Feed it from the dossier report's `clock` instead (the mod
   sends it every 60 s) or accept real-time decay.
3. DbService.loadDatabase/unloadDatabase: make `outcomeVerdict.pruneOnLoad`, `scenePlayback.stopAll`,
   `aiExchangeLog.onDatabaseLoaded` optional hooks.
4. consolidation.ts: split diary builders (core) from plan builders; `runSceneReflection` sleep path (plan context,
   `/cognition/sleep-boundary`) is AUTONOMY, travel diary stays CORE.
5. scene.ts: `playerFacing` + `statusBlock` are optional parameters; leave them, they are inert without the
   player-conversation service and the state cache.
6. Enums (AIActionType, SettingsEnum, StageId, ModWebsocketMessageType): keep all members (values are persisted in
   settings and the DB); hide tier-only members in the UI rather than deleting them.
7. ActionOutcomeRepository imports a type from OutcomeVerdictService; DailyPlan imports GoalPoolEntry from
   SimStateReport: strip each pair together, or keep the type-only files (zero runtime cost).
8. Apply B1 (c02d582) and B2 before release; B3 before trusting private diaries in a public build.
