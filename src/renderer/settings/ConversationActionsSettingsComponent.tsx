import { Box, Checkbox, FormControlLabel, FormHelperText, Slider, Typography } from '@mui/material';
import { SettingsEnum } from 'main/sentient-sims/models/SettingsEnum';
import useSetting from '../hooks/useSetting';

// Whether a reply to the player (chat window, voice, Twitch) may turn into an action, and
// how sure the scorer has to be first. On the settings page so it can be switched off
// mid-stream without an app restart.
export default function ConversationActionsSettingsComponent() {
  const enabled = useSetting<boolean>(SettingsEnum.CONVERSATION_ACTIONS_ENABLED, true);
  const threshold = useSetting<number>(SettingsEnum.CONVERSATION_ACTION_SCORE_THRESHOLD, 8);

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        marginBottom: 2,
      }}
    >
      <FormControlLabel
        label="Conversations can lead to actions"
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
        When you talk to a sim and they come away wanting to do something, they do it once their reply has finished
        playing. It queues behind whatever they were doing and never overrides your own clicks. Off, the wish waits for
        their next cognition tick instead.
      </FormHelperText>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, marginTop: 1, paddingRight: 2 }}>
        <Typography sx={{ whiteSpace: 'nowrap' }}>Action score needed:</Typography>
        <Slider
          aria-label="Conversation action score threshold"
          disabled={!enabled.value}
          value={threshold.value}
          onChange={(change: Event, value: number | number[]) => {
            void threshold.setSetting(Array.isArray(value) ? value[0] : value);
          }}
          step={1}
          min={1}
          max={10}
          marks
          valueLabelDisplay="auto"
        />
      </Box>
      <FormHelperText>
        The scorer rates 1-10 how much the reply left the sim wanting to act. 8 means only a clear &quot;I really
        should&quot;; lower it and casual chat starts sending them off to do things.
      </FormHelperText>
    </Box>
  );
}
