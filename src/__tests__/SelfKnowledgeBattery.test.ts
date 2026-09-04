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
    expect(claimed.contradiction).toBe(true);
    // Both are his children, and naming a child as a parent is the precise complaint
    expect(claimed.reason).toContain('is their child');
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

  // Every answer below is verbatim from the live run of 2026-09-03. Five of them were
  // graded wrongly - two correct answers failed, three wrong ones passed - which is the
  // worst state a benchmark can be in, so each one is pinned here.
  describe('the live run of 2026-09-03', () => {
    // Mackenzie: child of Travis, sibling of Ariel, four in the household, no career
    const mackenzie: SimDossier = {
      sim_id: '200',
      name: 'Mackenzie Scott',
      age: 'ELDER',
      gender: 'MALE',
      family: { parents: ['100'], siblings: ['300'], children: [], steady_ids: [] },
      household: { id: '900', name: 'BFF', member_ids: ['100', '200', '300', '400'] },
      careers: [],
      relationships: [
        { sim_id: '100', name: 'Travis Scott', has_met: true, friendship: 80 },
        { sim_id: '300', name: 'Ariel Scott', has_met: true, friendship: 70 },
        { sim_id: '400', name: 'Summer Holiday', has_met: true, friendship: 60 },
        { sim_id: '500', name: 'Alice Landgraab', has_met: true, friendship: -20 },
      ],
    };
    // Summer: no family at all on record, so every family question is adversarial
    const summer: SimDossier = {
      sim_id: '400',
      name: 'Summer Holiday',
      age: 'ELDER',
      family: { parents: [], siblings: [], children: [], steady_ids: [] },
      household: { id: '900', name: 'BFF', member_ids: ['100', '200', '300', '400'] },
      relationships: [
        { sim_id: '100', name: 'Travis Scott', has_met: true, friendship: 60 },
        { sim_id: '200', name: 'Mackenzie Scott', has_met: true, friendship: 70 },
      ],
    };
    const question = (forSim: SimDossier, id: string) => {
      const found = buildQuestions(forSim).find((candidate) => candidate.id === id);
      if (!found) {
        throw new Error(`no question ${id}`);
      }
      return found;
    };

    it('C1: a relative named in their own role is not a confabulation', () => {
      // Flagged as a contradiction live. It is a correct answer that also mentions his real
      // sister, correctly, as his sister.
      const graded = gradeAnswer(
        question(mackenzie, 'SELF-parents'),
        "Mackenzie Scott: My dad's Travis Scott, and my sister's Ariel—family's complicated.",
      );
      expect(graded.pass).toBe(true);
      expect(graded.contradiction).toBe(false);
    });

    it('C1: and the same for a Sim who spells out that they are not parents', () => {
      const ariel: SimDossier = {
        ...mackenzie,
        sim_id: '300',
        name: 'Ariel Scott',
        age: 'ADULT',
        family: { parents: ['100'], siblings: ['200'], children: [], steady_ids: [] },
        relationships: [
          { sim_id: '100', name: 'Travis Scott', has_met: true, friendship: 80 },
          { sim_id: '200', name: 'Mackenzie Scott', has_met: true, friendship: 70 },
        ],
      };
      const graded = gradeAnswer(
        question(ariel, 'SELF-parents'),
        "Ariel Scott: My dad is Travis Scott, and my sister is Mackenzie, but they're not my parents.",
      );
      expect(graded.pass).toBe(true);
      expect(graded.contradiction).toBe(false);
    });

    it('C2: a relative named in the WRONG role is a contradiction, whatever was asked', () => {
      // This PASSED the household question live: he named two people he does live with,
      // and called his sister one of his parents on the way past
      const graded = gradeAnswer(
        question(mackenzie, 'SELF-household'),
        'Mackenzie Scott: I live with my parents, Travis and Ariel.',
      );
      expect(graded.pass).toBe(false);
      expect(graded.contradiction).toBe(true);
      expect(graded.reason).toContain('Ariel Scott');
      expect(graded.reason).toContain('is their sibling');
    });

    it('C3: a denial that takes itself back is not a denial', () => {
      // Passed live. The game records no partner for her.
      const graded = gradeAnswer(
        question(mackenzie, 'SELF-partner'),
        "Ariel Scott: No, not married. I'm seeing someone, but it's complicated.",
      );
      expect(graded.pass).toBe(false);
      expect(graded.contradiction).toBe(true);
      expect(graded.reason).toContain('seeing someone');
    });

    it('C3: a plain denial still passes, negations included', () => {
      const partner = question(mackenzie, 'SELF-partner');
      expect(gradeAnswer(partner, "Mackenzie Scott: No, I'm not seeing anyone right now.").pass).toBe(true);
      expect(gradeAnswer(partner, 'Not dating anyone, no.').pass).toBe(true);
      expect(gradeAnswer(partner, "Nah, I'm flying solo these days, just focusing on me.").pass).toBe(true);
    });

    it('C3: an invention with no name in it fails too', () => {
      // Summer has no siblings on record. Nothing in the old grader looked at this: there
      // is no name to catch, only a claim.
      const graded = gradeAnswer(
        question(summer, 'SELF-siblings'),
        "Summer Holiday: Yeah, I have a sister and a brother, but we're not that close these days.",
      );
      expect(graded.pass).toBe(false);
      expect(gradeAnswer(question(summer, 'SELF-siblings'), "No, I don't have any siblings.").pass).toBe(true);
    });

    it('C4: retired is a correct answer to the job question, and vagueness is not', () => {
      const job = question(mackenzie, 'SELF-job');
      expect(job.mode).toBe('denial');
      expect(gradeAnswer(job, "Mackenzie Scott: I'm retired, mostly.").pass).toBe(true);
      expect(gradeAnswer(job, 'Not working these days.').pass).toBe(true);
      // ...and the live answer that should keep failing
      expect(
        gradeAnswer(job, "Mackenzie Scott: I'm mostly wrapped up in reading and thinking. Keeps things quiet.").pass,
      ).toBe(false);
    });

    it('C5: a name belonging to nobody is reported as a warning', () => {
      // "helped Jess with dinner plans" - live, and no other check in the battery sees it
      const graded = gradeAnswer(
        question(summer, 'SELF-household'),
        'Summer Holiday: I had a little spat with Ariel but then helped Jess with dinner plans.',
      );
      expect(graded.warnings).toContain('Jess');
      // A person she really knows is not a warning
      expect(graded.warnings).not.toContain('Travis');
    });

    it('C5: warnings are reported for the manually judged questions too', () => {
      const summerWithMemories = buildQuestions(summer, ['Summer Holiday (diary): a quiet day']);
      const memory = summerWithMemories.find((candidate) => candidate.id === 'MEM-today');
      if (!memory) throw new Error('no memory question');
      const graded = gradeAnswer(memory, 'Summer Holiday: I helped Jess with dinner plans.');
      expect(graded.reason).toBe('needs a person to judge it');
      expect(graded.warnings).toContain('Jess');
    });

    it('C6: the reason finishes its sentence and the flag drives the headline', () => {
      const graded = gradeBattery('200', 'Mackenzie Scott', [
        { question: question(mackenzie, 'SELF-parents'), answer: 'My parents are Alice Landgraab.' },
        {
          question: question(mackenzie, 'SELF-household'),
          answer: 'Mackenzie Scott: I live with my parents, Travis and Ariel.',
        },
        { question: question(summer, 'SELF-household'), answer: 'I helped Jess with dinner.', exchangeIds: [4447] },
      ]);
      expect(graded.results[0].reason).toContain('who is not a parent');
      expect(graded.contradictions).toHaveLength(2);
      expect(graded.warnings.some((warning) => warning.includes('Jess'))).toBe(true);
      expect(graded.results[2].exchangeIds).toEqual([4447]);
    });
  });
});
