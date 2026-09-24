# 02 - Generation, prompts, providers (app `jasmine-phase-3` @ 62b9bad, 2026-09-23)

Read in full: `services/` AIService (2743 lines), GenerationService, GenerationQueueService, OpenAI/Gemini/NovelAI/KoboldAI/VLLM/OpenRouter/SentientSimsAI services, ProviderConfigService, ModelSettingsService, AIExchangeLogService, PromptRequestBuilderService, InteractionService, MappingService, InteractionSemanticSearchService, AnimationsService; `modelSettings.ts`, `systemPrompts.ts`; all of `formatter/`, `tokens/` (top-level; `llama/` + `novelai/` are vendored tokenizers), `filters/`; `descriptions/` read for structure and consumers (they are 33k lines of data tables). Paths below are under `src/main/sentient-sims/`.
Tiers: CORE / AUTONOMY / STREAM / DEV as in the brief. "fed" = the code is CORE but only gets data from an AUTONOMY route.

## 1. File inventory

| File | What it is | Class | Mod routes reaching it (api.ts -> controller) | Prompt blocks / output | Settings read | Tests |
|---|---|---|---|---|---|---|
| `services/AIService.ts` | Every generation pipeline: the event dispatcher, directed scene (director -> actors -> reviewer -> scorer), monologue beats, classic single pass, reflections + nightly plan, one-shot seam, classification/buff, images, TTS casting | **MIXED** (see section 7) | `/ai/v2/event/interaction` (+prefetch/claim via the queue), `/ai/v2/event/directed-scene` (DEV), `/ai/v2/generate` (renderer chat tab), `/ai/v2/event/classification`, `/ai/v2/event/buff`, `/ai/v3/event/buff`, `/ai/v2/image/generate`, `/ai/v2/models`, bench `/bench/self-knowledge`, `/bench/player-thread`; `/cognition/sleep-boundary` -> `runSceneReflection` | Director/actor/reviewer/scorer prompts (built in `pipeline/prompts/scene.ts`), `Previously in this scene:`, the valence clause, content-free hint, persona flavour, the `<STATUS>/<TODAYS_PLAN>` player-facing block, the diary/plan prompt, the buff description prompt | `directedScenesEnabled`, `playerSpeakerName`, `playerVoicePersona`, `playerVoicePersonaBio`, `playerReplyMaxTokens`, `sceneMaxRounds`, `stagePromptOverrides`, `dailyGoalsEnabled`, `dailyLoadoutSize`, `ttsApiType`, `sentientSimsAITtsSettings.model` | ChatPipeline, DirectedSceneMonologue, PlayerFacingReplies, SceneStopGating, Reflections, InfantsQuiet, DoSomething(+Wire), AskAction, TwitchChat, StagePromptRouting, SynthesizePreAction, PrefetchPromptFormatting, PlayTTS, CognitionTrace, MemoryTraceEndToEnd, FactsInPrompts, Tier0 |
| `services/PromptRequestBuilderService.ts` | Builds the `PromptRequest` every path starts from (participants + scene memories + retrieval + facts) | CORE (two blocks AUTONOMY-fed) | via AIService only | `<CHARACTER_IN_INTERACTION>` per sim, `<RELATIONSHIPS>`, `<ALSO_PRESENT>`, `<DIRECTOR>` + `<SCENE_GUIDANCE>` (directed only), `<PAST_REFLECTIONS [speaker=]>`, `<KNOWN_FACTS [speaker=]>` (spliced before RELEVANT_MEMORIES), `<RELEVANT_MEMORIES>`, `<LOCATION>`, `<DATE>`, `<SEASON>`, `<WEATHER>`, postures, grouped scene history | `directedScenesEnabled`, `maxResponseTokens` | FactsInPrompts, AlsoPresent, MemoryRetrieval, Reflections, PrefetchPromptFormatting, ScenePrompts, PromptFormatter |
| `services/GenerationQueueService.ts` | Prefetch/claim/finalize/cancel state machine + four lanes (speech, foreground, cognition, idle) under `generationConcurrency` | CORE (cognition lane AUTONOMY) | `/ai/v2/event/interaction/{prefetch,claim,finalize,cancel}`; `runSpeech`/`runExclusive` from `/ai/v2/event/interaction` | none | `prefetchMaxQueueDepth`, `generationConcurrency` | GenerationQueueService, TwitchChat |
| `services/GenerationService.ts` | 4-method provider interface | CORE | - | - | - | - |
| `services/OpenAIService.ts` | OpenAI SDK chat completions; json_schema guided choice only on api.openai.com; optional translate pass | CORE | via seam | - | `openaiEndpoint`, `openaiModel`, `openaiKey` (else env `OPENAI_KEY`), `generationTimeoutSeconds`, `localizationEnabled`, `localizationLanguage` | OpenAIService(.it), OpenRouterModels |
| `services/OpenRouterService.ts` | OpenAIService subclass, OpenRouter endpoint/key/model, no json_schema | CORE | via seam | - | `openrouterEndpoint`, `openrouterModel`, `openrouterKey` (env `OPENROUTER_KEY`) | OpenRouterModels |
| `services/GeminiService.ts` | @google/genai text + image (paintings), random key from a comma list, 3 retries, safety BLOCK_NONE | CORE | via seam; images via `/ai/v2/image/generate` | - | `geminiModel`, `geminiKeys`, `localization*` (`geminiEndpoint` read but never used for requests) | ProviderConfig |
| `services/NovelAIService.ts` | NovelAI kayra `/ai/generate`, string prompt | CORE (legacy) | via seam | - | `novelAIEndpoint`, `novelAIGenerationEndpoint`, `novelAIModel`, `novelAIKey` | Settings (only) |
| `services/KoboldAIService.ts` | KoboldAI `/api/v1/generate` for local MythoMax | CORE (legacy) | via seam | - | `koboldaiEndpoint`, `generationTimeoutSeconds` | none |
| `services/VLLMAIService.ts` | vLLM chat completions with `/tokenize`-based truncation and guided choice | CORE | via seam | - | `vllmEndpoint`, `vllmApiKey`, `vllmModel`, `generationTimeoutSeconds` | ProviderConfig |
| `services/SentientSimsAIService.ts` | VLLM subclass for Gus's hosted server; Cognito token refresh + one 401 retry; `/v1/images/generations` | CORE | via seam | - | `sentientSimsAIEndpoint`, `accessToken`, `sentientSimsAIModel` | SentientSimsAIAuth |
| `services/ProviderConfigService.ts` | Named provider configs, per-action overrides, per-directed-stage inheritance | CORE | - | - | `aiProviderConfigs`, `defaultAiProviderConfigId`, `aiApiType`, `aiActionProviderOverrides`, `providerModel()` | ProviderConfig |
| `services/ModelSettingsService.ts` | Sampling/context table; SSAI syncs `/modelsettings` every 15 min | CORE | - | - | `sentientSimsAIEndpoint` | ProviderConfig (indirect) |
| `services/AIExchangeLogService.ts` | Records every provider call (ring 200 + `ai_exchange` table), dead-pipeline badge | CORE seam; persistence is DEV value | `/ai/exchanges[/:id]` (renderer AI Log, DEBUG nav) | - | none | AIExchangeLog, AIExchangePersistence |
| `services/InteractionService.ts` | Mapping lookup (DB/online override > built-in table), publish-name guard | CORE | `/interactions*` (via InteractionDescriptionController), `INTERACTION_MAPPING` events | - | none | PublishNameGuard |
| `services/MappingService.ts` | Trait/mood XML extractor + TS exporter for mappers | DEV (Traits page is DEBUG nav) | `/traits`, `/traits/unmapped`, `/traits/export`, `/moods`, `/moods/unmapped` | - | none | none |
| `services/InteractionSemanticSearchService.ts` | Embedding search over the mapping catalog, cache `interaction_embeddings.json` | CORE (Mapping Browser, DEBUG nav) | `/interactions/semantic-search` | - | via `ctx.embedding` | InteractionSemanticSearch |
| `services/AnimationsService.ts` | WickedWhims animation mappings: local overrides file > online `/animations`, 15-min resync | CORE (optional WW) | `/animations*`, `/animations/nsfw-enabled` | `act` text as WW pre-action | `sentientSimsAIEndpoint`, `accessToken`, `nsfwEnabled`, `mappingNotificationEnabled` | AnimationsController |
| `modelSettings.ts` | Static per-model sampling + `max_tokens` table; unknown model -> `default` (3900) | CORE | - | - | - | ProviderConfig |
| `systemPrompts.ts` | `getSystemPrompt(eventType, apiType, directed)` -> chat / wants / WW / OpenAI / MythoMax variants from `constants.ts` | CORE | - | the classic-path system prompt | - | (AskAction imports) |
| `formatter/PromptFormatter.ts` | `formatSentientSim`, `formatAction` token filler, output cleanup, degenerate-output guard, dialogue parsing/pacing, date/season/weather | CORE | - | character text, `<DATE>/<SEASON>/<WEATHER>` | - | PromptFormatter, Formatter |
| `formatter/{Default,MythoMax,NovelAI}Formatter.ts`, `InputOutputFormatting.ts` | Provider input shaping (`### Instruction/Input/Response`, NovelAI `{}`) | CORE | - | - | - | none direct |
| `formatter/{CastableVoice,ElevenLabsVoiceCasting,KokoroVoiceCasting,VoiceCasting,VoiceAssignment}.ts` | Trait/age/gender voice casting, pins override, alias bridge | CORE (voice mode) | - | - | - | PromptFormatter, ElevenLabs(.it) |
| `tokens/*.ts` | Token counters: NovelAI nerdstash, gpt-3-encoder (+4), LLaMa (+1); everything not NovelAI/OpenAI uses LLaMa | CORE | - | - | - | OpenAIRequestBuilder etc. |
| `descriptions/*` | Data: interactions (8.4k), traits (19k, 4 packs incl. WW), careers, postures, objects, moods, relationships, locations, sims, WW sex category/location | CORE | - | text of every character/relationship/posture line | - | indirect |
| `descriptions/allTraits.ts` | Spread of traitDescriptions, imported by nobody | dead | - | - | - | - |
| `filters/*` | `HasNotHappened`, `InitiatorIsActiveSim` factories; set on 2 live mappings (`interactionDescriptions.ts:7078,7284`), typed `any[]`, read by nothing | dead | - | - | - | - |

