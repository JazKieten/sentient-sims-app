import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { ReactNode } from 'react';
import { MemoryTrace } from 'main/sentient-sims/models/MemoryTrace';
import { useMemoryTrace } from '../hooks/useMemoryTrace';
import { PromptTextBlock } from './PromptTextBlock';
import { TextDiffView } from './TextDiffView';
import { CopyButton, LLMExchangeDetail } from './LLMExchangeDetail';

const pipelineLabels: Record<MemoryTrace['pipeline'], string> = {
  directed_scene: 'Directed scene (director → actors → reviewer)',
  scene_generation: 'Scene generation (single pass → reviewer)',
  scene_reflection: 'Scene reflection',
  cognition: 'Cognition tick (deliberation → review)',
  other: 'AI calls for this memory',
};

export type MemoryTraceDialogProps = {
  open: boolean;
  memoryId?: number;
  onClose: () => void;
};

// The director answers in `=== SCENE ===` / `=== PROMPT FOR <name> ===` blocks; each one is
// worth its own collapsible section rather than being shown as one run of text.
function splitDirection(direction: string): { title: string; body: string }[] {
  const matches = [...direction.matchAll(/^\s*===\s*(.+?)\s*===\s*$/gm)];
  if (matches.length === 0) {
    return [{ title: 'Direction', body: direction.trim() }];
  }

  return matches.map((match, index) => {
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : direction.length;
    return { title: match[1], body: direction.slice(start, end).trim() };
  });
}

function Section({
  title,
  subtitle,
  defaultExpanded = false,
  children,
}: {
  title: string;
  subtitle?: string;
  defaultExpanded?: boolean;
  children: ReactNode;
}) {
  return (
    <Accordion defaultExpanded={defaultExpanded} disableGutters sx={{ mb: 1 }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap' }}>
          <Typography variant="subtitle2">{title}</Typography>
          {subtitle ? (
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {subtitle}
            </Typography>
          ) : null}
        </Box>
      </AccordionSummary>
      <AccordionDetails sx={{ pt: 0 }}>{children}</AccordionDetails>
    </Accordion>
  );
}

Section.defaultProps = { subtitle: undefined, defaultExpanded: false };

/**
 * Dev-mode view of everything that produced one memory: the full prompt sent at each stage,
 * the director's direction, and a diff of the reviewer's edits.
 */
export function MemoryTraceDialog({ open, memoryId, onClose }: MemoryTraceDialogProps) {
  const { trace, isLoading } = useMemoryTrace(memoryId, open);

  const renderBody = () => {
    if (isLoading) {
      return (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      );
    }

    if (!trace) {
      return (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          No pipeline trace for this memory. Traces are kept in memory only, so they exist for scenes generated since
          the app was last started.
        </Typography>
      );
    }

    return (
      <>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 2 }}>
          <Chip size="small" label={pipelineLabels[trace.pipeline]} />
          <Chip size="small" variant="outlined" label={`${trace.exchanges.length} LLM stages`} />
          {trace.review ? (
            <Chip
              size="small"
              variant="outlined"
              color={trace.review.usedReviewerCut ? 'success' : 'warning'}
              label={trace.review.usedReviewerCut ? "Aired: reviewer's cut" : 'Aired: original lines (review rejected)'}
            />
          ) : null}
        </Box>

        {trace.directorDirection ? (
          <Section title="Director's direction" subtitle="what each actor was told" defaultExpanded>
            {splitDirection(trace.directorDirection).map((part) => (
              <Box key={part.title} sx={{ mb: 1.5 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                  <Typography variant="overline" sx={{ color: 'primary.main', letterSpacing: 1 }}>
                    {part.title}
                  </Typography>
                  <CopyButton text={part.body} />
                </Box>
                <PromptTextBlock text={part.body} />
                <Divider sx={{ mt: 1.5 }} />
              </Box>
            ))}
          </Section>
        ) : null}

        {trace.review ? (
          <Section title="Reviewer changes" subtitle="red removed · green added" defaultExpanded>
            <TextDiffView before={trace.review.before} after={trace.review.after} />
            <Accordion disableGutters sx={{ mt: 1.5 }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography variant="caption">Side by side (before / after)</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                  {[
                    { label: 'Before (as delivered)', text: trace.review.before },
                    { label: 'After (reviewer)', text: trace.review.after },
                  ].map((side) => (
                    <Box key={side.label} sx={{ flex: '1 1 260px', minWidth: 240 }}>
                      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                        {side.label}
                      </Typography>
                      <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', mt: 0.5 }}>
                        {side.text || '(empty)'}
                      </Typography>
                    </Box>
                  ))}
                </Box>
              </AccordionDetails>
            </Accordion>
          </Section>
        ) : null}

        <Typography variant="subtitle2" sx={{ mt: 2, mb: 1 }}>
          Full prompt, stage by stage
        </Typography>
        {trace.exchanges.map((exchange, index) => (
          <Section
            // Stage labels repeat across actors in a scene, so pair the label with its position
            key={`${exchange.label}-${index}`}
            title={`${index + 1}. ${exchange.label}`}
            subtitle={exchange.request.model ?? undefined}
          >
            <LLMExchangeDetail messages={exchange.request.messages} responseText={exchange.responseText} />
          </Section>
        ))}
      </>
    );
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="lg" scroll="paper">
      <DialogTitle>Generation pipeline</DialogTitle>
      <DialogContent dividers>{renderBody()}</DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

MemoryTraceDialog.defaultProps = { memoryId: undefined };
