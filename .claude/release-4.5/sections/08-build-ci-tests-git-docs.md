# 08 — App repo: git baseline, build + CI, tests, docs and scratch, public-cut hazards

Measured 2026-09-23, read-only, on `C:\Users\scott\Documents\github\sentient-sims-app`
(`jasmine-phase-3` at `62b9bad`, "Moodlet tooltips read like the game's own"). The only
write to the repo was `git fetch upstream --tags` (refs only) and this file. No npm, no
app, no tests run. Secret VALUES are deliberately not reproduced here.

## 1. Git baseline

- Remotes: `origin` = `Scott-Bott/sentient-sims-app-lab` (private: the GitHub API returns
  404 anonymously), `upstream` = `guspuffygit/sentient-sims-app`. Upstream's default
  branch is **`main`** (there is no `develop` in this repo; `git remote show upstream`
  says `HEAD branch: main`). Local `main` = `upstream/main` = `cf65dab`.
- Merge-base with `upstream/main`: **`21b6640`** = tag **v4.0.8** ("4.0.8 kokoro voices and
  auth fix", 2026-08-25), the same release point as the mod's merge-base.
- This branch is **143 commits** past it (104 Scott-Bott, 39 JazKieten). Upstream has
  **8 commits** since: `947d7d9` 4.0.9 old-lineage saves on fork, `a0546fb` install
  painting mount button, `c1c45bb` 4.0.10 rpmax, `8d6f31e` test, `170067c` 4.0.11 login via
  username, `009b02c` 4.0.12, `ad81451` kobold error messages, `cf65dab` **4.1.0 retire
  mythomax** (2026-09-04). 24 files; **10 overlap with ours** and will conflict or need a
  read: `AIService.ts`, `SettingsService.ts`, `DbService.ts`, `api.ts`, `constants.ts`,
  `App.tsx`, `MenuBar.tsx`, `MemoryRetrieval.test.ts`, `release/app/package{,-lock}.json`.
- Versions: upstream latest tag and release **v4.1.0** (published 2026-09-04; GitHub API).
  Ours: `release/app/package.json` = **4.0.8** (the root package.json carries no version;
  `update-version.ts <v>` writes release/app/package{,-lock}.json). A newer upstream tag
  `v1.5.0` appeared on fetch (old-numbered, ignore).
- Upstream ALREADY contains fork history: Gus merged `pr/sentience-voices-subtitles` as
  `f05b294` (2026-08-16); `upstream/main` carries 40 Scott-Bott and 11 JazKieten commits.
  Whatever was in those commits is public already; everything below is about the 143.
- `UPDATE-FOR-GUS-2026-08-27.md` (tracked) says Gus has write access to both lab repos and
  was told to pull `jasmine-phase-2` directly. Worth knowing before a "fresh public fork".
- Branches (ahead/behind HEAD):
  - `sentience-phase-3` (local+origin) `371bc35` 09-20: **27 ahead, 13 behind**. The 27
    are the research line: S1 per-Sim Sentience, J2 per-lot scenes, J9 finish_reason,
    Tier-0/memory-recall bench graders, T1-T8 dispositions/TriggerService/inner voice,
    L0-L3 (tones, go_talk_to, miss-rate, alias). It also adds **migrations 021-026**
    (`sentience`, `ai_exchange.finish_reason`, disposition triggers, `trigger_fire`,
    `disposition_why`, `intent_miss`) which jasmine-phase-3 does NOT have (it stops at
    `020-participant-description-generated`). A save DB opened by a sentience build then
    by a jasmine/core build has migrations the older build does not know.
  - `origin/jasmine-rollback` `24ad9ad`: 2 commits not in HEAD (Jaz persona + filler guard
    rollback; "tolerate the v4.0.8-migrated save DB"). Jaz's baseline, never touch.
  - `mem-today-oracle` 09-22: fully merged (0 ahead). `tts-streaming`: 1 ahead (07-28
    MediaSource ElevenLabs stream, superseded). `origin/mapping-browser-improvements`: 4
    ahead (08-06). Everything else (`jasmine-phase-2`, `fixes-0826-abc`,
    `night-watch-2026-08-18`, `phase-2-full-autonomy`, `sentience-phase1/2`, `prompting`,
    `more_prompting`, `origin/merge-upstream-4.0.0`, `origin/pr/sentience-voices-subtitles`,
    `origin/subtitles-playtest`, `origin/jasmine-app-local-2026-08-16`,
    `backup/sentience-phase1-pre-merge`) is 0 ahead: pure history. `origin/main`/`HEAD` =
    3.28.4 (07-22), `origin/New-System-Prompt` 2023. Upstream also has `outcomes`,
    `sleeping`, `vision6`, `gus-changes-subtitles`, `prompting`.
- Untracked (not ignored), both at repo root:
  - `TODO_STREAM_REVIEW_FIXES.md` (82 lines): the 6 findings of the 09-21 stream review
    (reviewer `1:` parser drops fixes, fix `/^\s*\d+[.):]\s+/`; 3 fixes that still did not
    air; `generationTimeoutSeconds` not bounding OpenRouter; no per-call spend in
    `ai_exchange`; Director Briefing = 40% of LLM cost; 22% of actor lines never aired).
    Names Jasmine, her Twitch stream, and her household's Sims. STREAM/DEV; never public.
  - `make them look at us when we talk t.txt` (20 lines): a pasted Discord note from JazK,
    a feature wish-list (sims initiate chats with the player, shorter/fewer monologues,
    "using computer" reaches into our world, place/move objects, create/delete sims, any
    life choice, "the ability to murder", "AI takeover hysteria to get engagement").
    Scratch; never public.
- Files ADDED vs `21b6640`: 140 total, 133 under `src/` (+34,427/−595 lines overall; 10,705
  of the insertions are tests). Outside src: `.claude/sentience-phase-2/{COOKBOOK,
  PLAYER-HANDOFF, start-of-tick-loop-planning}.md`, `UPDATE-FOR-GUS-2026-08-27.md`,
  `changes-since-more-prompting.md`, `scripts/repair-memories.{cjs,cmd}`.
  Under src/main + renderer, by tier (first pass; section owners refine):
  - AUTONOMY: `services/{CognitionService, DailyPlanService, AskActionService,
    OutcomeVerdictService, SimStateCache}`, `db/{DailyPlanRepository,
    ActionOutcomeRepository}`, `models/{CognitionIntent, ActionLoadout, DailyPlan,
    SimStateReport}`, `pipeline/prompts/{cognition, action, ask}`,
    `util/{conversationActions, formatCognitionPrompt}`.
  - CORE-memory (decision owed, mirrors the mod's dossier question): `db/SimFactRepository`,
    `controllers/SimFactsController`, `clients/SimFactsClient`, `models/SimDossier`,
    `pipeline/facts/{dossierFacts, predicates}`, `util/{renderKnownFacts, memoryHygiene,
    memoryRecallText, relationshipWords, lifeStageWords, simLifeStage, alsoPresent,
    nameCorrection, savedNames, simAliases, synthesizePreAction}`,
    `services/{SemanticMemoryService, DefaultDescriptionService}`,
    `pipeline/{stages, prompts/index, prompts/scene, prompts/consolidation,
    prompts/utility}`.
  - STREAM: `services/{TwitchAuthService, TwitchChatService, VoiceInputService,
    VoiceCommandService, VoiceHotkeyService, TranscriptionService, PlayerConversationService,
    ScenePlaybackRegistry, SceneMoodletService}`, `util/{twitchIrc, twitchSimTarget,
    airingChunks}`, `models/{TwitchChatStatus, PlayerVoicePersona}`, renderer
    `providers/VoiceInputProvider`, `voice/{useVoiceRecorder, playbackClock}`,
    `settings/{TwitchSettingsComponent, ConversationActionsSettingsComponent,
    voice/VoiceInputSettingsComponent}`.
  - DEV: `services/{AIExchangeLogService, MemoryTraceService}`, `db/{AIExchangeRepository,
    MemoryTraceRepository}`, `models/{AIExchangeLog, MemoryTrace}`, `bench/{tier0,
    selfKnowledge, playerThreads, playerThreadFixtures}` (routes `/bench/*` in api.ts
    lines 37-42), `util/{modLogMirror, textDiff}`, renderer `AILogPage`,
    `components/{LLMExchangeDetail, MemoryTraceDialog, PromptTextBlock, SimFactsDialog,
    TextDiffView}`, `hooks/{useAIExchanges, useMemoryTrace, useSimFacts}`.
  - 52 new `src/__tests__/*.test.ts` (see section 3).
- 15 heaviest modified pre-existing files (+/−):

| File | +/− | Note |
|---|---|---|
| `services/AIService.ts` | +1486/−198 | also changed upstream (4.1.0 retires mythomax) |
| `services/SettingsService.ts` | +433/−0 | all tiers' keys; also changed upstream |
| `db/MemoryRepository.ts` | +287/−4 | |
| `services/ApiContext.ts` | +284/−0 | service wiring for every tier |
| `controllers/CognitionController.ts` | +255/−22 | `/cognition/*` routes |
| `__tests__/CognitionRoutes.test.ts` | +252/−1 | |
| `controllers/AIController.ts` | +190/−4 | incl. bench handlers |
| `renderer/providers/AudioContextProvider.tsx` | +166/−18 | voice playback |
| `db/migrations.ts` | +183/−0 | 016-020: ai_exchange, memory_trace, action_outcome, sim_fact, sim_dossier, daily_plan (015) |
| `util/notifyRenderer.ts` | +158/−8 | |
| `services/PromptRequestBuilderService.ts` | +126/−37 | |
| `services/ActionDispatcherService.ts` | +153/−4 | |
| `db/ParticipantRepository.ts` | +124/−7 | |
| `__tests__/PrefetchPromptFormatting.test.ts` | +51/−63 | |
| `descriptions/interactionDescriptions.ts` | +102/−2 | |

Next: `MemoryRepository.test` +89/−12, `MemoryRetrieval.test` +93/−5,
`models/ModWebsocketMessage.ts` +92/−2, `voice/audioPlayback.ts` +89/−2,
`db/MemoryIndexRepository.ts` +78/−13. Nothing was deleted vs the merge-base.

## 2. Build and CI

- Scripts (root `package.json`): `build` = `electron-vite build` (main/preload/renderer ->
  `release/app/dist/`), `compile` = `tsc --noEmit --skipLibCheck`, `lint` = eslint with the
  native TS config flag, `package` = clean + build + `electron-builder --publish never`,
  `start` = electron-vite dev, `test*` all via `ELECTRON_RUN_AS_NODE=true electron vitest`,
  `backfill-memories` and (ours) `repair-memories` run `scripts/*.cjs` under Electron. Ours
  also removed `test:e2e` (CLAUDE.md still lists it) and added deps `ws` (+`@types/ws`) and
  native `uiohook-napi 1.5.5` (voice hotkeys; MIT) to both package.json files.
- electron-vite (`electron.vite.config.ts`, unchanged vs base): all deps bundled; only
  `release/app/package.json` dependencies (better-sqlite3, sharp, node-gyp, now
  uiohook-napi) are externalized. `.nvmrc` = `v24.15.0` (unchanged).
- electron-builder (`package.json > build`): productName `SentientSims`, appId
  `com.sentientsimulations.sentientsimsapp`, NSIS / universal DMG (hardened, notarized) /
  AppImage, `publish: { provider: github, owner: guspuffygit, repo: sentient-sims-app }`.
- **Self-update from Gus**: `main.ts:223-240` runs `electron-updater`
  `checkForUpdatesAndNotify()` on every packaged launch; the feed comes from that publish
  block, i.e. Gus's GitHub releases. A fork build at 4.0.8 sees v4.1.0, downloads it, and
  shows a dialog whose only button is "Install and Restart" (autoInstallOnAppQuit also
  applies). So a packaged stream/lab build **would replace itself with Gus's public app**.
  Dev mode (`npm start`) is not affected (updater is a no-op unpackaged), which is
  presumably why this has never bitten on Scott's/Jaz's machines. Any private build must
  change `publish` (or disable the updater) and bump past Gus's version.
- **Mod self-update from Gus's S3**: `renderer/providers/ModUpdateProvider.tsx:149-170`
  auto-installs on the first check after sign-in when `mod-version.json` differs from the
  S3 object metadata (`renderer/versions.ts:26`, bucket `sentient-sims-artifacts`);
  `UpdateService.installMod` (`services/UpdateService.ts:88-200`) extracts
  `sentient-sims-<type>.zip` over `Mods/sentient-sims/`, skipping only
  `sentient-sims.ts4script` when a `Scripts` folder exists. A fork mod has no matching
  `mod-version.json`, so a signed-in stream app would overwrite the fork's
  `sentient-sims.package` (45 tiered moodlets, plumbob MODL) with Gus's on startup.
  Needs a guard in any non-Gus build.
- Workflows (`.github/workflows`, unchanged vs base):
  - `compile-lint.yml`: on every push, ubuntu, npm install, `compile`, `lint`. No secrets.
  - `test.yml`: on every push, `npm install`, `npm run rebuild`, then `npm run package` AND
    `npm test` (full suite incl. `*.it.test.ts`) with secrets `OPENAI_KEY`,
    `GITHUB_TOKEN`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`,
    `SENTIENTSIMS_TEST_USER`, `SENTIENTSIMS_TEST_PASSWORD`; uploads `coverage/lcov-report`
    as a Pages artifact. In a fork without those secrets the network tests fail.
  - `publish.yml`: on push to `main` or `develop`; matrix ubuntu/macos/windows; Python 3.11
    (unused leftover); `electron-builder --publish always` with `GITHUB_TOKEN`, mac also
    `APPLE_P12_BASE64`, `APPLE_P12_PASSWORD`, `APPLE_ID`, `APPLE_ID_PASS`, `APPLE_TEAM_ID`.
    Uploads installers + `latest*.yml` to a GitHub release on **guspuffygit/sentient-sims-app**
    (hard-coded owner). Run from a fork it would try to publish to Gus's repo with the
    fork's token and fail. Mod zips to S3 are not uploaded here (mod repo's CI).
- Mod files under `src/main/sentient-sims/sentient-sims/` (`logs.txt` 0 B,
  `mod-version.json` = a mod commit sha, `sentient-sims.package` 13.1 MB,
  `sentient-sims.ts4script` 437 KB) are **tracked** and **already in upstream**: added
  2026-07-01 in Scott's "per-character voices" commit (`1cb0c46`, plus `8f0c966` under the
  TopTierBeads identity), ts4script touched by Jaz `d3c5bf3` 07-10. Nothing reads them:
  they are a dev run's Mods folder that got committed. Delete-candidate (not a leak).
- Version flow: `release/app/package.json` version -> `app.getVersion()` when packaged, or
  the imported `releaseAppVersion` in dev (`main.ts:35,180`, so dev no longer reports
  Electron's 41.x) -> `ApiContext.appVersion` -> `VersionService.getAppVerson()` ->
  `GET /versions/app` (`api.ts:53`, `VersionController.getAppVersion`) -> the mod compares
  it with `APP_VERSION_REQUIRED` (4.0.8 in the mod). `/versions/mod` reads
  `Mods/sentient-sims/mod-version.json`. Release 4.5 must bump release/app/package.json,
  the mod's `APP_VERSION_REQUIRED` and, for any private build, get above v4.1.0.

## 3. Tests

- 108 `*.test.ts` files, all in `src/__tests__/`: 56 existed at 4.0.8, **52 added** here.
  Every one runs under Electron's Node (`ELECTRON_RUN_AS_NODE`, better-sqlite3 built for
  Electron's ABI); vitest `pool: forks`, `fileParallelism: false`, 30 s timeout, coverage
  istanbul. 5 are `*.it.test.ts` (Api, ElevenLabs, EmbeddingService, OpenAIService,
  ProviderConfigApi); `test:unit` excludes them. Env-secret users: `Api.it`,
  `EmbeddingService.it`, `DirectedSceneScratch`, `PromptFormatter` (upstream files).
- 28 test files touch the DB (DbService / MemoryRepository / better-sqlite3).
- Added tests by area: autonomy (CognitionService, CognitionOutcomeReason, CognitionTrace,
  CognitionVocabulary, DailyPlan, AskAction, ActionOutcomePersistence, OutcomeVerdict,
  SimStateCache, ConversationAction, DayWatchFixes, ContentFreeSocials, PickerMappings);
  memory/facts (FactVocabulary, FactsInPrompts, MemoryFocusWindow, MemoryHygiene,
  MemoryRecallText, SemanticMemory, SimFactRoutes, RenderKnownFacts, DossierRoute,
  Reflections, InfantsQuiet, AlsoPresent, DefaultDescription); scene/voice/stream
  (SceneLineMessages, SceneMoodletService, ScenePlaybackRegistry, ScenePrompts,
  SceneStopGating, Stages, StagePromptRouting, DirectedSceneMonologue,
  PlayerConversationService, PlayerFacingReplies, PlayerVoicePersona, VoiceInput,
  NameCorrection, SynthesizePreAction, TwitchChat); names/publish (SavedNames,
  PublishNameGuard); bench/dev (SelfKnowledgeBattery, Tier0, AIExchangeLog,
  AIExchangePersistence, MemoryTrace, MemoryTraceEndToEnd, MemoryTracePersistence,
  ModLogMirror, OpenAIRequestBuilder).
- Known-failing: nothing in config or CI records a count. The "~57 DB-backed vitest
  failures / ~108 lint errors" in memory are machine observations (ABI/profile), not
  repo facts. The tracked `UPDATE-FOR-GUS` (08-27) claims "tsc clean, vitest green except
  the two Api tests that need AWS credentials (pass with AWS_PROFILE=sentientsims)" and
  "ESLint repo-wide has a known pre-existing backlog". `compile-lint.yml` runs lint on
  every push, so a lint backlog means that job is red; the lab repo is private and `gh`
  is not installed, so CI state was not checked. Confirm by running `npm run check` in the
  packaging session.

## 4. Docs and scratch

- `CLAUDE.md` (93 lines, +27 vs base: PlayerConversationService, player-facing replies,
  Sentient Moodlets, mod log mirror; STREAM content), `AGENTS.md` (24, differs from
  CLAUDE.md, unchanged), `README.md` (unchanged; Discord invite is Gus's),
  `MAPPING_BROWSER_CHANGES.md` (in upstream, +51 here).
- Root, added here: `UPDATE-FOR-GUS-2026-08-27.md` (195 lines, Jaz, the handoff to Gus,
  names "Jazki's machine", PR #37/#43, lab repo names) and `changes-since-more-prompting.md`
  (92, sentience-phase1 change log). Both PRIVATE-history.
- `.claude/`: tracked `sentience-phase-2/SENTIENT-SIMS-CODE-COOKBOOK.md` (37 KB),
  `SENTIENT-SIMS-PLAYER-HANDOFF.md` (38 KB; Jaz's working preferences and her Windows
  user path `C:\Users\<jazki>\OneDrive\...` at line 54), `start-of-tick-loop-planning.md`.
  Ignored and never committed: `playtest-db.db` (41 MB real save DB),
  `playtest-logs.txt` (124 MB), `settings.local.json` (one permission line),
  `scheduled_tasks.lock`. This session adds `.claude/release-4.5/` (untracked).
- Ignored on disk, never in history: `.env` (holds a **live OpenRouter API key** in plain
  text, non-KEY=VALUE format; rotate if the machine or folder is ever shared),
  `scott-scratch.md`, `logs.txt` / `logs (2).txt` (June mod logs), `.agent-local/sims4/`
  (how-to-play, actions, story-log notes), `.pytest_cache/`, `release/build`, `dist`.
- Secret scan of HEAD and all history: no real API keys (only `sk-or-v1-test` in
  `OpenRouterModels.test.ts:48`), no `.env`/`.p12`/`.db` ever committed. Twitch client id
  and channel are settings with empty defaults (`SettingsService.ts:396-450`), no Patreon
  client id in source (OAuth goes through Gus's site; `PatreonController`, `/patreon-
  redirect`). Present and Gus-owned (already public upstream): Cognito user pool, identity
  pool, app client id and hosted domain in `renderer/AmplifyConfig.ts:7-14` and
  `main.ts:143`; S3 bucket name in `UpdateService.ts:98` and `renderer/versions.ts:26`;
  `ai.sentientsimulations.com` in `constants.ts:72`.
- Real player/sim/Twitch data in tracked files (all post-base, so in the private 143):
  `bench/playerThreadFixtures.ts` = five verbatim player/Twitch-chat conversations from the
  09-19..21 stream logs with Jaz's household sims (Jonah Alder, Alex Moyer, Jake Flores,
  ...); sim names from her saves in code comments (`selfKnowledge.ts:374`,
  `MemoryRepository.ts:322`, `AIService.ts:1952`, `memoryRecallText.ts:6`,
  `renderKnownFacts.ts:126-128`, `TwitchChatService.ts:469`) and in ~20 test files;
  "Jaz's 09-04 handoff" cited in ~12 source comments (`ActionLoadout.ts:128`,
  `scene.ts:293`, `alsoPresent.ts:1`, `nameCorrection.ts:128`, `CognitionService.ts:1005`,
  ...); `TwitchChat.test.ts:116,439` use Jaz's Twitch handle. Commit author emails
  (Scott's and Jaz's personal addresses, plus a `TopTierBeads` identity) are in every
  commit; both already appear in upstream's history via the 08-16 merge.
- Licences: repo LICENSE is MIT (Gus). No Kokoro model weights, fonts or audio are bundled
  (Kokoro is a remote/local server; `renderer/kokoro/voices.ts` is a name list). Bundled
  third-party data: NovelAI tokenizer JSONs (upstream, pre-existing), electron-react-
  boilerplate images in `.erb/img`, Google/Discord/Patreon logos in `assets/` (upstream).
  New native dep `uiohook-napi` is MIT.

## 5. Public-cut hazards and delete-candidates

Hazards (must not reach the history that goes to Gus):
1. `.claude/sentience-phase-2/*` (Jaz's handoff + path, cookbook), `UPDATE-FOR-GUS-
   2026-08-27.md`, `changes-since-more-prompting.md`: in the 143 commits; needs rebuilt
   history, not a delete commit.
2. `bench/playerThreadFixtures.ts` (verbatim stream conversations) and the stream sims'
   names in comments/tests; "Jaz's handoff" comments. Scrub or replace with synthetic
   names in the public cut.
3. STREAM/AUTONOMY/DEV code listed in section 1, plus their SettingsService keys,
   ApiContext wiring, `/cognition/*` and `/bench/*` routes, migrations 015-020 (keep the
   ones the kept tables need; 021-026 live only on sentience-phase-3, keep the numbers
   reserved so a later merge cannot collide).
4. The two untracked root files: fine as long as nobody `git add -A`s; add to .gitignore
   or move out.
5. Private builds: `publish` owner and the S3 mod auto-install (section 2) will pull Gus's
   app and mod over a stream build. Not a leak, a correctness hazard for the stream copy.
6. Upstream 4.0.9..4.1.0: 10 overlapping files; merge before cutting (4.1.0 retires
   mythomax, which touches AIService and settings).

Delete-candidates (any cut):
- `src/main/sentient-sims/sentient-sims/` (4 tracked mod artefacts, 13.6 MB, unreferenced).
- `scripts/repair-memories.{cjs,cmd}` + `repair-memories` script: one-time repair from the
  08 playtest audit (DEV); the .cjs contains a literal NUL byte at offset 7274 (template
  literal separator), so git diffs it as binary. Replace with `\0` if kept.
- `test-import.ts` (root ad-hoc ApiContext smoke script, upstream), `.erb/img/*`
  boilerplate banners, publish.yml's unused Python setup, `src/__tests__/lastException.txt`
  only if `LastException.test.ts` goes (it is that test's fixture).
- CLAUDE.md: drop `test:e2e` from the command list (script removed), the WSL
  `/home/guspuffy` paths, and the stream sections for the public cut.
- Stale branches (0 ahead): all listed in section 1 except `sentience-phase-3`,
  `jasmine-rollback`, `tts-streaming`, `mapping-browser-improvements`.
- No empty tracked directories exist.
