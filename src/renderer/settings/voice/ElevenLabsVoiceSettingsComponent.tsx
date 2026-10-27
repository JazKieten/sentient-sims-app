import {
  Avatar,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Divider,
  FormControlLabel,
  FormHelperText,
  MenuItem,
  Paper,
  Select,
  Slider,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import {
  defaultElevenLabsTTSSettings,
  ElevenLabsSpeechModel,
  ElevenLabsTTSSettings,
  ElevenLabsVoiceSettings,
  toSpeechModel,
} from 'main/sentient-sims/models/ElevenLabsTTSSettings';
import { SettingsEnum } from 'main/sentient-sims/models/SettingsEnum';
import { useMemo } from 'react';
import { TestVoiceButton } from 'renderer/components/VoiceTestButton';
import useSetting from 'renderer/hooks/useSetting';
import handleOpenExternalLink from 'renderer/hooks/handleOpenExternalLink';
import { useTTS } from 'renderer/providers/AudioContextProvider';
import { ElevenLabsVoiceInfo } from 'main/sentient-sims/clients/ElevenLabsVoiceRequest';
import {
  isElevenLabsV4,
  resolvedVoiceSettings,
  supportsAudioTags,
} from 'main/sentient-sims/clients/ElevenLabsTTSRequest';
import { useElevenLabsVoiceInfo } from 'renderer/voice/useElevenLabsVoiceInfo';
import { ElevenLabsKeySetup } from './ElevenLabsKeySetup';

const voiceLibraryUrl = 'https://elevenlabs.io/app/voice-library';

function ElevenLabsVoiceCard({ voice }: { voice: ElevenLabsVoiceInfo }) {
  return (
    <Paper
      variant="outlined"
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        padding: 2,
        marginBottom: 2,
        borderColor: 'divider',
        backgroundColor: 'background.default',
      }}
    >
      <Avatar src={voice.imageUrl} alt={voice.name} sx={{ width: 56, height: 56 }}>
        {voice.name.charAt(0).toUpperCase()}
      </Avatar>
      <Box sx={{ minWidth: 0 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography sx={{ fontWeight: 600 }}>{voice.name}</Typography>
          {voice.category ? <Chip size="small" variant="outlined" label={voice.category} /> : null}
        </Stack>
        {voice.labels.length > 0 ? (
          <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5, marginTop: 0.5 }}>
            {voice.labels.map((label) => (
              <Chip key={label.name} size="small" title={label.name} label={label.value} />
            ))}
          </Stack>
        ) : null}
        {voice.description ? (
          <Typography variant="body2" color="text.secondary" sx={{ marginTop: 0.5 }}>
            {voice.description}
          </Typography>
        ) : null}
        {voice.redirectedTo ? (
          <Typography variant="caption" color="warning.main" sx={{ display: 'block', marginTop: 0.5 }}>
            This ID is retired. ElevenLabs plays it as the voice above — use {voice.redirectedTo} instead.
          </Typography>
        ) : null}
      </Box>
    </Paper>
  );
}

