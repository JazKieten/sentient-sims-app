// Builds the deliberation prompt for one cognition tick. The offered vocabulary is
// restricted to what the snapshot actually contains (perception vocabulary == action
// vocabulary), and every policy rule that can be enforced in code is enforced in code —
// the preamble only carries the judgment calls a model has to make.

import { SimStateEntry, SimStateReport } from '../models/SimStateReport';
import { formatPerception } from './formatPerception';
import { offeredActions, SimTargetInfo, SOCIAL_ACTIONS } from '../models/CognitionIntent';

function pretty(text: string): string {
  return text.replace(/_/g, ' ');
}

// Socials the model should only aim where the relationship supports them; annotated in
// the offered list, enforced by the game's own relationship tests at push time
const ROMANTIC_SOCIALS = new Set(['flirt', 'kiss']);
const MEAN_SOCIALS = new Set(['insult']);

// Relationship bits the game names in ways worth repeating verbatim (married, engaged,
// enemies...) read badly raw — keep only the recognizable word
function prettyBit(bit: string): string | undefined {
  const lowered = bit.toLowerCase();
  // SocialContext_* bits are transient conversation-tone states (every casual
  // acquaintance carries Awkwardness_Casual), not relationship lore — never render them
  if (lowered.includes('socialcontext')) {
    return undefined;
  }
  for (const word of ['married', 'engaged', 'enem', 'unfaithful', 'awkward']) {
    if (lowered.includes(word)) {
      return word === 'enem' ? 'enemies' : word;
    }
  }
  return undefined;
}

// "Nancy Landgraab (sim_id 123, friend, a romantic spark)" — the lore layer that lets a
// social pick match the relationship (get_to_know a stranger, flirt at a spark, not both)
function describeTarget(simId: string, target: SimTargetInfo): string {
  const parts: string[] = [`sim_id ${simId}`];
  if (!target.hasMet) {
    parts.push('a stranger — chat to break the ice');
  } else {
    const friendship = target.friendship ?? 0;
    if (friendship >= 50) {
      parts.push('a good friend');
    } else if (friendship >= 15) {
      parts.push('a friend');
    } else if (friendship <= -15) {
      parts.push('on bad terms with you');
    } else {
      parts.push('an acquaintance');
    }
    const romance = target.romance ?? 0;
    if (romance >= 40) {
      parts.push('romantic');
    } else if (romance >= 10) {
      parts.push('a romantic spark');
    }
    const bits = (target.bits ?? []).map(prettyBit).filter((bit): bit is string => Boolean(bit));
    parts.push(...new Set(bits));
  }
  return `${target.name ?? 'someone'} (${parts.join(', ')})`;
}

// ---------------------------------------------------------------------------
// Full Autonomy prompts. The game engine is the fast brain: sims keep doing what
// they are doing. The tick pipeline is Monologue -> Scores; only an action score
// over the threshold stages an Action Scene (a choose-your-own-adventure beat with
// options bound to the OFFERED vocabulary). The old one-shot "decide what to do"
// deliberation prompt is retired.
// ---------------------------------------------------------------------------

export const TICK_MONOLOGUE_SYSTEM_PROMPT = `You are the private inner voice of one Sim in The Sims 4.
Given their situation, reply with ONLY one or two short sentences of the Sim's inner monologue right now — first person, present tense, in their own voice, grounded in what they are doing, feeling, and wanting.
Nobody hears this. No narration, no third person, no JSON, no quotation marks.`;

export const TICK_SCORES_SYSTEM_PROMPT = `You are scoring one Sim's present moment, judged from their own point of view. Their inner monologue is the strongest signal.
Reply with ONLY a JSON object: {"memory": <1-10>, "action": <1-10>, "action_reason": "one short line"}
- "memory": how memorable this moment is for them. 1 means routine and forgettable, 10 means life-changing.
- "action": how strongly they want to CHANGE what they are doing right now — something more, something less, or something different. 1-3 means content to carry on, 4-6 means an itch but nothing urgent, 7 and up means they genuinely want to act on something now. A content Sim mid-activity scores low; boredom, loneliness, low needs, and restless thoughts push it up.
- "action_reason": what they would want to do or change, in their voice.`;

export const ACTION_OPTIONS_SYSTEM_PROMPT = `You are directing a choose-your-own-adventure beat for one Sim in The Sims 4 who wants a change of course.
Given their situation, their inner monologue, and what is pulling at them, reply with ONLY a JSON object:
{"scene": "one or two sentences framing the moment, second person", "options": [{"action": "<action key>", "target_sim_id": "<id, only for social actions>", "target_object_id": "<id, only if shown for that action>", "label": "the choice as the Sim would think it, one short line"}]}
Rules:
- 3 to 5 options, each a genuinely different answer to the pull — more of something, less of something, or something new. No filler.
- Every "action" MUST be an action key from the OFFERED lists in the situation; social actions need a target_sim_id from the OFFERED people. Never invent actions, targets, or ids.
- At least one option should directly answer what is pulling at them.`;

