// Builds the deliberation prompt for one cognition tick. The offered vocabulary is
// restricted to what the snapshot actually contains (perception vocabulary == action
// vocabulary), and every policy rule that can be enforced in code is enforced in code —
// the preamble only carries the judgment calls a model has to make.

import { SimStateEntry, SimStateReport } from '../models/SimStateReport';
import { formatPerception } from './formatPerception';
import { offeredActions, SimTargetInfo, SOCIAL_ACTIONS } from '../models/CognitionIntent';
import { TEEN_PLUS_TARGET_SOCIALS, isRomanceAge } from '../models/ActionLoadout';

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
  // A minor target is named as such so the model aims age-gated verbs elsewhere on its
  // own — the hard filters below are the backstop, this is the signal
  if (target.age !== undefined && !isRomanceAge(target.age)) {
    parts.push(`a ${target.age.toLowerCase()} — keep talk age-appropriate`);
  }
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
  return `${target.name || 'someone'} (${parts.join(', ')})`;
}

// The Full Autonomy tick and action prompts now live in the stage registry
// (pipeline/prompts). They are re-exported here so every existing importer and test keeps
// working while call sites migrate to promptFor(stageId, ...).
export { TICK_MONOLOGUE_SYSTEM_PROMPT, TICK_SCORES_SYSTEM_PROMPT } from '../pipeline/prompts/cognition';
export {
  ACTION_OPTIONS_SYSTEM_PROMPT,
  ACTION_CHOICE_SYSTEM_PROMPT,
  ACTION_REVIEW_SYSTEM_PROMPT,
} from '../pipeline/prompts/action';

function clampScore(value: unknown): number | undefined {
  const num = typeof value === 'string' ? Number(value) : value;
  if (typeof num !== 'number' || Number.isNaN(num)) {
    return undefined;
  }
  return Math.min(10, Math.max(1, Math.round(num)));
}

export function firstJsonBlock(raw: string): unknown {
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

export function parseActionChoice(raw: string): { choice: number; motivation?: string; retries?: number } | undefined {
  const parsed = firstJsonBlock(raw);
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }
  const body = parsed as { choice?: unknown; motivation?: unknown; retries?: unknown };
  const choice = typeof body.choice === 'string' ? Number(body.choice) : body.choice;
  if (typeof choice !== 'number' || Number.isNaN(choice) || choice < 0) {
    return undefined;
  }
  const rawRetries = typeof body.retries === 'string' ? Number(body.retries) : body.retries;
  const retries =
    typeof rawRetries === 'number' && !Number.isNaN(rawRetries)
      ? Math.min(3, Math.max(0, Math.round(rawRetries)))
      : undefined;
  return {
    choice: Math.round(choice),
    motivation: typeof body.motivation === 'string' ? body.motivation : undefined,
    retries,
  };
}

// The day's plan as the prompt sees it: goal labels + the persona stage direction.
// The loadout is deliberately NOT rendered — the OFFERED lists are already narrowed to
// it, and naming the mechanism invites meta-reasoning about "allowed actions".
export type TodaysPlanBlock = {
  goals: { label: string; action_keys?: string[]; reachable?: boolean }[];
  persona?: string;
};

// G-5: a goal reads with the verbs that serve it, so "serve a goal" is a concrete pick
// and an unreachable goal is named as such instead of silently ignored
export function describePlanGoal(goal: { label: string; action_keys?: string[]; reachable?: boolean }): string {
  if (goal.action_keys && goal.action_keys.length > 0) {
    return `${goal.label} [serve it with: ${goal.action_keys.map(pretty).join(', ')}]`;
  }
  if (goal.reachable === false) {
    return `${goal.label} [no action in your vocabulary serves this yet]`;
  }
  return goal.label;
}

