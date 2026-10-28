// Builds the deliberation prompt for one cognition tick. The offered vocabulary is
// restricted to what the snapshot actually contains (perception vocabulary == action
// vocabulary), and every policy rule that can be enforced in code is enforced in code —
// the preamble only carries the judgment calls a model has to make.

import { SimStateEntry, SimStateReport, VenueEntry } from '../models/SimStateReport';
import { formatPerception } from './formatPerception';
import { offeredActions, SimTargetInfo, SOCIAL_ACTIONS } from '../models/CognitionIntent';
import { TEEN_PLUS_TARGET_SOCIALS, isRomanceAge } from '../models/ActionLoadout';
import { relationshipWords } from './relationshipWords';
import { firstJsonBlock } from './jsonBlock';
import { formatSelfStatusSections, TodaysPlanBlock } from './formatSelfStatus';
import { formatVocabularyRows } from './formatVocabulary';
import type { VocabularyRow } from '../models/ActionIntent';

// What the prompt sees beyond the entry and the report (autonomy parts 2 and 3, 2026-10-21)
export type CognitionPromptExtras = {
  // 'pie' with rows: the OFFERED block is the mod's pie-menu rows; 'pie' without rows (the
  // monologue / scores prompt) keeps the people and the destinations and drops the whitelist
  // object and social lists; 'whitelist' is the prompt as it was
  vocabulary?:
    | { mode: 'whitelist' }
    | {
        mode: 'pie';
        rows?: { offered: VocabularyRow[]; greyed: VocabularyRow[]; whitelist?: VocabularyRow[] };
        cannotStartNow?: { reason?: string; why?: string };
      };
  // The other household Sims right now, and what they are already on
  householdLines?: string[];
  // Plum's active beat (a director has <sim> on <doing>), never more than two lines
  directorLines?: string[];
  // The Sim's intention rows for the day, in order, with what each waits for (part 5)
  intentionLines?: string[];
};

// Core since release 4.5 (util/jsonBlock, util/formatSelfStatus); re-exported for the
// autonomy callers that always imported them from here
export { firstJsonBlock, firstJsonBlockLoose } from './jsonBlock';
export { describePlanGoal, formatSelfStatus, formatSelfStatusSections } from './formatSelfStatus';
export type { TodaysPlanBlock } from './formatSelfStatus';

function pretty(text: string): string {
  return text.replace(/_/g, ' ');
}

// Socials the model should only aim where the relationship supports them; annotated in
// the offered list, enforced by the game's own relationship tests at push time
const ROMANTIC_SOCIALS = new Set(['flirt', 'kiss']);
const MEAN_SOCIALS = new Set(['insult']);

// "Nancy Landgraab (sim_id 123, friend, a romantic spark)" — the lore layer that lets a
// social pick match the relationship (get_to_know a stranger, flirt at a spark, not both)
function describeTarget(simId: string, target: SimTargetInfo): string {
  const parts: string[] = [`sim_id ${simId}`];
  // A minor target is named as such so the model aims age-gated verbs elsewhere on its
  // own — the hard filters below are the backstop, this is the signal
  if (target.age !== undefined && !isRomanceAge(target.age)) {
    parts.push(`a ${target.age.toLowerCase()} — keep talk age-appropriate`);
  }
  // The bands live in util/relationshipWords so <KNOWN_FACTS> says the same words
  parts.push(...relationshipWords(target));
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
  // go_out only: the venue NAME chosen from the prompt's destination list
  destination?: string;
  label?: string;
  // Pie vocabulary: the row id and the option chosen from a collapsed row
  row?: string;
  option?: string;
};