export const ACTION_CHOICE_SYSTEM_PROMPT = `You are one Sim in The Sims 4 choosing what to do next, like picking a path in a choose-your-own-adventure book.
Given the moment and your numbered options, reply with ONLY a JSON object: {"choice": <option number>, "motivation": "why, in your own voice, one short line"}
Choose as the character: mood, needs, wants, and your inner monologue decide — not what would look sensible to someone else.`;

export const ACTION_REVIEW_SYSTEM_PROMPT = `You review a Sim's chosen next action for obvious mistakes before it executes.
Given the situation, the numbered options, and the Sim's choice, reply with ONLY a JSON object: {"choice": <option number to execute>}
DEFAULT TO THE SIM'S OWN CHOICE. Override to a different option only on a clear mistake: the choice ignores a DESPERATE need, repeats something that just failed, or is wildly wrong for the relationship or the hour. Reply {"choice": 0} only when every option is clearly wrong and the Sim should simply carry on as they are.`;

function clampScore(value: unknown): number | undefined {
  const num = typeof value === 'string' ? Number(value) : value;
  if (typeof num !== 'number' || Number.isNaN(num)) {
    return undefined;
  }
  return Math.min(10, Math.max(1, Math.round(num)));
}

function firstJsonBlock(raw: string): unknown {
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) {
    return undefined;
  }
  try {
    return JSON.parse(match[0]) as unknown;
  } catch {
    return undefined;
  }
}

export type TickScores = { memory: number; action: number; reason?: string };

export function parseTickScores(raw: string): TickScores | undefined {
  const parsed = firstJsonBlock(raw);
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }
  const verdict = parsed as { memory?: unknown; action?: unknown; action_reason?: unknown };
  const memory = clampScore(verdict.memory);
  const action = clampScore(verdict.action);
  if (memory === undefined && action === undefined) {
    return undefined;
  }
  return {
    memory: memory ?? 3,
    action: action ?? 1,
    reason: typeof verdict.action_reason === 'string' ? verdict.action_reason : undefined,
  };
}

export type ActionOption = {
  action: string;
  target_sim_id?: string;
  target_object_id?: string;
  label?: string;
};

export function parseActionOptions(raw: string): { scene?: string; options: ActionOption[] } | undefined {
  const parsed = firstJsonBlock(raw);
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }
  const body = parsed as { scene?: unknown; options?: unknown };
  if (!Array.isArray(body.options)) {
    return undefined;
  }
  const options = body.options
    .filter((option): option is Record<string, unknown> => Boolean(option) && typeof option === 'object')
    .map((option) => ({
      action: typeof option.action === 'string' ? option.action : '',
      target_sim_id: typeof option.target_sim_id === 'string' ? option.target_sim_id : undefined,
      target_object_id: typeof option.target_object_id === 'string' ? option.target_object_id : undefined,
      label: typeof option.label === 'string' ? option.label : undefined,
    }))
    .filter((option) => option.action.length > 0);
  return { scene: typeof body.scene === 'string' ? body.scene : undefined, options };
}

export function parseActionChoice(raw: string): { choice: number; motivation?: string } | undefined {
  const parsed = firstJsonBlock(raw);
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }
  const body = parsed as { choice?: unknown; motivation?: unknown };
  const choice = typeof body.choice === 'string' ? Number(body.choice) : body.choice;
  if (typeof choice !== 'number' || Number.isNaN(choice) || choice < 0) {
    return undefined;
  }
  return {
    choice: Math.round(choice),
    motivation: typeof body.motivation === 'string' ? body.motivation : undefined,
  };
}

