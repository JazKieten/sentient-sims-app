// Builds the deliberation prompt for one cognition tick. The offered vocabulary is
// restricted to what the snapshot actually contains (perception vocabulary == action
// vocabulary), and every policy rule that can be enforced in code is enforced in code —
// the preamble only carries the judgment calls a model has to make.

import { SimStateEntry, SimStateReport } from '../models/SimStateReport';
import { formatPerception } from './formatPerception';
import { offeredActions } from '../models/CognitionIntent';

function pretty(text: string): string {
  return text.replace(/_/g, ' ');
}

export const COGNITION_SYSTEM_PROMPT = `You are the inner voice of one Sim in The Sims 4, deciding what they do next.
Reply with ONLY a JSON object, no prose, matching:
{"kind":"action|speak|continue|wait","action":"<action key>","target_sim_id":"<id>","target_object_id":"<id>","speak":{"target_sim_id":"<id>","topic":"one line"},"thought":"one-line inner monologue","motivation":"why, in-world","urgency":"low|normal|emergency"}

Rules:
- "continue" is the default: a Sim who is content and mid-activity should be left alone.
- Act when the Sim is idle, stuck, has an urgent need, or a want/goal pulls them.
- Fix the WORST need first (the most negative number), whatever it is — fun and social are real needs. When two are similarly low, prefer bladder, then hunger, then hygiene, then sleep. A need that is already fine (positive) never needs fixing.
- Only choose actions and targets from the OFFERED lists. Use sim ids, never names.
- To talk to someone, use "speak" with a topic, or a specific social action.
- Late night is for sleep, not skill practice. Respect work schedules.
- "thought" is always present: one line of what the Sim is thinking right now.`;

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
      const needs = Object.entries(self.needs)
        .map(([need, value]) => `${pretty(need)} ${value}`)
        .join(', ');
      selfLines.push(`Needs (-100 to 100): ${needs}`);
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
      lotLines.push(`Something is wrong on the lot: ${brokenThings.join('; ')}.`);
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
    [...offered.simTargets.entries()]
      .map(([simId, target]) => `${target.name ?? 'someone'} (sim_id ${simId}${target.hasMet ? '' : ', a stranger'})`)
      .join('; ') || '(no one)';
  sections.push(`OFFERED object actions: ${objectList}`);
  if (offered.lotActions.size > 0) {
    sections.push(`OFFERED household actions: ${[...offered.lotActions].map(pretty).join(', ')}`);
  }
  sections.push(`OFFERED people to talk to: ${simList}`);
  if (unavailableActions?.length) {
    // Negative feedback the model otherwise never gets: without this, a sim whose
    // memories fixate on an impossible action (bills already paid) re-picks it every
    // tick and burns the deliberation budget on rejections
    sections.push(`NOT possible right now, do not choose: ${unavailableActions.map(pretty).join(', ')}.`);
  }
  sections.push('What do you do? JSON only.');

  return sections.join('\n\n');
}

export const COGNITION_REVIEW_SYSTEM_PROMPT = `You review a Sim's chosen next action for obvious mistakes before it executes.
Given the situation and the chosen intent JSON, reply with ONLY the corrected intent JSON.
Keep the choice unless it clearly violates one of these:
- LOW needs (negative numbers) go before fun or socializing; a need that is already fine (positive) never justifies changing the plan
- don't interrupt a content, busy Sim ("continue" instead)
- wash up before bed only if hygiene is actually low
- targets must come from the offered lists
DEFAULT TO RETURNING THE CHOICE UNCHANGED. Adjust only on a clear violation.`;