export function buildCognitionUserPrompt(
  entry: SimStateEntry,
  report: SimStateReport | undefined,
  memoriesBlock?: string,
  unavailableActions?: string[],
  plan?: TodaysPlanBlock,
  // Keys hidden from this sim today — off today's loadout, or forbidden by their age.
  // Filtered out of the rendered social lists (object/lot channels are narrowed upstream).
  // Never listed as "NOT possible": a hidden key is ABSENT from the prompt, not named.
  hiddenActions?: Set<string>,
): string {
  const sections: string[] = [];
  // || not ??: an older mod sends '' for a nameless sim, and 'You are  (sim_id ...)' is
  // worse than the id
  const name = entry.sim_name || entry.sim_id;
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

  if (plan && (plan.goals.length > 0 || plan.persona)) {
    const planLines: string[] = ['<TODAYS_PLAN>'];
    if (plan.persona) {
      planLines.push(`Who I want to be today: ${plan.persona}`);
    }
    if (plan.goals.length > 0) {
      planLines.push(`Today's goals: ${plan.goals.map(describePlanGoal).join('; ')}.`);
    }
    planLines.push('</TODAYS_PLAN>');
    sections.push(planLines.join('\n'));
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
      lotLines.push(
        `Something is wrong on the lot: ${brokenThings.join('; ')} — hire_repair_service fixes broken things.`,
      );
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
  // A sleeping sim is present (perception says so, plainly) but is not someone you can
  // talk to: every social toward them dies at execution. The model cannot pick what it
  // was never shown — validateIntent is the backstop, this stops the tick being spent.
  // Live 2026-08-16: three 'chat' pushes at a napping sim, all INTERACTION_INCOMPATIBILITY.
  const awakeTargets = [...offered.simTargets.entries()].filter(([, target]) => !target.asleep);
  const simList = awakeTargets.map(([simId, target]) => describeTarget(simId, target)).join('; ') || '(no one)';
  sections.push(`OFFERED object actions: ${objectList}`);
  if (offered.lotActions.size > 0) {
    sections.push(`OFFERED household actions: ${[...offered.lotActions].map(pretty).join(', ')}`);
  }
  sections.push(`OFFERED people to talk to: ${simList}`);
  if (awakeTargets.length > 0) {
    // The model can't name a social it was never shown — before this line existed every
    // conversation degraded to plain 'chat' (the vocabulary was validation-only).
    // Off-loadout socials are simply not shown ('chat' is always available).
    const plain: string[] = [];
    const romantic: string[] = [];
    const mean: string[] = [];
    const teenPlus: string[] = [];
    // Romance needs BOTH sides adult-or-teen: the actor, and at least one same-room sim
    // who could receive it. Unknown age (older mod build) blocks it. Live 2026-08-10:
    // nothing read age anywhere, so a CHILD's prompt offered 'flirt' at whoever was in
    // the room — and an adult's offered it at a child.
    const teenPlusTargetPresent = (entry.sims ?? []).some(
      (perceived) => perceived.tier === 'same_room' && isRomanceAge(perceived.age),
    );
    const romanceAllowed = isRomanceAge(entry.self?.age) && teenPlusTargetPresent;
    // Whether any same-room sim CANNOT receive a teen-plus social (unknown age counts:
    // fail closed) — only then does the "teens and up" label earn its place
    const minorPresent = (entry.sims ?? []).some(
      (perceived) => perceived.tier === 'same_room' && !isRomanceAge(perceived.age),
    );
    SOCIAL_ACTIONS.forEach((action) => {
      if (action !== 'chat' && hiddenActions?.has(action)) {
        return;
      }
      if (ROMANTIC_SOCIALS.has(action) && !romanceAllowed) {
        return;
      }
      // Non-romance socials the game refuses at a child target (deep_conversation,
      // dispatched at a CHILD and canceled at execution — live 2026-08-11): with no
      // teen+ target in the room they are hidden, with a mixed-age room they are
      // labeled so the model aims them at the right person
      if (TEEN_PLUS_TARGET_SOCIALS.has(action) && !teenPlusTargetPresent) {
        return;
      }
      if (ROMANTIC_SOCIALS.has(action)) {
        romantic.push(pretty(action));
      } else if (MEAN_SOCIALS.has(action)) {
        mean.push(pretty(action));
      } else if (TEEN_PLUS_TARGET_SOCIALS.has(action) && minorPresent) {
        teenPlus.push(pretty(action));
      } else {
        plain.push(pretty(action));
      }
    });
    const socialParts = [
      `OFFERED social actions (need a target_sim_id; match them to the relationship): ${plain.join(', ')}`,
    ];
    if (teenPlus.length > 0) {
      socialParts.push(`teens and up only: ${teenPlus.join(', ')}`);
    }
    if (romantic.length > 0) {
      socialParts.push(`romantic only: ${romantic.join(', ')}`);
    }
    if (mean.length > 0) {
      socialParts.push(`mean: ${mean.join(', ')}`);
    }
    sections.push(`${socialParts.join('; ')}.`);
  }
  if (unavailableActions?.length) {
    // Negative feedback the model otherwise never gets: without this, a sim whose
    // memories fixate on an impossible action (bills already paid) re-picks it every
    // tick and burns the deliberation budget on rejections
    sections.push(`NOT possible right now, do not choose: ${unavailableActions.map(pretty).join(', ')}.`);
  }
  return sections.join('\n\n');
}
