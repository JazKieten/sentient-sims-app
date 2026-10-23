// A pie-menu label as a plain line in the house style of the built-in mappings:
// "Pay Bills" -> "{actor.0} is paying bills.", "Teach about Plants" -> "{actor.0} is teaching
// {actor.1} about plants.". A label only becomes a verb phrase when its first word is a verb
// on the list below; anything else reads "{actor.0} is busy with Back Flip.", so the line is
// never a guess like "is backing flip". No line ever has the "Name: text" shape, which the
// memories window and the scene prompt read as the sim SAYING the label.
//
// The lists are seeded from the first words of real labels (seen_unmapped_interactions.json,
// 2026-10-23). `[PreAction] UNMAPPED ... is busy with` in main.log names the labels that fell
// through; grow the lists from there.

const VERBS = new Set(
  `add admire admit adopt age agree analyse analyze apologize argue arrest ask assess attempt
  attend babble bake bark bathe be beg begin bid bike bite blame book bow box brew bring browse
  brush build burp buy calibrate call calm carry celebrate change chase chat check cheer chill
  chop clean climb clog close cloudgaze collect comfort commit complain compliment confess
  console consult contemplate control convince cook craft crawl create criticize cry cuddle
  cure dance debate deliver determine diagnose dig discover discuss dive do donate draw dream
  dress drink dye eat educate empty encourage enter enthuse escape examine exclaim exercise
  explore express feed feel fertilize fetch fight fill film find fingerprint finish fish fix
  flee flirt floss forget forgive gaze get give glue go gossip grab greet grieve groom guide
  hang harvest have heal help hide hire hit hold host howl hug hunt impress inspect insult
  interrogate interview introduce invent investigate invite issue jog join joke jump kick kiss
  knit laugh learn leash leave lecture lend let lick lie lift list listen lock look lounge make
  marry meditate mentor mention mix mock mop mourn move nap nuzzle object obsess offer open
  optimize order pack paint pamper panic participate pass pay perform pet pick plan plant play
  pluck poke polish ponder post pour practice practise praise pray prefer prepare prevent
  promote propose pull punch purchase push put quit quiz reach read reaffirm record regain
  regret rehearse relax release remember repair request rescue research rest resume return
  reveal ride rock run scold scrap scratch scream scrub scry sculpt search see seduce sell send
  serenade serve sew share shoo shout show shower sign sing sit sketch ski sleep slide sniff
  solve splash spar stare stargaze stay stitch stretch strum study style submit surf sweep swim
  synthesize take talk taste teach tease tell thank throw tickle tinker toast train transform
  travel treat try tutor upgrade use vent view visit wait wake walk wash watch water weed
  welcome whisper workout wrestle write yell self-publish cross-stitch`.split(/\s+/),
);

// Verbs whose object can be the other sim: the target goes right after the verb
// ("Lecture about Barking" -> "lecturing {actor.1} about barking") instead of a trailing "with"
const TAKES_TARGET = new Set(
  `accuse adopt arrest ask bathe blame bring buy call carry chase comfort compliment console
  convince criticize cuddle educate encourage feed forgive give greet groom guide help hire hit
  hold hug impress insult interrogate interview introduce invite kick kiss lecture leash mentor
  mock nuzzle offer pamper pet pick poke praise punch put scold seduce send serenade show
  tease teach tell thank tickle train tutor visit wake watch welcome`.split(/\s+/),
);

// Of those, the ones that take a thing after the sim ("Give Tip" -> "giving {actor.1} tip")
const DITRANSITIVE = new Set(['ask', 'bring', 'buy', 'give', 'offer', 'send', 'show', 'teach', 'tell']);

const PREPOSITIONS = new Set(['about', 'at', 'for', 'from', 'if', 'in', 'into', 'on', 'to']);
const PARTICLES = new Set(['around', 'away', 'back', 'down', 'off', 'out', 'over', 'up']);

// Whole labels whose object comes last ("Get to Know" -> "getting to know {actor.1}")
const TARGET_LAST = new Set(['get to know', 'listen to', 'look at', 'talk to', 'wait for', 'check on']);

// Verbs where a trailing "with" would read wrong ("sleeping with")
const TARGET_PREPOSITION: Record<string, string> = { apologize: 'to', bow: 'to', sleep: 'near' };

// Labels that start with a gerund but name a thing, not what the sim is doing
const NOUN_PHRASES = new Set(['cleaning frenzy']);

// Two-syllable verbs stressed on the end, which double their last consonant
const DOUBLES = new Set(
  `acquit admit begin commit compel control equip excel expel forget occur omit patrol permit
  prefer propel rebel refer regret submit transfer upset`.split(/\s+/),
);

const SPECIAL_GERUNDS: Record<string, string> = {
  be: 'being',
  dye: 'dyeing',
  ski: 'skiing',
  workout: 'working out',
};

function gerundOf(verb: string): string {
  const special = SPECIAL_GERUNDS[verb];
  if (special) {
    return special;
  }
  if (/ie$/.test(verb)) {
    return `${verb.slice(0, -2)}ying`;
  }
  if (/ue$/.test(verb) || /[^aeiou]e$/.test(verb)) {
    return `${verb.slice(0, -1)}ing`;
  }
  if (/ic$/.test(verb)) {
    return `${verb}king`;
  }
  // One syllable ending consonant-vowel-consonant (chat, sit, quit), never after w/x/y
  const spelled = verb.replace(/qu/g, 'qw');
  if (/^[^aeiou]*[aeiou][bcdfghjklmnpqrstvz]$/.test(spelled) || DOUBLES.has(verb)) {
    return `${verb}${verb.slice(-1)}ing`;
  }
  return `${verb}ing`;
}

