# Section 04: cognition, autonomy, bench, util/ (app `jasmine-phase-3` @ 62b9bad)

Read in full: CognitionService (1853), ActionDispatcherService (223), AskActionService (446), DailyPlanService (705),
SimStateCache (104), OutcomeVerdictService (185), CognitionController (452), DebugController (79), bench/* (4 files,
1527), util/* (35 files, selfKnowledge-style pure graders skimmed past their data tables). Paths below are relative to
`src/main/sentient-sims/`. Key: CORE / AUTONOMY / STREAM / DEV; "MIXED" = file needs surgery.

## 1. Services and controllers

| File | What it is | Class | Mod traffic | Settings read | Timers | Deps | Tests |
|---|---|---|---|---|---|---|---|
| services/CognitionService.ts | Per-sim state machine IDLE/DELIBERATING/PENDING_OUTCOME/COOLDOWN. Tick = monologue + scores, then Action Scene (options/choice/review) over offered vocab; rule lanes (critical need <-85, exhausted/starving away -> go_home, miserable 5 min away -> go_home, idle off-lot -> go_home/enter_lot); transient retry (G-10); armed scene desires; conversation follow-through held until scene closes | AUTONOMY | sends `enqueue_interaction` via dispatcher (sources `cognition`, `conversation`); `cancel_interaction` via `release()` on pending timeout | cognitionEnabled (default **false**), cognitionAutonomyLevel (off/suggest/full, default **suggest**), cognitionMaxConcurrent (2, clamp 1-4), cognitionPerSimHourlyBudget (20), cognitionActionScoreThreshold (6), cognitionTickIntervalSeconds (30 = cooldown, min 5), conversationActionsEnabled (default true), conversationActionScoreThreshold (8) | **No interval**: driven by SimStateCache.onReport (mod 5 s). Per dispatch: pending timeout max(90 s or 240 s long verbs, 2 s/m*dist+45 s); retry 4 s; held conversation TTL 5 min; LLM stage 15 s x2 attempts; armed desire TTL 10 min; suppression 10 min fail / 90 s benign | simStateCache, actionDispatcher, dailyPlan, generationQueue, ai.runOneShot, memoryRetrieval, semanticMemory, memoryRepository, memoryTrace; util formatCognitionPrompt, memoryRecallText, conversationActions; models CognitionIntent, ActionLoadout | CognitionService (66), CognitionVocabulary (7), CognitionTrace (1), ConversationAction (12), DayWatchFixes, InfantsQuiet |
| services/ActionDispatcherService.ts | Only sender of push traffic. `dispatch()` throws if mod ws down, or if source=`cognition` and sim has one in flight; `release()` sends cancel; `lookup/wasClosed/resolve` for F5 grading; `pushdiag()` log helper | AUTONOMY | `enqueue_interaction {type, request_id(uuid), sim_id, action, target_sim_id?, target_object_id?, priority?, insert_strategy?, clear_queue?, preempt?, zone_id?, source (default 'cognition')}`; `cancel_interaction {type, request_id}`; `sendToMod()` also carries `request_perception` | none | none; lazy TTL prune 10 min; closed ring 200 | websocketServer (sendModNotification, isWebSocketConnected) | CognitionService/CognitionRoutes tests |
| services/AskActionService.ts | Solo player line (voice/Twitch/chat) triaged talk-vs-do; "do" matched onto full offered vocab, sim answers yes/no in character; yes dispatches; airs the thought as a paced "(to self)" line | AUTONOMY (fork inside CORE reply path) | `enqueue_interaction` source `player_ask`, **priority critical, preempt true**; scene_line via notifyRenderer | askActionsEnabled (default **true**, independent of cognitionEnabled), playerVoicePersona*, playerSpeakerName | none | simStateCache (hard requirement: no entry -> return undefined before any LLM call), promptBuilder, semanticMemory, providerConfigs, memoryRepository, participantRepository | AskAction (19) |
| services/DailyPlanService.ts | Per-game-day plan (<=2 goals from mod goal_pool, persona, loadout of 3-10 keys). Validation, persistence, lazy mid-day planner; pure helpers `parsePlannerJson`, `extractDiaryProse`, `bindGoalId`, `outingNudgeLines` | AUTONOMY (but `extractDiaryProse`/`parsePlannerJson` are used by the CORE diary path) | none | dailyGoalsEnabled (default **true**), dailyLoadoutSize (8) | failure cooldown 10 min; no timers | dailyPlanRepository, participantRepository, simStateCache (optional-chained), ai.runOneShot, pipeline/prompts/consolidation | DailyPlan (36) |
| services/SimStateCache.ts | Latest `state_report` + per-sim entries (never evicted); seq ordering; re-flags `is_active` from `active_sim_id` on heartbeats; `ingestPerception` merge; listeners | CORE-able container (fed only by AUTONOMY mod reporter) | none (fed by POST /cognition/state) | none | none; `isStale` 15 s and `isPaused` have **no production caller** | none | SimStateCache (7) |
| services/OutcomeVerdictService.ts | Grades outcomes confirmed/claimed/suspect/unknown (`verdictFor`), persists `action_outcome` (cap 5000, prune every 500 inserts and on DB load) | AUTONOMY (+DEV read via /ai/outcomes, tier0) | none | outcomeInstantSuccessMs (1500) read by controller | none | ActionOutcomeRepository | OutcomeVerdict (8), Tier0 (7) |
| controllers/CognitionController.ts | MIXED. `postState` (/cognition/state) -> cache.ingest; `postDossier` (/cognition/dossier) -> semanticMemory.ingestDossier + clear generated description; `postOutcome` (/cognition/outcome) -> grade, 'outcome' memory row (notifyMod false), record, cognition.onOutcome; `postSleepBoundary` (/cognition/sleep-boundary) -> endCurrentScene + runSceneReflection('sleep') diary; `postPerception` (/cognition/perception); `debugRequestPerception` (/cognition/debug/perception, sends `request_perception {type, request_id, sim_id}`); `debugEnqueue` (/cognition/debug/enqueue, raw ActionIntent) | dossier CORE; state CORE-able; outcome AUTONOMY; sleep-boundary DECISION; perception+debug DEV | see left | outcomeInstantSuccessMs | none | simStateCache, actionDispatcher, outcomeVerdict, semanticMemory, participantRepository, defaultDescriptions, sceneService, ai, util formatPerception, simLifeStage | CognitionRoutes (15), CognitionOutcomeReason (7) |
| controllers/DebugController.ts | `/debug/health` (mod health check), `/debug/test-ai`, `/debug/send-logs`, `/debug/interaction` bug report: all CORE (upstream). `/debug/twitch-message` injects a fake PRIVMSG | CORE + one STREAM/DEV handler (:59-78) | none | none | none | logSend, providerConfigs, twitchChat | none direct |

Routes (api.ts): :14-17 CORE debug; :18 twitch-message STREAM/DEV; :36-37 `/ai/outcomes` + `/bench/tier0` DEV; :38 `/bench/self-knowledge/:simId`, :41-42 `/bench/player-threads`, `/bench/player-thread/:index` DEV; :129 outcome, :130 perception AUTONOMY/DEV; :131 state; :132 dossier CORE; :142 sleep-boundary; :143-144 debug DEV.

## 2. bench/ (all DEV)

| File | What | Imports / importers | Risk |
|---|---|---|---|
| bench/tier0.ts | Tier-0 run-validity asserts: `assertDiaryIsProse`, `assertOutcomeIsTruthful`, `repairDiary` (= extractDiaryProse), `runTier0` | imports DailyPlanService.extractDiaryProse, ActionOutcomeRepository type. **Imported by CORE AIService.ts:95** (diary write gate :750-757) and AIController.getTier0 :335 | a CORE write path depends on a bench file which depends on an AUTONOMY service |
| bench/selfKnowledge.ts | Self/relationship battery H5: `buildQuestions` from a dossier, `gradeAnswer`, `gradeBattery`, role/denial/name graders | pure; imports models/SimDossier, util/lifeStageWords; used by AIController.selfKnowledge :140 | none at runtime; 58 tests |
| bench/playerThreads.ts | Replays a fixture through `ai.runDirectedGeneration` with saveMemory false, suggestActionsOnly true; polls 500 ms up to 60 s for action verdicts | ctx.simStateCache, playerConversations, aiExchangeLog, util/twitchSimTarget | `closeAll('reset')` wipes the live player threads on every run |
| bench/playerThreadFixtures.ts | Five real 09-19..21 conversations + `EVASIVE_PATTERNS`, `countEvasive` | pure | **Ships real save sim names** (Jake Flores, Lillie, Jonah Alder, Alex Moyer) and stream text: strip from any public build |

## 3. util/ (35 files)

| File | One-liner | Class | Importers (non-test) |
|---|---|---|---|
| airingChunks | Splits long replies into <=160-char `continues` chunks for airing | STREAM (voice airing; CORE if TTS replies ship) | AIService |
| alsoPresent | `<ALSO_PRESENT>` roster block from the state report (same lot only, cap 12, species words) | CORE (inert w/o report) | PromptRequestBuilderService |
| browserWindows | `getAllBrowserWindows()` safe in tests | CORE | 7 files |
| conversationActions | see note A | AUTONOMY | CognitionService only |
| debugLog | toggle electron-log levels | CORE | SettingsService, main |
| degeneratePreAction | rejects broken rendered pre_actions | CORE | AIService |
| eventContainsPlayerSim | `containsPlayerSim(event)` | CORE | AIService |
| filter | null filter, emoji/nonprintable strip | CORE | formatters, VersionService |
| format | epoch->log timestamp, `formatLog` | CORE | websocketServer, LogViewerPage |
| formatCognitionPrompt | see note B | MIXED | AIService, AskAction, Cognition, DailyPlan, VoiceCommand |
| formatPerception | `<PERCEPTION>` prose from a snapshot/entry | AUTONOMY | CognitionController, formatCognitionPrompt |
| gameProcess | `isGameRunning()` before mod update | CORE | UpdateController |
| getRandomItem | random element | CORE | AIService, Gemini* |
| interactionDisplayName | tuning name -> "Passionate Kiss" | CORE | InteractionSemanticSearch, OnlineMappingBrowser |
| lifeStageWords | stage -> phrase/accept words (facts + battery) | CORE | renderKnownFacts, selfKnowledge |
| memoryHygiene | refusal/scaffold gate, article strip, trigram near-dup | CORE | MemoryRepository, MemoryTraceService |
| memoryRecallText | recall text incl. attributed player line | CORE | Cognition, MemoryAnnotation, PromptRequestBuilder |
| modLogMirror | mirrors mod INFO+ into main.log as `[Mod]` | CORE (ops) | websocketServer |
| nameCorrection | levenshtein/phonetic/`correctNames`/whisper prompt | CORE (push-to-talk) | Transcription, VoiceInput, twitchSimTarget |
| nightlyAccess | Patreon nightly flag | CORE | ReleaseTypeSelector |
| notifyRenderer | IPC + mod notification hub | MIXED: CORE (memory_*, notification, popups, clock-state, playTTS) + STREAM (`sendSceneLineToMod`, `sendSceneLineEndedToMod`, `sendConversationClosedToMod`, `sendSceneEndedToMod`, `notifySceneStop`, `setSceneMemoryObserver`, `notifyTwitchStatus`) | 28 files |
| onlineMappingSync | 5-min sync interval const + map equality | CORE | Animations, InteractionRepository |
| pacedScenes | content-keyed "paced" marks so memory_created does not double-subtitle | CORE/STREAM (paced airing) | AIService, AskAction, ipcHandlers, notifyRenderer |
| patreonUtil | Patreon debug lines | CORE | LogSendService, PatreonDebug |
| relationshipWords | friendship/romance/bit words | CORE (shared by facts + tick) | formatCognitionPrompt, renderKnownFacts |
| renderKnownFacts | `<KNOWN_FACTS>` renderer | CORE (fact store) | SemanticMemoryService |
| savedNames | blocks publishing save names to shared mappings | CORE | InteractionService |
| simAliases | placeholder-name test, alias table for nameless NPCs | CORE (alias feed is Twitch setting) | AIService, ParticipantRepo, Twitch, VoiceCasting, VoiceInput, nameCorrection |
| simLifeStage | `lifeStageOf`: state report `self.age`, else fact store | CORE (degrades to facts) | AIService :598, CognitionController :351 |
| synthesizePreAction | unmapped interaction -> label-based pre_action | CORE | AIService |
| textDiff | LCS line/word diff | CORE (UI) | TextDiffView |
| tokenTruncate | prompt/message truncation | CORE | OpenAIRequestBuilder, VLLM |
| twitchIrc | IRC line/badge/command parsing | STREAM | TwitchChatService |
| twitchSimTarget | `!ask <name>` resolver, `buildAskSentientSim`, `buildTwitchAskEvent`, TWITCH_CHAT_* | STREAM (+DEV bench) | TwitchChatService, playerThreads |
| typeChecks | `stringType()` | dead (no importer) | none |

**Note A, conversationActions.ts (48 lines).** `CONVERSATION_IDLE_ACTIONS` maps 13 idle/self-care keys (practice_speech, use_toilet, sit, browse_web, nap, brush_teeth, take_shower, grab_snack, write, paint, garden, listen_to_music, workout) to trigger phrases; `deniedConversationActions(transcript)` returns every key whose phrases the transcript does NOT contain (word-boundary regex). CognitionService.actOnConversation :1200 adds them to both the narrowed vocabulary and `hiddenActions`. Risks: watch_tv, read_book, dance, cook_meal, play_* are not denied, so a casual line can still become TV; loose phrases re-enable keys ("rest" -> nap, "book" -> write, "clean up" -> take_shower, "eat" -> grab_snack). Pure, 12 tests.

**Note B, formatCognitionPrompt.ts (438 lines).** Holds four unrelated things: (1) tick prompt `buildCognitionUserPrompt` + `describeTarget` (AUTONOMY; pulls formatPerception, CognitionIntent.offeredActions/SOCIAL_ACTIONS, ActionLoadout.TEEN_PLUS_TARGET_SOCIALS/isRomanceAge); (2) re-exports of TICK_*/ACTION_* prompts from pipeline/prompts/cognition and /action (:38-43, AUTONOMY); (3) parsers `firstJsonBlock`, `firstJsonBlockLoose` (generic), `parseTickScores`, `parseActionOptions`, `parseActionChoice` (AUTONOMY); (4) `formatSelfStatusSections`/`formatSelfStatus`/`TodaysPlanBlock`/`describePlanGoal` (<STATUS>/<TODAYS_PLAN>/activity), which the CORE player-reply path uses (AIService :80, :2393).

