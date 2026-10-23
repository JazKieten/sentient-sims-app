import { narrateLabel, toGerund } from 'main/sentient-sims/util/labelNarration';
import { isDegeneratePreAction } from 'main/sentient-sims/util/degeneratePreAction';

// The memories window's speaker pattern (mod overlay/overlay_memories.py _SPEAKER_RE):
// a line that matches it is drawn as the sim saying the rest
const SPEAKER_RE = /^(\p{L}[\p{L}\p{N}_'’.-]*(?: \p{L}[\p{L}\p{N}_'’.-]*){0,3})(?: \(([^()]{1,40})\))?: (.+)$/u;

function render(line: string): string {
  return line.replace(/\{actor\.0\}/g, 'Julian Vance').replace(/\{actor\.1\}/g, 'Winston');
}

describe('toGerund', () => {
  it.each([
    ['pay', 'paying'],
    ['chat', 'chatting'],
    ['sit', 'sitting'],
    ['run', 'running'],
    ['shop', 'shopping'],
    ['hug', 'hugging'],
    ['box', 'boxing'],
    ['bow', 'bowing'],
    ['make', 'making'],
    ['give', 'giving'],
    ['dance', 'dancing'],
    ['bathe', 'bathing'],
    ['age', 'aging'],
    ['be', 'being'],
    ['lie', 'lying'],
    ['see', 'seeing'],
    ['agree', 'agreeing'],
    ['argue', 'arguing'],
    ['visit', 'visiting'],
    ['open', 'opening'],
    ['travel', 'traveling'],
    ['admit', 'admitting'],
    ['begin', 'beginning'],
    ['panic', 'panicking'],
    ['quit', 'quitting'],
    ['wait', 'waiting'],
    ['scry', 'scrying'],
    ['ski', 'skiing'],
    ['dye', 'dyeing'],
    ['workout', 'working out'],
    ['self-publish', 'self-publishing'],
    ['cross-stitch', 'cross-stitching'],
  ])('%s -> %s', (verb, gerund) => {
    expect(toGerund(verb)).toEqual(gerund);
  });
});

