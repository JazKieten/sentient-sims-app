// The self-and-relationship battery (Phase 3.1 H5). Ten questions a Sim should be able to
// answer about itself, graded against the dossier rather than against a judge: the mod
// already knows who a Sim's parents are, so "who are your parents" is scoreable the way an
// arithmetic answer is, right or wrong.
//
// Pure on purpose - no context, no database, no network - so the graders are testable and
// so the same module can grade a live overlay-chat answer or a headless bench run.
//
// Two grading rules do the work. A question with a definite set of correct names passes
// only if the answer names at least one of them and names NOBODY it should not: a Sim that
// lists four people to make sure one is right has not answered the question. A question
// with no correct answer at all (the Sim genuinely has no siblings) passes only on a
// denial - that is the adversarial half of the battery, where confabulation shows up.

import { SimDossier } from '../models/SimDossier';
import { lifeStageAcceptWords } from '../util/lifeStageWords';

export type GradeMode = 'names' | 'denial' | 'text' | 'manual';

// The roles a Sim can put someone in while answering. A const object rather than an enum,
// for the reason FactPredicate is one: these strings travel through results and HTTP.
export const Role = {
  PARENT: 'parent',
  SIBLING: 'sibling',
  CHILD: 'child',
  PARTNER: 'partner',
} as const;

export type Role = (typeof Role)[keyof typeof Role];

// How a person says each role out loud. This table is what lets the grader tell "My dad's
// Travis, and my sister's Ariel" (both correct, and both were flagged as confabulation)
// from "I live with my parents, Travis and Ariel" (Ariel is his sister, and this passed).
// Both are live answers from 2026-09-03.
export const ROLE_WORDS: Record<Role, string[]> = {
  [Role.PARENT]: ['dad', 'dads', 'mom', 'moms', 'mum', 'mums', 'father', 'mother', 'parent', 'parents', 'folks'],
  [Role.SIBLING]: ['sister', 'sisters', 'brother', 'brothers', 'sibling', 'siblings', 'sis', 'bro'],
  [Role.CHILD]: ['son', 'sons', 'daughter', 'daughters', 'kid', 'kids', 'child', 'children'],
  [Role.PARTNER]: [
    'wife',
    'husband',
    'boyfriend',
    'girlfriend',
    'partner',
    'spouse',
    'fiance',
    'fiancee',
    'fiancé',
    'fiancée',
  ],
};

export type BatteryQuestion = {
  id: string;
  question: string;
  mode: GradeMode;
  // Names that count as correct (mode 'names'), or that must NOT appear (mode 'denial')
  expected: string[];
  // Other people's names that make an answer wrong if claimed in this role
  forbidden?: string[];
  // People this Sim really is related to, in some OTHER role. A denial may name them in
  // passing ("no siblings, just my two kids, Ariel and Mackenzie") without that being a
  // confabulation; naming anyone else while denying still is.
  excusable?: string[];
  // Substrings any of which satisfies mode 'text'
  accept?: string[];
  // Everyone the dossier gives a family role to, by name. Checked in EVERY auto-graded
  // mode: putting a real relative in the wrong role is a contradiction whatever was asked.
  roles?: Record<string, Role>;
  // Phrases that assert the very thing a denial question denies. A denial followed by one
  // of these is not a denial ("No, not married. I'm seeing someone" - live 2026-09-03).
  affirmations?: string[];
  // Extra wordings that count as a denial for THIS question ("retired" for the job one).
  denials?: string[];
  // What the question asks about, so a reason sentence can finish: "who is not a parent".
  roleLabel?: string;
  // Every name this Sim could legitimately say: everyone they have met, themselves, their
  // household. Anything else capitalised in an answer is reported as an unknown name.
  knownNames?: string[];
  note?: string;
};

export type QuestionResult = {
  id: string;
  question: string;
  answer: string;
  expected: string[];
  pass: boolean;
  reason: string;
  // A wrong relationship, as opposed to a vague or missing answer. Set by the graders
  // rather than sniffed back out of the reason string afterwards.
  contradiction: boolean;
  // Names in the answer belonging to nobody this Sim knows. Reported, never failed: the
  // cheapest confabulation instrument there is, and it covers the manual questions too.
  warnings?: string[];
  // The provider calls this answer came from, so a graded answer can be traced to its
  // prompt without searching the exchange log.
  exchangeIds?: number[];
};

