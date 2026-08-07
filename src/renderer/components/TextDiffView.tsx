import { Box, Typography } from '@mui/material';
import { DiffLine, diffLines, hasChanges } from 'main/sentient-sims/util/textDiff';

export type TextDiffViewProps = {
  before: string;
  after: string;
};

const lineStyles: Record<DiffLine['op'], object> = {
  equal: { backgroundColor: 'transparent', borderColor: 'transparent', color: 'text.secondary' },
  removed: { backgroundColor: 'rgba(229, 57, 53, 0.14)', borderColor: 'rgba(229, 57, 53, 0.55)' },
  added: { backgroundColor: 'rgba(67, 160, 71, 0.16)', borderColor: 'rgba(67, 160, 71, 0.55)' },
};

const marker: Record<DiffLine['op'], string> = { equal: ' ', removed: '−', added: '+' };

/**
 * Line-by-line diff of what the actors delivered against what the reviewer aired: removed
 * text in red, added text in green, with the changed words inside a rewritten line
 * highlighted so a small edit doesn't read as a whole new line.
 */
export function TextDiffView({ before, after }: TextDiffViewProps) {
  const diff = diffLines(before, after);

  if (!hasChanges(diff)) {
    return (
      <Typography variant="body2" sx={{ color: 'text.secondary', fontStyle: 'italic' }}>
        The reviewer kept every line exactly as delivered.
      </Typography>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      {diff.map((line, index) => (
        <Box
          // Diff rows have no stable identity of their own — position is the identity
          key={`${line.op}-${index}`}
          sx={{
            display: 'flex',
            gap: 1,
            px: 1,
            py: 0.5,
            borderLeft: '3px solid',
            borderRadius: 0.5,
            ...lineStyles[line.op],
          }}
        >
          <Typography variant="body2" sx={{ fontFamily: 'monospace', opacity: 0.7, userSelect: 'none' }}>
            {marker[line.op]}
          </Typography>
          <Typography variant="body2" sx={{ lineHeight: 1.6 }}>
            {line.words
              ? line.words.map((part, partIndex) => (
                  <Box
                    key={`${part.op}-${partIndex}`}
                    component="span"
                    sx={{
                      backgroundColor:
                        part.op === 'removed'
                          ? 'rgba(229, 57, 53, 0.35)'
                          : part.op === 'added'
                            ? 'rgba(67, 160, 71, 0.4)'
                            : 'transparent',
                      borderRadius: 0.5,
                      fontWeight: part.op === 'equal' ? 400 : 600,
                    }}
                  >
                    {part.text}
                  </Box>
                ))
              : line.text}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}
