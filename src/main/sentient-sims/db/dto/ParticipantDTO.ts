import { VoiceType } from '../../models/VoiceType';

// A voice the user pinned to a sim. The id is what drives playback so a voice keeps
// working after the user removes it from their collection (or it's a Kokoro blend like
// 'af_heart+af_sky'); the name is only kept for display.
export type ParticipantVoiceDTO = {
  voiceId: string;
  voiceName?: string;
};

export type ParticipantDTO = {
  id: string;
  description?: string;
  name?: string;
  // IPA for the name, read inline by Eleven v4. Undefined on a write means "leave the
  // stored value alone" (the mod's updates never carry it); an empty string clears it.
  pronunciation?: string;
  // Pinned voices keyed by voice type. A missing entry means that provider falls back
  // to automatic voice casting for this sim.
  voices?: Partial<Record<VoiceType, ParticipantVoiceDTO>>;
};

// POST /participants body: voice fields ride alongside the participant row. voiceId is
// only honored together with a voiceType; an empty voiceId clears that type's pin.
export type UpdateParticipantRequest = ParticipantDTO & {
  voiceType?: VoiceType;
  voiceId?: string;
  voiceName?: string;
};
