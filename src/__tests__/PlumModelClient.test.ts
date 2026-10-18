import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicPlumClient } from 'main/sentient-sims/services/plum/PlumModelClient';

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
});
