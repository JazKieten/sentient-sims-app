// V-3: who the player is when they speak into the game. The label is the speaker string
// on the player line and MUST stay byte-identical between the app (playerLine.speaker) and
// the mod (PLAYER_SPEAKER, pushed via update_setting) or the mod's 30s subtitle dedupe
// breaks and lines double.
export const PLAYER_VOICE_PERSONAS = ['voice', 'guardian_angel', 'conscience', 'imaginary_friend', 'player'] as const;
export type PlayerVoicePersona = (typeof PLAYER_VOICE_PERSONAS)[number];

export const PLAYER_VOICE_PERSONA_LABELS: Record<PlayerVoicePersona, string> = {
  voice: 'The Voice',
  guardian_angel: 'Guardian Angel',
  conscience: 'Conscience',
  imaginary_friend: 'Imaginary Friend',
  player: 'Player',
};

// The one semantic line the sim is told about what is speaking to them
export const PLAYER_VOICE_PERSONA_FLAVOR: Record<PlayerVoicePersona, string> = {
  voice: 'a disembodied voice only they can hear — calm, familiar, impossible to place',
  guardian_angel: 'their guardian angel: warm, protective, on their side no matter what',
  conscience: 'their own conscience: the quiet inner voice that knows what they should do',
  imaginary_friend: 'their imaginary friend from childhood, back for a chat — playful and loyal',
  player: 'a person who is not in the room but somehow knows them',
};

export function playerSpeakerLabel(persona: PlayerVoicePersona): string {
  return PLAYER_VOICE_PERSONA_LABELS[persona] ?? PLAYER_VOICE_PERSONA_LABELS.voice;
}
