import { Box, Checkbox, FormControlLabel, FormHelperText, TextField, Typography } from '@mui/material';
import { SettingsEnum } from 'main/sentient-sims/models/SettingsEnum';
import { defaultPlumModel, unattendedPlumDirectorModel } from 'main/sentient-sims/constants';
import useSetting from '../hooks/useSetting';
import APIKeyInput from '../APIKeyInput';

// Plum: Claude in the game, the second tab of the mod's memories window. Bring your own
// Anthropic key for now; the model loop runs in this app (PlumService).
export default function PlumSettingsComponent() {
  const enabled = useSetting(SettingsEnum.PLUM_ENABLED, true);
  const apiKey = useSetting(SettingsEnum.PLUM_API_KEY, '');
  const model = useSetting(SettingsEnum.PLUM_MODEL, defaultPlumModel);
  const directorModel = useSetting(SettingsEnum.PLUM_DIRECTOR_MODEL, '');
  const allowWrites = useSetting(SettingsEnum.PLUM_ALLOW_WRITES, true);
  const whisperVoiced = useSetting(SettingsEnum.PLUM_WHISPER_VOICED, true);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', marginBottom: 2, gap: 1 }}>
      <Typography variant="subtitle1">Plum</Typography>
      <FormControlLabel
        label="Plum (Claude in the game)"
        control={
          <Checkbox
            checked={enabled.value}
            onChange={(change) => {
              void enabled.setSetting(change.target.checked);
            }}
          />
        }
      />
      <FormHelperText>
        Plum lives in the Plum tab of the in-game memories window (Ctrl+M). Ask what the household is up to, why a Sim
        is doing something, or to change things. Every tool call shows as a row. Plum is Claude Opus, running on your
        own Anthropic API key.
      </FormHelperText>
      <APIKeyInput setting={apiKey} aiName="Anthropic (Plum)" optional />
      <TextField
        label="Plum model"
        size="small"
        value={model.value}
        onChange={(change) => {
          void model.setSetting(change.target.value);
        }}
        helperText={`An Anthropic model id; ${defaultPlumModel} is the default.`}
      />
      <TextField
        label="Director model"
        size="small"
        value={directorModel.value}
        placeholder={`same as Plum model (${model.value || defaultPlumModel})`}
        slotProps={{ inputLabel: { shrink: true } }}
        onChange={(change) => {
          void directorModel.setSetting(change.target.value);
        }}
        helperText={
          `The model for director ticks and script wake-ups. Empty: the Plum model above. For an unattended run set ` +
          `${unattendedPlumDirectorModel} (about 30x cheaper than Opus; Sonnet is not worth switching to).`
        }
      />
      <FormControlLabel
        label="Plum may change things"
        control={
          <Checkbox
            checked={allowWrites.value}
            onChange={(change) => {
              void allowWrites.setSetting(change.target.checked);
            }}
          />
        }
      />
      <FormHelperText>
        Off: Plum can only look (lot, Sims, memories) and refuses every tool that moves money, Sims, moods or settings.
      </FormHelperText>
      <FormControlLabel
        label="Voice a Sim's thought when they go along with a whisper"
        control={
          <Checkbox
            checked={whisperVoiced.value}
            onChange={(change) => {
              void whisperVoiced.setSetting(change.target.checked);
            }}
          />
        }
      />
      <FormHelperText>
        Plum can whisper to a Sim as a voice in their head; a Sim who agrees has a thought about it that shows in the
        game. On, the thought is spoken in their voice; off, it is only shown.
      </FormHelperText>
    </Box>
  );
}
