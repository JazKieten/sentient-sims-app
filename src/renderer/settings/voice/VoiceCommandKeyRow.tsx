// AUTONOMY tier (release 4.5): the voice settings' command chord. What you say while holding
// it is an order the sim carries out, which only the autonomy tier can do; moved out of
// VoiceInputSettingsComponent, which renders it only when this tier is present.
import { Stack, Typography } from '@mui/material';
import { SettingsEnum } from 'main/sentient-sims/models/SettingsEnum';
import useSetting from '../../hooks/useSetting';
import type { VoiceCommandRowProps } from '../../tiers/types';
import VoiceHotkeySelect from './VoiceHotkeySelect';

export default function VoiceCommandKeyRow({ talkHotkey, presets }: VoiceCommandRowProps) {
  const commandHotkey = useSetting<string>(SettingsEnum.VOICE_COMMAND_HOTKEY, '');

  return (
    <Stack spacing={2} direction="row" sx={{ alignItems: 'center' }}>
      <Typography sx={{ minWidth: 110 }}>Command key:</Typography>
      <VoiceHotkeySelect
        value={commandHotkey.value}
        presets={presets.filter((preset) => preset.value !== talkHotkey)}
        onChange={(chord) => void commandHotkey.setSetting(chord)}
        leading={{ value: '', label: 'Off' }}
      />
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        Hold this one and what you say is an ORDER the sim carries out, not talk.
      </Typography>
    </Stack>
  );
}
