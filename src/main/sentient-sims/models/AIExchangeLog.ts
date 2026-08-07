import { AIActionType } from './AIActionType';
import { ApiType } from './ApiType';
import { OpenAICompatibleRequest } from './OpenAICompatibleRequest';

// One row in the dev-mode AI log list. Deliberately free of the full prompt so the list
// can be polled cheaply; the prompt arrives with the detail fetch.
export type AIExchangeSummary = {
  id: number;
  at: string;
  label: string;
  actionType?: AIActionType;
  apiType?: ApiType;
  model?: string;
  durationMs: number;
  promptChars: number;
  responsePreview: string;
  // Set once the memory this call produced has been written
  memoryId?: number;
  error?: string;
};

export type AIExchangeDetail = AIExchangeSummary & {
  request: OpenAICompatibleRequest;
  responseText: string;
};
