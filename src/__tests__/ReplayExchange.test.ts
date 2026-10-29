import { Server } from 'http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runApi } from 'main/sentient-sims/api';
import { AIActionType } from 'main/sentient-sims/models/AIActionType';
import { AIExchangeDetail, ReplayResult } from 'main/sentient-sims/models/AIExchangeLog';
import { ApiType } from 'main/sentient-sims/models/ApiType';
import { OpenAICompatibleRequest } from 'main/sentient-sims/models/OpenAICompatibleRequest';
import { GenerationService } from 'main/sentient-sims/services/GenerationService';
import { mockApiContext } from './util';

describe('AI exchange replay route', () => {
  const ctx = mockApiContext({ port: 25211 });
  const apiUrl = `http://localhost:${ctx.port}`;
  let server: Server;

  const exchange: AIExchangeDetail = {
    id: 42,
    at: '2026-10-29T12:00:00.000Z',
    label: 'Actor: Alex Alder',
    actionType: AIActionType.DIRECTED_SCENE_ACTOR,
    apiType: ApiType.OpenRouter,
    model: 'anthropic/claude-haiku-5.5',
    durationMs: 900,
    promptChars: 30,
    responsePreview: 'SAY: Hey.',
    responseText: 'SAY: Hey.\nTHINK: Here we go.',
    request: {
      messages: [
        { role: 'system', content: 'You are Alex Alder.', tokens: 5 },
        { role: 'user', content: 'Now respond as Alex Alder.', tokens: 6 },
      ],
      maxResponseTokens: 120,
      model: 'anthropic/claude-haiku-5.5',
      apiType: ApiType.OpenRouter,
    },
  };

  async function post(path: string, body: unknown) {
    const response = await fetch(`${apiUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as ReplayResult & { error?: string } };
  }

  beforeAll(() => {
    server = runApi(ctx);
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  });

  it('sends the logged prompt unchanged to the picked preset and parses both answers', async () => {
    const sent: OpenAICompatibleRequest[] = [];
    const service = {
      sentientSimsGenerate: (request: OpenAICompatibleRequest) => {
        sent.push(request);
        return Promise.resolve({ text: 'SAY: Hey there, long time no see.\nTHINK: Keep it light.' });
      },
    } as unknown as GenerationService;
    const get = vi.spyOn(ctx.aiExchangeLog, 'get').mockReturnValue(exchange);
    const getConfig = vi
      .spyOn(ctx.providerConfigs, 'getConfig')
      .mockReturnValue({ id: 'sonnet', name: 'Claude Sonnet', apiType: ApiType.OpenRouter, model: 'sonnet-x' });
    const getService = vi.spyOn(ctx, 'getGenerationService').mockReturnValue(service);
    try {
      const { status, body } = await post('/ai/exchanges/42/replay', { configIds: ['sonnet'] });
      expect(status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0].messages).toEqual(exchange.request.messages);
      expect(sent[0].maxResponseTokens).toBe(120);
      expect(sent[0].model).toBe('sonnet-x');
      expect(body.original.say).toBe('Hey.');
      expect(body.original.think).toBe('Here we go.');
      expect(body.replays[0].name).toBe('Claude Sonnet');
      expect(body.replays[0].say).toBe('Hey there, long time no see.');
      expect(body.replays[0].sayWords).toBe(6);
    } finally {
      get.mockRestore();
      getConfig.mockRestore();
      getService.mockRestore();
    }
  });

  it('reports a failed replay on its own card instead of failing the request', async () => {
    const service = {
      sentientSimsGenerate: () => Promise.reject(new Error('rate limited')),
    } as unknown as GenerationService;
    const get = vi.spyOn(ctx.aiExchangeLog, 'get').mockReturnValue(exchange);
    const getConfig = vi
      .spyOn(ctx.providerConfigs, 'getConfig')
      .mockReturnValue({ id: 'nano', name: 'Nano', apiType: ApiType.OpenRouter, model: 'nano' });
    const getService = vi.spyOn(ctx, 'getGenerationService').mockReturnValue(service);
    try {
      const { status, body } = await post('/ai/exchanges/42/replay', { configIds: ['nano'] });
      expect(status).toBe(200);
      expect(body.replays[0].error).toContain('rate limited');
    } finally {
      get.mockRestore();
      getConfig.mockRestore();
      getService.mockRestore();
    }
  });

  it('refuses an empty or oversized preset list', async () => {
    const get = vi.spyOn(ctx.aiExchangeLog, 'get').mockReturnValue(exchange);
    try {
      expect((await post('/ai/exchanges/42/replay', { configIds: [] })).status).toBe(400);
      expect((await post('/ai/exchanges/42/replay', { configIds: ['a', 'b', 'c', 'd', 'e'] })).status).toBe(400);
    } finally {
      get.mockRestore();
    }
  });
});
