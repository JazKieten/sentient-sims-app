import { beforeEach, describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicPlumClient, resetStrictBudget } from 'main/sentient-sims/services/plum/PlumModelClient';
import { mergeCatalogue, toApiTools, type ModToolDef } from 'main/sentient-sims/services/plum/PlumTools';

// The request the SDK is handed: both cache markers (explicit on the system block, automatic
// top-level on the moving tail of the messages) and the beta fallback. Checked against a stub
// SDK; nothing reaches the network.
describe('AnthropicPlumClient', () => {
  it('sends the top-level cache_control next to the system marker', async () => {
    const params: Record<string, unknown>[] = [];
    const message = { id: 'msg_1', content: [], usage: { input_tokens: 1, output_tokens: 1 } };
    const sdk = {
      beta: {
        messages: {
          stream: (request: Record<string, unknown>) => {
            params.push(request);
            return { finalMessage: () => Promise.resolve(message) };
          },
        },
      },
    } as unknown as Anthropic;
    const client = new AnthropicPlumClient('sk-test', sdk);
    const system = [{ type: 'text' as const, text: 'prompt', cache_control: { type: 'ephemeral' as const } }];
    const result = await client.create({
      model: 'claude-opus-5-5',
      system,
      tools: [],
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
      effort: 'low',
    });

    expect(result).toBe(message);
    expect(params).toHaveLength(1);
    const [request] = params;
    expect(request.cache_control).toEqual({ type: 'ephemeral' });
    expect(request.system).toBe(system);
    expect(request.model).toBe('claude-opus-5-5');
    expect(request.max_tokens).toBe(100);
    expect(request.output_config).toEqual({ effort: 'low' });
    expect(request.fallbacks).toBe('default');
  });

  beforeEach(() => {
    resetStrictBudget();
  });

  it('halves the strict tools while Anthropic refuses the grammar, best-ranked kept, and remembers', async () => {
    // Live 2026-10-21: the poll tools pushed a catalogue that passed both counts over the grammar cap
    const tool = (name: string, risk: ModToolDef['risk']): ModToolDef => ({
      name,
      description: name,
      input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      risk,
      timeout_ms: 1000,
      tier: 'core',
    });
    const reads = Array.from({ length: 9 }, (_, i) => tool(`read_${i}`, 'read'));
    const tools = toApiTools(mergeCatalogue([...reads, tool('send_sim_home', 'destructive')], []));
    const sent: string[][] = [];
    let refusals = 2;
    const message = { id: 'msg_1', content: [], usage: { input_tokens: 1, output_tokens: 1 } };
    const sdk = {
      beta: {
        messages: {
          stream: (request: { tools: Anthropic.Beta.Messages.BetaTool[] }) => {
            sent.push(request.tools.filter((each) => each.strict).map((each) => each.name));
            if (refusals > 0) {
              refusals -= 1;
              const error = { type: 'invalid_request_error', message: 'The compiled grammar is too large' };
              return {
                finalMessage: () =>
                  Promise.reject(Anthropic.APIError.generate(400, { error }, undefined, new Headers())),
              };
            }
            return { finalMessage: () => Promise.resolve(message) };
          },
        },
      },
    } as unknown as Anthropic;
    const client = new AnthropicPlumClient('sk-test', sdk);
    const request = {
      model: 'claude-opus-5-5',
      system: [],
      tools,
      messages: [{ role: 'user' as const, content: 'hi' }],
      maxTokens: 100,
      effort: 'low' as const,
    };

    expect(await client.create(request)).toBe(message);
    expect(sent.map((names) => names.length)).toEqual([10, 5, 2]);
    expect(sent[2]).toEqual(['read_0', 'send_sim_home']);
    expect(tools.map((each) => each.name)).toEqual([...reads.map((each) => each.name), 'send_sim_home']);

    // The next request starts from the smaller number
    await client.create(request);
    expect(sent[3]).toHaveLength(2);
  });
});
