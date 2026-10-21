// Plum's mind: the one place the app calls Anthropic for Plum (PlumService owns the loop).
//
// The interface is the seam for the later Sentient Sims AI subscription route: a second
// implementation would forward the same request to the Go server. Today the only one is the
// bring-your-own-key Anthropic client.
import Anthropic from '@anthropic-ai/sdk';
import log from 'electron-log';
import { limitStrict } from './PlumTools';

export type PlumEffort = 'low' | 'medium' | 'high';

export type PlumModelRequest = {
  model: string;
  system: Anthropic.Beta.Messages.BetaTextBlockParam[];
  tools: Anthropic.Beta.Messages.BetaTool[];
  messages: Anthropic.Beta.Messages.BetaMessageParam[];
  maxTokens: number;
  effort: PlumEffort;
};

export interface PlumModelClient {
  create(request: PlumModelRequest): Promise<Anthropic.Beta.Messages.BetaMessage>;
}

// How many tools may stay strict. Anthropic measures the grammar strict tools compile to past
// what PlumTools can count; when it refuses, the request goes again with half as many strict
// tools (the best-ranked kept), and the smaller number holds until the app restarts.
let strictBudget = Number.POSITIVE_INFINITY;

export function resetStrictBudget() {
  strictBudget = Number.POSITIVE_INFINITY;
}

export function isStrictGrammarRefusal(error: unknown): boolean {
  return (
    error instanceof Anthropic.BadRequestError &&
    /compiled grammar is too large|too many strict tools|parameters with union types/i.test(error.message)
  );
}

export class AnthropicPlumClient implements PlumModelClient {
  private readonly client: Anthropic;

  // Tests hand in a stub SDK whose beta.messages.stream records the params
  constructor(apiKey: string, sdk?: Anthropic) {
    this.client = sdk ?? new Anthropic({ apiKey });
  }

  async create(request: PlumModelRequest): Promise<Anthropic.Beta.Messages.BetaMessage> {
    // Streaming keeps the request alive past the SDK's non-streaming timeout on a slow turn;
    // finalMessage() collects the whole message. No tool_choice (Opus 5.5 rejects forced
    // calls), no thinking parameter (always on; effort is the lever, and the default is
    // medium so it is set explicitly). Safety-classifier refusals re-run on Anthropic's
    // default fallback model inside the same call.
    //
    // Two cache markers. The explicit one on the system block (set by PlumService) is a
    // guaranteed read point for tools + system prompt. The top-level one is automatic: the
    // API puts it on the last cacheable block and walks it forward each request, so every
    // request reads the whole prior thread and writes only the new tail. Without it the
    // growing messages array was re-bought at full price on every request (2026-10-15:
    // 8.5M uncached input tokens in one evening, cache_read flat at the prefix).
    for (;;) {
      const tools = limitStrict(request.tools, strictBudget);
      const strictCount = tools.filter((tool) => tool.strict).length;
      try {
        return await this.send(request, tools);
      } catch (error) {
        if (!isStrictGrammarRefusal(error) || strictCount === 0) {
          throw error;
        }
        strictBudget = Math.floor(strictCount / 2);
        log.warn(`[Plum] Anthropic refused ${strictCount} strict tools; sending again with ${strictBudget}`);
      }
    }
  }

  private async send(request: PlumModelRequest, tools: Anthropic.Beta.Messages.BetaTool[]) {
    const stream = this.client.beta.messages.stream({
      model: request.model,
      max_tokens: request.maxTokens,
      system: request.system,
      tools,
      messages: request.messages,
      cache_control: { type: 'ephemeral' },
      output_config: { effort: request.effort },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    return stream.finalMessage();
  }
}

// A friendly sentence for the tab, from the SDK's typed errors. Never the raw stack.
export function describeModelError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return "Plum can't sign in to Anthropic: check Plum's API key in the app's Settings.";
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return "Plum's API key is not allowed to use this model: check the key and model in Settings.";
  }
  if (error instanceof Anthropic.NotFoundError) {
    return `Anthropic does not know the model Plum is set to use; check the model name in Settings.`;
  }
  if (error instanceof Anthropic.RateLimitError) {
    return 'Anthropic is rate limiting Plum; try again in a moment.';
  }
  if (error instanceof Anthropic.BadRequestError) {
    return `Anthropic rejected the request: ${error.message}`;
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return "Plum can't reach Anthropic right now (network).";
  }
  if (error instanceof Anthropic.APIError) {
    return `Anthropic answered with an error (${error.status ?? '?'}): ${error.message}`;
  }
  if (error instanceof Error) {
    return `Plum hit an error: ${error.message}`;
  }
  return `Plum hit an error: ${String(error)}`;
}
