import { describe, expect, it } from 'vitest';
import {
  buildQuestions,
  gradeAnswer,
  gradeBattery,
  mentions,
  stripSpeaker,
} from 'main/sentient-sims/bench/selfKnowledge';
import { SimDossier } from 'main/sentient-sims/models/SimDossier';

// H5: the acceptance battery. The value of it rests entirely on the graders being strict,
// so these tests are mostly about the ways a wrong answer could sneak through.
describe('self-knowledge battery', () => {
  const dossier: SimDossier = {
    sim_id: '100',
    name: 'Travis Scott',
    age: 'ELDER',
    family: { parents: [], siblings: [], children: ['200', '300'], steady_ids: [] },
    household: { id: '900', name: 'BFF', member_ids: ['100', '200', '300', '400'] },
    careers: [{ career: 'career_Adult_TechGuru', level: 4 }],
    likes: ['trait_SimPreference_Likes_Music_HipHop'],
    relationships: [
      { sim_id: '200', name: 'Mackenzie Scott', has_met: true, friendship: 100 },
      { sim_id: '300', name: 'Ariel Scott', has_met: true, friendship: 80 },
      { sim_id: '400', name: 'Summer Holiday', has_met: true, friendship: 60, romance: 55 },
      { sim_id: '500', name: 'Alice Landgraab', has_met: true, friendship: -40 },
    ],
  };

  const questions = buildQuestions(dossier);
  const byId = (id: string) => {
    const question = questions.find((candidate) => candidate.id === id);
    if (!question) {
      throw new Error(`no question ${id}`);
    }
    return question;
  };

  it('asks only questions the dossier can grade', () => {
    // A question with no oracle is noise in a graded battery
    expect(
      questions.every(
        (question) => question.mode === 'manual' || question.expected.length > 0 || question.mode === 'denial',
      ),
    ).toBe(true);
    expect(questions.map((question) => question.id)).toContain('SELF-children');
  });

  it('turns a family the Sim does not have into an adversarial question', () => {
    // Travis has no parents on record, so the only right answer is to say so
    const parents = byId('SELF-parents');
    expect(parents.mode).toBe('denial');
    expect(gradeAnswer(parents, "I don't have any parents around, honestly.").pass).toBe(true);
    expect(gradeAnswer(parents, 'My mother is Alice Landgraab.').pass).toBe(false);
  });

  it('fails an answer that names the wrong person in the right role', () => {
    const children = byId('SELF-children');
    expect(gradeAnswer(children, 'Mackenzie and Ariel.').pass).toBe(true);
    // Alice is someone he knows, but she is not his child
    const wrong = gradeAnswer(children, 'My kids are Mackenzie and Alice.');
    expect(wrong.pass).toBe(false);
    expect(wrong.reason).toContain('Alice');
  });

  it('fails a shotgun answer that lists everyone to be safe', () => {
    const children = byId('SELF-children');
    const shotgun = gradeAnswer(children, 'Mackenzie, Ariel, Summer, Alice, all of them really.');
    expect(shotgun.pass).toBe(false);
  });

  it('accepts a first name, which is what a Sim actually says', () => {
    expect(gradeAnswer(byId('SELF-children'), 'Just Mackenzie and the other one.').pass).toBe(true);
  });

  it('does not match a name inside another word', () => {
    expect(mentions('I went to the arielle cafe', 'Ariel Scott')).toBe(false);
    expect(mentions('Ariel, mostly.', 'Ariel Scott')).toBe(true);
  });

  it('grades the job from the career the game records', () => {
    const job = byId('SELF-job');
    expect(gradeAnswer(job, 'I work in tech, a Tech Guru gig.').pass).toBe(true);
    expect(gradeAnswer(job, 'I am a professional chef.').pass).toBe(false);
  });

  it('counts an empty answer as a failure, not as a skip', () => {
    expect(gradeAnswer(byId('SELF-job'), '   ').pass).toBe(false);
  });

  it('leaves the judgment questions to a person and out of the score', () => {
    const romance = byId('SOC-romance');
    expect(romance.mode).toBe('manual');
    const graded = gradeBattery('100', 'Travis Scott', [
      { question: byId('SELF-children'), answer: 'Mackenzie and Ariel.' },
      { question: romance, answer: 'She is everything to me.' },
    ]);
    // One auto-graded question, passed; the manual one is neither passed nor failed
    expect(graded.total).toBe(1);
    expect(graded.passed).toBe(1);
  });

  it('reports a contradiction separately from a mere miss', () => {
    const graded = gradeBattery('100', 'Travis Scott', [
      // wrong person in the role: a contradiction
      { question: byId('SELF-children'), answer: 'My kids are Alice and Summer.' },
      // vague but not false: just a miss
      { question: byId('SELF-job'), answer: 'A bit of this and that.' },
    ]);
    expect(graded.passed).toBe(0);
    expect(graded.contradictions).toHaveLength(1);
    expect(graded.contradictions[0]).toContain('SELF-children');
  });

  it('asks who a Sim lives with, and rejects a housemate who is not one', () => {
    const household = byId('SELF-household');
    expect(gradeAnswer(household, 'Mackenzie, Ariel and Summer.').pass).toBe(true);
    expect(gradeAnswer(household, 'I live with Alice.').pass).toBe(false);
  });

  it('reads a natural denial as a denial', () => {
    // Live 2026-09-03: "Nah, I'm flying solo these days" was failed as a non-denial, which
    // was the grader being wrong rather than the Sim
    const partner = byId('SELF-partner');
    expect(gradeAnswer(partner, "Nah, I'm flying solo these days, just focusing on me.").pass).toBe(true);
    expect(gradeAnswer(partner, 'Not really, no.').pass).toBe(true);
    // ...but naming someone is still a fail, whatever words surround it
    expect(gradeAnswer(partner, 'Nah, well, apart from Alice Landgraab I guess.').pass).toBe(false);
  });

  it('lets a denial mention real people in passing', () => {
    // Live 2026-09-03: "No, just my two kids, Ariel and Mackenzie" was failed as inventing
    // siblings. It is a correct denial that names his real children the way a person does.
    const siblings = byId('SELF-siblings');
    expect(gradeAnswer(siblings, 'No, just my two kids, Ariel and Mackenzie.').pass).toBe(true);
    // ...but asserting the role with no denial in it still fails
    const parents = byId('SELF-parents');
    const claimed = gradeAnswer(parents, "My mom's Mackenzie Scott, and Ariel Scott's my dad.");
    expect(claimed.pass).toBe(false);
    expect(claimed.reason).toContain('invented');
  });

  it('strips the speaker prefix a scene line carries', () => {
    // Live 2026-09-03: every answer arrived as "Travis Scott: ..." so a leading "No,"
    // was never at the start and correct denials were graded as failures
    const siblings = byId('SELF-siblings');
    expect(gradeAnswer(siblings, 'Travis Scott: No, just my two kids, Ariel and Mackenzie.').pass).toBe(true);
    expect(stripSpeaker('Travis Scott: No, none at all.')).toBe('No, none at all.');
    // A colon inside a real sentence is not a speaker prefix
    expect(stripSpeaker('Here is the thing: I have no siblings.')).toBe('Here is the thing: I have no siblings.');
  });

  it('accepts a life stage said the way a person says it', () => {
    const age = byId('SELF-age');
    expect(gradeAnswer(age, "I'm getting on a bit these days.").pass).toBe(true);
    expect(gradeAnswer(age, 'Older than I look, retired now.').pass).toBe(true);
    expect(gradeAnswer(age, 'Somewhere between holding on and letting go.').pass).toBe(false);
  });

  it('leaves likes to a person, because a tuning name is not a sentence', () => {
    const likes = byId('SELF-likes');
    expect(likes.mode).toBe('manual');
  });

  it('accepts any of the equally-closest friends', () => {
    // Friendship saturates at 100, so "who are you closest to" often has several right
    // answers; failing a Sim for naming the other one was the grader's fault (live 2026-09-03)
    const tied = buildQuestions({
      ...dossier,
      relationships: [
        { sim_id: '200', name: 'Mackenzie Scott', has_met: true, friendship: 100 },
        { sim_id: '300', name: 'Ariel Scott', has_met: true, friendship: 100 },
        { sim_id: '500', name: 'Alice Landgraab', has_met: true, friendship: -40 },
      ],
    });
    const closest = tied.find((question) => question.id === 'SOC-bestfriend');
    if (!closest) throw new Error('no closest-friend question');
    expect(closest.expected.length).toBe(2);
    expect(gradeAnswer(closest, 'Mackenzie, easily.').pass).toBe(true);
    expect(gradeAnswer(closest, "Ariel, she's the one.").pass).toBe(true);
  });

  it('takes a number as an answer to how old are you', () => {
    expect(gradeAnswer(byId('SELF-age'), "I'm pushing past sixty these days.").pass).toBe(true);
  });

  it('only asks about a closest friend when there is a real one', () => {
    const lonely = buildQuestions({
      sim_id: '1',
      relationships: [{ sim_id: '2', name: 'Someone', has_met: true, friendship: 5 }],
    });
    expect(lonely.some((question) => question.id === 'SOC-bestfriend')).toBe(false);
  });
});
