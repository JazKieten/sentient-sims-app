# Sentient Sims — everything on `jasmine-phase-2` since the last PRs (for Gus, 2026-08-27)

You asked which `sentient-sims-code` and `sentient-sims-app` branches to pull. Both repos,
same branch name:

| repo | branch | tip | contains |
|---|---|---|---|
| `Scott-Bott/sentient-sims-app-lab` | `jasmine-phase-2` | `364ad3b` | your `main` v4.0.8 + everything below |
| `Scott-Bott/sentient-sims-code` | `jasmine-phase-2` | `47da1cb` | your `main` v4.0.8 + everything below |

Both branches merged your v4.0.8 this week and are **0 commits behind your `main`** — your
kokoro casting, paintings, resizable font and auth fix are all in. You have write access on
both repos, so pull directly; no PR needed unless you want one.

The last thing we sent you was **PR #37** (app: ElevenLabs voices, directed scenes, memory
retrieval — you merged it with 3.28.9) and **PR #43** (mod: subtitles UI, prefetch lifecycle,
focus-handler fix) on 2026-08-10. Everything below landed since then: roughly 80 app commits
and 145 mod commits, all playtested live on Jazki's machine over ~15 sessions.

---

## 1. Full Autonomy — sims run their own lives (the big one)

The centerpiece. With `cognitionEnabled` on, every sim gets a private tick loop that
perceives, deliberates, and acts — no player interaction required.

**App side (`CognitionService` + friends):**

- **Per-sim tick loop** — budgeted (`cognitionPerSimHourlyBudget`), concurrency-capped
  (`cognitionMaxConcurrent`, default 2), hard 45s timeout per model call, LLM retry with
  one-shot success suppression. Rule-based fast path for critical needs (bladder/hunger
  below −85 skip the model entirely).
- **Action Scenes** — instead of a bare "sim decides to do X", a tick that scores high
  enough (`cognitionActionScoreThreshold`) stages a directed scene: inner monologue,
  dialogue, and the action, written by a Director/Manager/Reviewer pipeline. Group scenes
  keep every speaker (a trio talks as a trio, capped at 8). Scenes can continue themselves
  for up to `sceneMaxRounds` rounds when the scorer says "unfinished".
- **Daily plans** — each night a sim picks goals from the game's own objective pool, gets a
  persona sentence, and a D&D-style "action loadout" of discretionary verbs for the day.
  Goals render with the verbs that serve them, and the loadout force-includes goal-serving
  keys. Overnight plans key to the day the sim wakes into.
- **Reflections** — first-person short diary entries, framed by what just ended; a sim's
  monologue, cognition thoughts, and reflections are private per-sim memories.
- **Guardrails everywhere** — autonomy-echo guard (don't "decide" to do what autonomy
  already started), suppression windows after failures, transient-only retry policy,
  stuck-goal callouts, never interrupting player-queued actions, too-tired sims lose
  `go_out`, visiting sims never get travel verbs, romance and teen-plus socials age-gated
  on *both* sides, failing closed.

**Mod side (the action substrate that makes it real):**

