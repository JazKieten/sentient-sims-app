// Turns fact rows into the <KNOWN_FACTS> block. Pure: no database, no context, so the
// wording is unit-testable and the same renderer serves the tick, the scene, the ask
// decision and the reflection.
//
// The block is deliberately small. A sim who has met forty people cannot carry forty
// relationship lines into every tick, and the failure mode of a bloated facts block is
// the one F2 was written for: the user message gets truncated away. Self facts first
// (they are short and always relevant), then the people actually present or mentioned,
// then hearsay.

import { FactPredicate } from '../pipeline/facts/predicates';
import { relationshipWords } from './relationshipWords';

export type RenderableFact = {
  predicate: string;
  objectText?: string;
  objectSimId?: string;
  source: string;
  confidence: number;
  validFromDay?: number;
};

export type RenderKnownFactsInput = {
  selfFacts: RenderableFact[];
  // one entry per person worth describing, already narrowed to who is here or mentioned
  people: {
    simId: string;
    name?: string;
    facts: RenderableFact[];
    relationship?: { hasMet?: boolean; friendship?: number; romance?: number; bits?: string[] };
  }[];
  told: { text: string; saidBy?: string; confidence: number }[];
  // A name can genuinely be missing (an unmet sim mentioned by id), so the fallbacks
  // below are real - the type has to admit it or the checker calls them dead code.
  names: Record<string, string | undefined>;
  maxChars?: number;
};

export const DEFAULT_FACTS_MAX_CHARS = 1000;

function pretty(value: string): string {
  return value
    .replace(/^trait_SimPreference_(Likes|Dislikes)_/, '')
    .replace(/^trait_Fear_/, '')
    .replace(/^trait_/, '')
    .replace(/^career_(Adult|Teen)_/, '')
    .replace(/^aspiration_/, '')
    .replace(/^Track_/, '')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
}

// 'family_Target_IsSonOrDaughterOf_Actor' -> 'their child'. The bit is written from the
// ACTOR's side (the subject of the fact), so Target_Is<X>Of_Actor means the other sim is
// the subject's <X>. Anything unrecognized falls back to a readable form of the raw name
// rather than being dropped: a wrong-looking label is debuggable, a missing one is not.
export function familyBitWords(bit: string): string {
  const match = /family_Target_Is(.+?)Of_Actor/i.exec(bit);
  const role = match ? match[1] : undefined;
  if (!role) {
    return pretty(bit.replace(/^family_/, ''));
  }
  const lowered = role.toLowerCase();
  const table: Record<string, string> = {
    sonordaughter: 'their child',
    parent: 'their parent',
    siblings: 'their sibling',
    sibling: 'their sibling',
    grandparent: 'their grandparent',
    grandchild: 'their grandchild',
    auntuncle: 'their aunt or uncle',
    niecenephew: 'their niece or nephew',
    cousin: 'their cousin',
    spouse: 'their spouse',
  };
  return table[lowered] ?? `their ${pretty(role).toLowerCase()}`;
}

function selfLine(fact: RenderableFact, names: Record<string, string | undefined>): string | undefined {
  const name = (id?: string) => (id ? (names[id] ?? `sim ${id}`) : undefined);
  switch (fact.predicate) {
    case FactPredicate.AGE_STAGE:
      return fact.objectText ? `you are ${fact.objectText.toLowerCase()}` : undefined;
    case FactPredicate.GENDER:
      return fact.objectText ? `you are ${fact.objectText.toLowerCase()}` : undefined;
    case FactPredicate.PRONOUNS:
      return fact.objectText ? `your pronouns are ${fact.objectText}` : undefined;
    case FactPredicate.OCCULT_CURRENT:
      return fact.objectText && fact.objectText !== 'HUMAN' ? `you are a ${fact.objectText.toLowerCase()}` : undefined;
    case FactPredicate.DEATH_TYPE:
      return `you are dead (${pretty(fact.objectText ?? '')})`;
    case FactPredicate.HOUSEHOLD:
      return fact.objectText ? `you live with the ${fact.objectText} household` : undefined;
    case FactPredicate.ASPIRATION:
      return fact.objectText ? `your aspiration is ${pretty(fact.objectText)}` : undefined;
    case FactPredicate.JOB:
      return fact.objectText ? `you work as ${pretty(fact.objectText)}` : undefined;
    case FactPredicate.PARENT:
      return `${name(fact.objectSimId)} is your parent`;
    case FactPredicate.CHILD:
      return `${name(fact.objectSimId)} is your child`;
    case FactPredicate.SIBLING:
      return `${name(fact.objectSimId)} is your sibling`;
    case FactPredicate.GRANDPARENT:
      return `${name(fact.objectSimId)} is your grandparent`;
    case FactPredicate.SPOUSE:
      return `${name(fact.objectSimId)} is your husband or wife`;
    case FactPredicate.FIANCE:
      return `you are engaged to ${name(fact.objectSimId)}`;
    case FactPredicate.STEADY:
      return `${name(fact.objectSimId)} is your partner`;
    default:
      return undefined;
  }
}

