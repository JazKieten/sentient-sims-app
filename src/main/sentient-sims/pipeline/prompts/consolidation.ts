// Stages: consolidation_reflect and consolidation_plan — the sleep boundary.
//
// One call does both jobs when the boundary is sleep: the diary entry that closes the day,
// and the goal review plus tomorrow's goals, loadout and persona. Without a plan context it
// degrades to the diary alone. Moved verbatim from AIService.runSceneReflection and
// DailyPlanService's lazy mid-day plan.

export type ReflectionPromptContext = {
  // "You are Alice. " — empty when the reflection has no point-of-view Sim
  identity: string;
  // What kind of boundary closed this stretch of the day
  boundary?: 'sleep' | 'travel';
  locationName: string;
  // The other Sims present, rendered as "Bob and Carol"; empty when the Sim was alone
  namesList: string;
  hasOthers: boolean;
};

// The diary half of the prompt, shared by the diary-only and the diary-plus-plan shapes.
export function buildDiaryRules(context: ReflectionPromptContext): string {
  const othersLine = context.hasOthers
    ? `Mention each of the people you spent this time with — ${context.namesList} — what passed between you and how they left you feeling.\n`
    : '';
  return `Write a short diary entry — two or three sentences in your own voice: first person, past tense, plain prose. No headers, no labels, no lists, and no greeting like "Dear Diary" — just the entry itself. Never refer to yourself in the third person.
Sum up what happened and how you feel about it now.
${othersLine}Keep it concise and grounded. Do not invent events that are not in the notes below.`;
}

export function buildReflectionFraming(context: ReflectionPromptContext): string {
  const { boundary, locationName } = context;
  if (boundary === 'sleep') {
    return `The day is winding down at ${locationName} and you're writing in your diary before sleep.`;
  }
  if (boundary === 'travel') {
    return `You've just left ${locationName} and are writing in your diary about your time there.`;
  }
  return `A stretch of your day at ${locationName} has ended and you're writing it down in your diary.`;
}

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

export function buildDiaryOnlySystemPrompt(context: ReflectionPromptContext): string {
  return `${context.identity}${buildReflectionFraming(context)}
${buildDiaryRules(context)}`;
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
