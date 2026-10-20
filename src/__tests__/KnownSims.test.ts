import { afterEach, describe, expect, it } from 'vitest';
import { SimAge } from 'main/sentient-sims/models/SimAge';
import { SentientSim } from 'main/sentient-sims/models/SentientSim';
import { VoiceType } from 'main/sentient-sims/models/VoiceType';
import { withKnownSpeakers } from 'main/sentient-sims/services/AIService';
import { castElevenLabsVoice } from 'main/sentient-sims/formatter/ElevenLabsVoiceCasting';
import { castVoicesForLines } from 'main/sentient-sims/formatter/VoiceCasting';
import { clearKnownSims, knownSim, rememberSims } from 'main/sentient-sims/util/knownSims';

// A Plum whisper's thought is voiced with no cast, only the speaker's simId: the sim the
// game last sent under that id casts the voice, so it is never the narrator's
function makeSim(name: string, simId: string, extra: Partial<SentientSim> = {}): SentientSim {
  return {
    careers: [],
    name,
    age: SimAge.ADULT,
    sim_id: simId,
    gender: 'Male',
    traits: [],
    moods: [],
    is_ghost: false,
    grubby: false,
    in_pool: false,
    is_at_home: false,
    is_dying: false,
    is_human: true,
    is_inside_building: false,
    is_outside: false,
    is_pet: false,
    on_fire: false,
    on_home_lot: false,
    sleeping: false,
    is_pregnant: false,
    is_player_sim: false,
    ...extra,
  };
}

const JONAH = makeSim('Jonah Alder', '11', { traits: ['trait_Gloomy'] });
const thought = { speaker: 'Jonah Alder (to self)', text: 'A walk would clear my head.', simId: '11' };

describe('known sims', () => {
  afterEach(() => {
    clearKnownSims();
  });

  it('a whisper line with no cast takes the voice of the sim the game sent', () => {
    rememberSims([JONAH]);
    const cast = withKnownSpeakers([thought], undefined) ?? [];
    expect(cast).toEqual([JONAH]);
    const [line] = castVoicesForLines([thought], cast, VoiceType.ElevenLabs);
    expect(line.voiceId).toBe(castElevenLabsVoice(JONAH));
  });

  it('a pinned voice still wins for a sim found by id', () => {
    rememberSims([JONAH]);
    const cast = withKnownSpeakers([thought], undefined) ?? [];
    const [line] = castVoicesForLines([thought], cast, VoiceType.ElevenLabs, new Map([['11', 'pinned-voice']]));
    expect(line.voiceId).toBe('pinned-voice');
  });

  it('a cast that already holds the speaker is left alone', () => {
    rememberSims([makeSim('Jonah Alder', '11', { gender: 'Female' })]);
    expect(withKnownSpeakers([thought], [JONAH])).toEqual([JONAH]);
  });

  it('an unseen sim leaves the line uncast', () => {
    expect(withKnownSpeakers([thought], undefined)).toBeUndefined();
  });

  it('the newest send of a sim replaces the older one', () => {
    rememberSims([JONAH]);
    rememberSims([{ ...JONAH, moods: ['Sad'] }]);
    expect(knownSim('11')?.moods).toEqual(['Sad']);
  });
});
