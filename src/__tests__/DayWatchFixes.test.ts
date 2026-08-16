import { describe, expect, it } from 'vitest';
import { humanizeOutcomeReason } from 'main/sentient-sims/controllers/CognitionController';
import { offeredActions, validateIntent } from 'main/sentient-sims/models/CognitionIntent';
import { formatPerception } from 'main/sentient-sims/util/formatPerception';
import { buildCognitionUserPrompt } from 'main/sentient-sims/util/formatCognitionPrompt';
import { PerceptionSnapshot } from 'main/sentient-sims/models/PerceptionSnapshot';
import { SimStateEntry } from 'main/sentient-sims/models/SimStateReport';

// Regressions for the 2026-08-16 day-watch findings (see
// .claude/sentience-phase-2/DAY-WATCH-2026-08-16.md in the mod repo).

describe('FINDING D - engine reprs never reach a memory row', () => {
  it('cleans a repr the mod truncated mid-shell', () => {
    // The mod caps a reason at 300 chars, so the closing brackets are gone and neither
    // whole-string unwrap could match. Stored as "<EnqueueResult: ..." in memories
    // 2036 and 2124 (neutralized to a guillemet by the display layer).
    const raw =
      '<EnqueueResult: True <ExecuteResult: Interaction finished during append.  Finishing Info: ' +
      "FinishingType.DISPLACED: (None) - Interaction <class 'sims4.tuning.instances";

    const cleaned = humanizeOutcomeReason(raw);

    expect(cleaned).not.toContain('<');
    expect(cleaned).not.toContain('EnqueueResult');
    expect(cleaned).toContain('Interaction finished during append.');
  });

  it('still keeps the human sentence of a well-formed repr', () => {
    expect(
      humanizeOutcomeReason(
        '<EnqueueResult: Inadequate relationship level (4.21875 not within [50.0,100.0]) between  and . <ExecuteResult: False: (None)>>',
      ),
    ).toBe('Inadequate relationship level (4.21875 not within [50.0,100.0]) between the two of them.');
  });
});

describe('FINDING F - a sleeping sim is not a social target', () => {
  const sleeper: SimStateEntry = {
    sim_id: '100',
    sims: [{ sim_id: '200', tier: 'same_room', name: 'Mackenzie Scott', asleep: true, social: { has_met: true } }],
  } as SimStateEntry;

  it('marks the target asleep in the offered vocabulary', () => {
    expect(offeredActions(sleeper).simTargets.get('200')?.asleep).toBe(true);
  });

  it('refuses a social toward them instead of dispatching a doomed push', () => {
    // Live: three 'chat' pushes at a napping sim, each INTERACTION_INCOMPATIBILITY
    const result = validateIntent({ kind: 'action', action: 'chat', target_sim_id: '200' }, sleeper);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('asleep');
  });

  it('still allows socials toward an awake sim', () => {
    const awake: SimStateEntry = {
      sim_id: '100',
      sims: [{ sim_id: '200', tier: 'same_room', name: 'Mackenzie Scott', social: { has_met: true } }],
    } as SimStateEntry;

    expect(validateIntent({ kind: 'action', action: 'chat', target_sim_id: '200' }, awake).ok).toBe(true);
  });

  it('leaves a sleeping sim out of the offered targets while perception still shows them', () => {
    const prompt = buildCognitionUserPrompt(
      {
        sim_id: '100',
        sim_name: 'Travis Scott',
        sims: [
          { sim_id: '200', tier: 'same_room', distance: 2, name: 'Mackenzie Scott', asleep: true },
          { sim_id: '300', tier: 'same_room', distance: 3, name: 'Liberty Lee' },
        ],
        objects: [],
      },
      undefined,
    );

    expect(prompt).toContain('Mackenzie Scott (asleep, 2m away)');
    expect(prompt).toContain('OFFERED people to talk to: Liberty Lee (sim_id 300');
    expect(prompt).not.toContain('sim_id 200');
  });

  it('says "asleep" in the perception prose rather than an activity to interrupt', () => {
    const snapshot: PerceptionSnapshot = {
      sim_id: '1',
      sims: [{ sim_id: '2', tier: 'same_room', distance: 2, name: 'Mackenzie Scott', doing: 'nap', asleep: true }],
      objects: [],
    };

    expect(formatPerception(snapshot)).toContain('Mackenzie Scott (asleep, 2m away)');
  });
});
