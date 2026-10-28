import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AIActionType } from 'main/sentient-sims/models/AIActionType';
import { AIExchangeLogService } from 'main/sentient-sims/services/AIExchangeLogService';
import {
  chosenKey,
  DECISIONS_URL,
  DecisionService,
  IMPORTANCE_LEVELS,
  scoreLevel,
} from 'main/sentient-sims/services/DecisionService';

// The Jev day (2026-10-27): the OpenRouter Decisions API client. No text, typed answers,
// logged like any provider call.

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function build(settings: { decisionProvider?: 'off' | 'jev'; openrouterKey?: string; decisionModel?: string } = {}) {
  const exchangeLog = new AIExchangeLogService();
  const service = new DecisionService({
    settings: {
      decisionProvider: settings.decisionProvider ?? 'jev',
      openrouterKey: settings.openrouterKey ?? 'or-key',
      decisionModel: settings.decisionModel ?? 'typesafe/jev-1.13',
    },
    aiExchangeLog: exchangeLog,
  } as never);
  return { service, exchangeLog };
}

describe('DecisionService', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is enabled only with the setting on and a key', () => {
    expect(build().service.enabled()).toBe(true);
    expect(build({ decisionProvider: 'off' }).service.enabled()).toBe(false);
    const saved = process.env.OPENROUTER_KEY;
    delete process.env.OPENROUTER_KEY;
    expect(build({ openrouterKey: '' }).service.enabled()).toBe(false);
    if (saved !== undefined) {
      process.env.OPENROUTER_KEY = saved;
    }
  });

  it('posts the model, state and questions with the bearer key and parses the typed answers', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        answers: {
          pick: { choice: 'i2', probabilities: { i1: 0.2, i2: 0.7, none: 0.1 } },
          importance: { score: 2.4 },
          start: { noul: 0.81 },
        },
        usage: { cost: 0.00002, input_tokens: 512 },
      }),
    );
    const { service, exchangeLog } = build();
    const result = await service.decide(
      { sim: 'Elliot' },
      {
        pick: { type: 'choice', instructions: 'which', criteria: { i1: 'a', i2: 'b', none: 'wait' } },
        importance: { type: 'score', instructions: 'how much', criteria: IMPORTANCE_LEVELS },
        start: { type: 'noul', instructions: 'now?', criteria: { true: 'yes', false: 'no' } },
      },
      { label: 'Jev Row Pick: Elliot' },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(DECISIONS_URL);
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer or-key');
    expect((init?.headers as Record<string, string>)['X-Title']).toBe('Sentient Sims');
    const body = JSON.parse(init?.body as string) as {
      model: string;
      state: unknown;
      questions: Record<string, unknown>;
    };
    expect(body.model).toBe('typesafe/jev-1.13');
    expect(body.state).toEqual({ sim: 'Elliot' });
    expect(Object.keys(body.questions)).toEqual(['pick', 'importance', 'start']);

    expect(result.answers.pick?.choice).toBe('i2');
    expect(result.answers.start?.noul).toBe(0.81);
    expect(result.cost).toBe(0.00002);
    expect(result.inputTokens).toBe(512);
    expect(result.ms).toBeGreaterThanOrEqual(0);

    const [entry] = exchangeLog.list();
    expect(entry.label).toBe('Jev Row Pick: Elliot');
    expect(entry.actionType).toBe(AIActionType.DECISION);
    expect(entry.model).toBe('typesafe/jev-1.13');
    expect(entry.responsePreview).toContain('"cost":0.00002');
  });

  it('throws on a non-2xx and logs the error', async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { error: 'bad question' }));
    const { service, exchangeLog } = build();
    await expect(
      service.decide(
        {},
        { q: { type: 'noul', instructions: 'x', criteria: { true: 'y', false: 'n' } } },
        { label: 'x' },
      ),
    ).rejects.toThrow('decisions 400');
    expect(exchangeLog.list()[0].error).toContain('decisions 400');
  });

  it('times out and rejects when the API hangs', async () => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    );
    const { service } = build();
    await expect(
      service.decide(
        {},
        { q: { type: 'noul', instructions: 'x', criteria: { true: 'y', false: 'n' } } },
        { label: 'x', timeoutMs: 20 },
      ),
    ).rejects.toThrow('timed out');
  });

  it('refuses without a key', async () => {
    const saved = process.env.OPENROUTER_KEY;
    delete process.env.OPENROUTER_KEY;
    const { service } = build({ openrouterKey: '' });
    await expect(service.decide({}, {}, { label: 'x' })).rejects.toThrow('No OpenRouter key');
    expect(fetchMock).not.toHaveBeenCalled();
    if (saved !== undefined) {
      process.env.OPENROUTER_KEY = saved;
    }
  });
});

describe('the answer helpers', () => {
  it('trusts a choice only when it names an offered key', () => {
    const criteria = { r1: 'a', none: 'wait' };
    expect(chosenKey({ choice: 'r1' }, criteria)).toBe('r1');
    expect(chosenKey({ choice: 'r9' }, criteria)).toBe('none');
    expect(chosenKey(undefined, criteria)).toBe('none');
  });

  it('turns the 0-based legend into 1..N, clamped', () => {
    expect(scoreLevel({ score: 0 }, 5)).toBe(1);
    expect(scoreLevel({ score: 2.4 }, 5)).toBe(3);
    expect(scoreLevel({ score: 9 }, 5)).toBe(5);
    expect(scoreLevel(undefined, 5)).toBe(1);
  });
});