## 2. Trace: ordinary interaction event -> memory row -> `memory_created`

| Step | Where | What happens |
|---|---|---|
| 1 prefetch | `AIController.ts:83` -> `GenerationQueueService.prefetch` :88 | dup check; `toPrimaryInteractionEvent` (cap 8 performers, AIService:386); `resolveInteractionPreAction` (AIService:853): mapping via `InteractionService.getInteractionDescription` (DB/online override > `interactionDescriptions`), `ignored` -> IGNORED, no player sim and not `always_run` -> NOT_PLAYER_SIM; **unmapped**: `synthesizeInteractionDescription` builds `{actor.0}: <label> (with {actor.1})` from the mod's `interaction_display_name_template`/`interaction_display_name` (string-table path), `recordUnmappedInteraction` feeds the Mapping Browser; `formatAction` renders; `isDegeneratePreAction` -> UNMAPPED. Queue depth >= `prefetchMaxQueueDepth` -> ack `fallback`; else enqueue `generatePrefetch`, ack `queued` + `pre_action_text` (the bar text). |
| 2 generate | `generatePrefetch` :263 -> `AIService.interactionEventDeferred` :947 | `handleSceneBoundary` (lot change: close threads, flush other-lot prefetches, `scenePlayback.stopAll`, travel reflection) -> `runDirectedGeneration(event, {action: preAction}, {deferPlayback})`. Throws retried up to `prefetchMaxAttempts`(3) with backoff; non-GENERATED -> `fallback`. |
| 3 claim | `AIController.ts:90` -> `claim` :125 | no entry -> synchronous `interactionEvent` through the foreground lane; done/fallback/abandoned -> `consume` (fallback = `createInteractionPreActionFallback`: text = pre-action); running -> waiter with `claimMaxWaitMs` (75 s) safety. Controller calls `play()` (starts TTS + scene lines, stores monologue rows), responds `{...result, text: "\n"+text}`, `sendChatGeneration` to renderer. |
| 4 finalize | `AIController.ts:104` -> `finalize` :158 | only arms `postAnimationGraceMs` (60 s) deadline for a still-running entry; `cancel` drops it. TTL `prefetchTtlMs` 180 s. |
| 5 memory | mod `POST /memories` -> `MemoriesController.createMemory` :79 -> `memoryRepository.createMemory` -> `notifyNewMemoryAdded` (`util/notifyRenderer.ts:70`) | hygiene gate may reject (`{rejected}`); single-participant `monologue` stamped owner; `memory_created {memory, paced}`: `paced` = `consumePacedScene(content)` set by `markScenePaced` in play(), so the mod suppresses the block subtitle and waits for `scene_line`s; the scene-memory observer lets ScenePlaybackRegistry trim a stopped scene's row. |
| sync path | `POST /ai/v2/event/interaction` (`AIController.ts:57`) | autonomous game interactions, chat, wants, WW, continue, do-something: `player_voice` source -> speech lane, chat -> front of foreground lane; `interactionEvent` :826 switch; same response + mod POST as above. |