describe('narrateLabel', () => {
  const alone = { withTarget: false };
  const pair = { withTarget: true };

  it.each([
    ['Pay Bills', alone, '{actor.0} is paying bills.'],
    ['Talk about Recent Studies', pair, '{actor.0} is talking about recent studies with {actor.1}.'],
    ['Give {actor.1} a hug', alone, '{actor.0} is giving {actor.1} a hug.'],
    ['Wake Up {actor.1}', alone, '{actor.0} is waking up {actor.1}.'],
    ['Hug', pair, '{actor.0} is hugging {actor.1}.'],
    ['Wake Up', pair, '{actor.0} is waking {actor.1} up.'],
    ['Put to Bed', pair, '{actor.0} is putting {actor.1} to bed.'],
    ['Lecture about Barking', pair, '{actor.0} is lecturing {actor.1} about barking.'],
    ['Give Tip ()', pair, '{actor.0} is giving {actor.1} tip.'],
    ['Get to Know', pair, '{actor.0} is getting to know {actor.1}.'],
    ['Chat', pair, '{actor.0} is chatting with {actor.1}.'],
    ['Relaxing with {actor.1}', alone, '{actor.0} is relaxing with {actor.1}.'],
    ['Dancing', alone, '{actor.0} is dancing.'],
    ['Critically Assess', alone, '{actor.0} is critically assessing.'],
    ['"Fertilize"', alone, '{actor.0} is fertilizing.'],
    ['Travel...', alone, '{actor.0} is traveling.'],
    ['Celebrate!', alone, '{actor.0} is celebrating.'],
    ["Ask for Cupid's Counseling ()", pair, "{actor.0} is asking {actor.1} for cupid's counseling."],
    ['Ask About Interests (+▰Fame)', pair, '{actor.0} is asking {actor.1} about interests.'],
    ['Issue APB', alone, '{actor.0} is issuing APB.'],
    ['Talk About TV Shows', alone, '{actor.0} is talking about TV shows.'],
    ['Take Vacation Day (Salaryperson)', alone, '{actor.0} is taking vacation day.'],
    ['Workout (Push the Limits)', alone, '{actor.0} is working out.'],
    ['Give Yourself a Pep Talk', pair, '{actor.0} is giving themselves a pep talk.'],
    ['Upgrade Mind Control: Promiscuous', alone, '{actor.0} is upgrading mind control - promiscuous.'],
    [
      'Read "Romance Vol 1: From Flirtation Disaster to Romance Master"',
      alone,
      '{actor.0} is reading "Romance Vol 1 - From Flirtation Disaster to Romance Master".',
    ],
    ['Cleaning Frenzy!', alone, '{actor.0} is busy with Cleaning Frenzy.'],
    ['Woohoo', pair, '{actor.0} is busy with Woohoo with {actor.1}.'],
    ['Back Flip', alone, '{actor.0} is busy with Back Flip.'],
    ['Romantic Kiss', alone, '{actor.0} is busy with Romantic Kiss.'],
    ['2) Vertical Challenge - Easy', alone, '{actor.0} is busy with Vertical Challenge - Easy.'],
  ])('%s', (label, options, line) => {
    expect(narrateLabel(label, options)).toEqual(line);
  });

  it('keeps names from the save as written and leaves the target out when one is named', () => {
    expect(narrateLabel('Ask Jonah on a Date', { withTarget: true, keepCase: ['Jonah'] })).toEqual(
      '{actor.0} is asking Jonah on a date.',
    );
    expect(narrateLabel('Pampering Bartholomew A.', { withTarget: true, keepCase: ['Bartholomew A.'] })).toEqual(
      '{actor.0} is pampering Bartholomew A.',
    );
    expect(narrateLabel('Chat with Yuki', { withTarget: false, keepCase: ['Yuki'] })).toEqual(
      '{actor.0} is chatting with Yuki.',
    );
  });

  it('puts the target after a particle phrase only when nothing else follows', () => {
    expect(narrateLabel('Show Off Work', pair)).toEqual('{actor.0} is showing off work with {actor.1}.');
    expect(narrateLabel('Pick Up', pair)).toEqual('{actor.0} is picking {actor.1} up.');
  });

  it.each([
    ['Risky Have Drink With', alone, '{actor.0} is busy with Risky Have Drink.'],
    ['Fill and Call Pet', alone, '{actor.0} is filling and calling pet.'],
    ['Sleep', pair, '{actor.0} is sleeping near {actor.1}.'],
    ['Apologize', pair, '{actor.0} is apologizing to {actor.1}.'],
  ])('%s reads naturally', (label, options, line) => {
    expect(narrateLabel(label, options)).toEqual(line);
  });

  it('only turns a short tuning-name phrase that opens on a verb into a verb phrase', () => {
    const fromName = { withTarget: true, fromTuningName: true };
    expect(narrateLabel('chat', fromName)).toEqual('{actor.0} is chatting with {actor.1}.');
    expect(narrateLabel('mentor fishing', fromName)).toEqual('{actor.0} is mentoring fishing with {actor.1}.');
    expect(narrateLabel('moving hug', fromName)).toEqual('{actor.0} is busy with moving hug with {actor.1}.');
    expect(narrateLabel('pet cat wait nearby owner', fromName)).toEqual(
      '{actor.0} is busy with pet cat wait nearby owner with {actor.1}.',
    );
  });

  it('has nothing to say for a label that is all scaffolding', () => {
    expect(narrateLabel(' () ', alone)).toBeUndefined();
  });

  // Real labels from seen_unmapped_interactions.json (2026-10-23)
  const REAL_LABELS = [
    'Ask for Mentoring',
    'Ask to Go Potty',
    'Ask if Lonely',
    'Back Flip',
    'Bath',
    'Be Upset',
    'Book Now',
    'Bow',
    'Box',
    'Breeze Through Homework',
    'Call Over',
    'Change Diaper',
    'Check Pulse',
    'Clean Up',
    'Clog Drain',
    'Cloudgaze Together',
    'Collect Soul Flamboyantly',
    'Comfort About Missing Pet',
    'Cry In Closet',
    'Debate about Aliens',
    'Determine Cause of Death',
    'Do Lab Work',
    'Doing Acting Routine',
    'Dress Up',
    'Empty Popper',
    'Endurance Run (Push the Limits)',
    'Energized Jog',
    'Feed ()',
    'Feeling The Love',
    'Finished',
    'Fire',
    'Flirt with Self',
    'Get Attention from Margo',
    'Giddy',
    'Give Life Lesson on Hard Work',
    'Go For Jog',
    'Go Home',
    'Hang Out',
    'Insta-Repair!',
    'Instant Upgrade',
    'Introduction',
    'Join Thumbs-Up! Game',
    'Kiss',
    'Let Lick Face',
    'List on Plopsy ()',
    'Long Walk',
    'Look at the Brightside',
    'Mentor Charisma',
    'Mop',
    'Move Here',
    'Nuzzle',
    'Object To Mischief',
    'Obsess - Investigate',
    'Offer Tarot Reading (+)',
    'Pick Up',
    'Play Fetch',
    'Playing Woo-Who!? Game',
    'Pluck Some Inspiration',
    'Put Down',
    'Return Home...',
    'Risky Kiss',
    'Scry for Assignment',
    'Self-Publish',
    'Send Flirty Selfie',
    'Shoo',
    'Show Off Work',
    'Sit Nearby',
    'Skinny Dip',
    'Sleep',
    'Splash',
    'Strum for Fun',
    'Swim Laps',
    'Teach Shapes',
    'Teach to Talk',
    'Tell Jokes',
    'Tickle the Ivories',
    'Try for Baby',
    'Vocal Greet',
    'Waiting in Line',
    'Wake Up Cat',
    'Watch',
    'WooHoo',
    'You Are My Favorite',
    'Age Up',
    'Cross-stitch',
    'Risky Have Drink With',
    'Relax and Unwind on Couch',
    'Fill and Call Pet',
  ];

  it.each(REAL_LABELS)('%s never reads as speech and passes the degenerate check', (label) => {
    [alone, pair].forEach((options) => {
      const line = narrateLabel(label, options) as string;
      expect(line).toMatch(/^\{actor\.0\} is /);
      const rendered = render(line);
      expect(SPEAKER_RE.test(rendered)).toBe(false);
      expect(isDegeneratePreAction(rendered, line)).toBe(false);
    });
  });
});
