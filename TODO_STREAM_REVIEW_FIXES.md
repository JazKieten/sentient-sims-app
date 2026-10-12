# Fixes from the Sep 21 stream review

Found while reviewing Jasmine's Twitch stream of 2026-09-21 (18:38–22:21 UTC): her
`ai_exchange` table, the mod log and `config.json`. The cost report is the artifact
"Jasmine's Stream AI Bill". Figures below cover the part of the stream still in
`ai_exchange` (19:02–22:14 UTC, 5,000 LLM calls). Full findings and the analysis scripts:
`sentient-sims-code/.claude/sentience-phase-3/HANDOFF-JASMINE-STREAM-REVIEW-2026-09-22.md`.

## 1. Director Review fixes are dropped when the reviewer numbers lines `1:`

**Status:** open, fix known.

The reviewer is told to return the delivered lines numbered `1.`, `2.`, … and sometimes
writes `1:` instead. `parseReviewedLines` in `src/main/sentient-sims/services/AIService.ts`
only strips `1.` and `1)`:

```ts
cleanupAIOutput(rawText.replace(/^\s*\d+[.)]\s+/gm, ''))
```

A `1: Jonah Alder: …` line then matches no speaker, `reviewedLines` comes back empty,
`useReviewerCut` is false, and the actors' uncorrected lines air. Nothing is logged except
`Final cut: actors' original lines`.

On the stream the reviewer rewrote 16 of 668 reviews, almost all fact-check repairs, and only
8 of those fixes aired. **5 of the 8 lost ones were this bug**, including:

- "I know I've let you down, **Alex**" (said to the Conscience; the fix named the Conscience)
- "I'm worried about **Mom and Dad**" (Ehren's parents are Jonah and Alex)
- "No, **he** needs stability here at home" (the fix named Ehren)
- "**Kassandra**, obviously" (the fix added "Ehren's friend")

**Fix:** accept `:` as a number delimiter: `/^\s*\d+[.):]\s+/gm`. Add a test in the
parseReviewedLines / directed-scene tests for a `1: Speaker: text` reply, and one for a
reply where the speaker names are also mangled (`1 **: text`, seen once on the stream),
which should still fall back to the actors' lines.

## 2. Three correctly formatted reviewer fixes still didn't air

**Status:** open, cause unknown.

The reviewer returned a properly numbered fix, but the original line aired a few seconds
later. Examples: "tough **divorce**" → "tough split" (21:49:51 UTC), "How was your day,
**Mom**?" → "…, Vesper?" (22:07:53), "after **Mr Alder's** cooking" → "Jonah's" (20:27:44).
Several scenes were generating in parallel each time. Jasmine's app `main.log` would show
which cut each scene used (`[Pipeline] Final cut: …`); get it from her before guessing.

## 3. `generationTimeoutSeconds` doesn't bound OpenRouter calls

**Status:** open, hypothesis untested.

A Director Briefing ran 302 s (finished 21:44:43 UTC) and an Action Options call ran 39.9 s
(21:34:46), with the timeout set to 60 s. The timeout is set on the OpenAI client
(`OpenAIService.ts`). Likely cause: OpenRouter sends headers straight away and keeps the
connection open while the provider stalls, and the SDK's timeout stops counting once
headers arrive. Confirm, then add an overall deadline (e.g. an `AbortSignal.timeout` on the
request) so a call can't outlive the setting.

## 4. The app can't report its own AI spend

**Status:** open.

`ai_exchange` stores no token counts, cost or provider, and prunes to ~5,000 rows (the first
24 minutes of a 3 h 43 m stream were already gone). OpenRouter returns `usage.cost` and the
serving provider on every response. Store them per call, and consider a longer retention
for rows, or a per-session summary that survives pruning.

## 5. Director Briefing is 40% of LLM cost

**Status:** open, needs a design decision.

703 briefings averaged ~3,300 input tokens, re-sent about every 5 s during a scene (≈ $1.46
of ≈ $3.65 logged). 510 of the 703 overflowed their 3,400-token prompt budget and were
trimmed. Look at trimming or caching the director prompt.

## 6. 22% of generated actor lines never aired

**Status:** open, cause probable.

1,153 actor-line generations; 894 appear in the mod log. The other 259 were probably
prefetched rounds discarded when a scene ended (`prefetchMaxQueueDepth` = 2). Check whether
prefetch depth is worth what it costs.