Inside `runDirectedGeneration` (non-player beat): `buildPromptRequest` -> `sceneContext` = location+date+season+weather+postures+participants (AIService:1518) -> **Director Briefing** (500 tok, `PLANNING_BRIEF`, user text = `Previously in this scene` + sceneAction with `Open the scene`, valence clause, content-free hint) -> per-performer **Actor** (120 tok, `BROCA_SPEECH`, own `KNOWN_FACTS` via `semanticMemory.recall`, SAY/THINK) -> **Director Review** (400 tok, numbered lines, `PREFRONTAL_REVIEW`, per-speaker facts) -> **Scene Scores** (300 tok JSON, `LIMBIC_SALIENCE`) -> `armCognitionDesires` -> continue-round decision (`sceneMaxRounds`, 50 s `directedSceneBudgetMs`) -> memory `{content: preActionLine + dialogue}` returned; `play()` stores monologues (owned, importance=memory score), `playTtsLines(paced, sceneId, participantSimIds)`, `scenePlayback.roundQueued`, fire-and-forget next round. Solo beat -> `finishMonologueScene` :2163 (no reviewer, `(to self)` line, event_type `monologue`).

## 3. `runDirectedGeneration` and every caller (`playerFacing = Boolean(playerLine)`, AIService:1551)