// The -ing form of a verb; a hyphenated word changes its last part only
export function toGerund(word: string): string {
  const lowered = word.toLowerCase();
  const dash = lowered.lastIndexOf('-');
  if (dash > 0 && !SPECIAL_GERUNDS[lowered]) {
    return `${lowered.slice(0, dash + 1)}${gerundOf(lowered.slice(dash + 1))}`;
  }
  return gerundOf(lowered);
}

const GERUNDS = new Set([...VERBS].map((verb) => toGerund(verb)));

function cleanLabel(label: string): string {
  let cleaned = label.replace(/\s+/g, ' ').trim();
  cleaned = cleaned.replace(/\(\s*\)/g, ' ').replace(/^\d+\)\s*/, '');
  let previous = '';
  while (previous !== cleaned) {
    previous = cleaned;
    cleaned = cleaned
      .trim()
      .replace(/\s*\([^()]*\)$/, '')
      .replace(/(\.\.\.|…|!)+$/, '')
      .trim();
  }
  const quoted = /^["“]([^"“”]*)["”]$/.exec(cleaned);
  if (quoted) {
    cleaned = quoted[1].trim();
  }
  // "Risky Have Drink With": the label's object is the sim the line adds or leaves out
  cleaned = cleaned.replace(/\s+(and|at|by|for|from|of|to|with)$/i, '');
  return cleaned.replace(/\s*:\s*/g, ' - ').replace(/\s+/g, ' ');
}

function isTitleCase(word: string): boolean {
  return word
    .split('-')
    .map((part) => part.replace(/[^\p{L}]/gu, ''))
    .every((letters) => letters.length === 0 || /^\p{Lu}\p{Ll}*$/u.test(letters));
}

// Lowercase the Title-Case words of the rest of a verb phrase; tokens, ALL-CAPS and
// mixed-caps words (DJ, WooHoo), quoted text and names from the save keep their case
function lowerRest(text: string, keepWords: Set<string>): string {
  return text
    .split(/("[^"]*"|“[^”]*”)/)
    .map((segment, index) => {
      if (index % 2 === 1) {
        return segment;
      }
      return segment
        .split(' ')
        .map((word) => {
          if (!word || word.includes('{') || keepWords.has(word) || !isTitleCase(word)) {
            return word;
          }
          const lowered = word.toLowerCase();
          if (lowered === 'yourself') {
            return 'themselves';
          }
          if (lowered === 'your') {
            return 'their';
          }
          return lowered;
        })
        .join(' ');
    })
    .join('');
}

export interface NarrateOptions {
  // Two or more sims and the label does not name the other one
  withTarget: boolean;
  // Names from the loaded save, kept as written
  keepCase?: string[];
  // Words picked out of a tuning name, not a label: only a short phrase that opens on a
  // listed verb becomes a verb phrase ("chat"), never a jumble ("moving on hug")
  fromTuningName?: boolean;
}

// A label ending on an initial ("Bartholomew A.") already has its full stop
function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

// The rest of a verb phrase with the target placed, or undefined when it trails as "with"
function placeTarget(verb: string, rest: string[]): string[] | undefined {
  if (!TAKES_TARGET.has(verb)) {
    return undefined;
  }
  const next = rest[0]?.toLowerCase() ?? '';
  const onlyParticles = rest.every((word) => PARTICLES.has(word.toLowerCase()));
  if (onlyParticles || PREPOSITIONS.has(next) || (DITRANSITIVE.has(verb) && !PARTICLES.has(next))) {
    return ['{actor.1}', ...rest];
  }
  return undefined;
}

export function narrateLabel(label: string, options: NarrateOptions): string | undefined {
  const cleaned = cleanLabel(label);
  if (!cleaned) {
    return undefined;
  }
  const keepCase = options.keepCase ?? [];
  const keepWords = new Set(keepCase.flatMap((name) => name.split(/\s+/)));
  const lowered = cleaned.toLowerCase();
  const named = keepCase.some((name) => lowered.includes(name.toLowerCase()));
  const withTarget = options.withTarget && !named && !/\b(yourself|self)\b/i.test(cleaned);

  const words = cleaned.split(' ');
  let adverb = '';
  if (words.length > 1 && /ly$/i.test(words[0]) && VERBS.has(words[1].toLowerCase())) {
    adverb = `${words.shift()?.toLowerCase()} `;
  }
  const first = words[0].toLowerCase();
  let gerund: string | undefined;
  if (options.fromTuningName) {
    if (VERBS.has(first) && words.length <= 3) {
      gerund = toGerund(first);
    }
  } else if (VERBS.has(first)) {
    gerund = toGerund(first);
  } else if (GERUNDS.has(first) && !NOUN_PHRASES.has(lowered)) {
    gerund = first;
  }

  if (!gerund) {
    return sentence(`{actor.0} is busy with ${cleaned}${withTarget ? ' with {actor.1}' : ''}`);
  }
  let rest = words.slice(1);
  // "Fill and Call Pet" -> "filling and calling pet"
  if (rest.length > 1 && rest[0].toLowerCase() === 'and' && VERBS.has(rest[1].toLowerCase())) {
    rest = ['and', toGerund(rest[1]), ...rest.slice(2)];
  }
  let suffix = '';
  if (withTarget) {
    const placed = adverb ? undefined : placeTarget(first, rest);
    if (placed) {
      rest = placed;
    } else if (TARGET_LAST.has(lowered)) {
      suffix = ' {actor.1}';
    } else {
      suffix = ` ${TARGET_PREPOSITION[first] ?? 'with'} {actor.1}`;
    }
  }
  const tail = lowerRest(rest.join(' '), keepWords);
  return sentence(`{actor.0} is ${adverb}${gerund}${tail ? ` ${tail}` : ''}${suffix}`);
}
