import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Chip,
  IconButton,
  Tooltip,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { OpenAIMessage } from 'main/sentient-sims/models/OpenAIMessage';
import { PromptTextBlock } from './PromptTextBlock';

const roleLabels: Record<string, string> = {
  system: 'System prompt',
  user: 'User message',
  assistant: 'Assistant message',
};

export function CopyButton({ text }: { text: string }) {
  return (
    <Tooltip title="Copy">
      <IconButton
        size="small"
        onClick={(event) => {
          event.stopPropagation();
          void navigator.clipboard.writeText(text);
        }}
      >
        <ContentCopyIcon fontSize="inherit" />
      </IconButton>
    </Tooltip>
  );
}

function MessageBlock({ message }: { message: OpenAIMessage }) {
  return (
    <Accordion defaultExpanded={message.role === 'system'} disableGutters sx={{ mb: 0.5 }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%' }}>
          <Chip
            size="small"
            variant="outlined"
            color={message.role === 'system' ? 'secondary' : 'default'}
            label={roleLabels[message.role] ?? message.role}
          />
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {message.content.length.toLocaleString()} chars
          </Typography>
          <Box sx={{ flexGrow: 1 }} />
          <CopyButton text={message.content} />
        </Box>
      </AccordionSummary>
      <AccordionDetails sx={{ pt: 0 }}>
        <PromptTextBlock text={message.content} />
      </AccordionDetails>
    </Accordion>
  );
}

export type LLMExchangeDetailProps = {
  messages: OpenAIMessage[];
  responseText: string;
  error?: string;
};

/**
 * One AI call rendered in full: every prompt message as its own collapsible, formatted
 * block, then the model's response. Shared by the memory pipeline dialog and the AI log.
 */
export function LLMExchangeDetail({ messages, responseText, error }: LLMExchangeDetailProps) {
  return (
    <>
      {messages.map((message, index) => (
        <MessageBlock key={`${message.role}-${index}`} message={message} />
      ))}
      <Box
        sx={{
          mt: 1,
          p: 1,
          borderRadius: 1,
          backgroundColor: error ? 'rgba(229, 57, 53, 0.12)' : 'action.hover',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
          <Chip
            size="small"
            color={error ? 'error' : 'primary'}
            variant="outlined"
            label={error ? 'Error' : 'Response'}
          />
          <CopyButton text={error ?? responseText} />
        </Box>
        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
          {error ?? responseText}
          {!error && !responseText ? '(empty)' : ''}
        </Typography>
      </Box>
    </>
  );
}

LLMExchangeDetail.defaultProps = { error: undefined };
