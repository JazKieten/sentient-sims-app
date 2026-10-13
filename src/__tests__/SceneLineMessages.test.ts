import { vi, describe, it, expect, beforeEach } from 'vitest';

const { sendModNotification } = vi.hoisted(() => ({ sendModNotification: vi.fn() }));
vi.mock('main/sentient-sims/websocketServer', () => ({ sendModNotification }));

// Imported after the mock so notifyRenderer sends through the fake socket
const { sendSceneLineToMod, sendSceneLineEndedToMod, sendSceneEndedToMod, sendSceneLineRevealUpdateToMod } =
  await import('main/sentient-sims/util/notifyRenderer');

function sent(): Record<string, unknown> {
  const call = sendModNotification.mock.calls.at(-1);
  if (!call) {
    throw new Error('Nothing was sent to the mod');
  }
  return call[0] as Record<string, unknown>;
}

describe('scene messages to the mod', () => {
  beforeEach(() => {
    sendModNotification.mockClear();
  });

  it('names the conversation and everyone in it on every line', () => {
    // Sim ids, not names: two sims in one household can share a first name, and the
    // mod follows the conversation's sims to know when they stop being together
    sendSceneLineToMod({
      speaker: 'Bella Goth',
      text: 'Been fishing here for years.',
      simId: '2',
      sceneId: 'scene-7',
      participantSimIds: ['1', '2'],
    });

    expect(sent()).toMatchObject({
      type: 'scene_line',
      speaker: 'Bella Goth',
      scene_id: 'scene-7',
      speaker_sim_id: '2',
      participant_sim_ids: ['1', '2'],
    });
  });

  it('leaves a solo line unwatched', () => {
    // A sim answering the player alone has no partner to walk away from
    sendSceneLineToMod({ speaker: 'The Voice', text: 'Hello?' });

    expect(sent()).toMatchObject({ type: 'scene_line', scene_id: undefined, participant_sim_ids: undefined });
  });

  it('tags a line ending with its conversation', () => {
    sendSceneLineEndedToMod({ speaker: 'Bella Goth', text: 'Been fishing.', sceneId: 'scene-7' });

    expect(sent()).toEqual({ type: 'scene_line_ended', speaker: 'Bella Goth', scene_id: 'scene-7' });
  });

  it('says when more of the same line follows, on the line and on its ending', () => {
    // A long reply to the player airs in sentence chunks; the mod keeps the mouth open
    // through the breath between them instead of closing it at every chunk's end
    sendSceneLineToMod({ speaker: 'Bella Goth', text: 'First sentence.', simId: '2', continues: true });
    expect(sent()).toMatchObject({ type: 'scene_line', continues: true });

    sendSceneLineEndedToMod({ speaker: 'Bella Goth', text: 'First sentence.', sceneId: 'scene-7', continues: true });
    expect(sent()).toMatchObject({ type: 'scene_line_ended', scene_id: 'scene-7', continues: true });

    // The last chunk (and every ordinary line) carries nothing
    sendSceneLineEndedToMod({ speaker: 'Bella Goth', text: 'Last sentence.', sceneId: 'scene-7' });
    expect(sent()).toEqual({
      type: 'scene_line_ended',
      speaker: 'Bella Goth',
      scene_id: 'scene-7',
      continues: undefined,
    });
  });

  it('tells the mod when the conversation is over', () => {
    sendSceneEndedToMod('scene-7', 'stopped');

    expect(sent()).toEqual({ type: 'scene_ended', scene_id: 'scene-7', reason: 'stopped' });
  });

  describe('word reveal', () => {
    // 'one two three' with every character 100 ms: words start at 0, 400, 800
    const charMs = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200];

    it('sends the word times in snake_case, counted on the text the mod shows', () => {
      // 'one <two> three': the markup is neutralized one codepoint for one, so the
      // third word still starts at its tenth character
      sendSceneLineToMod({
        speaker: 'Bella Goth',
        text: 'one <two> three',
        simId: '2',
        reveal: {
          charMs: [...charMs, 1300, 1400],
          partial: false,
          startedAtMs: 1760400000123,
          rate: 1.25,
          source: 'elevenlabs',
        },
        followsClock: true,
      });

      expect(sent()).toMatchObject({
        type: 'scene_line',
        text: 'one ‹two› three',
        reveal: {
          word_ms: [0, 400, 1000],
          started_at_ms: 1760400000123,
          rate: 1.25,
          follows_clock: true,
          partial: false,
          source: 'elevenlabs',
        },
      });
    });

    it('omits the reveal when the line has no timing', () => {
      sendSceneLineToMod({ speaker: 'Bella Goth', text: 'Plain.', simId: '2' });

      expect('reveal' in sent()).toBe(false);
    });

    it('follows the clock unless told otherwise, and carries ready-made word times', () => {
      sendSceneLineToMod({
        speaker: 'Bella Goth',
        text: 'one two',
        reveal: { wordMs: [0, 500], partial: false, startedAtMs: 5, rate: 1, source: 'estimate' },
      });
      expect(sent()).toMatchObject({ reveal: { word_ms: [0, 500], follows_clock: true, source: 'estimate' } });

      sendSceneLineToMod({
        speaker: 'Bella Goth',
        text: 'one two',
        reveal: { wordMs: [0, 500], partial: false, startedAtMs: 5, rate: 1, source: 'estimate' },
        followsClock: false,
      });
      expect(sent()).toMatchObject({ reveal: { follows_clock: false } });
    });

    it('marks a streamed prefix partial', () => {
      sendSceneLineToMod({
        speaker: 'Bella Goth',
        text: 'one two three',
        reveal: { charMs: charMs.slice(0, 5), partial: true, startedAtMs: 5, rate: 1, source: 'elevenlabs' },
      });

      expect(sent()).toMatchObject({ reveal: { word_ms: [0, 400], partial: true } });
    });

    it('sends the rest of a streamed line’s times as an update', () => {
      sendSceneLineRevealUpdateToMod({
        speaker: 'Bella Goth',
        text: 'one two three',
        sceneId: 'scene-7',
        reveal: { charMs, partial: false },
      });

      expect(sent()).toEqual({
        type: 'scene_line_reveal_update',
        speaker: 'Bella Goth',
        text: 'one two three',
        scene_id: 'scene-7',
        reveal: { word_ms: [0, 400, 800], partial: false },
      });
    });
  });
});
