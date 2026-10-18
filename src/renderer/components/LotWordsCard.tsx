// The dev build's Lot Words panel on the Locations page: the furnishings on lots visited this
// app run that no rule puts into plain words, with a place to give them words. Saved words go
// into every description written after; "Copy for Claude" hands them over to ship for everyone.
import {
  Box,
  Button,
  Checkbox,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import ChairOutlinedIcon from '@mui/icons-material/ChairOutlined';
import { useCallback, useEffect, useState } from 'react';
import log from 'electron-log';
import { appApiUrl } from 'main/sentient-sims/constants';
import type { LotWordRow } from 'main/sentient-sims/services/LotWordsService';
import type { PlayerFurnishingWords } from 'main/sentient-sims/util/lotFurnishings';
import AppCard from '../AppCard';
import { useSnackBar } from '../providers/SnackBarProvider';

type Draft = { one: string; many: string; leaveOut: boolean };

function draftOf(row: LotWordRow): Draft {
  return { one: row.word?.one ?? '', many: row.word?.many ?? '', leaveOut: row.word === null };
}

// Blank rows stay unmapped
function wordsOf(drafts: Record<string, Draft>): PlayerFurnishingWords {
  const words: PlayerFurnishingWords = {};
  Object.entries(drafts).forEach(([name, draft]) => {
    if (draft.leaveOut) {
      words[name] = null;
    } else if (draft.one.trim()) {
      words[name] = { one: draft.one.trim(), many: draft.many.trim() || draft.one.trim() };
    }
  });
  return words;
}

async function loadRows(): Promise<LotWordRow[] | undefined> {
  try {
    const response = await fetch(`${appApiUrl}/lot-words`);
    return ((await response.json()) as { rows: LotWordRow[] }).rows;
  } catch (err) {
    log.error('Could not load lot words', err);
    return undefined;
  }
}

export default function LotWordsCard() {
  const { showMessage } = useSnackBar();
  const [rows, setRows] = useState<LotWordRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState(false);

  const show = useCallback((fresh: LotWordRow[]) => {
    setRows(fresh);
    setDrafts(Object.fromEntries(fresh.map((row) => [row.name, draftOf(row)])));
  }, []);

  const refresh = useCallback(() => {
    void (async () => {
      const fresh = await loadRows();
      if (fresh) {
        show(fresh);
      }
    })();
  }, [show]);

  useEffect(refresh, [refresh]);

  const edit = (name: string, change: Partial<Draft>) => {
    setDrafts((current) => ({ ...current, [name]: { ...current[name], ...change } }));
  };

  const save = async () => {
    setSaving(true);
    try {
      const response = await fetch(`${appApiUrl}/lot-words`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ words: wordsOf(drafts) }),
      });
      const body = (await response.json()) as { rows?: LotWordRow[]; error?: string };
      if (!response.ok || !body.rows) {
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      show(body.rows);
      showMessage('Lot words saved', 'success');
    } catch (err) {
      showMessage(`Could not save lot words: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const copyForClaude = async () => {
    const words = wordsOf(drafts);
    const lots = Object.fromEntries(rows.map((row) => [row.name, row.lots]));
    const handover = Object.fromEntries(
      Object.entries(words).map(([name, word]) => [name, { words: word, lots: lots[name] ?? [] }]),
    );
    await navigator.clipboard.writeText(JSON.stringify(handover, null, 2));
    showMessage(`Copied ${Object.keys(handover).length} lot words`, 'success');
  };

  return (
    <AppCard
      title="Lot Words"
      subtitle="Furnishings on the lots visited this run that the description writer has no plain words for"
      icon={<ChairOutlinedIcon fontSize="small" />}
    >
      {rows.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          Every furnishing on the lots visited so far has plain words. Visit a lot in game and press Refresh.
        </Typography>
      ) : (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Game name</TableCell>
              <TableCell>Seen on</TableCell>
              <TableCell>One</TableCell>
              <TableCell>More than one</TableCell>
              <TableCell padding="checkbox">
                <Tooltip title="Say nothing about it, like walls and lamps">
                  <span>Leave out</span>
                </Tooltip>
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row) => {
              const draft = drafts[row.name] ?? draftOf(row);
              return (
                <TableRow key={row.name}>
                  <TableCell sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{row.name}</TableCell>
                  <TableCell>
                    <Typography variant="caption" color="text.secondary">
                      {row.lots.join(', ') || 'not on a lot visited this run'}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <TextField
                      size="small"
                      placeholder="a dish rack"
                      value={draft.one}
                      disabled={draft.leaveOut}
                      onChange={(event) => {
                        edit(row.name, { one: event.target.value });
                      }}
                    />
                  </TableCell>
                  <TableCell>
                    <TextField
                      size="small"
                      placeholder="dish racks"
                      value={draft.many}
                      disabled={draft.leaveOut}
                      onChange={(event) => {
                        edit(row.name, { many: event.target.value });
                      }}
                    />
                  </TableCell>
                  <TableCell padding="checkbox">
                    <Checkbox
                      checked={draft.leaveOut}
                      onChange={(event) => {
                        edit(row.name, { leaveOut: event.target.checked });
                      }}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      <Box sx={{ display: 'flex', gap: 1, mt: 2 }}>
        <Button
          variant="contained"
          loading={saving}
          disabled={rows.length === 0}
          onClick={() => {
            void save();
          }}
        >
          Save
        </Button>
        <Button variant="outlined" onClick={refresh}>
          Refresh
        </Button>
        <Tooltip title="Copies the words as JSON, to paste to Claude so they ship for everyone">
          <span>
            <Button
              variant="outlined"
              color="secondary"
              disabled={Object.keys(wordsOf(drafts)).length === 0}
              onClick={() => {
                void copyForClaude();
              }}
            >
              Copy for Claude
            </Button>
          </span>
        </Tooltip>
      </Box>
    </AppCard>
  );
}