export function buildCognitionUserPrompt(
  entry: SimStateEntry,
  report: SimStateReport | undefined,
  memoriesBlock?: string,
  unavailableActions?: string[],
): string {
  const sections: string[] = [];
  const name = entry.sim_name ?? entry.sim_id;
  sections.push(`You are ${name} (sim_id ${entry.sim_id}).`);

  sections.push(formatPerception(entry));

  const self = entry.self;
  if (self) {
    const selfLines: string[] = ['<STATUS>'];
    if (self.mood) {
      selfLines.push(`Mood: ${pretty(self.mood)}`);
    }
    if (self.needs && Object.keys(self.needs).length > 0) {
      // Worst-first with the negatives flagged: fed in arbitrary order the model kept
      // topping up healthy needs (brush_teeth at hygiene 70) while fun sat at -47 and
      // social at -100 (observed live)
      const needs = Object.entries(self.needs)
        .sort(([, a], [, b]) => a - b)
        .map(([need, value]) => `${pretty(need)} ${value}${value <= -75 ? ' (DESPERATE)' : value < 0 ? ' (low)' : ''}`)
        .join(', ');
      selfLines.push(`Needs, WORST FIRST (-100 to 100): ${needs}`);
    }
    if (self.wants?.length) {
      selfLines.push(`Current wants: ${self.wants.map(pretty).join(', ')}`);
    }
    if (self.buffs?.length) {
      selfLines.push(`Feelings: ${self.buffs.map(pretty).join(', ')}`);
    }
    if (self.next_objective) {
      const objective = self.next_objective;
      selfLines.push(
        `Next life goal step: ${pretty(objective.objective ?? '')}${objective.test ? ` (${objective.test}${objective.threshold !== undefined ? ` ${objective.threshold}` : ''})` : ''}`,
      );
    }
    (self.careers ?? []).forEach((career) => {
      selfLines.push(
        `Career: ${pretty(career.career ?? '')} level ${career.level ?? '?'}${career.at_work ? ' (at work now)' : ''}`,
      );
    });
    selfLines.push('</STATUS>');
    sections.push(selfLines.join('\n'));
  }

  const activity = entry.activity;
  if (activity) {
    const doing = activity.running ? `You are currently: ${pretty(activity.running)}.` : 'You are idle right now.';
    const queued = activity.queue?.length ? ` Queued next: ${activity.queue.map(pretty).join(', ')}.` : '';
    sections.push(`${doing}${queued}`);
  }

  const lot = report?.lot;
  if (lot) {
    const lotLines: string[] = [];
    if (lot.clock?.hour !== undefined) {
      lotLines.push(`It is ${lot.clock.hour}:${String(lot.clock.minute ?? 0).padStart(2, '0')}.`);
    }
    if (lot.bills?.due) {
      const cut = lot.bills.shut_off?.length ? ` — ${lot.bills.shut_off.join(' and ')} already shut off` : '';
      lotLines.push(`Household bills of $${lot.bills.amount ?? '?'} are due${cut}.`);
    }
    const brokenThings = (lot.conditions ?? [])
      .filter((condition) => condition.conditions.some((tag) => tag !== 'dirty'))
      .slice(0, 5)
      .map((condition) => `${condition.name} (${condition.conditions.join(', ')})`);
    if (brokenThings.length > 0) {
      lotLines.push(`Something is wrong on the lot: ${brokenThings.join('; ')} — hire_repair_service fixes broken things.`);
    }
    // Dirty things get their own line — hidden from the prompt, the model never once
    // chose clean_up while the offered list carried it (observed live: filthy counter,
    // sim happily sitting around)
    const dirtyThings = (lot.conditions ?? [])
      .filter((condition) => condition.conditions.includes('dirty'))
      .slice(0, 5)
      .map((condition) => `${condition.name}`);
    if (dirtyThings.length > 0) {
      lotLines.push(`The place is getting gross — dirty: ${dirtyThings.join('; ')}. Choosing clean_up will clean it.`);
    }
    if (lotLines.length > 0) {
      sections.push(lotLines.join(' '));
    }
  }

  if (memoriesBlock) {
    sections.push(memoriesBlock);
  }

  const offered = offeredActions(entry, report?.lot?.action_keys);
  const objectList = [...offered.objectActions.keys()].map(pretty).join(', ') || '(none)';
  const simList =
    [...offered.simTargets.entries()].map(([simId, target]) => describeTarget(simId, target)).join('; ') ||
    '(no one)';
  sections.push(`OFFERED object actions: ${objectList}`);
  if (offered.lotActions.size > 0) {
    sections.push(`OFFERED household actions: ${[...offered.lotActions].map(pretty).join(', ')}`);
  }
  sections.push(`OFFERED people to talk to: ${simList}`);
  if (offered.simTargets.size > 0) {
    // The model can't name a social it was never shown — before this line existed every
    // conversation degraded to plain 'chat' (the vocabulary was validation-only)
    const plain: string[] = [];
    const romantic: string[] = [];
    const mean: string[] = [];
    SOCIAL_ACTIONS.forEach((action) => {
      if (ROMANTIC_SOCIALS.has(action)) {
        romantic.push(pretty(action));
      } else if (MEAN_SOCIALS.has(action)) {
        mean.push(pretty(action));
      } else {
        plain.push(pretty(action));
      }
    });
    sections.push(
      `OFFERED social actions (need a target_sim_id; match them to the relationship): ${plain.join(', ')}; romantic only: ${romantic.join(', ')}; mean: ${mean.join(', ')}.`,
    );
  }
  if (unavailableActions?.length) {
    // Negative feedback the model otherwise never gets: without this, a sim whose
    // memories fixate on an impossible action (bills already paid) re-picks it every
    // tick and burns the deliberation budget on rejections
    sections.push(`NOT possible right now, do not choose: ${unavailableActions.map(pretty).join(', ')}.`);
  }
  return sections.join('\n\n');
}