## 4. The five questions

**(1) No state reports ever (core mod never POSTs /cognition/state).** CognitionService has no timer of its own; `onStateReport` (:394) is only a SimStateCache listener, so the tick never runs: no LLM calls, no dispatch, no timers, no log lines, no errors. SimStateCache stays empty (`isStale()` true, but nothing calls it). Two entry points still fire from the CORE scene pipeline:
- `armDesireFromScene` (AIService.armCognitionDesires :2476-2495) on every non-player directed scene: for each sim with action score >= 6 it creates a runtime entry and logs `[Cognition] sim X armed action desire N (...)`. Never consumed, TTL 10 min. **Log noise, one INFO line per sim per scene.**
- `actOnConversation` (AIService :1909-1922, :2416-2470) on player-facing replies with score >= 8 (conversationActionsEnabled defaults true): logs "holds a conversation action", parks a Promise + 5-min timer until the scene closes, then finds no cache entry and arms (another INFO line). No LLM spend, no errors.
- AskActionService returns before triage (no entry, :69-72). Daily plan: lazy planner fires only from onStateReport; sleep plan context needs `goal_pool` (AIService :536-539), so the diary stays the plain 160-token reflection. VoiceCommandService pops "no sim to command yet" and sends `player_voice_status error` (it also needs the AUTONOMY push engine, so strip it).
Verdict: idles cleanly; cosmetic noise from the two AIService call-outs. Removing CognitionService from the core build requires stubbing both.

