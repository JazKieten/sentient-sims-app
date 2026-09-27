# Release 4.5 working folder (app side)

**Start here (2026-09-27):** the whole remaining 4.5 list is section 0 of
`sentient-sims-code/.claude/release-4.5/ACTION-PLAN-2026-09-23.md`. Rule: stream, autonomy and
dev code NEVER goes public (a packaged app's JS is readable and the PR is public source). For
the app that is: version 4.5.0; the tier split of map section I done like the mod's (a tier
manifest of the whole-file STREAM/AUTONOMY/DEV entries, seams in the mixed files, and a strip
check that deletes the manifest paths and runs `tsc` + unit tests; the core app is built from
that stripped tree); a stream-only build flag (the four mod-install paths and electron-updater
off, distinct appId/productName); the AI exchange log kept in memory only in core, never written
to `ai_exchange`; the CLAUDE.md trim; the public-cut hygiene.

Started 2026-09-23, the same evening as the mod map. Goal: prepare `jasmine-phase-3` for release
as Sentient Sims 4.5 with ONE codebase and build-time tiers (no code fork). Read in this order:

1. `COMPONENT-MAP-2026-09-23.md`: the condensed map of the whole app at `62b9bad`, sections
   0–K, every file classified CORE / AUTONOMY / STREAM / DEV / KILL, the split list (section I),
   bugs by severity (J) and where this map disagrees with the mod map (K). Start every release
   session here; do not re-derive the classification.
2. `sections/01..08-*.md`: the eight raw Opus section reports the map was condensed from, with
   file:line for every cut. Use them when doing the surgery.
   - 01 transport, lifecycle, controllers, clients, routes, websocket inventory, settings by tier
   - 02 generation, prompts, providers (the leak, the interaction trace, degradation without state)
   - 03 memory, fact store, migrations, models, everything that crosses the mod boundary
   - 04 cognition, autonomy, bench, util/ (the five questions, push contract)
   - 05 voice, scenes, push-to-talk, Twitch (playback timeline, PTT end to end)
   - 06 images, paintings, every mod-download path, the app self-updater
   - 07 renderer (pages, settings UI by tier, IPC/HTTP tables, auth, dead code)
   - 08 git baseline, build + CI, tests, docs, public-cut hazards

The decisions, the action plan and the mod map live in the mod repo:
`sentient-sims-code/.claude/release-4.5/{ACTION-PLAN-2026-09-23.md, COMPONENT-MAP-2026-09-23.md,
RELEASE-NOTES-FOR-FUTURE-SESSIONS-2026-09-23.md}`.

Nothing in the app repo was changed by the mapping session other than adding this folder
(and one `git fetch upstream --tags`, refs only).
