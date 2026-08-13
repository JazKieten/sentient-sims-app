# CognitionService tick loop — roadmap block #4 (the autonomy leap)

## Context

Jazki streamed Claude playing the Sims via the Sentient Sims app and asked for an honest retro:
performance as "the voice" was lacking in specific, diagnosable ways, and those failure modes are
the design spec for the next build. Today, moment-to-moment autonomy is Claude driving one scene at
a time through MCP/API calls — a bottleneck impersonating sentience. The fix is roadmap build-order
item #4 (`plans/SENTIENCE_ROADMAP.md` §1, §8): a per-Sim **CognitionService ticker** in the Electron
app that continuously runs perceive → retrieve → deliberate → act → observe for every Sim on the
active lot, at machine cadence.

Everything upstream is already built and live-verified: the 27-action whitelist + enqueue pipeline
(`/cognition/debug/enqueue` → mod push), perception snapshots (§1.5, `ss_perception.py` +
`/cognition/perception`), memory retrieval (embeddings + `<RELEVANT_MEMORIES>` block), and outcome
reporting back to `/cognition/outcome`. The tick loop is the piece that closes the loop without a
human (or Claude) in it.

## Design requirements distilled from the streaming retro (failure modes → guardrails)

These are non-negotiable behaviors of the tick loop, each traced to an observed failure:

1. **Intent lifecycle awareness** — while a sim's intent is in-flight (queued/routing/running), the
   ticker must NOT issue a new intent for that sim. Re-pushing cancels the walk and resets routing
   from zero (the Adrian/DJ-booth incident). Outcome reports (`/cognition/outcome`) close the
   in-flight state; a generous timeout (~distance-aware) handles lost outcomes.
2. **"Continue what you're doing" is a first-class, default-biased action** — the tick prompt shows
   current activity + mood; a happy sim mid-activity should usually be left alone (the
   cancelled-dance → bored incident). Deliberation only escalates to a new intent on idle, stuck,
   unmet need, or plan/want pull.
3. **Perception must include object states** — `Broken*`/`Dirty*` etc. in the snapshot so root
   causes are perceivable ("the sink is leaking") instead of narrated as character (the six-day
   mopping saga). Safety in the vocabulary: no self-repair of electrical objects without handiness
   (the electrocution/kitchen-fire incident); prefer a hire-repair-service action.
4. **Wants / aspiration objectives / career daily tasks feed deliberation** — the long-horizon
   layers Claude kept forgetting. At minimum, current wants in the tick prompt.
5. **Real social graph in prompts** — name actual acquaintances so the model stops inventing people
   (the "DJ Luna" hallucination). Targets must be chosen from the perception snapshot (already the
   §1.5 design).
6. **Outcome memories** — the sim learns whether the thing it tried worked; failures (route-fail,
   cancel) are memories too, not silent retries.
7. **Scene deconfliction** — a sim actively in a directed scene / conversation is not ticked into a
   competing intent.
8. **Ops** — cheap model for ticks, big model for scenes/reflections; priority channels
   speech > cognition > reflection; everything behind an autonomy settings toggle
   (off / suggest-only / full); active-lot sims only, throttled.

## Current-state findings

*(to be filled from app + mod exploration)*

## Implementation plan

*(to be filled after Plan agent design pass)*

## Verification

*(to be filled — headless drive via dev exec server + live playtest checklist)*
