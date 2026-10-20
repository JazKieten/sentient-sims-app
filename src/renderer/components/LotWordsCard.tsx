// The dev build's Lot Words panel on the Locations page: the furnishings on lots visited this
// app run that no rule puts into plain words. Each comes with a first guess (the AI's, or one
// read off the name) to accept or correct; saved rows leave the queue for the Done list.
// Saved words go into every description written after; "Copy for Claude" hands them over to
// ship for everyone.
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  Checkbox,
  Chip,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import ChairOutlinedIcon from '@mui/icons-material/ChairOutlined';
import CheckIcon from '@mui/icons-material/Check';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useCallback, useEffect, useRef, useState } from 'react';
import log from 'electron-log';
import { appApiUrl } from 'main/sentient-sims/constants';
import type { LotWordRow, LotWords } from 'main/sentient-sims/services/LotWordsService';
import {
  Article,
  articleFor,
  FurnishingWord,
  PlayerFurnishingWords,
  pluralOf,
  splitArticle,
  withArticle,
} from 'main/sentient-sims/util/lotFurnishings';
import AppCard from '../AppCard';
import { useSnackBar } from '../providers/SnackBarProvider';

type Drafts = Record<string, Draft | undefined>;

type Draft = {
  article: Article;
  noun: string;
  plural: string;
  leaveOut: boolean;
  // Accepted or edited by the player: only these leave the queue on Save
  accepted: boolean;
  // The player picked the article or typed the plural, so the noun no longer sets them
  articleSet: boolean;
  pluralSet: boolean;
  // A Done row to forget, so it goes back to the queue
  forget: boolean;
};

function draftFrom(word: FurnishingWord | null | undefined, accepted: boolean): Draft {
  const base = { accepted, articleSet: false, pluralSet: false, forget: false };
  if (word === null) {
    return { ...base, article: 'a', noun: '', plural: '', leaveOut: true };
  }
  if (!word) {
    return { ...base, article: 'a', noun: '', plural: '', leaveOut: false };
  }
  const { article, noun } = splitArticle(word.one);
  return { ...base, article, noun, plural: word.many === word.one ? '' : word.many, leaveOut: false };
}

function draftOf(row: LotWordRow): Draft {
  return row.word !== undefined ? draftFrom(row.word, true) : draftFrom(row.suggestion?.word, false);
}

function autoPlural(draft: Draft): string {
  return draft.article === 'none' ? draft.noun.trim() : pluralOf(draft.noun);
}

// What a draft saves as: null leaves the name out, undefined saves nothing
function wordOf(draft: Draft): FurnishingWord | null | undefined {
  if (draft.forget || !draft.accepted) {
    return undefined;
  }
  if (draft.leaveOut) {
    return null;
  }
  const typed = splitArticle(draft.noun);
  const noun = draft.article !== 'none' && typed.article !== 'none' ? typed.noun : draft.noun.trim();
  if (!noun) {
    return undefined;
  }
  return { one: withArticle(noun, draft.article), many: draft.plural.trim() || autoPlural({ ...draft, noun }) };
}

function wordsOf(drafts: Drafts): PlayerFurnishingWords {
  const words: PlayerFurnishingWords = {};
  Object.entries(drafts).forEach(([name, draft]) => {
    const word = draft && wordOf(draft);
    if (word !== undefined) {
      words[name] = word;
    }
  });
  return words;
}

const SUGGESTION_LABELS = { ai: 'AI guess', name: 'Guess from the name' };

