import { Box, Typography } from '@mui/material';

export type PromptTextBlockProps = {
  text: string;
  dense?: boolean;
};

type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'paragraph'; text: string };

// A `=== SCENE ===` / `--- PROMPT ---` style separator the pipeline writes into its prompts
const HEADING = /^\s*(?:={2,}|-{2,}|#{1,3})\s*(.+?)\s*(?:={2,}|-{2,})?\s*$/;
const BULLET = /^\s*[-*•]\s+(.*)$/;

// Prompts are long, structured text: header lines, bullet rules, prose paragraphs. Rendered
// as one blob they're unreadable, so each shape gets its own treatment.
function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let bullets: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
      paragraph = [];
    }
  };
  const flushBullets = () => {
    if (bullets.length > 0) {
      blocks.push({ kind: 'bullets', items: bullets });
      bullets = [];
    }
  };

  text.split('\n').forEach((rawLine) => {
    const line = rawLine.trimEnd();
    if (line.trim().length === 0) {
      flushParagraph();
      flushBullets();
      return;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      flushParagraph();
      bullets.push(bullet[1]);
      return;
    }

    // Only treat a line as a heading when it's wrapped in separators, not merely dash-led
    const heading = /^\s*(?:={2,}|-{2,}|#{1,3})/.test(line) ? HEADING.exec(line) : null;
    if (heading) {
      flushParagraph();
      flushBullets();
      blocks.push({ kind: 'heading', text: heading[1] });
      return;
    }

    flushBullets();
    paragraph.push(line.trim());
  });

  flushParagraph();
  flushBullets();
  return blocks;
}

/**
 * Renders one prompt (or model response) as readable structure — headings, bulleted rules,
 * and paragraphs — instead of a single wall of text.
 */
export function PromptTextBlock({ text, dense = false }: PromptTextBlockProps) {
  const blocks = parseBlocks(text);
  const variant = dense ? 'caption' : 'body2';

  if (blocks.length === 0) {
    return (
      <Typography variant={variant} sx={{ color: 'text.secondary', fontStyle: 'italic' }}>
        (empty)
      </Typography>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      {blocks.map((block, index) => {
        const key = `${block.kind}-${index}`;
        if (block.kind === 'heading') {
          return (
            <Typography
              key={key}
              variant="overline"
              sx={{ color: 'primary.main', letterSpacing: 1, lineHeight: 1.6, mt: index === 0 ? 0 : 1 }}
            >
              {block.text}
            </Typography>
          );
        }

        if (block.kind === 'bullets') {
          return (
            <Box key={key} component="ul" sx={{ m: 0, pl: 2.5, display: 'flex', flexDirection: 'column', gap: 0.25 }}>
              {block.items.map((item, itemIndex) => (
                <Typography key={`${key}-${itemIndex}`} component="li" variant={variant} sx={{ lineHeight: 1.5 }}>
                  {item}
                </Typography>
              ))}
            </Box>
          );
        }

        return (
          <Typography key={key} variant={variant} sx={{ lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
            {block.text}
          </Typography>
        );
      })}
    </Box>
  );
}

PromptTextBlock.defaultProps = {
  dense: false,
};
