import { Box, FormHelperText, MenuItem, TextField } from '@mui/material';
import { SettingsEnum } from 'main/sentient-sims/models/SettingsEnum';
import useSetting from '../hooks/useSetting';

// DEV: where Plum thinks. API is the key under Plum below; Claude Code is a local session on
// the developer's own Claude plan (services/plum/ClaudeCodeBrain.ts, scripts/plum-claude/).
// Switching is instant both ways and loses nothing.
export default function PlumBrainSettingsComponent() {
  const brain = useSetting(SettingsEnum.PLUM_BRAIN, 'api');

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', marginBottom: 2, gap: 1 }}>
      <TextField
        select
        label="Plum's brain"
        size="small"
        value={brain.value === 'claude-code' ? 'claude-code' : 'api'}
        onChange={(change) => {
          void brain.setSetting(change.target.value);
        }}
      >
        <MenuItem value="api">API (the Anthropic key under Plum)</MenuItem>
        <MenuItem value="claude-code">Claude Code (dev)</MenuItem>
      </TextField>
      <FormHelperText>
        Claude Code: start it in a second terminal with <code>npm run plum:claude</code> and keep that terminal off the
        stream. Attended sessions only. Switch back to API any time; nothing is lost.
      </FormHelperText>
    </Box>
  );
}