async function request(method: 'GET' | 'PUT' | 'POST', route: string, body?: unknown): Promise<LotWords> {
  const response = await fetch(`${appApiUrl}${route}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await response.json()) as Partial<LotWords> & { error?: string };
  if (!response.ok || !json.rows || !json.lots) {
    throw new Error(json.error ?? `HTTP ${response.status}`);
  }
  return json as LotWords;
}

type RowProps = {
  row: LotWordRow;
  draft: Draft;
  inQueue: boolean;
  onChange: (name: string, change: Partial<Draft>) => void;
};

function WordRow({ row, draft, inQueue, onChange }: RowProps) {
  const edit = (change: Partial<Draft>) => {
    onChange(row.name, { ...change, accepted: true });
  };
  const disabled = draft.leaveOut || draft.forget;
  return (
    <TableRow sx={{ opacity: draft.forget ? 0.5 : 1 }}>
      <TableCell sx={{ maxWidth: 260 }}>
        <Typography variant="body2" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
          {row.name}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {row.lots.join(', ') || 'not on a lot visited this run'}
        </Typography>
      </TableCell>
      <TableCell>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <ToggleButtonGroup
            size="small"
            exclusive
            disabled={disabled}
            value={draft.article}
            onChange={(_event, article: Article | null) => {
              if (article) {
                edit({ article, articleSet: true });
              }
            }}
          >
            <ToggleButton value="a">a</ToggleButton>
            <ToggleButton value="an">an</ToggleButton>
            <Tooltip title="No article, for words like art supplies">
              <ToggleButton value="none">none</ToggleButton>
            </Tooltip>
          </ToggleButtonGroup>
          <TextField
            size="small"
            placeholder="dish rack"
            value={draft.noun}
            disabled={disabled}
            onChange={(event) => {
              const noun = event.target.value;
              const typed = splitArticle(noun);
              // Typing "a dish rack" moves the article into the toggle
              if (typed.article !== 'none') {
                edit({ noun: typed.noun, article: typed.article, articleSet: true });
                return;
              }
              const article = draft.articleSet || !noun.trim() ? draft.article : articleFor(noun);
              edit({ noun, article });
            }}
          />
        </Box>
      </TableCell>
      <TableCell>
        <TextField
          size="small"
          placeholder={autoPlural(draft) || 'dish racks'}
          value={draft.plural}
          disabled={disabled}
          onChange={(event) => {
            edit({ plural: event.target.value, pluralSet: true });
          }}
        />
      </TableCell>
      <TableCell padding="checkbox">
        <Checkbox
          checked={draft.leaveOut}
          disabled={draft.forget}
          onChange={(event) => {
            edit({ leaveOut: event.target.checked });
          }}
        />
      </TableCell>
      <TableCell sx={{ whiteSpace: 'nowrap' }}>
        {inQueue && !draft.accepted && row.suggestion && (
          <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
            <Chip
              size="small"
              variant="outlined"
              color={row.suggestion.source === 'ai' ? 'info' : 'default'}
              label={SUGGESTION_LABELS[row.suggestion.source]}
            />
            <Tooltip title="Accept this guess">
              <IconButton
                size="small"
                color="success"
                onClick={() => {
                  onChange(row.name, { accepted: true });
                }}
              >
                <CheckIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
        )}
        {inQueue && draft.accepted && wordOf(draft) !== undefined && (
          <Chip size="small" color="success" variant="outlined" label="Ready to save" />
        )}
        {!inQueue && (
          <Tooltip title={draft.forget ? 'Keep these words' : 'Forget these words and put it back in the queue'}>
            <IconButton
              size="small"
              onClick={() => {
                onChange(row.name, { forget: !draft.forget });
              }}
            >
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </TableCell>
    </TableRow>
  );
}

function WordTable({
  rows,
  drafts,
  inQueue,
  onChange,
}: {
  rows: LotWordRow[];
  drafts: Drafts;
  inQueue: boolean;
  onChange: RowProps['onChange'];
}) {
  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          <TableCell>Game name, seen on</TableCell>
          <TableCell>One</TableCell>
          <TableCell>More than one</TableCell>
          <TableCell padding="checkbox">
            <Tooltip title="Say nothing about it, like walls and lamps">
              <span>Leave out</span>
            </Tooltip>
          </TableCell>
          <TableCell />
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((row) => (
          <WordRow
            key={row.name}
            row={row}
            draft={drafts[row.name] ?? draftOf(row)}
            inQueue={inQueue}
            onChange={onChange}
          />
        ))}
      </TableBody>
    </Table>
  );
}

export default function LotWordsCard() {
  const { showMessage } = useSnackBar();
  const [data, setData] = useState<LotWords>({ rows: [], lots: [], unsuggested: 0 });
  const [drafts, setDrafts] = useState<Drafts>({});
  const [saving, setSaving] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const askedForSuggestionsRef = useRef(false);

  // A fresh list keeps what the player has already accepted or edited in the queue
  const show = useCallback((fresh: LotWords) => {
    setData(fresh);
    setDrafts((current) =>
      Object.fromEntries(
        fresh.rows.map((row) => {
          const kept = current[row.name];
          return [row.name, row.word === undefined && kept?.accepted ? kept : draftOf(row)];
        }),
      ),
    );
  }, []);

  const suggest = useCallback(async () => {
    setSuggesting(true);
    try {
      show(await request('POST', '/lot-words/suggest'));
    } catch (err) {
      showMessage(`Could not get AI guesses: ${err instanceof Error ? err.message : String(err)}`, 'warning');
    } finally {
      setSuggesting(false);
    }
  }, [show, showMessage]);

  const refresh = useCallback(() => {
    void (async () => {
      try {
        const fresh = await request('GET', '/lot-words');
        show(fresh);
        if (fresh.unsuggested > 0 && !askedForSuggestionsRef.current) {
          askedForSuggestionsRef.current = true;
          await suggest();
        }
      } catch (err) {
        log.error('Could not load lot words', err);
      }
    })();
  }, [show, suggest]);

  useEffect(refresh, [refresh]);

  const change = useCallback((name: string, update: Partial<Draft>) => {
    setDrafts((current) => {
      const previous = current[name];
      if (!previous) {
        return current;
      }
      const next = { ...previous, ...update };
      if (!next.pluralSet && ('noun' in update || 'article' in update)) {
        next.plural = '';
      }
      return { ...current, [name]: next };
    });
  }, []);

  const queue = data.rows.filter((row) => row.word === undefined);
  const done = data.rows.filter((row) => row.word !== undefined);
  const ready = queue.filter((row) => {
    const draft = drafts[row.name];
    return draft && wordOf(draft) !== undefined;
  }).length;
  const guessed = queue.filter((row) => row.suggestion && !drafts[row.name]?.accepted).length;

  const save = async () => {
    setSaving(true);
    try {
      show(await request('PUT', '/lot-words', { words: wordsOf(drafts) }));
      showMessage(
        ready > 0 ? `Saved words for ${ready} ${ready === 1 ? 'furnishing' : 'furnishings'}` : 'Lot words saved',
        'success',
      );
    } catch (err) {
      showMessage(`Could not save lot words: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const acceptAll = () => {
    setDrafts((current) => {
      const next = { ...current };
      queue.forEach((row) => {
        const draft = next[row.name];
        if (row.suggestion && draft && !draft.accepted) {
          next[row.name] = { ...draft, accepted: true };
        }
      });
      return next;
    });
  };

  // Saved words only, so a guess nobody accepted never ships
  const copyForClaude = async () => {
    const handover = Object.fromEntries(done.map((row) => [row.name, { words: row.word, lots: row.lots }]));
    await navigator.clipboard.writeText(JSON.stringify(handover, null, 2));
    showMessage(`Copied ${done.length} lot words`, 'success');
  };

  return (
    <AppCard
      title="Lot Words"
      subtitle="Furnishings on the lots visited this run that the description writer has no plain words for"
      icon={<ChairOutlinedIcon fontSize="small" />}
    >
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        Needs words ({queue.length})
      </Typography>
      {suggesting && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Asking the AI for words for {data.unsuggested} {data.unsuggested === 1 ? 'name' : 'names'}...
        </Typography>
      )}
      {queue.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          Every furnishing on the lots visited so far has plain words. Visit a lot in game and press Refresh.
        </Typography>
      ) : (
        <WordTable rows={queue} drafts={drafts} inQueue onChange={change} />
      )}
      {data.lots.length > 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          Checked this run:{' '}
          {data.lots
            .map((lot) =>
              lot.missing === 0
                ? `${lot.name} (every item has words)`
                : `${lot.name} (${lot.missing} ${lot.missing === 1 ? 'item needs' : 'items need'} words)`,
            )
            .join(', ')}
        </Typography>
      ) : null}
      <Box sx={{ display: 'flex', gap: 1, mt: 2, flexWrap: 'wrap' }}>
        <Tooltip title="Saves the rows marked Ready to save, and any changes in Done">
          <span>
            <Button
              variant="contained"
              loading={saving}
              onClick={() => {
                void save();
              }}
            >
              {ready > 0 ? `Save ${ready}` : 'Save'}
            </Button>
          </span>
        </Tooltip>
        <Button variant="outlined" color="success" disabled={guessed === 0} onClick={acceptAll}>
          Accept all guesses ({guessed})
        </Button>
        <Button variant="outlined" onClick={refresh}>
          Refresh
        </Button>
        <Tooltip title="Copies the saved words as JSON, to paste to Claude so they ship for everyone">
          <span>
            <Button
              variant="outlined"
              color="secondary"
              disabled={done.length === 0}
              onClick={() => {
                void copyForClaude();
              }}
            >
              Copy for Claude
            </Button>
          </span>
        </Tooltip>
      </Box>
      <Accordion disableGutters sx={{ mt: 2 }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Typography variant="subtitle2">Done ({done.length})</Typography>
        </AccordionSummary>
        <AccordionDetails>
          {done.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              Nothing saved yet. Words already folded into the app are in its built-in table.
            </Typography>
          ) : (
            <WordTable rows={done} drafts={drafts} inQueue={false} onChange={change} />
          )}
        </AccordionDetails>
      </Accordion>
    </AppCard>
  );
}
