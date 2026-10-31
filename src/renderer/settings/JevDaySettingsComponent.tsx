import { Box, FormControlLabel, FormHelperText, Switch } from '@mui/material';
import { SettingsEnum } from 'main/sentient-sims/models/SettingsEnum';
import useSetting from '../hooks/useSetting';

// The one switch between the two autonomies (Scott, 2026-10-27): on, the Jev day (the rows
// decide what could happen, Jev decides whether and which, the pie menu, the moment gate,
// the night call, a thought on the beats that matter); off, release/4.6's autonomy (the
// per-tick monologue, scores and three-stage Action Scene over the whitelist). Flipping it
// takes effect on the next tick; no restart.
export default function JevDaySettingsComponent() {
  const jevDay = useSetting<boolean>(SettingsEnum.JEV_DAY_AUTONOMY, false);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', marginBottom: 2 }}>
      <FormControlLabel
        label="Jev-day autonomy"
        control={
          <Switch
            checked={jevDay.value}
            onChange={(change) => {
              void jevDay.setSetting(change.target.checked);
            }}
          />
        }
      />
      <FormHelperText>
        On: the intention rows say what each sim could do, Jev (a typed decision model, 0.2 s a call) says whether and
        which, clicks come from the game&apos;s own pie menu, and a sim thinks out loud only on the beats that matter.
        Off: the 4.6 autonomy as shipped, a monologue, scores and a three-stage action scene on the text model every
        tick, over the 61-verb list.
      </FormHelperText>
    </Box>
  );
}