| Caller | playerLine | Tier | Notes |
|---|---|---|---|
| `handleInteraction` :936 / `interactionEventDeferred` :947 | - | CORE | the default path for every mapped interaction |
| `handleContinue` :987, `handleDoSomething` :1073 (via `tryDirectedGeneration`, falls back to classic `runGeneration`) | - | CORE | |
| `handleChat` :1094, 2+ sims | `{speaker: sims[0].name, text}` | CORE | typed chat window, `priority` |
| `handleChat` :1112, solo | `{speaker: playerSpeakerName}` + persona flavour :1579 | CORE (PTT / The Voice) | runs `askAction.tryAskedAction` first (:1480, AUTONOMY) |
| `handleChatContinue` :1135 | `{speaker, text:''}` + open thread | CORE | "keep talking or wrap up" (:1564) |
| `runDirectedScene` :1448 (`/ai/v2/event/directed-scene`) | - | DEV | scenario tester, `saveMemory: true` |
| `TwitchChatService.ts:519` | `Chat` + `playerLineFlavor`, `playerLineDisplaySpeaker`, `speakPlayerLine`, `saveMemory` | STREAM | |
| `AIController.selfKnowledge` :198 (`/bench/self-knowledge`) | question, `standalone` | DEV | |
| `bench/playerThreads.ts:86` (`/bench/player-thread`) | fixture lines, `suggestActionsOnly` | DEV | |
| own continuation :2121 | cleared | same as parent | `round+1`, carried lines |