export type BatteryResult = {
  simId: string;
  simName?: string;
  results: QuestionResult[];
  passed: number;
  total: number;
  // Answers that named someone in a role the dossier gives to someone else. The headline
  // number for 3.1: a wrong relationship is worse than a vague one.
  contradictions: string[];
  // Unknown names, across every question including the manually judged ones.
  warnings: string[];
};

function pretty(value: string): string {
  return value
    .replace(/^trait_SimPreference_(Likes|Dislikes)_/, '')
    .replace(/^trait_/, '')
    .replace(/^career_(Adult|Teen)_/, '')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
}

// First names are what a Sim actually says ("that's Mackenzie"), so matching on the full
// name alone would fail most correct answers.
function nameForms(name: string): string[] {
  const trimmed = name.trim();
  const first = trimmed.split(/\s+/)[0];
  return first && first !== trimmed ? [trimmed, first] : [trimmed];
}

/**
 * Drops the "<Name>: " a scene line carries, leaving what the Sim actually said. Only a
 * short, name-shaped prefix is removed, so a colon inside a real answer survives.
 */
export function stripSpeaker(answer: string): string {
  // Name-shaped means up to four capitalised words, which "Here is the thing:" is not -
  // a looser rule ate the opening clause of ordinary sentences.
  return answer.trim().replace(/^[A-Z][A-Za-z'’-]*(?: [A-Z][A-Za-z'’-]*){0,3}:\s*/, '');
}

// A phrase, matched on word boundaries so it is not found inside an unrelated word.
export function containsPhrase(haystack: string, phrase: string): boolean {
  const needle = phrase.trim().toLowerCase();
  if (!needle) {
    return false;
  }
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`).test(haystack.toLowerCase());
}

export function mentions(answer: string, name: string): boolean {
  const lowered = answer.toLowerCase();
  return nameForms(name).some((form) => {
    const needle = form.toLowerCase();
    // Word-boundary match so "Ariel" does not match inside another word
    return new RegExp(`(^|[^a-z])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(lowered);
  });
}

// A Sim denies something the way a person does, not the way a form does. The first live
// run failed "Nah, I'm flying solo these days" as a non-denial, which was the grader being
// wrong rather than the Sim: it is a correct and natural answer to "are you seeing anyone".
// A leading "nah" or "nope" only ever appears here on a denial-mode question, where the
// only correct answer IS a denial, so it cannot make a wrong answer pass.
const DENIAL_PHRASES = [
  "don't have",
  'do not have',
  'no siblings',
  'none',
  'nobody',
  'no one',
  'not married',
  "haven't",
  'have not',
  "aren't any",
  'no brothers',
  'no sisters',
  'only child',
  'single',
  'flying solo',
  'on my own',
  'by myself',
  'nah',
  'nope',
  'not really',
  "i'm not",
  'i am not',
  'no parents',
  'no family',
];

// "I never really had parents around" is a denial in every sense except the grader's,
// which failed it (live 2026-09-04). An adverb can sit between the two halves, which is
// why this is a pattern and not another entry in the list above.
const NEVER_HAD = /\bnever\b(?:\s+\w+){0,2}\s+\b(had|knew|met|seen|got)\b/;

// The life-stage words live in util/lifeStageWords so the facts block and this oracle
// cannot drift apart: the prompt tells the Sim it is "an elder (retirement age)" and the
// grader accepts the words a person says for that. Grading on the tuning name ("ELDER")
// failed every correct answer.

// A negation anywhere in the sentence followed by "anyone" or "anybody" ("not dating
// anyone", "haven't met anybody"). The phrase list cannot cover this: the verb between the
// two halves is open-ended, and every wording it missed failed a correct answer.
const NEGATED_ANYONE = /\b(not|no|never)\b[^.!?]*\b(any *one|any *body|anything)\b|n't[^.!?]*\b(any *one|any *body)\b/;
// A bare "no" as its own clause, which is how a person often finishes a denial
const TRAILING_NO = /[,;]\s*no\s*[.!]?$/;