**(2) SimStateCache consumers outside cognition, and what degrades.**
| Consumer | Reads | Without reports |
|---|---|---|
| PromptRequestBuilderService :473-482 | `lot` (lot_id match) -> `defaultDescriptions.considerLocation(location, lot, lot_name)` | generated location descriptions lose venue/ownership/conditions/lot name (V-6 "The Residence" everywhere) |
| PromptRequestBuilderService :583-590 | `buildAlsoPresentBlock(report, location_id, performers)` | no `<ALSO_PRESENT>`: models may invent pets/people (J3) |
| AIService.selfStatusBlock :2368-2395 | `getSim(simId)` + clock day + dailyPlan | player-facing replies lose `<STATUS>`/`<TODAYS_PLAN>`; returns '' (the 09-19..21 "I don't know" failure the 09-21 change fixed comes back for "what do you want") |
| AIService.buildSleepPlanContext :535-575 | goal_pool, traits, age, action_keys, clock | no plan (AUTONOMY anyway) |
| ApiContext :458-465 -> MemoryRepository :531 | `lot.clock.absolute_day` as the game-day stamp on every memory | `memory_index.game_day` never written; retrieval decays on wall clock (already 99.5% NULL on the live save, MemoryRepository :321 comment) |
| util/simLifeStage (AIService :598 sleep diary, CognitionController :351) | `self.age` | falls back to dossier fact AGE_STAGE: fine if dossier ships |
| CognitionController.postDossier :144 | clock day fallback | none for a mod that sends `clock` with the dossier |
| SimFactsController :133, :152 | clock day for manual fact add/retire | validFromDay undefined |
| VoiceInputService :190 knownNames, :223 onLotNames | report names | name correction falls back to participant DB; on-lot tie-break lost |
| TranscriptionService :67 namePrompt | names + `lot.zone_id` | whisper bias uses participants + ALL locations (truncated at 700 chars) |
| VoiceCommandService :26, :37 | active sim, offered vocab | broken (AUTONOMY) |
| TwitchChatService :413-440, :502 | roster, `is_active`, `active_sim_id` | unnamed `!ask` has no active-sim fallback (STREAM) |
| AskActionService :69, :82; bench/playerThreads :63; AIController :173 | entry/report | skip / DEV |
"Active-sim routing for unnamed chat asks" is Twitch (STREAM) and the voice-command hotkey (AUTONOMY). The core chat window and push-to-talk do not need it: push-to-talk sends `player_voice_message` and the mod picks the active sim.

