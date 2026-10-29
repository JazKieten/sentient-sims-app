import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Chip,
  CircularProgress,
  FormControlLabel,
  MenuItem,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useMemo, useState } from 'react';
import { AIExchangeSummary } from 'main/sentient-sims/models/AIExchangeLog';
import { AIActionType, AIActionTypeName } from 'main/sentient-sims/models/AIActionType';
import { AIProviderConfig } from 'main/sentient-sims/models/AIProviderConfig';
import { SettingsEnum } from 'main/sentient-sims/models/SettingsEnum';
import AppCard from './AppCard';
import { LLMExchangeDetail } from './components/LLMExchangeDetail';
import { ReplayPanel } from './components/ReplayPanel';
import useSetting from './hooks/useSetting';
import { useAIExchange, useAIExchanges } from './hooks/useAIExchanges';
import { useDebugMode } from './providers/DebugModeProvider';

function formatTime(iso: string): string {
  const at = new Date(iso);
  return at.toLocaleTimeString(undefined, { hour12: false });
}

type ReplayPicks = {
  configs: AIProviderConfig[];
  selected: string[];
  onSelectedChange: (ids: string[]) => void;
};

const REPLAY_PICKS_KEY = 'aiLog.replayPicks';

function readReplayPicks(): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(REPLAY_PICKS_KEY) ?? '[]') as unknown;
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function ExchangeRow({ exchange, replay }: { exchange: AIExchangeSummary; replay: ReplayPicks }) {
  const [expanded, setExpanded] = useState(false);
  // Only fetch the (large) prompt once this row is actually opened
  const { exchange: detail, isLoading } = useAIExchange(expanded ? exchange.id : undefined);

  return (
    <Accordion
      disableGutters
      expanded={expanded}
      onChange={(_event, isExpanded) => {
        setExpanded(isExpanded);
      }}
      sx={{ mb: 0.5 }}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%', flexWrap: 'wrap' }}>
          <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
            {formatTime(exchange.at)}
          </Typography>
          <Typography variant="subtitle2">{exchange.label}</Typography>
          {exchange.error ? <Chip size="small" color="error" label="failed" /> : null}
          {exchange.memoryId !== undefined ? (
            <Chip size="small" variant="outlined" color="success" label={`memory ${exchange.memoryId}`} />
          ) : null}
          <Box sx={{ flexGrow: 1 }} />
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {exchange.model ?? 'default model'} · {(exchange.promptChars / 1000).toFixed(1)}k chars ·{' '}
            {(exchange.durationMs / 1000).toFixed(1)}s
          </Typography>
        </Box>
      </AccordionSummary>
      <AccordionDetails sx={{ pt: 0 }}>
        <Typography variant="body2" sx={{ color: 'text.secondary', fontStyle: 'italic', mb: 1 }}>
          {exchange.responsePreview || '(no response text)'}
        </Typography>
        {isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
            <CircularProgress size={24} />
          </Box>
        ) : null}
        {detail ? (
          <ReplayPanel
            exchangeId={exchange.id}
            configs={replay.configs}
            selected={replay.selected}
            onSelectedChange={replay.onSelectedChange}
          />
        ) : null}
        {detail ? (
          <LLMExchangeDetail
            messages={detail.request.messages}
            responseText={detail.responseText}
            error={detail.error}
          />
        ) : null}
      </AccordionDetails>
    </Accordion>
  );
}

/**
 * Dev-mode log of every call the app makes to an AI provider — scene pipelines, cognition
 * ticks, reflections, classifications, importance ratings — with the full prompt and
 * response behind each row.
 */
export default function AILogPage() {
  const debugMode = useDebugMode();
  const [live, setLive] = useState(true);
  const [search, setSearch] = useState('');
  const [actionFilter, setActionFilter] = useState<AIActionType | 'all'>('all');
  const { exchanges, isLoading } = useAIExchanges(live);
  const providerConfigs = useSetting<AIProviderConfig[]>(SettingsEnum.AI_PROVIDER_CONFIGS, []);
  const [replaySelected, setReplaySelected] = useState<string[]>(readReplayPicks);
  const replay: ReplayPicks = {
    configs: providerConfigs.value,
    selected: replaySelected,
    onSelectedChange: (ids) => {
      setReplaySelected(ids);
      try {
        localStorage.setItem(REPLAY_PICKS_KEY, JSON.stringify(ids));
      } catch {
        // a remembered pick is a convenience only
      }
    },
  };

  const actionTypes = useMemo(() => {
    const present = new Set<AIActionType>();
    exchanges.forEach((exchange) => {
      if (exchange.actionType) {
        present.add(exchange.actionType);
      }
    });
    return [...present].sort();
  }, [exchanges]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return exchanges.filter((exchange) => {
      if (actionFilter !== 'all' && exchange.actionType !== actionFilter) {
        return false;
      }
      if (!needle) {
        return true;
      }
      return (
        exchange.label.toLowerCase().includes(needle) ||
        exchange.responsePreview.toLowerCase().includes(needle) ||
        (exchange.model ?? '').toLowerCase().includes(needle)
      );
    });
  }, [exchanges, search, actionFilter]);

  if (!debugMode.isEnabled) {
    return <AppCard>The AI log is a dev mode tool. Press Ctrl+Shift+D to enable dev mode.</AppCard>;
  }

  return (
    <>
      <AppCard>
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
          <TextField
            size="small"
            label="Search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
            sx={{ minWidth: 220 }}
          />
          <TextField
            size="small"
            select
            label="Action type"
            value={actionFilter}
            onChange={(event) => {
              setActionFilter(event.target.value as AIActionType | 'all');
            }}
            sx={{ minWidth: 220 }}
          >
            <MenuItem value="all">All</MenuItem>
            {actionTypes.map((actionType) => (
              <MenuItem key={actionType} value={actionType}>
                {AIActionTypeName(actionType)}
              </MenuItem>
            ))}
          </TextField>
          <FormControlLabel
            control={
              <Switch
                checked={live}
                onChange={(event) => {
                  setLive(event.target.checked);
                }}
              />
            }
            label="Live"
          />
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {filtered.length} of {exchanges.length} calls this session
          </Typography>
        </Box>
      </AppCard>
      <Box sx={{ mt: 2 }}>
        {isLoading && exchanges.length === 0 ? <AppCard>Loading…</AppCard> : null}
        {!isLoading && exchanges.length === 0 ? (
          <AppCard>
            No AI calls yet this session. Play the game or generate a scene and they will appear here — the log is kept
            in memory only, so it starts empty each time the app launches.
          </AppCard>
        ) : null}
        {filtered.map((exchange) => (
          <ExchangeRow key={exchange.id} exchange={exchange} replay={replay} />
        ))}
      </Box>
    </>
  );
}