export function looksLikeDenial(answer: string, extra: string[] = []): boolean {
  const lowered = answer.toLowerCase().trim();
  // A plain "No, ..." opening is the commonest denial of all and matches none of the
  // phrases below, which is why it is checked on its own.
  if (/^no[,.\s]/.test(lowered) || lowered === 'no') {
    return true;
  }
  if (NEGATED_ANYONE.test(lowered) || TRAILING_NO.test(lowered) || NEVER_HAD.test(lowered)) {
    return true;
  }
  return [...DENIAL_PHRASES, ...extra].some((phrase) => lowered.includes(phrase));
}

/**
 * Which roles an answer puts a named person in.
 *
 * Clause-local on purpose. "My dad's Travis, and my sister's Ariel" has to read as two
 * separate claims, and treating the whole sentence as one bag of role words made every
 * relative look like every role. A name in a clause with no role word of its own inherits
 * the previous clause's ("I live with my parents, Travis and Ariel"), which is how English
 * lists work and is exactly the sentence that hid a real contradiction.
 */
export function claimedRoles(answer: string, name: string): Role[] {
  const clauses = stripSpeaker(answer).split(/[,.;!?]|\band\b/i);
  const rolesIn = (clause: string): Role[] =>
    (Object.keys(ROLE_WORDS) as Role[]).filter((role) => ROLE_WORDS[role].some((word) => containsPhrase(clause, word)));

  const found = new Set<Role>();
  let carried: Role[] = [];
  for (const clause of clauses) {
    const here = rolesIn(clause);
    if (here.length > 0) {
      carried = here;
    }
    if (mentions(clause, name)) {
      // A clause of its own beats an inherited one; with neither, the name was mentioned
      // in no role at all and nothing is claimed.
      (here.length > 0 ? here : carried).forEach((role) => found.add(role));
    }
  }
  return [...found];
}

// "No, not married" is a denial; "No, not married. I'm seeing someone" is not. The window
// before the phrase is what keeps "not dating anyone" and "no boyfriend" from counting as
// assertions of the thing being denied.
const NEGATION_WINDOW = 14;

export function affirmsAnyway(answer: string, affirmations: string[]): string | undefined {
  const lowered = stripSpeaker(answer).toLowerCase();
  return affirmations.find((phrase) => {
    const needle = phrase.toLowerCase();
    let index = lowered.indexOf(needle);
    while (index >= 0) {
      const before = lowered.slice(Math.max(0, index - NEGATION_WINDOW), index);
      if (!/\bnot\b|n't|\bno\b|\bnever\b/.test(before)) {
        return true;
      }
      index = lowered.indexOf(needle, index + needle.length);
    }
    return false;
  });
}

// Words that start a sentence, stand for the speaker, or are simply not names. Everything
// else capitalised mid-sentence is a name the Sim produced from somewhere.
const NOT_A_NAME = new Set([
  'i',
  "i'm",
  "i'll",
  "i've",
  "i'd",
  'sim',
  'sims',
  'nah',
  'nope',
  'yeah',
  'yep',
  'honestly',
  'maybe',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]);

/**
 * Capitalised words in an answer that belong to nobody this Sim knows.
 *
 * A warning rather than a failure, and deliberately so: a Sim may name a bar, a town or a
 * band. But "helped Jess with dinner plans" (live 2026-09-03) is a person who does not
 * exist, and no other check in the battery would have caught it.
 */
export function unknownNames(answer: string, known: string[]): string[] {
  const text = stripSpeaker(answer);
  // Every WORD of every known name, not just the full name and the first name: a shared
  // surname was being reported as an unknown person ("Scott", live 2026-09-04).
  const knownForms = new Set(
    known
      .flatMap(nameForms)
      .flatMap((form) => [form, ...form.split(/\s+/)])
      .map((form) => form.toLowerCase()),
  );
  const found: string[] = [];
  // Skip the first word of each sentence: it is capitalised by grammar, not by being a name
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    const words = sentence.trim().split(/\s+/).slice(1);
    for (const raw of words) {
      const word = raw.replace(/^[^A-Za-z']+|[^A-Za-z']+$/g, '');
      if (!/^[A-Z][a-z']+$/.test(word)) {
        continue;
      }
      const lowered = word.toLowerCase();
      if (NOT_A_NAME.has(lowered) || knownForms.has(lowered) || found.includes(word)) {
        continue;
      }
      found.push(word);
    }
  }
  return found;
}

