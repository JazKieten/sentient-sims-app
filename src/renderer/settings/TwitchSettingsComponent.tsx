import { useEffect, useState } from 'react';
import SyncIcon from '@mui/icons-material/Sync';
import {
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Divider,
  FormControl,
  FormControlLabel,
  FormHelperText,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { SettingsEnum } from 'main/sentient-sims/models/SettingsEnum';
import { ApiType } from 'main/sentient-sims/models/ApiType';
import { defaultTwitchChatVoiceId, defaultTwitchCommandWord } from 'main/sentient-sims/constants';
import { TwitchChatStatus, TwitchDeviceLoginStart } from 'main/sentient-sims/models/TwitchChatStatus';
import useSetting from 'renderer/hooks/useSetting';
import HelpButton from 'renderer/components/HelpButton';
import { useElevenLabsVoices } from 'renderer/hooks/useElevenLabsVoices';
import { useAISettings } from 'renderer/providers/AISettingsProvider';
import { TestVoiceButton } from 'renderer/components/VoiceTestButton';

function stateChip(status?: TwitchChatStatus) {
  if (!status || status.state === 'disabled') {
    return <Chip size="small" label="Off" />;
  }
  if (status.state === 'connected') {
    return <Chip size="small" color="success" label={`Connected to #${status.channel}`} />;
  }
  if (status.state === 'error') {
    return <Chip size="small" color="error" label="Error" />;
  }
  return (
    <Chip size="small" color="warning" label={status.state === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'} />
  );
}

// Twitch !ask: viewers' chat questions are read from the channel (no login needed for
// reading) and delivered to the active sim as the player-voice persona. The optional
// account login below powers the followers-only gate.
export default function TwitchSettingsComponent() {
  const enabled = useSetting<boolean>(SettingsEnum.TWITCH_CHAT_ENABLED, false);
  const channel = useSetting<string>(SettingsEnum.TWITCH_CHANNEL, '');
  const commandWord = useSetting<string>(SettingsEnum.TWITCH_COMMAND_WORD, defaultTwitchCommandWord);
  const askPermission = useSetting<string>(SettingsEnum.TWITCH_ASK_PERMISSION, 'everyone');
  const viewerCooldown = useSetting<number>(SettingsEnum.TWITCH_VIEWER_COOLDOWN_SECONDS, 0);
  const globalCooldown = useSetting<number>(SettingsEnum.TWITCH_GLOBAL_COOLDOWN_SECONDS, 0);
  const followersOnly = useSetting<boolean>(SettingsEnum.TWITCH_FOLLOWERS_ONLY, true);
  const clientId = useSetting<string>(SettingsEnum.TWITCH_CLIENT_ID, '');
  const aliases = useSetting<string>(SettingsEnum.TWITCH_SIM_ALIASES, '');
  const speakQuestions = useSetting<boolean>(SettingsEnum.TWITCH_SPEAK_QUESTIONS, true);
  const chatVoiceId = useSetting<string>(SettingsEnum.TWITCH_CHAT_VOICE_ID, '');
  const { ttsApiType, ttsEnabled } = useAISettings();
  const { cache: voicesCache, isRefreshing, refresh } = useElevenLabsVoices();

  const [status, setStatus] = useState<TwitchChatStatus>();
  const [loginStart, setLoginStart] = useState<TwitchDeviceLoginStart>();
  const [loginBusy, setLoginBusy] = useState(false);
  // A dev hot-reload can pair this component with an app whose preload predates the
  // tier bridge; computed at render so the settings route degrades instead of crashing
  const staleBridge = typeof (window.electron as Partial<typeof window.electron>).tierInvoke !== 'function';

  useEffect(() => {
    if (staleBridge) {
      return undefined;
    }
    void (async () => {
      try {
        const initial = await window.electron.tierInvoke('twitch-status-get');
        // A live push may have landed first; the seed must not clobber it
        setStatus((prev) => prev ?? initial);
      } catch {
        // main process not ready yet; pushes will follow
      }
    })();
    const unsubscribe = window.electron.tierOn('twitch-status', (_event, next) => {
      setStatus(next);
    });
    return () => {
      unsubscribe();
    };
  }, [staleBridge]);

  async function startLogin() {
    setLoginBusy(true);
    setLoginStart(undefined);
    try {
      setLoginStart(await window.electron.tierInvoke('twitch-login-start'));
    } finally {
      setLoginBusy(false);
    }
  }

  const loggedIn = status?.auth.loggedIn ?? false;

  return (
    <Box sx={{ width: '100%' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', marginBottom: 1 }}>
        <FormControlLabel
          label="Enable Twitch chat questions (!ask)"
          control={
            <Checkbox checked={enabled.value} onChange={(change) => void enabled.setSetting(change.target.checked)} />
          }
        />
        <HelpButton url="https://dev.twitch.tv/console" />
        {stateChip(status)}
      </Box>
      <FormHelperText sx={{ marginBottom: 2 }}>
        Viewers type {commandWord.value || defaultTwitchCommandWord} plus a question and your active Sim answers, or
        they can name any Sim on the lot ({commandWord.value || defaultTwitchCommandWord} lillie how are you) to make
        that Sim answer — even mid-conversation. Questions get their own {'"'}Chat{'"'} section in the in-game memories
        window, answers play aloud, and OBS picks everything up through game capture and desktop audio.
      </FormHelperText>
      {staleBridge ? (
        <FormHelperText error sx={{ marginBottom: 2 }}>
          Restart the Sentient Sims app to finish enabling the Twitch integration.
        </FormHelperText>
      ) : null}
      {enabled.value ? (
        <Stack spacing={2} sx={{ maxWidth: 640 }}>
          <Stack spacing={2} direction="row" sx={{ alignItems: 'center' }}>
            <Typography sx={{ minWidth: 130 }}>Channel:</Typography>
            <TextField
              size="small"
              fullWidth
              value={channel.value}
              placeholder="your Twitch channel name"
              onChange={(change) => void channel.setSetting(change.target.value)}
            />
          </Stack>
          <Stack spacing={2} direction="row" sx={{ alignItems: 'center' }}>
            <Typography sx={{ minWidth: 130 }}>Command:</Typography>
            <TextField
              size="small"
              value={commandWord.value}
              onChange={(change) => void commandWord.setSetting(change.target.value)}
            />
            <Typography sx={{ minWidth: 90 }}>Who can ask:</Typography>
            <Select
              size="small"
              value={askPermission.value}
              onChange={(change) => void askPermission.setSetting(change.target.value)}
            >
              <MenuItem value="everyone">Everyone</MenuItem>
              <MenuItem value="subs">Subscribers</MenuItem>
              <MenuItem value="mods">Mods only</MenuItem>
            </Select>
          </Stack>
          <Stack spacing={2} direction="row" sx={{ alignItems: 'center' }}>
            <Typography sx={{ minWidth: 130 }}>Cooldowns (sec):</Typography>
            <TextField
              size="small"
              type="number"
              label="Per viewer"
              sx={{ width: 120 }}
              value={viewerCooldown.value}
              onChange={(change) => void viewerCooldown.setSetting(Number(change.target.value))}
            />
            <TextField
              size="small"
              type="number"
              label="Everyone"
              sx={{ width: 120 }}
              value={globalCooldown.value}
              onChange={(change) => void globalCooldown.setSetting(Number(change.target.value))}
            />
            {status?.queueDepth ? (
              <Typography variant="body2">{status.queueDepth} question(s) queued</Typography>
            ) : null}
          </Stack>
          <FormHelperText>
            Cooldowns are off by default: every ask is accepted and answered strictly in order. If a message never shows
            up here at all, Twitch AutoMod may be holding it before it reaches chat — approve it or relax AutoMod in
            your Twitch moderation settings.
          </FormHelperText>
          <Stack spacing={2} direction="row" sx={{ alignItems: 'center' }}>
            <Typography sx={{ minWidth: 130 }}>Extra targets:</Typography>
            <TextField
              size="small"
              fullWidth
              multiline
              minRows={1}
              value={aliases.value}
              placeholder="Grim Reaper=153992008478429871"
              onChange={(change) => void aliases.setSetting(change.target.value)}
              helperText="Name=simId per line. Lets chat !ask sims the game reports without a name (service NPCs like the Grim Reaper) — even when they aren't on the lot."
            />
          </Stack>
          {status?.lastEvent ? (
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {status.lastEvent}
            </Typography>
          ) : null}
          <Divider />
          <FormControlLabel
            label="Give chat a voice: speak each question aloud (ElevenLabs)"
            control={
              <Checkbox
                checked={speakQuestions.value}
                onChange={(change) => void speakQuestions.setSetting(change.target.checked)}
              />
            }
          />
          {speakQuestions.value ? (
            <>
              <Stack spacing={1} direction="row" sx={{ alignItems: 'center' }}>
                <FormControl size="small" sx={{ minWidth: 260 }}>
                  <InputLabel id="twitch-chat-voice-label">Chat voice</InputLabel>
                  <Select
                    labelId="twitch-chat-voice-label"
                    label="Chat voice"
                    value={chatVoiceId.value}
                    onChange={(change) => void chatVoiceId.setSetting(change.target.value)}
                  >
                    <MenuItem value="">Default (Charlie)</MenuItem>
                    {/* A voice removed from My Voices still plays, so keep it selectable */}
                    {chatVoiceId.value && !voicesCache.voices.some((voice) => voice.voiceId === chatVoiceId.value) ? (
                      <MenuItem value={chatVoiceId.value}>{`${chatVoiceId.value} (removed)`}</MenuItem>
                    ) : null}
                    {voicesCache.voices.map((voice) => (
                      <MenuItem key={voice.voiceId} value={voice.voiceId}>
                        {voice.name}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <Tooltip title="Refresh voices from ElevenLabs">
                  <span>
                    <IconButton
                      disabled={isRefreshing}
                      onClick={() => {
                        void refresh();
                      }}
                    >
                      {isRefreshing ? <CircularProgress size={20} /> : <SyncIcon />}
                    </IconButton>
                  </span>
                </Tooltip>
                <TestVoiceButton voiceId={chatVoiceId.value || defaultTwitchChatVoiceId} />
              </Stack>
              {ttsApiType !== ApiType.ElevenLabs || !ttsEnabled ? (
                <FormHelperText error>
                  Questions are only spoken while TTS is enabled and set to ElevenLabs in the Voice settings.
                </FormHelperText>
              ) : null}
            </>
          ) : null}
          <Divider />
          <FormControlLabel
            label="Only followers can ask"
            control={
              <Checkbox
                checked={followersOnly.value}
                onChange={(change) => void followersOnly.setSetting(change.target.checked)}
              />
            }
          />
          {followersOnly.value ? (
            <Stack spacing={2}>
              {loggedIn ? (
                <Stack spacing={2} direction="row" sx={{ alignItems: 'center' }}>
                  <Chip size="small" color="success" label={`Twitch account: ${status?.auth.login ?? 'connected'}`} />
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={() => void window.electron.tierInvoke('twitch-logout')}
                  >
                    Disconnect
                  </Button>
                </Stack>
              ) : (
                <>
                  <FormHelperText>
                    Checking who follows you needs a one-time Twitch login. Create a (free) application at
                    dev.twitch.tv/console (type: Device Code Grant, any name), paste its Client ID here, then connect.
                  </FormHelperText>
                  <Stack spacing={2} direction="row" sx={{ alignItems: 'center' }}>
                    <Typography sx={{ minWidth: 130 }}>Client ID:</Typography>
                    <TextField
                      size="small"
                      fullWidth
                      value={clientId.value}
                      onChange={(change) => void clientId.setSetting(change.target.value)}
                    />
                    <Button
                      variant="outlined"
                      disabled={loginBusy || !clientId.value}
                      onClick={() => void startLogin()}
                    >
                      Connect
                    </Button>
                  </Stack>
                  {loginStart?.error ? <FormHelperText error>{loginStart.error}</FormHelperText> : null}
                  {loginStart?.userCode ? (
                    <Stack spacing={2} direction="row" sx={{ alignItems: 'center' }}>
                      <Typography>
                        Enter code <b>{loginStart.userCode}</b> at
                      </Typography>
                      <Button
                        size="small"
                        variant="outlined"
                        onClick={() => {
                          window.electron.openBrowserLink(
                            loginStart.verificationUri ?? 'https://www.twitch.tv/activate',
                          );
                        }}
                      >
                        twitch.tv/activate
                      </Button>
                    </Stack>
                  ) : null}
                  <FormHelperText error>
                    While no account is connected, follower-gated questions are dropped.
                  </FormHelperText>
                </>
              )}
            </Stack>
          ) : null}
        </Stack>
      ) : null}
    </Box>
  );
}