**(3) CLOCK_STATE vs the state cache (the UNDECIDED item).** They are separate channels. Voice playback follows the game clock via the websocket `clock_state` LOG message (mod ss_clock / `GameClock._update_speed` hook) -> websocketServer.ts :119-127 (gated by `playbackFollowsGameClock`, default true) -> notifyRenderer.notifyClockState :47 -> preload `onClockState` -> renderer/voice/playbackClock.ts + AudioContextProvider. Nothing on that path touches SimStateCache or /cognition/state. The state report's `paused`/`lot.clock` is read only by CognitionService.onStateReport :398 (and the unused `isPaused()`). **Voice clock-following needs zero state-cache code; the cache's clock is used for game-day stamping and plans, not playback.** Decision can close: keep `clock_state` CORE; the state reporter can stay AUTONOMY.

**(4) Push contract as the app sends it** (the app has no `PLAYER_PUSH_SOURCES`; that set lives in the mod).
| Sender | source | priority | preempt | app one-in-flight? | Mod treatment (per mod map C) |
|---|---|---|---|---|---|
| Cognition tick, rule lanes, retry (CognitionService :718, :774, :850, :909, :1403, :1814) | `cognition` | omitted (mod default critical) | no | **yes**: dispatcher throws (:109) | yields to player clicks |
| Conversation follow-through (:1403 via :1255) | `conversation` | omitted (mod default high); preempt removed 2026-09-22 (:1410-1413) | no | no, but runtime phase guard :1182 | yields |
| AskActionService :122-133 | `player_ask` | `critical` | **true** | no | never yields |
| VoiceCommandService :92-102 | `player_command` | `critical` | no | no | yields (not in the mod's set; likely unintended, mod map C) |
| /cognition/debug/enqueue :445 | raw body; omitted -> message says `cognition` while `intent.source` is undefined | body | body | no | yields; graded `unowned=false` |
| pending timeout release :1756 | `cancel_interaction {request_id}` | | | | |
`motivation` never goes to the mod (app-side only, becomes the outcome row's `pre_action`). `insert_strategy`/`clear_queue` are never set outside debug. `zone_id` only from go_out destinations.

**(5) util/ imports that couple CORE to AUTONOMY.**
- AIService :80 `formatSelfStatus, TodaysPlanBlock` from formatCognitionPrompt, which imports formatPerception, models/CognitionIntent, models/ActionLoadout and re-exports pipeline/prompts/cognition + /action.
- AIService :94 `parsePlannerJson, extractDiaryProse, DailyPlanService` (services, not util); :95 bench/tier0 (-> DailyPlanService again); :98 `isBelowChild` from models/ActionLoadout.
- No util file imports CognitionService/ActionDispatcher. The autonomy-only util files are conversationActions and formatPerception; formatCognitionPrompt is mixed.
- STREAM-into-CORE: AIService imports airingChunks; notifyRenderer carries the scene_line/scene_ended senders.

## 5. What a CORE build must keep, and the surgery

Keep whole: SimStateCache (as an optional enricher), relationshipWords, renderKnownFacts, lifeStageWords, simLifeStage, alsoPresent, memoryHygiene, memoryRecallText, nameCorrection, simAliases, synthesizePreAction, degeneratePreAction, and the plain CORE helpers in section 3. DebugController minus :59-78.

Remove whole: CognitionService, ActionDispatcherService, AskActionService, DailyPlanService (after the extraction below), OutcomeVerdictService, VoiceCommandService, util/conversationActions, util/formatPerception, util/twitchIrc + twitchSimTarget (STREAM), util/typeChecks (dead), bench/* (DEV).

| File:line | Surgery |
|---|---|
| util/formatCognitionPrompt.ts :53-98, :173-263 | Move `firstJsonBlock(+Loose)` to util/jsonBlocks and `formatSelfStatus*`/`TodaysPlanBlock`/`describePlanGoal` to util/selfStatus (CORE). Everything else stays AUTONOMY |
| services/DailyPlanService.ts :133-205 | Move `parsePlannerJson` + `extractDiaryProse` to a CORE util. bench/tier0 `assertDiaryIsProse`/`repairDiary` (:30-70) into the same util; tier0 re-imports from there |
| services/AIService.ts :80, :94-98 | Retarget imports to the new utils; `isBelowChild` needs a CORE home (it is also used by CognitionController :352 sleep-boundary) |
| AIService.ts :527-580, :700-740 | Sleep-plan context + planner parse: strip (or feature-flag); keep the plain-diary path and the tier-0 prose gate :750-757 |
| AIService.ts :1478-1495 | `askAction.tryAskedAction` fork: strip |
| AIService.ts :1905-1922, :2412-2495 | `actOnConversation` / `armCognitionDesires`: strip, or guard on a no-op cognition stub |
| AIService.ts :2368-2395 | `selfStatusBlock`: keep (returns '' without a report); drop the dailyPlan lookup |
| services/ApiContext.ts :405 | `releaseConversationActions` in `onSceneClosed`: strip (SceneMoodletService appraise is STREAM, same callback) |
| ApiContext.ts :41-47, :72, :380, :383, :424, :448, :471-474, :576-613, :653, :701, :713 | Drop dispatcher/ask/voiceCommand/dailyPlan/cognition/outcomeVerdict construction and getters. Keep :425 cache + :458-465 game-day provider |
| services/DbService.ts :117 | `outcomeVerdict.pruneOnLoad()`: strip |
| controllers/CognitionController.ts | Keep `postDossier` :135-185 (move to SimFactsController) and optionally `postState` :118-130. Strip `postOutcome` :202-308, `postPerception` :391-414, debug :418-451; decide `postSleepBoundary` :327-387 (diary = memory; mod sender is the AUTONOMY sleep watcher) |
| controllers/AIController.ts :19-22, :140, :173, :224-260, :320-345 | Strip bench + outcomes handlers |
| api.ts :18, :36-42, :129-131, :142-144 | Strip routes; keep :132 dossier |
| bench/playerThreadFixtures.ts | Must never reach a public build: real save names and stream transcript |

## 6. Bugs and risks (not fixed)

1. `actOnConversation` gates on `cognitionAutonomyLevel !== 'off'` but **not `cognitionEnabled`** (:1172). With cognition off and level `full`, replies still dispatch; with the default `suggest` and a live state report, each high-scoring player reply still pays for a 2-3 call Action Scene that is then only logged.
2. `armDesireFromScene` logs and allocates runtimes with cognition disabled (:1437-1446).
3. Dispatcher one-in-flight applies only to `cognition`; a `player_ask`/`player_command`/`conversation` dispatch overwrites `inFlightBySim`, so a cognition push can be in flight alongside it (the runtime guard covers `conversation` only).
4. `onOutcome` with no `request_id` skips the correlation guard (:491) and can close another request's PENDING_OUTCOME.
5. `/cognition/debug/enqueue` without `source` goes to the mod as `cognition` but is graded as owned (`unowned=false`) and bypasses the in-flight rule.
6. SimStateCache `simEntries` is never evicted across lots/saves (TwitchChatService :400-404 works around it); `isStale`/`isPaused` are dead code.
7. `askActionsEnabled` and `dailyGoalsEnabled` default true while `cognitionEnabled` defaults false: with a state-reporting mod, ask triage and the 900-token sleep planner run for users who never enabled autonomy.
8. bench/playerThreads `closeAll('reset')` closes live player threads when run during play.
9. conversationActions coverage gaps (note A).