// What each question is asking about, so a failure reads as a sentence rather than as a
// clause that stops halfway ("named Ariel Scott, who is not").
const ROLE_LABELS: Record<string, string> = {
  'SELF-parents': 'a parent',
  'SELF-siblings': 'a sibling',
  'SELF-children': 'a child of theirs',
  'SELF-partner': 'a partner',
  'SELF-household': 'someone they live with',
  'SOC-bestfriend': 'someone they are close to',
};

// Claiming the thing the question asks the Sim to deny. Live 2026-09-03, "No, not married.
// I'm seeing someone, but it's complicated" was graded as a correct denial: the denial is
// there, and so is the invention that follows it.
const AFFIRMATIONS: Record<string, string[]> = {
  'SELF-parents': ['my mom', 'my mum', 'my dad', 'my mother', 'my father', 'my parents', 'my folks'],
  'SELF-siblings': ['my sister', 'my brother', 'my siblings', 'a sister', 'a brother', 'an older', 'a younger'],
  'SELF-partner': [
    'seeing someone',
    'boyfriend',
    'girlfriend',
    'my partner',
    'my husband',
    'my wife',
    'married to',
    'dating',
    'engaged',
    'in a relationship',
    'with someone',
  ],
  // Deliberately only explicit claims of employment: "I'm a retiree" must not read as one.
  'SELF-job': ['i work as', 'i work at', 'i work in', 'my job', 'my career', 'i have a job'],
};

// "Retired" is the right answer to "what do you do for a living" for a Sim the game gives
// no career, and it is not a denial in any general sense - so it is attached per question
// rather than added to DENIAL_PHRASES, where it would let a Sim deny having a sibling by
// mentioning retirement.
const EXTRA_DENIALS: Record<string, string[]> = {
  'SELF-job': ['retired', 'not working', "don't work", 'do not work', 'between jobs', 'unemployed', 'no job'],
};

function namesFor(dossier: SimDossier, ids: string[] | undefined): string[] {
  const byId = new Map((dossier.relationships ?? []).map((edge) => [edge.sim_id, edge.name ?? ''] as const));
  return (ids ?? []).map((id) => byId.get(id) ?? '').filter(Boolean);
}

/**
 * The ten questions, built from this Sim's own dossier so every one has a known answer.
 * Questions whose answer the dossier cannot supply are dropped rather than asked with no
 * oracle: an ungraded question in a graded battery is just noise.
 */