// Traits, likes, dislikes and fears are lists, so they read far better collapsed into one
// line each than as one bullet per value.
function collectList(facts: RenderableFact[], predicate: string): string[] {
  return facts
    .filter((fact) => fact.predicate === predicate && fact.objectText)
    .map((fact) => pretty(fact.objectText as string));
}

function joinList(values: string[], limit = 6): string {
  const kept = values.slice(0, limit);
  const suffix = values.length > limit ? ', ...' : '';
  return kept.join(', ') + suffix;
}

export function renderKnownFacts(input: RenderKnownFactsInput): string {
  const lines: string[] = [];
  const selfLines: string[] = [];
  for (const fact of input.selfFacts) {
    const line = selfLine(fact, input.names);
    if (line) {
      selfLines.push(line);
    }
  }
  for (const [predicate, label] of [
    [FactPredicate.TRAIT, 'your personality'],
    [FactPredicate.FEAR, 'you are afraid of'],
    [FactPredicate.LIKES, 'you like'],
    [FactPredicate.DISLIKES, 'you dislike'],
  ] as const) {
    const values = collectList(input.selfFacts, predicate);
    if (values.length > 0) {
      selfLines.push(`${label}: ${joinList(values)}`);
    }
  }
  if (selfLines.length > 0) {
    lines.push('About you:');
    lines.push(...selfLines.map((line) => `- ${line}`));
  }

  const peopleLines: string[] = [];
  for (const person of input.people) {
    const name = person.name ?? input.names[person.simId] ?? `sim ${person.simId}`;
    const parts: string[] = [];
    // The family bit is the precise word ("their child"), so it beats the score band
    const familyBit = person.facts.find((fact) => fact.predicate === FactPredicate.FAMILY_BIT)?.objectText;
    if (familyBit) {
      parts.push(familyBitWords(familyBit).replace('their ', 'your '));
    }
    for (const fact of person.facts) {
      const line = selfLine(fact, input.names);
      // reuse the self wording but from the other direction: "X is your parent"
      if (line && line.includes('your') && fact.predicate !== FactPredicate.FAMILY_BIT) {
        const role = line.replace(`${name} is `, '').replace('you are engaged to ', 'engaged to ');
        if (role !== line) {
          parts.push(role);
        }
      }
    }
    if (person.relationship) {
      parts.push(...relationshipWords(person.relationship));
    }
    const unique = [...new Set(parts.filter(Boolean))];
    if (unique.length > 0) {
      peopleLines.push(`- ${name}: ${unique.join(', ')}`);
    }
  }
  if (peopleLines.length > 0) {
    lines.push('About people here or mentioned:');
    lines.push(...peopleLines);
  }

  if (input.told.length > 0) {
    lines.push('Recently learned (may not be true):');
    for (const item of input.told) {
      const attribution = item.saidBy ? ` (said by ${item.saidBy})` : '';
      lines.push(`- ${item.text}${attribution}`);
    }
  }

  if (lines.length === 0) {
    return '';
  }

  // Trim from the end: self facts matter most and hearsay least, and the sections are
  // already in that order.
  const maxChars = input.maxChars ?? DEFAULT_FACTS_MAX_CHARS;
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > maxChars) {
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  if (kept.length === 0) {
    return '';
  }
  return `<KNOWN_FACTS>\n${kept.join('\n')}\n</KNOWN_FACTS>`;
}