export function ElevenLabsVoiceSettingsComponent() {
  const tts = useTTS();
  const voiceInfo = useElevenLabsVoiceInfo();
  const elevenLabsTTSSettings = useSetting<ElevenLabsTTSSettings>(
    SettingsEnum.ELEVENLABS_TTS_SETTINGS,
    defaultElevenLabsTTSSettings,
  );

  const modelMenuItems = useMemo(() => {
    return Object.values(ElevenLabsSpeechModel).map((model) => (
      <MenuItem key={model} value={model}>
        {model}
      </MenuItem>
    ));
  }, []);

  // Keeps the card from describing a voice the user has already typed away from
  const loadedVoice = voiceInfo.voice?.voiceId === elevenLabsTTSSettings.value.voice ? voiceInfo.voice : undefined;

  // What the sliders show: the stored values with legacy gaps filled, exactly what the
  // request builder sends
  const voiceSettings = resolvedVoiceSettings(elevenLabsTTSSettings.value);
  const isV4 = isElevenLabsV4(elevenLabsTTSSettings.value.model);
  const moodTagsOn = elevenLabsTTSSettings.value.moodTags ?? true;

  function handleModelChange(model: string) {
    void elevenLabsTTSSettings.setSetting({
      ...elevenLabsTTSSettings.value,
      model: toSpeechModel(model),
    });
  }

  function handleVoiceChange(voice: string) {
    void elevenLabsTTSSettings.setSetting({
      ...elevenLabsTTSSettings.value,
      voice: voice.trim(),
    });
  }

  // Writes the WHOLE resolved object so a legacy stored object (no stability) becomes a
  // current one on the first slider move, instead of staying legacy for the other slider
  function handleVoiceSettingChange(change: Partial<ElevenLabsVoiceSettings>) {
    void elevenLabsTTSSettings.setSetting({
      ...elevenLabsTTSSettings.value,
      voice_settings: { ...voiceSettings, ...change },
    });
  }

  function handleMoodTagsChange(enabled: boolean) {
    void elevenLabsTTSSettings.setSetting({
      ...elevenLabsTTSSettings.value,
      moodTags: enabled,
    });
  }

  return (
    <Box sx={{ maxWidth: 560 }}>
      <Typography variant="subtitle1">ElevenLabs</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', marginBottom: 2 }}>
        Speech generated with voices from your ElevenLabs account.
      </Typography>
      <Box sx={{ marginBottom: 2 }}>
        <Typography variant="body2" sx={{ color: 'text.secondary', marginBottom: 0.75 }}>
          Speech model
        </Typography>
        <Select
          size="small"
          labelId="tts-models"
          id="tts-models"
          label="TTS Model"
          value={elevenLabsTTSSettings.value.model}
          sx={{ width: '100%' }}
          onChange={(change) => {
            handleModelChange(change.target.value);
          }}
        >
          {modelMenuItems}
        </Select>
        {isElevenLabsV4(elevenLabsTTSSettings.value.model) ? (
          <FormHelperText>
            Eleven v4 reads delivery notes as audio tags and has no speed setting; lines air at the model&apos;s own
            pace.
          </FormHelperText>
        ) : null}
      </Box>
      {tts.error ? (
        <Box sx={{ marginBottom: 2 }}>
          <FormHelperText error>Error: {tts.error}</FormHelperText>
        </Box>
      ) : null}
      <Box sx={{ marginBottom: 1 }}>
        <Typography variant="body2" sx={{ color: 'text.secondary', marginBottom: 0.75 }}>
          Voice
        </Typography>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
          <TextField
            label="Default Voice ID"
            variant="outlined"
            size="small"
            fullWidth
            value={elevenLabsTTSSettings.value.voice}
            onChange={(change) => {
              handleVoiceChange(change.target.value);
            }}
          />
          <TestVoiceButton onTest={() => void voiceInfo.loadVoice(elevenLabsTTSSettings.value.voice)} />
        </Stack>
      </Box>
      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: 'center',
          flexWrap: 'wrap',
          marginBottom: 2,
        }}
      >
        <Button size="small" startIcon={<OpenInNewIcon />} onClick={handleOpenExternalLink(voiceLibraryUrl)}>
          Voice Library
        </Button>
        <FormHelperText sx={{ margin: 0 }}>
          Pick a voice, click its <MoreVertIcon sx={{ fontSize: 'inherit', verticalAlign: 'middle' }} /> menu, choose
          &quot;Copy voice ID&quot;, then paste it above.
        </FormHelperText>
      </Stack>
      {voiceInfo.isLoading ? (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', marginBottom: 2 }}>
          <CircularProgress size={16} />
          <Typography variant="body2" color="text.secondary">
            Looking up voice...
          </Typography>
        </Stack>
      ) : null}
      {voiceInfo.error ? (
        <Box sx={{ marginBottom: 2 }}>
          <FormHelperText error>{voiceInfo.error}</FormHelperText>
        </Box>
      ) : null}
      {loadedVoice ? <ElevenLabsVoiceCard voice={loadedVoice} /> : null}
      <Box sx={{ marginBottom: 1 }}>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          Stability: {voiceSettings.stability.toFixed(2)}
        </Typography>
        <Slider
          size="small"
          min={0}
          max={1}
          step={0.05}
          value={voiceSettings.stability}
          onChange={(_event, value) => {
            handleVoiceSettingChange({ stability: value });
          }}
        />
        <FormHelperText sx={{ marginTop: -1 }}>
          Lower is more expressive, higher is steadier. v3 snaps to Creative (0), Natural (0.5) or Robust (1).
        </FormHelperText>
      </Box>
      <Box sx={{ marginBottom: 1 }}>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          Similarity: {voiceSettings.similarity_boost.toFixed(2)}
        </Typography>
        <Slider
          size="small"
          min={0}
          max={1}
          step={0.05}
          value={voiceSettings.similarity_boost}
          onChange={(_event, value) => {
            handleVoiceSettingChange({ similarity_boost: value });
          }}
        />
        <FormHelperText sx={{ marginTop: -1 }}>How closely the read sticks to the original voice.</FormHelperText>
      </Box>
      {isV4 ? null : (
        <Box sx={{ marginBottom: 1 }}>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            Speed: {voiceSettings.speed.toFixed(2)}
          </Typography>
          <Slider
            size="small"
            min={0.7}
            max={1.2}
            step={0.05}
            value={voiceSettings.speed}
            onChange={(_event, value) => {
              handleVoiceSettingChange({ speed: value });
            }}
          />
          <FormHelperText sx={{ marginTop: -1 }}>Not available on Eleven v4.</FormHelperText>
        </Box>
      )}
      <Box sx={{ marginBottom: 2 }}>
        <FormControlLabel
          control={
            <Checkbox
              size="small"
              checked={moodTagsOn}
              onChange={(_event, checked) => {
                handleMoodTagsChange(checked);
              }}
              disabled={!supportsAudioTags(elevenLabsTTSSettings.value.model)}
            />
          }
          label="Deliver lines in the speaker's mood"
        />
        <FormHelperText sx={{ marginTop: -0.5 }}>
          Prefixes each line with an audio tag for the sim&apos;s current mood (angry, cheerful, nervous...). v3 and v4
          only.
        </FormHelperText>
      </Box>
      <Divider sx={{ marginBottom: 2.5 }} />
      <ElevenLabsKeySetup />
    </Box>
  );
}
