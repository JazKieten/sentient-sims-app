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

export type GradeMode = 'names' | 'denial' | 'text' | 'manual';

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
  note?: string;
};

export type QuestionResult = {
  id: string;
  question: string;
  answer: string;
  expected: string[];
  pass: boolean;
  reason: string;
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
];

// How each life stage sounds in a sentence. The game's word for it is not one a person
// says out loud, and grading on the tuning name failed every correct answer.
const AGE_WORDS: Record<string, string[]> = {
  BABY: ['baby', 'infant'],
  INFANT: ['infant', 'baby'],
  TODDLER: ['toddler', 'little', 'two', 'three'],
  CHILD: ['child', 'kid', 'little', 'school'],
  TEEN: ['teen', 'teenager', 'high school', 'seventeen', 'sixteen'],
  YOUNGADULT: ['young adult', 'twenties', 'young', 'just started out'],
  ADULT: ['adult', 'middle', 'thirties', 'forties', 'grown'],
  // The decades are here because a Sim answers "how old are you" with a number, and
  // "pushing past sixty" is a correct answer for an elder that no adjective catches.
  ELDER: [
    'elder',
    'older',
    'old',
    'senior',
    'retired',
    'getting on',
    'my age',
    'grandpa',
    'grandma',
    'sixty',
    'sixties',
    'seventy',
    'seventies',
    'eighty',
    'eighties',
  ],
};

export function looksLikeDenial(answer: string): boolean {
  const lowered = answer.toLowerCase().trim();
  // A plain "No, ..." opening is the commonest denial of all and matches none of the
  // phrases below, which is why it is checked on its own.
  if (/^no[,.\s]/.test(lowered) || lowered === 'no') {
    return true;
  }
  return DENIAL_PHRASES.some((phrase) => lowered.includes(phrase));
}

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
      accept: AGE_WORDS[stage] ?? [dossier.age.toLowerCase()],
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

  return questions;
}

export function gradeAnswer(question: BatteryQuestion, answer: string): QuestionResult {
  const base = { id: question.id, question: question.question, answer, expected: question.expected };
  // Scene lines arrive speaker-prefixed ("Travis Scott: No, just my two kids"). Grading
  // the raw string put every answer's first word behind that prefix, so a leading "No,"
  // was never seen as one and correct denials were failed (live 2026-09-03).
  const trimmed = stripSpeaker(answer);
  if (!trimmed) {
    return { ...base, pass: false, reason: 'no answer' };
  }

  const wronglyNamed = (question.forbidden ?? []).filter((name) => mentions(trimmed, name));

  switch (question.mode) {
    case 'names': {
      const named = question.expected.filter((name) => mentions(trimmed, name));
      if (wronglyNamed.length > 0) {
        return { ...base, pass: false, reason: `named ${wronglyNamed.join(', ')}, who is not` };
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
      const denied = looksLikeDenial(trimmed);
      const excusable = new Set(question.excusable ?? []);
      const convicting = denied ? wronglyNamed.filter((name) => !excusable.has(name)) : wronglyNamed;
      if (convicting.length > 0) {
        return { ...base, pass: false, reason: `invented ${convicting.join(', ')}` };
      }
      return denied
        ? { ...base, pass: true, reason: 'denied it, correctly' }
        : { ...base, pass: false, reason: 'did not deny it' };
    }
    case 'text': {
      // Whole words only. A substring match passed "Somewhere between holding on and
      // letting go" as saying "old" - the grader finding the answer inside a word that
      // has nothing to do with it (live 2026-09-03).
      const hit = (question.accept ?? question.expected).find((word) => containsPhrase(trimmed, word));
      return hit
        ? { ...base, pass: true, reason: `said "${hit}"` }
        : { ...base, pass: false, reason: `expected one of ${(question.accept ?? question.expected).join(', ')}` };
    }
    default:
      return { ...base, pass: false, reason: 'needs a person to judge it' };
  }
}

export function gradeBattery(
  simId: string,
  simName: string | undefined,
  answers: { question: BatteryQuestion; answer: string }[],
): BatteryResult {
  const results = answers.map(({ question, answer }) => gradeAnswer(question, answer));
  // A manual question is neither passed nor failed by the machine, so it is excluded from
  // the score rather than counted as a failure.
  const auto = results.filter((result) => result.reason !== 'needs a person to judge it');
  return {
    simId,
    simName,
    results,
    passed: auto.filter((result) => result.pass).length,
    total: auto.length,
    contradictions: results
      .filter((result) => result.reason.startsWith('named ') && result.reason.endsWith('who is not'))
      .concat(results.filter((result) => result.reason.startsWith('invented ')))
      .map((result) => `${result.id}: ${result.reason}`),
  };
}
