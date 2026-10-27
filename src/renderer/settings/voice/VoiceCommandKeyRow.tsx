// AUTONOMY tier (release 4.5): the voice settings' command chord. What you say while holding
// it is an order the sim carries out, which only the autonomy tier can do; moved out of
// VoiceInputSettingsComponent, which renders it only when this tier is present.
import { Stack, Typography } from '@mui/material';
import { SettingsEnum } from 'main/sentient-sims/models/SettingsEnum';
import { voiceHotkeyLabel } from 'main/sentient-sims/models/VoiceHotkeyPresets';
import useSetting from '../../hooks/useSetting';
import type { VoiceCommandRowProps } from '../../tiers/types';
import VoiceHotkeySelect from './VoiceHotkeySelect';

export default function VoiceCommandKeyRow({ talkHotkey, presets }: VoiceCommandRowProps) {
  const { isMac } = window.electron;
  const commandHotkey = useSetting<string>(SettingsEnum.VOICE_COMMAND_HOTKEY, '');

  // A saved chord the list no longer offers keeps a row of its own
  const offered = presets.filter((preset) => preset.value !== talkHotkey);
  const saved = commandHotkey.value;
  if (saved && !offered.some((preset) => preset.value === saved)) {
    offered.push({ value: saved, label: voiceHotkeyLabel(saved, isMac) });
  }

  return (
    <Stack spacing={2} direction="row" sx={{ alignItems: 'center' }}>
      <Typography sx={{ minWidth: 110 }}>Command key:</Typography>
      <VoiceHotkeySelect
        value={commandHotkey.value}
        presets={offered}
        onChange={(chord) => void commandHotkey.setSetting(chord)}
        leading={{ value: '', label: 'Off' }}
      />
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        Hold this one and what you say is an ORDER the sim carries out, not talk.
      </Typography>
    </Stack>
  );
}
