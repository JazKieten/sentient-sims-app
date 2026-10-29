import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  CircularProgress,
  ListItemText,
  MenuItem,
  TextField,
  Typography,
} from '@mui/material';
import { useState } from 'react';
import { AIClient } from 'main/sentient-sims/clients/AIClient';
import { AIProviderConfig } from 'main/sentient-sims/models/AIProviderConfig';
import { ReplayAnswer, ReplayResult } from 'main/sentient-sims/models/AIExchangeLog';

const client = new AIClient();
const MAX_PICKS = 4;

function answerAsText(answer: ReplayAnswer): string {
  const head = `${answer.name}${answer.model ? ` (${answer.model})` : ''}, ${(answer.durationMs / 1000).toFixed(1)}s`;
  if (answer.error) {
    return `${head}: FAILED ${answer.error}`;
  }
  if (answer.say !== undefined) {
    return `${head}\n  SAY: ${answer.say || '(none)'}\n  THINK: ${answer.think || '(none)'}`;
  }
  return `${head}\n  ${answer.text}`;
}

function comparisonText(result: ReplayResult): string {
  return [
    `Replay of #${result.exchangeId} ${result.label}`,
    ...[result.original, ...result.replays].map(answerAsText),
  ].join('\n');
}

function AnswerCard({ answer }: { answer: ReplayAnswer }) {
  return (
    <Card variant="outlined" sx={{ flex: '1 1 240px', minWidth: 240 }}>
      <CardContent sx={{ '&:last-child': { pb: 1.5 } }}>
        <Typography variant="subtitle2">{answer.name}</Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 1 }}>
          {answer.model ?? 'default model'} · {(answer.durationMs / 1000).toFixed(1)}s
          {answer.sayWords !== undefined ? ` · ${answer.sayWords} words` : ''}
        </Typography>
        {answer.error ? <Alert severity="error">{answer.error}</Alert> : null}
        {!answer.error && answer.say !== undefined ? (
          <>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {answer.say || '(no spoken line)'}
            </Typography>
            <Typography variant="body2" sx={{ color: 'text.secondary', fontStyle: 'italic', mt: 0.5 }}>
              {answer.think || '(no thought)'}
            </Typography>
          </>
        ) : null}
        {!answer.error && answer.say === undefined ? (
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
            {answer.text || '(empty)'}
          </Typography>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * Sends one logged prompt, unchanged, to other provider presets and shows every answer next
 * to the original, so two models can be judged on exactly the same input.
 */
export function ReplayPanel({
  exchangeId,
  configs,
  selected,
  onSelectedChange,
}: {
  exchangeId: number;
  configs: AIProviderConfig[];
  selected: string[];
  onSelectedChange: (ids: string[]) => void;
}) {
  const [result, setResult] = useState<ReplayResult | undefined>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);
  const picks = selected.filter((id) => configs.some((config) => config.id === id));

  const replay = async () => {
    setRunning(true);
    setError(undefined);
    setCopied(false);
    try {
      setResult(await client.replayExchange(exchangeId, picks));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Box sx={{ mb: 2, p: 1.5, border: 1, borderColor: 'divider', borderRadius: 1 }}>
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
        <TextField
          select
          size="small"
          label={`Replay with (up to ${MAX_PICKS})`}
          sx={{ minWidth: 280 }}
          value={picks}
          onChange={(event) => {
            const value = event.target.value as unknown as string[];
            onSelectedChange(value.slice(0, MAX_PICKS));
          }}
          slotProps={{
            select: {
              multiple: true,
              renderValue: (value: unknown) =>
                (value as string[]).map((id) => configs.find((config) => config.id === id)?.name ?? id).join(', '),
            },
          }}
        >
          {configs.map((config) => (
            <MenuItem
              key={config.id}
              value={config.id}
              dense
              disabled={!picks.includes(config.id) && picks.length >= MAX_PICKS}
            >
              <Checkbox size="small" checked={picks.includes(config.id)} />
              <ListItemText primary={config.name} secondary={config.model} />
            </MenuItem>
          ))}
        </TextField>
        <Button
          variant="contained"
          size="small"
          disabled={picks.length === 0 || running}
          onClick={() => {
            void replay();
          }}
        >
          {result ? 'Replay again' : 'Replay'}
        </Button>
        {running ? <CircularProgress size={20} /> : null}
        {result ? (
          <Button
            size="small"
            onClick={() => {
              navigator.clipboard
                .writeText(comparisonText(result))
                .then(() => {
                  setCopied(true);
                  return undefined;
                })
                .catch(() => {
                  setCopied(false);
                });
            }}
          >
            {copied ? 'Copied' : 'Copy comparison'}
          </Button>
        ) : null}
      </Box>
      {error ? (
        <Alert severity="error" sx={{ mt: 1 }}>
          {error}
        </Alert>
      ) : null}
      {result ? (
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 1.5 }}>
          {[result.original, ...result.replays].map((answer, index) => (
            <AnswerCard key={answer.configId ?? `original-${index}`} answer={answer} />
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