playerFacing changes: director and actors get `selfStatusBlock` (:2371, `formatSelfStatus` over SimStateCache + DailyPlan), actor budget `playerReplyMaxTokens`, multi-line SAY, reviewer 700 tok, scorer `done` field, thread record (`PlayerConversationService`), `actOnConversation` (:2416 -> CognitionService, AUTONOMY) instead of `armCognitionDesires`, solo reply owned + scored when app-saved (:2025).

## 4. The raw-context fallback leak (handoff's `AIService.ts:1578`) - STILL PRESENT, now at **AIService.ts:1678-1681**

```ts
} else {
  // If the director's output couldn't be parsed, fall back to the raw scene context
  actorPrompts.set(name, `You are playing ${name}.\n\n${sceneContext}`);
}
```
(Line moved from 1565 in dc3915a/1578 in the handoff's snapshot to 1680 after 31f2423 added the player-facing code above it; `git log -S` shows no fix.) When the briefing throws (:1657) or has no `=== PROMPT FOR <name> ===` section, each such actor receives the WHOLE `sceneContext` - which is `promptRequest.participants`, i.e. every performer's `<CHARACTER_IN_INTERACTION>`, `<ALSO_PRESENT>`, `<DIRECTOR>`, `<SCENE_GUIDANCE>`, every performer's labelled `<PAST_REFLECTIONS speaker=...>` (private diaries) and `<KNOWN_FACTS speaker=...>`, and `<RELEVANT_MEMORIES>` retrieved with `ownerScope` = all present sims (so other sims' owned monologue rows). The only guard the design has (the director is told to keep a diary in its owner's briefing, PromptRequestBuilder:265) is bypassed. Also the shared-scene prefix is lost, and the actor is then ALSO given its own facts in the system prompt (duplicated). Untested: no test hits the fallback (PlayerFacingReplies only uses a literal `'You are playing Jonah Alder.'` string). Fix for CORE: fall back to `You are playing ${name}.` + location/date/season/weather/postures + that actor's own character block only (never `participants`), or skip the scene (NOOP) like the over-budget path.

## 5. SimStateCache / semantic memory reads, and a CORE mod that never reports state

| Read | Where | Source route (mod tier) | With no state reports / no dossier |
|---|---|---|---|
| `simStateCache.getReport().lot` -> `defaultDescriptions.considerLocation` | PRBS:473-483 | `/cognition/state` (AUTONOMY) | generated lot descriptions lose venue/ownership facts; still runs |
| `buildAlsoPresentBlock(report, lot, ids)` | PRBS:583 | `/cognition/state` | `presentOnLot` returns [] -> **no `<ALSO_PRESENT>`**; J3 hallucination guard ("which cats are here") gone |
| `semanticMemory.recall` per sim -> `<KNOWN_FACTS>` | PRBS:299-318, AIService:1708 (actor), :658 (diary) | facts are written ONLY by `CognitionController.ts:152` `ingestDossier` (`/cognition/dossier`) and DEV `SimFactsController.addFact` | `recall` returns '' when a sim has no facts (SemanticMemoryService:262) -> **no `<KNOWN_FACTS>` anywhere**, silently. The brief lists the fact store as CORE, so the mod's 60 s dossier push (mod map D, AUTONOMY) and `/cognition/dossier` must move to CORE, or CORE ships an empty hippocampus. |
| `memoryRetrieval.retrieve` -> `<RELEVANT_MEMORIES>` | PRBS:273 | memory rows (CORE) | unaffected |
| `getRecentReflectionsByOwner` -> `<PAST_REFLECTIONS>` | PRBS:233 | reflection rows | travel reflections still written (CORE); sleep-boundary reflections come from `/cognition/sleep-boundary` (AUTONOMY) -> far fewer diaries |
| `selfStatusBlock` (`<STATUS>/<TODAYS_PLAN>`) | AIService:2371 | `/cognition/state` + DailyPlan | returns '' -> prompts say "when present", degrade cleanly |
| `lifeStageOf` (J8 no diary below child) | AIService:598 | state report, else dossier `age_stage` fact | undefined -> infants get diaries again |
| `buildSleepPlanContext` | AIService:527 | state report `goal_pool` | undefined -> plain diary (AUTONOMY anyway) |

Every read is try/catch'd; nothing throws. The cost is silent prompt degradation, not errors.

## 6. AI exchange log pruning

Seam: `ApiContext.withExchangeLogging` (ApiContext.ts:790) wraps every GenerationService, so all calls are recorded (success and error) with the AsyncLocalStorage label/actionType/stageId from `runLabeled`. Ring: 200 entries in memory. Table `ai_exchange` in the loaded save DB stores the FULL request JSON + response. Pruning: `onDatabaseLoaded` prunes to 5000, then `record` prunes when `id % 500 === 0` (`DELETE ... NOT IN (SELECT id ORDER BY id DESC LIMIT 5000)`, AIExchangeRepository:136) -> table oscillates 5000-5499 rows. Risks: prompts are 10-40 KB, so ~5k rows is on the order of 100 MB in a save DB that CLAUDE.md says is copied whole on every game save; rows contain other sims' private facts/diaries; `linkRequestsToMemory`/`idForRequest` only search the 200-row ring. Health: 3 consecutive failures -> `notifyProviderHealth` badge + toast (O-6, CORE). Recommendation: CORE keeps the ring + health tracking, and either drops table persistence (F4 exists for bench/watches) or caps it at a few hundred rows.

## 7. What a CORE build must keep, and the surgery mixed files need

Keep whole: all provider services, ProviderConfig, ModelSettings, modelSettings.ts, systemPrompts.ts, formatter/, tokens/, descriptions/ (drop `allTraits.ts`), InteractionService, InteractionSemanticSearchService, AnimationsService, AIExchangeLogService (ring). Drop: MappingService + `/traits*`,`/moods*` (DEV), `filters/` once the two `filters:` lines are removed from `interactionDescriptions.ts:7078,7284` (and `:1-2` imports).

| File:line | Tier | Surgery |
|---|---|---|
| AIService.ts:95 `import { assertDiaryIsProse, repairDiary } from '../bench/tier0'` | DEV import in CORE path | move both (and `extractDiaryProse` they import from DailyPlanService) into `util/` before stripping `bench/` |
| :78, :94, :98 imports (`sleepPlanDays`, `DailyPlanService`/`parsePlannerJson`, `isBelowChild` from ActionLoadout) | AUTONOMY | `isBelowChild` -> `util/simLifeStage`; plan imports go with the sleep-plan branch |
| :527-585 `buildSleepPlanContext`, :678-698 plan prompt branch, :713-740 plan parse | AUTONOMY | CORE keeps `buildDiaryOnlySystemPrompt` path only |
| :503 `scenePlayback.stopAll`, :1500/1701/1806/1883/2044 `sceneStopped`, :2103 `roundQueued`, :2120/2138 `generationStarted/Finished` | STREAM (scene control, moodlet appraisal via `sceneCast` :2097) | keep ScenePlaybackRegistry as a no-op stub (none of these calls is guarded; a missing service throws) |
| :1480-1496 `askAction.tryAskedAction` | AUTONOMY (ask-actions push interactions) | guard/strip; unguarded call |
| :1577-1578 `playerLineFlavor`, :317-333 Twitch options, :2073-2086 `speakPlayerLine` | STREAM | strip with TwitchChatService |
| :1579-1581 persona flavour (`playerVoicePersona*`) | CORE (PTT / The Voice) | keep |
| :1623-1631, :1724 status blocks, :2369-2397 `selfStatusBlock` | AUTONOMY-fed | keep call, stub to '' (drops DailyPlan dependency) |
| :1678-1681 raw-context fallback | CORE bug | fix (section 4) |
| :1907-1922 `actOnConversation`, :1921/:2202 `armCognitionDesires`, :2412-2493 | AUTONOMY | strip; both already try/catch |
| :2112-2140 multi-round continuation | CORE | keep, minus registry calls |
| :1448-1463 `runDirectedScene`; :336-340 `standalone`/`suggestActionsOnly`/`onConversationAction` | DEV | strip with `/ai/v2/event/directed-scene` and bench routes (AIController.ts:116-257) |
| PlayerConversationService use (:1142, :1479, :1488, :2056, :2321-2367) | CORE (chat window "has said their piece") | keep; :1488 and :2056 `record` are unguarded |
| PRBS:583-590 ALSO_PRESENT, :473-483 lot facts, :625-628 KNOWN_FACTS | CORE code, AUTONOMY-fed | keep; move dossier/state ingestion to CORE or accept empty blocks (section 5) |
| GenerationQueueService.ts:224-243, :421-437 cognition lane | AUTONOMY | inert without callers; can stay |
| AIExchangeLogService.ts:15 `MAX_PERSISTED_ENTRIES = 5000` | DEV value | lower or disable table (section 6) |

## 8. Bugs and risks found (not fixed)

1. **Leak** at AIService:1680 (section 4). Untested.
2. **Solo thought floor only applies to app-saved beats.** `finishMonologueScene` skips storing a thought scored < `thoughtMemoryFloor` (4) only when `saveMemory` (:2234); on the game path the same `memory` is returned (:2268) and the mod POSTs it, so every routine thought is stored, owner-stamped but without its importance (MemoriesController:86 cannot see the score). Probable; confirm against the mod's use of `result.memory` vs `text`.
3. `finishMonologueScene` passes `new Map([[performer.name, think]])` to `armCognitionDesires` (:2202), which reads `monologueBySim.get(sim.sim_id)` -> the thought never reaches a solo beat's armed desire.
4. `storeMonologues` looks up `scores.get(sim.name)` (:2520) where the rest uses `findScore` (first-name keys) -> importance lost when the scorer answers with a first name.
5. `localizationEnabled` translates EVERY OpenAI/Gemini response, including scorer JSON, planner JSON and classifications (OpenAIService:162, GeminiService:102) -> parse failures; VLLM/SSAI never translate (inconsistent).
6. NovelAI failure returns the literal text `Error generating via novelai` as a successful generation (NovelAIService:249) -> can air and become a memory; no timeout on its fetch; Kobold has no `response.ok` check and a hardcoded 4094 context.
7. `MappingService.getMoods` uses `moodsPath = ''` (:236) -> `readdirSync('')` throws; `/moods` and `/moods/unmapped` always fail. `getTraits`/`exportTraits` read/write caller-supplied paths (local only).
8. Unknown models (any OpenRouter/Groq id not in `modelSettings.ts`) get `default.max_tokens` 3900, so directed prompts are truncated at ~3.5k tokens by the request builder; `runClassification`/`runBuffDescription` hardcode 3900 too.
9. Unguarded optional-service calls in AIService (section 7 table: `askAction`, `scenePlayback`, `playerConversations.record`): a tier strip must stub these services, not delete them, or the core interaction path throws.
10. `ai_exchange` table size and privacy (section 6). `geminiEndpoint` setting is dead. `allTraits.ts` and `filters/` are dead code.
