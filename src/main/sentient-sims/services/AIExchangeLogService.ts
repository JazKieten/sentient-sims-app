import { AsyncLocalStorage } from 'async_hooks';
import { AIActionType } from '../models/AIActionType';
import { AIExchangeDetail, AIExchangeSummary } from '../models/AIExchangeLog';
import { OpenAICompatibleRequest } from '../models/OpenAICompatibleRequest';
import { notifyProviderHealth } from '../util/notifyRenderer';

// Prompts run tens of kilobytes each, so the log is a bounded ring: enough history to
// follow a play session, small enough to never matter for memory.
const MAX_ENTRIES = 200;
const PREVIEW_CHARS = 160;
// O-6: this many consecutive provider failures = the pipeline is dead (3h of 429s went
// unnoticed in the 08-04..08-14 playtest). One renderer badge + ONE non-pausing game
// toast; cleared on the next success.
const DEAD_PIPELINE_FAILURES = 3;

type LabelContext = { label: string; actionType?: AIActionType };

type Entry = AIExchangeDetail;

/**
 * Records every request the app makes to an AI provider — scene pipelines, cognition ticks,
 * reflections, classifications, importance ratings, everything — so dev mode can show the
 * exact prompt and response for each one.
 *
 * Capture happens at the single provider seam (ApiContext.getGenerationService), which is why
 * new call sites are logged automatically. The human-readable label comes from an
 * AsyncLocalStorage scope set by the caller: concurrent generations (a prefetch and a
 * cognition tick overlap routinely) each keep their own label without threading a parameter
 * through the GenerationService interface.
 */
export class AIExchangeLogService {
  private entries: Entry[] = [];

  private nextId = 1;

  private readonly labelContext = new AsyncLocalStorage<LabelContext>();

  private consecutiveFailures = 0;

  private pipelineDown = false;

  getProviderHealth(): { down: boolean; consecutiveFailures: number } {
    return { down: this.pipelineDown, consecutiveFailures: this.consecutiveFailures };
  }

  private trackHealth(error: string | undefined) {
    if (error) {
      this.consecutiveFailures += 1;
      if (!this.pipelineDown && this.consecutiveFailures >= DEAD_PIPELINE_FAILURES) {
        this.pipelineDown = true;
        notifyProviderHealth({ down: true, failures: this.consecutiveFailures, lastError: error.slice(0, 200) });
      }
      return;
    }
    if (this.pipelineDown) {
      this.pipelineDown = false;
      notifyProviderHealth({ down: false, failures: 0 });
    }
    this.consecutiveFailures = 0;
  }

  // Runs fn with a label attached to every provider call made inside it
  runLabeled<T>(label: string, actionType: AIActionType | undefined, fn: () => Promise<T>): Promise<T> {
    return this.labelContext.run({ label, actionType }, fn);
  }

  record(params: {
    request: OpenAICompatibleRequest;
    responseText: string;
    durationMs: number;
    error?: string;
  }): number {
    const context = this.labelContext.getStore();
    const id = this.nextId;
    this.nextId += 1;
    this.trackHealth(params.error);

    const promptChars = params.request.messages.reduce((total, message) => total + message.content.length, 0);
    const responsePreview = params.responseText.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS);

    this.entries.push({
      id,
      at: new Date().toISOString(),
      label: context?.label ?? 'AI Generation',
      actionType: context?.actionType,
      apiType: params.request.apiType,
      model: params.request.model,
      durationMs: params.durationMs,
      promptChars,
      responsePreview,
      responseText: params.responseText,
      request: params.request,
      error: params.error,
    });

    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }

    return id;
  }

  // Stamps the memory a set of calls produced onto their log rows. Matching is by request
  // object identity — the exact objects the pipeline passed to the provider — so no text
  // comparison can mislabel a row.
  linkRequestsToMemory(requests: OpenAICompatibleRequest[], memoryId: number) {
    if (requests.length === 0) {
      return;
    }
    this.entries.forEach((entry) => {
      if (entry.memoryId === undefined && requests.includes(entry.request)) {
        entry.memoryId = memoryId;
      }
    });
  }

  // Newest first, without the prompt bodies — the list is polled, the detail is not
  list(limit = MAX_ENTRIES): AIExchangeSummary[] {
    return this.entries
      .slice(-limit)
      .reverse()
      .map((entry) => ({
        id: entry.id,
        at: entry.at,
        label: entry.label,
        actionType: entry.actionType,
        apiType: entry.apiType,
        model: entry.model,
        durationMs: entry.durationMs,
        promptChars: entry.promptChars,
        responsePreview: entry.responsePreview,
        memoryId: entry.memoryId,
        error: entry.error,
      }));
  }

  get(id: number): AIExchangeDetail | undefined {
    return this.entries.find((entry) => entry.id === id);
  }
}
