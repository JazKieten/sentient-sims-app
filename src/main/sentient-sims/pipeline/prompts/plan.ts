// Stage: consolidation_plan (AUTONOMY tier, release 4.5) — the sleep boundary's diary call
// doubles as the nightly planner: the goal review plus tomorrow's goals, loadout and
// persona, around the core diary rules. Also the lazy mid-day plan. Moved verbatim from
// consolidation.ts, where they were written from AIService.runSceneReflection and
// DailyPlanService.
import { buildDiaryRules, buildReflectionFraming, ReflectionPromptContext } from './consolidation';

export type ConsolidationPromptContext = ReflectionPromptContext & {
  // The goal pool, today's plan, age gating and lot affordances, already rendered
  choicesBlock: string;
  // "About you: ...\nYour traits: ...\n", already rendered; empty when unknown
  aboutLine: string;
  // Whether today had goals to review
  hasTodaysGoals: boolean;
  loadoutSize: number;
};

// G-6: goals and loadout come BEFORE the diary in the schema — the diary is the long field
// and used to squeeze the trailing ones out at the token cap (6 of 6 sleep rows came back
// with goals: []). The diary stays required and the degrade path is intact.
export function buildConsolidationSystemPrompt(context: ConsolidationPromptContext): string {
  const { identity, choicesBlock, aboutLine, hasTodaysGoals, loadoutSize } = context;
  const framing = buildReflectionFraming(context);
  const diaryRules = buildDiaryRules(context);
  const reviewInstruction = hasTodaysGoals
    ? `\n- "goal_review": a verdict for each of today's goals — honestly, from the notes.`
    : `\n- "goal_review": [] (you had no goals set today).`;

  return `${identity}${framing} Before sleep you also set intentions for tomorrow.
${aboutLine}${choicesBlock}

Reply with ONLY a JSON object, fields in this order:
{"goal_review": [{"id": "<goal id>", "verdict": "met|partial|ignored"}], "goals": ["<goal id>"], "loadout": ["<action key>"], "persona": "one sentence", "diary": "the diary entry"}${reviewInstruction}
- "goals": 1 or 2 ids for TOMORROW, chosen ONLY from GOAL OPTIONS (copy the id exactly). Prefer goals that list [serve it with] verbs.
- "loadout": exactly ${loadoutSize} action keys chosen ONLY from ACTION STYLES — the activities and ways of relating you'll reach for tomorrow. It MUST include the verbs that serve the chosen goals.
- "persona": one short first-person sentence in the PRESENT tense (it is read during that day, so never start with "Tomorrow") — who you want to be (your character for the day, not a task).
- "diary": ${diaryRules.replace(/\n/g, ' ')}`;
}

// The lazy mid-day plan: a Sim who woke without a plan sets intentions for the rest of
// today. Moved verbatim from DailyPlanService.
export function buildLazyPlanSystemPrompt(loadoutSize: number): string {
  return `You are the inner voice of one Sim in The Sims 4, setting intentions for the rest of today.
Reply with ONLY a JSON object:
{"goals": ["<goal id>"], "loadout": ["<action key>"], "persona": "one sentence"}
- "goals": 1 or 2 ids chosen ONLY from GOAL OPTIONS — what this Sim genuinely cares about finishing today. Prefer goals that list [serve it with] verbs.
- "loadout": exactly ${loadoutSize} action keys chosen ONLY from ACTION STYLES — the activities and ways of relating this Sim will reach for today. It MUST include the verbs that serve the chosen goals.
- "persona": one short first-person sentence of stage direction — who this Sim wants to be today (their character, not a task).`;
}
