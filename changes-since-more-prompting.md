# Changes since `more_prompting`

Covers both repos on the `sentience-phase1` branch: **sentient-sims-app** (28 commits since `more_prompting`) and **sentient-sims-code** (17 commits vs `develop`).

## Summary

### sentient-sims-app (28 commits)

**Sentience roadmap core (cognition + memory):**
- Added an action dispatcher and cognition outcome capture — the app can now push interactions into the game and record what happened.
- Receives and renders mod perception snapshots (with small polish like labeling TVs as "a tv" in perception prose).
- Memory pipeline (roadmap Blocks 4–6): memories get annotated with importance scores and embeddings, retrieved by recency/importance/similarity, and wired into prompts as `<RELEVANT_MEMORIES>`. Annotation was later moved to an idle lane on the generation queue so it doesn't block generation, plus an offline backfill script that rates historical memories with gpt-4.1-nano.

**Scene/conversation behavior:**
- In-game chat now routes through the directed scene pipeline.
- Group scenes favor the player sim as partner in NPC-initiated beats, rotate partners in group conversations, and a group-event relationship crash was fixed.

**Stability and playtest fixes:**
- Fixed duplicate DB loads, stale annotation writes, and doubled scene TTS; outcome rendering, degenerate pre-action, and TTS logging fixes; content-less memories now get display text so the in-game memory window renders.

**Providers and features (mostly merged in from main, releases 3.28.0–3.28.4):**
- Multi-provider AI support — named provider configs with per-action overrides — reconciled with the sentience work in a merge commit, plus OpenRouter as a dedicated provider with curated uncensored models.
- ElevenLabs voice pinning per sim, model dropdown fix, online interactions/animations loading, forced Google account selection, deletion support, and macOS build/notarization changes.

### sentient-sims-code (mod, 17 commits vs `develop`)

**App-driven interactions:**
- `enqueue_interaction` websocket listener so the app can push interactions, an affordance whitelist with action keys and staged mixer pushes, and outcome reporting back to the app — including canceled outcomes for pushes that never produce an interaction.

**Scene playback and perception:**
- Prefetch lifecycle, eligibility filtering, and paced scene playback with a subtitles UI (v1 stable).
- Tiered perception scene snapshots (roadmap 1.5) sent to the app.

**Group conversation pacing:**
- A run of tuning commits: player chats undamped, NPC side chatter allowed and able to carry beats through lulls, mirrored social events deduped, and pacing dials tightened for continuous group scenes.

**Fixes/tooling:** game-thread marshaling, perception hygiene, `exec_c` working on the Windows game process, guarding `local/mcp.py` from in-game import, and roadmap bookkeeping commits marking Blocks 4–6 as built.

**In short:** the two branches together implement the sentience roadmap through Block 6 — perception snapshots flow from mod to app, the app runs cognition and pushes directed interactions/scenes back, memories are annotated/retrieved/injected into prompts — followed by a wave of playtest-driven pacing and stability fixes, with main's multi-provider work merged in along the way.

## Commit-by-commit (few words each)

### sentient-sims-app

- `46b8bd5` — offline script to backfill memory ratings
- `e900a8f` — memory window renders content-less memories
- `f967dec` — in-game chat uses scene pipeline
- `0367c0e` — pin ElevenLabs voice per sim
- `8d2d971` — player sim favored in group beats
- `d131f66` — group crash fix; partner rotation
- `da2e45f` — playtest fixes (outcomes, pre-actions, TTS logs)
- `e902558` — memory annotation runs when idle
- `75315b9` — merge main (multi-provider) into branch
- `0d1daca` — OpenRouter provider added
- `14f45a4` — fix duplicate loads, stale writes, doubled TTS
- `3bd5966` — memories injected into prompts (Block 6)
- `70010e8` — relevant-memory retrieval (Block 5)
- `521b4e4` — memory importance + embeddings (Block 4)
- `0993fe8` — TVs labeled "a tv" in perception
- `b041bfa` — receive/render perception snapshots
- `4aaea94` — action dispatcher + outcome capture
- `69d0b99` — 3.28.4: notarization change
- `3f2e550` — 3.28.3: universal macOS build
- `f76964f` — 3.28.2: mapping fix
- `d21d88f` — allow deletion
- `12a4065` — show "is ignored"
- `6bbc5cc` — load online interactions/animations
- `b9c35f2` — force Google account selection
- `b14fe1d` — 3.28.1: model dropdown fix
- `c264f5c` — 3.28.0 release
- `0894992` — multi-provider support
- `d0eb4e5` — multi-provider AI setup

### sentient-sims-code

- `c9cf5c3` — tighter group pacing dials
- `3c8ea30` — side chatter carries beats through lulls
- `38cf2a7` — player chats undamped; NPC chatter allowed
- `9bed5ce` — dedupe mirrored socials; idle convos flow
- `9dedc87` — playtest fixes (threading, outcomes, perception)
- `af47b51` — report canceled push outcomes
- `541ef04` — guard mcp.py from in-game import
- `f6073cb` — mark Block 6 built
- `e2acf06` — exec_c works on Windows
- `df00d20` — mark Block 5 built
- `04a3b1b` — mark Block 4 built
- `3af93d0` — tiered perception snapshots (1.5)
- `881ff21` — report pushed-interaction outcomes
- `d964804` — affordance whitelist + mixer pushes
- `00ba36d` — enqueue_interaction websocket listener
- `b4a1e19` — prefetch, eligibility filter, paced playback
- `b1e672f` — subtitles UI for paced scenes