export function buildQuestions(dossier: SimDossier, todaysMemories: string[] = []): BatteryQuestion[] {
  const questions: BatteryQuestion[] = [];
  const family = dossier.family ?? {};
  const everyone = (dossier.relationships ?? []).map((edge) => edge.name ?? '').filter(Boolean);

  const parents = namesFor(dossier, family.parents);
  const siblings = namesFor(dossier, family.siblings);
  const children = namesFor(dossier, family.children);
  const householdNames = namesFor(dossier, dossier.household?.member_ids);

  const notIn = (correct: string[]) => everyone.filter((name) => !correct.includes(name));
  // People this Sim really is close to, in whatever role. A denial that mentions one of
  // them in passing is not a confabulation - see the 'denial' case in gradeAnswer.
  const relatives = [...new Set([...parents, ...siblings, ...children, ...householdNames])];

  // Family questions. Where the Sim genuinely has none, the question becomes an
  // adversarial one: the pass is a denial, and naming anybody is a fail.
  questions.push(
    parents.length > 0
      ? {
          id: 'SELF-parents',
          question: 'Who are your parents?',
          mode: 'names',
          expected: parents,
          forbidden: notIn(parents),
        }
      : {
          id: 'SELF-parents',
          question: 'Who are your parents?',
          mode: 'denial',
          expected: [],
          forbidden: everyone,
          excusable: relatives,
          note: 'the game records no parents for this Sim',
        },
  );

  questions.push(
    siblings.length > 0
      ? {
          id: 'SELF-siblings',
          question: 'Do you have any brothers or sisters? Who?',
          mode: 'names',
          expected: siblings,
          forbidden: notIn(siblings),
        }
      : {
          id: 'SELF-siblings',
          question: 'Do you have any brothers or sisters? Who?',
          mode: 'denial',
          expected: [],
          forbidden: everyone,
          excusable: relatives,
          note: 'the game records no siblings',
        },
  );

  if (children.length > 0) {
    questions.push({
      id: 'SELF-children',
      question: 'Do you have children? Who are they?',
      mode: 'names',
      expected: children,
      forbidden: notIn(children),
    });
  }

  const partnerIds = [family.spouse_id, family.fiance_id, ...(family.steady_ids ?? [])].filter((id): id is string =>
    Boolean(id),
  );
  const partners = namesFor(dossier, partnerIds);
  questions.push(
    partners.length > 0
      ? {
          id: 'SELF-partner',
          question: 'Are you married or seeing anyone? Who?',
          mode: 'names',
          expected: partners,
          forbidden: notIn(partners),
        }
      : {
          id: 'SELF-partner',
          question: 'Are you married or seeing anyone? Who?',
          mode: 'denial',
          expected: [],
          forbidden: everyone,
          // A partner denial may mention family; it may NOT mention an outsider, which is
          // how "Nah, apart from Alice" stays a failure.
          excusable: relatives,
          note: 'the game records no spouse, fiance or steady',
        },
  );

  if (householdNames.length > 0) {
    questions.push({
      id: 'SELF-household',
      question: 'Who do you live with?',
      mode: 'names',
      expected: householdNames,
      forbidden: notIn(householdNames),
    });
  }

  // The strongest friendships in the dossier. Graded on naming one of them, not on any
  // particular wording about them.
  const byFriendship = [...(dossier.relationships ?? [])]
    .filter((edge) => edge.has_met && edge.name)
    .sort((a, b) => (b.friendship ?? 0) - (a.friendship ?? 0));
  const strongestFriend = byFriendship.at(0);
  if (strongestFriend && (strongestFriend.friendship ?? 0) >= 30) {
    // Friendship saturates at 100, so a Sim often has several people equally close and
    // the question has more than one right answer. Grading against whichever one sorted
    // first failed a Sim for naming the other (live 2026-09-03).
    const top = strongestFriend.friendship ?? 0;
    const closest = byFriendship
      .filter((edge) => top - (edge.friendship ?? 0) <= 10)
      .map((edge) => edge.name as string);
    questions.push({
      id: 'SOC-bestfriend',
      question: 'Who would you say you are closest to?',
      mode: 'names',
      expected: closest,
      note: `friendship ${top}${closest.length > 1 ? `, tied among ${closest.length}` : ''}`,
    });
  }

  const strongestRomance = [...(dossier.relationships ?? [])]
    .filter((edge) => edge.has_met && edge.name && Math.abs(edge.romance ?? 0) >= 20)
    .sort((a, b) => Math.abs(b.romance ?? 0) - Math.abs(a.romance ?? 0))
    .at(0);
  if (strongestRomance) {
    questions.push({
      id: 'SOC-romance',
      question: `How do you feel about ${strongestRomance.name}?`,
      mode: 'manual',
      expected: [strongestRomance.name as string],
      note: `romance ${strongestRomance.romance ?? 0}; judged by a person, not auto-graded`,
    });
  }

  const career = (dossier.careers ?? []).at(0);
  questions.push(
    career?.career
      ? {
          id: 'SELF-job',
          question: 'What do you do for a living?',
          mode: 'text',
          expected: [pretty(career.career)],
          accept: pretty(career.career)
            .split(' ')
            .filter((word) => word.length > 3),
        }
      : {
          id: 'SELF-job',
          question: 'What do you do for a living?',
          mode: 'denial',
          expected: [],
          note: 'the game records no career',
        },
  );

  if (dossier.age) {
    const stage = dossier.age.toUpperCase();
    questions.push({
      id: 'SELF-age',
      // "What stage of life are you at" invited philosophy every time it was asked live;
      // the plainer question is what a person would actually ask.
      question: 'How old are you, roughly?',
      mode: 'text',
      expected: [dossier.age],
      // ELDER is game vocabulary. Nobody says "I am an elder", they say they are older or
      // retired, so the oracle has to speak English too. This synonym set is safe in a way
      // one for likes would not be: there are exactly seven life stages and they are
      // ordered, so the words for each are a closed list rather than an open-ended guess.
      accept: lifeStageAcceptWords(stage),
    });
  }

  const likes = (dossier.likes ?? []).map(pretty);
  if (likes.length > 0) {
    questions.push({
      id: 'SELF-likes',
      question: 'What do you enjoy doing?',
      // Judged by a person, and this is the honest call rather than a cop-out. The game
      // stores a like as a tuning name (Activities Fitness, Music HipHop) and a Sim says
      // "hitting the gym and diving deep into beats" - which is exactly right and matches
      // no word in the oracle. Deciding it automatically would need a synonym table, and a
      // wrong synonym table makes the grader lie in both directions: passing an answer
      // that missed, failing one that landed. Live 2026-09-03, this failed a correct answer.
      mode: 'manual',
      expected: likes,
      note: 'a like expressed naturally cannot be matched against a tuning name',
    });
  }

  if (todaysMemories.length > 0) {
    questions.push({
      id: 'MEM-today',
      question: 'What did you do earlier today?',
      mode: 'manual',
      expected: todaysMemories.slice(0, 5),
      note: "graded against today's memory rows by a person",
    });
  }

  // Everything below is true of every question rather than of one, so it is attached in a
  // single pass: who this Sim's relatives actually are (checked in all four modes), the
  // names that are not confabulations, and the per-question wordings.
  const roles: Record<string, Role> = {};
  const assign = (names: string[], role: Role) => {
    for (const name of names) {
      roles[name] = role;
    }
  };
  assign(parents, Role.PARENT);
  assign(siblings, Role.SIBLING);
  assign(children, Role.CHILD);
  assign(partners, Role.PARTNER);

  const knownNames = [...new Set([...everyone, dossier.name ?? '', dossier.household?.name ?? ''])].filter(Boolean);

  return questions.map((question) => ({
    ...question,
    roles,
    knownNames,
    roleLabel: ROLE_LABELS[question.id],
    affirmations: question.mode === 'denial' ? AFFIRMATIONS[question.id] : undefined,
    denials: EXTRA_DENIALS[question.id],
  }));
}