function cleanIdText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' || ['null', 'none', 'undefined'].includes(trimmed.toLowerCase()) ? undefined : trimmed;
}

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
      target_sim_id: cleanIdText(option.target_sim_id),
      target_object_id: cleanIdText(option.target_object_id),
      destination: typeof option.destination === 'string' ? option.destination : undefined,
      label: typeof option.label === 'string' ? option.label : undefined,
      row:
        typeof option.row === 'string' || typeof option.row === 'number'
          ? String(option.row).trim() || undefined
          : undefined,
      option: typeof option.option === 'string' ? option.option : undefined,
    }))
    .filter((option) => option.action.length > 0 || option.row !== undefined);
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
  // <KNOWN_FACTS> (Phase 3.1 H3): what this sim actually knows about itself and the
  // people here, from the semantic store. Empty string when the store has nothing, so
  // the prompt is byte-identical to the pre-3.1 one until facts exist.
  factsBlock?: string,
  // go_out destinations (the mod's venue directory, same-world first); rendered only
  // when go_out is actually offered this tick
  venues?: VenueEntry[],
  extras?: CognitionPromptExtras,
): string {
  const sections: string[] = [];
  // || not ??: an older mod sends '' for a nameless sim, and 'You are  (sim_id ...)' is
  // worse than the id
  const name = entry.sim_name || entry.sim_id;
  sections.push(`You are ${name} (sim_id ${entry.sim_id}).`);

  sections.push(formatPerception(entry));
  sections.push(...formatSelfStatusSections(entry, plan, report?.lot?.clock));

  const pieMode = extras?.vocabulary?.mode === 'pie';
  const pieRows = extras?.vocabulary?.mode === 'pie' ? extras.vocabulary.rows : undefined;

  const lot = report?.lot;
  if (lot) {
    const lotLines: string[] = [];
    // Where you are, first: the venue decides what an evening can be (order_drink was never
    // offered at two clubs on 10-21 because nothing said "this is a lounge")
    if (lot.is_home !== undefined) {
      const place = lot.lot_name || 'this lot';
      const venue = lot.venue_type ?? lot.venue;
      if (lot.is_home) {
        lotLines.push(`You are at home (${place}).`);
      } else {
        lotLines.push(`You are at ${place}${venue ? ` (${pretty(venue)})` : ''}, not your home.`);
      }
    }
    if (lot.clock?.hour !== undefined) {
      lotLines.push(`It is ${lot.clock.hour}:${String(lot.clock.minute ?? 0).padStart(2, '0')}.`);
    }
    if (typeof lot.funds === 'number') {
      // Money next to the bills: pay_bills x9 with no funds on 10-19
      let money = `Household funds: $${Math.round(lot.funds).toLocaleString('en-US')}`;
      if (lot.bills?.due) {
        const amount = lot.bills.amount;
        const cut = lot.bills.shut_off?.length ? ` (${lot.bills.shut_off.join(' and ')} already shut off)` : '';
        const afford =
          typeof amount === 'number' ? (lot.funds >= amount ? 'you can afford them' : 'you cannot afford them') : '';
        money += `; bills of $${typeof amount === 'number' ? amount.toLocaleString('en-US') : '?'} are due${
          afford ? `: ${afford}` : ''
        }${cut}`;
      }
      lotLines.push(`${money}.`);
    } else if (lot.bills?.due) {
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
  if (extras?.householdLines?.length) {
    sections.push(extras.householdLines.join('\n'));
  }
  if (extras?.intentionLines?.length) {
    sections.push(extras.intentionLines.join('\n'));
  }
  if (extras?.directorLines?.length) {
    sections.push(extras.directorLines.slice(0, 2).join('\n'));
  }

  // Facts before memories: what is TRUE anchors how the recalled episodes are read, and
  // a fact block that gets truncated away is worse than a short one that survives.
  if (factsBlock) {
    sections.push(factsBlock);
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
  if (pieRows) {
    // The options prompt in pie mode: the mod's rows ARE the vocabulary
    sections.push(
      formatVocabularyRows(pieRows, extras?.vocabulary?.mode === 'pie' ? extras.vocabulary.cannotStartNow : undefined),
    );
  } else if (!pieMode) {
    sections.push(`OFFERED object actions: ${objectList}`);
    if (offered.lotActions.size > 0) {
      sections.push(`OFFERED household actions: ${[...offered.lotActions].map(pretty).join(', ')}`);
    }
  }
  const goOutOffered = pieRows
    ? (pieRows.whitelist ?? []).some((row) => row.key === 'go_out')
    : offered.lotActions.has('go_out');
  if (goOutOffered && venues && venues.length > 0) {
    // Names only — zone ids never reach the model. Same-world entries lead (the mod
    // sorts them first) and the cap keeps the prompt from ballooning; anywhere in the
    // directory stays reachable because validateIntent matches by name, not by list
    // position... but the model can only name what it sees, so cap generously.
    const listed = venues
      .slice(0, 12)
      .map((venue) => {
        const detail = [venue.venue, venue.world].filter(Boolean).join(', ');
        return detail ? `${venue.name} (${detail})` : `${venue.name}`;
      })
      .join('; ');
    sections.push(
      `go_out destinations — name one with "destination" on a go out option, or leave it off to just head somewhere: ${listed}.`,
    );
    // The gentle evening pull: a lonely sim at home with the night ahead should think
    // of going out on their own — same pattern as the dirty/broken lines above
    const hour = report?.lot?.clock?.hour;
    const social = entry.self?.needs?.social;
    if (typeof hour === 'number' && hour >= 18 && typeof social === 'number' && social < 25) {
      sections.push('The evening is young and nobody is around — going out (go_out) would put people nearby.');
    }
  }
  if (!pieRows) {
    sections.push(`OFFERED people to talk to: ${simList}`);
  }
  if (awakeTargets.length > 0 && !pieMode) {
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