- **61-verb affordance whitelist** (was 27 at PR #43) — care, social, household, skill,
  venue and travel verbs, each with variants, fallbacks, target conditions
  (`hire_repair_service` targets a provider that is actually BROKEN), mixers-on-objects,
  and instant-outcome flags. `WHITELIST_VERSION` is an auto-hash so the app can detect
  drift. First INFANT/TODDLER coverage: `feed_infant`, `change_infant_diaper`,
  `put_infant_to_nap`, `talk_to_toddler`, `hug_toddler`, `comfort_toddler` — tuning names
  verified against the running build's InstanceManager.
- **Perception v2** — tiered scene snapshots; lot state (dirty objects, broken-state track
  only, abandoned plates count as mess, fresh half-full plates don't); public venues promote
  earshot sims to same-room; on-lot NPCs and off-lot household sims reported; target ages
  reported so gating can happen app-side; per-sim age-blocked verb lists read from the
  game's own tests.
- **State reporting** — 5-second sim state reports (activity, motives, `is_active`), a
  `CLOCK_STATE` websocket message on every speed change with `paused_by: mod|user`, and
  pause ownership read off the game's own stack.
- **Outcome honesty** — every push gets a real outcome: finishing callbacks, an orphan
  sweep that distinguishes "never started" from "started then cut off", a failure
  classifier that humanizes reasons (and sanitizes unclassified Python exception text), a
  game-thread drain alarm, `cancel_interaction` support so app timeouts cancel the
  game-side push, and `PUSHDIAG` logging on every dispatch stage for debugging.

## 2. The player has a voice — literally

- **Hold-to-talk mic input** (`voiceInputEnabled`): a hotkey (hold or toggle) captures the
  mic, transcribes via any OpenAI-compatible `/audio/transcriptions` endpoint (Whisper),
  and the words land in-game — holding pauses the game, releasing unpauses. STT gets a
  name dictionary + fuzzy correction so sim names survive transcription.
- **The player persona** (`playerVoicePersona` + bio): who the player *is* when they speak
  — "The Voice" by default, or a guardian angel, or anything. Solo voice chat works on a
  lone sim through the directed pipeline; hotkey+click locks a specific chat partner.
- **Voice commands** (second hotkey): speech is an *order*, dispatched through the offered
  action vocabulary instead of spoken dialogue.
- **Playback follows the game clock** (`playbackFollowsGameClock`): a user pause holds
  audio and the scene queue; speeds 2/3 raise the playback rate. The player's own voice
  pre-empts running playback.

## 3. Twitch integration — viewers talk to the sims

New in the last week, live-tested on stream 08-24/08-26.

- **`!ask`** (`twitchChatEnabled`): viewers type `!ask how are you?` in the streamer's
  Twitch chat and the active sim answers **aloud** — subtitle, TTS, and memory all ride
  the player-voice pipeline. `!ask lillie how's the baby?` targets Lillie by name (fuzzy
  phonetic match, full-name-first so siblings never collide; ambiguous falls back to the
  active sim and logs the roster). Connection is anonymous read-only IRC — no login needed.
- **Questions can be spoken too** ("Give chat a voice"): the viewer's typed question is
  read aloud in a dedicated ElevenLabs chat voice before the sim replies.
- **Gating**: everyone/subs/mods permission, per-viewer + global cooldowns, queue cap,
  length cap + sanitizer, and an optional followers-only gate backed by a device-code
  OAuth login against the streamer's own Twitch app (public client, no secret stored).
  Questions queue FIFO, paced one at a time keyed to actual generation completion.
- **Ask-actions** (`askActionsEnabled`): a Voice or Twitch line that's a *request to do
  something* ("go cook dinner!") is triaged, the sim answers yes-or-no **in character**,
  and an accepted ask dispatches through the real action vocabulary — preempting the sim's
  queued *and* running actions on the mod side.
- Viewers get credited in the in-game memories window ("Chat (viewer, to Jonah)") —
  display-only; stored rows keep clean speakers.
- **Sim aliases** (`Name=simId`): service NPCs the game reports namelessly ("Sim 153…")
  become addressable — chat can `!ask grim reaper` and the pinned voice still applies.

## 4. The in-game overlay grew up (ImGui dll, `ui/`)

Since PR #43's v1 subtitles the overlay became a full UI layer:

- **Memories window as a script**: consecutive lines stack into speaker blocks behind
  round portraits (the game's own thumbnails, cropped and circle-masked, cached), per-sim
  stable name colors, spoken lines bold white, **thoughts arrive live in italics** as sims
  think them (never subtitled, never pausing), narration centered between rules. Click any
  line to edit/forget/retry/continue that memory. State survives script hot-reload.
- **Chat, Do Something, Location, Sim Description, and Settings windows** — all in-overlay,
  all driven over the same bridge protocol.
- **Scaling**: Text Size and Subtitle Size to 500% (three font bakes, stays crisp) plus a
  separate overall UI Scale; "Show Subtitles With Memories Window" setting (Scott's, this
  week); mouse-wheel scrolls lists without zooming the game camera underneath (wheel
  deltas queued across threads so notches stop dropping).
- **Reliability**: every off-thread push marshalled onto the game thread; startup grace so
  the overlay isn't declared unavailable while still loading.
- `ui/prebuilt/ss_overlay.dll` on the branch is CI-built (`ui/build.sh`, mingw cross) from
  the exact merged sources.

## 5. Hardening from ~15 live playtest sessions

Every autonomy feature above was driven in long live sessions (there are tick-by-tick
director logs in `.claude/sentience-phase-2/` if you want the evidence trail). The three
findings from the 08-26 session, all fixed this week:

- **Participant naming (A)** — first-name keying mis-attributed real *actions* between
  sims sharing a first name (an infant kept getting credited with an adult's `go_out`).
  Now: monologue maps keyed by `sim_id`, scene-score remaps require exactly one match
  before arming, the participant DB never persists a placeholder name over a real one, the
  mod has one canonical `display_name()` chain (first+last → full_name → NPC career label
  → `Sim <id>` last), and voice casting prefers exact over prefix and casts *nobody* on
  ambiguity rather than first-in-list.
- **Starved rescues (B)** — a feed push queued behind a running craft/skill interaction
  was invisible to every outcome path; hunger fell for a day while everything reported
  success. Now a stuck-push watchdog reports honest `canceled` outcomes with a
  `blocked_by` flag the app honors (holds re-dispatch until clear), plus an off-by-default
  gated escalation that can cancel the blocking interaction for sub-−85 needs (only if
  mod-pushed or autonomy-sourced — never a player action).
- **Infant/toddler gap (C)** — the six new whitelist verbs above, so babies stop being
  invisible to autonomy.

Plus dozens of smaller ones: `grab_snack` self-cancel loop merged into a running food
chain, despawned sims never polled or canceled, `auto_respond_dialogs` asserted both
directions, TTS `stop()` settling its promise, chat replies jumping the playback queue,
directed scenes never airing a line the actor wrote for someone else, the updater's
version *check* never installing.

## 6. Dev tooling you might actually want upstream

- **AI exchange log** (app page): every LLM request/response inspectable with timing and
  token counts.
- **Memory trace viewer**: pick a memory, see the full pipeline of how it came to be.
- Log archiving (25MB × 10), `PUSHDIAG`, a self-running push battery for the mod's
  dispatch paths, repair-memories one-liner.

## 7. State of the tree (honest edition)

- **Mod**: 517 pytest, all green. The CI pylint *cyclic-import* gate is red — five cycles
  pre-existing on this branch since before 08-23, two new ones from the watchdog module;
  runtime is unaffected (in-function imports), cleanup owed.
- **App**: `tsc` clean, vitest green except the two `Api` tests that need AWS credentials
  (they pass with `AWS_PROFILE=sentientsims`). ESLint repo-wide has a known pre-existing
  backlog on this branch; touched files are kept clean.
- **One heads-up from the v4.0.8 merge**: our merge briefly dropped chat_window.cpp's
  `overlay_ui.h` include (your 4.0.7 resizable-font sizing calls `OverlayUiScale()` there);
  fixed in `d62919f`. Your `main` is fine.
- Everything 64-bit-id-sensitive still treats ids as opaque strings end to end; only the
  SQLite layer touches integers.

## 8. Pulling it

```
git fetch <remote> jasmine-phase-2
git checkout jasmine-phase-2
```

App needs an `npm install` (uiohook-napi for the voice hotkeys, plus lockfile changes).
The mod's overlay dll ships prebuilt on the branch; `ui/build.sh` / `ui/build_mac.sh`
rebuild it from source if you'd rather.

Questions → Jazki or Scott. The deep-dive docs live in the mod repo under
`.claude/sentience-phase-2/` — `PROGRESS.md` is the index, `HANDOFF-TO-SCOTT-2026-08-25.md`
is the most complete single description of the current architecture.