// Someone the Sim really is related to, named in a role that belongs to somebody else.
// This is a contradiction whatever the question was: "I live with my parents, Travis and
// Ariel" passed the household question live, and Ariel is his sister.
function miscastRelative(question: BatteryQuestion, answer: string): string | undefined {
  const roles = question.roles ?? {};
  for (const [name, trueRole] of Object.entries(roles)) {
    if (!mentions(answer, name)) {
      continue;
    }
    const claimed = claimedRoles(answer, name);
    const wrong = claimed.find((role) => role !== trueRole);
    if (wrong) {
      return `named ${name} as ${wrong === Role.CHILD ? 'their child' : `a ${wrong}`}, but ${name} is their ${trueRole}`;
    }
  }
  return undefined;
}

export function gradeAnswer(question: BatteryQuestion, answer: string): QuestionResult {
  const trimmed = stripSpeaker(answer);
  const warnings = question.knownNames ? unknownNames(trimmed, question.knownNames) : [];
  const base = {
    id: question.id,
    question: question.question,
    answer,
    expected: question.expected,
    contradiction: false,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  // Scene lines arrive speaker-prefixed ("Travis Scott: No, just my two kids"). Grading
  // the raw string put every answer's first word behind that prefix, so a leading "No,"
  // was never seen as one and correct denials were failed (live 2026-09-03).
  if (!trimmed) {
    return { ...base, pass: false, reason: 'no answer' };
  }
  if (question.mode === 'manual') {
    return { ...base, pass: false, reason: 'needs a person to judge it' };
  }

  // Checked before the mode, because a relative in the wrong role is wrong in every mode
  const miscast = miscastRelative(question, trimmed);
  if (miscast) {
    return { ...base, pass: false, contradiction: true, reason: miscast };
  }

  const roles = question.roles ?? {};
  const wronglyNamed = (question.forbidden ?? []).filter((name) => {
    if (!mentions(trimmed, name)) {
      return false;
    }
    // A relative named in their OWN role is not a claim about this question: "My dad's
    // Travis, and my sister's Ariel" answers "who are your parents" correctly and names
    // his real sister as his sister. Failing that was the grader being wrong twice over
    // (live 2026-09-03, both flagged contradictions).
    if (!(name in roles)) {
      // No family role at all, so nothing they were called can be the right one
      return true;
    }
    return !claimedRoles(trimmed, name).includes(roles[name]);
  });

  switch (question.mode) {
    case 'names': {
      const named = question.expected.filter((name) => mentions(trimmed, name));
      if (wronglyNamed.length > 0) {
        const label = question.roleLabel ? ` ${question.roleLabel}` : '';
        return {
          ...base,
          pass: false,
          contradiction: true,
          reason: `named ${wronglyNamed.join(', ')}, who is not${label}`,
        };
      }
      return named.length > 0
        ? { ...base, pass: true, reason: `named ${named.join(', ')}` }
        : { ...base, pass: false, reason: 'named none of them' };
    }
    case 'denial': {
      // A denial may mention the Sim's own relatives in passing - "No siblings, just my
      // two kids, Ariel and Mackenzie" is how a person answers, and grading it as invented
      // siblings was the grader being wrong (live 2026-09-03). Naming anyone ELSE while
      // denying is still a confabulation ("Nah, apart from Alice"), and asserting the role
      // outright with no denial in it fails whoever is named.
      const denied = looksLikeDenial(trimmed, question.denials ?? []);
      const excusable = new Set(question.excusable ?? []);
      const convicting = denied ? wronglyNamed.filter((name) => !excusable.has(name)) : wronglyNamed;
      if (convicting.length > 0) {
        return { ...base, pass: false, contradiction: true, reason: `invented ${convicting.join(', ')}` };
      }
      if (!denied) {
        return { ...base, pass: false, reason: 'did not deny it' };
      }
      // A denial that takes itself back. The invention here is usually nameless ("I've got
      // a sister and a brother"), which is why no name check catches it.
      const affirmed = affirmsAnyway(trimmed, question.affirmations ?? []);
      if (affirmed) {
        return { ...base, pass: false, contradiction: true, reason: `denied it, then claimed "${affirmed}"` };
      }
      return { ...base, pass: true, reason: 'denied it, correctly' };
    }
    default: {
      // Whole words only. A substring match passed "Somewhere between holding on and
      // letting go" as saying "old" - the grader finding the answer inside a word that
      // has nothing to do with it (live 2026-09-03).
      const hit = (question.accept ?? question.expected).find((word) => containsPhrase(trimmed, word));
      return hit
        ? { ...base, pass: true, reason: `said "${hit}"` }
        : { ...base, pass: false, reason: `expected one of ${(question.accept ?? question.expected).join(', ')}` };
    }
  }
}

export function gradeBattery(
  simId: string,
  simName: string | undefined,
  answers: { question: BatteryQuestion; answer: string; exchangeIds?: number[] }[],
): BatteryResult {
  const results = answers.map(({ question, answer, exchangeIds }) => {
    const graded = gradeAnswer(question, answer);
    return exchangeIds && exchangeIds.length > 0 ? { ...graded, exchangeIds } : graded;
  });
  // A manual question is neither passed nor failed by the machine, so it is excluded from
  // the score rather than counted as a failure.
  const auto = results.filter((result) => result.reason !== 'needs a person to judge it');
  return {
    simId,
    simName,
    results,
    passed: auto.filter((result) => result.pass).length,
    total: auto.length,
    // Read off the flag the graders set. Matching on the shape of the reason string meant
    // every new wording silently dropped out of the headline number.
    contradictions: results.filter((result) => result.contradiction).map((result) => `${result.id}: ${result.reason}`),
    // Manual questions warn too: a name nobody knows is the same defect whether or not the
    // question could be auto-graded.
    warnings: results.flatMap((result) => (result.warnings ?? []).map((name) => `${result.id}: ${name}`)),
  };
}
