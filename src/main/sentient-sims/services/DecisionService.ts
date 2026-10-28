import log from 'electron-log';
import { ApiType } from '../models/ApiType';
import { AIActionType } from '../models/AIActionType';
import { openrouterAttributionHeaders } from '../models/OpenRouterModels';
import { OpenAICompatibleRequest } from '../models/OpenAICompatibleRequest';
import { StageId } from '../pipeline/stages';
import type { ApiContext } from './ApiContext';

// Jev (2026-10-27): the OpenRouter Decisions API. A typed decision model, not a chat model:
// it answers questions about a JSON state and never writes text. `choice` picks one key of a
// keyed set, `noul` gives P(true), `score` a position on an ordered legend (0-based). Every
// question in one request is answered in parallel and cannot see the others' answers, so a
// pick that depends on another pick is two requests. Measured 2026-10-06: p50 0.22 s,
// $0.042 per million input tokens, output free; "none" grows with the list, so callers keep
// lists short (see .claude/jev/ASSESSMENT-JEV-PIPELINE-2026-10-06.md in the mod repo).
export const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
export const DEFAULT_DECISION_MODEL = 'typesafe/jev-1.13';
const DEFAULT_TIMEOUT_MS = 4_000;

export type DecisionQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'noul'; instructions: string; criteria: { true: string; false: string } }
  | { type: 'score'; instructions: string; criteria: string[] };

export type DecisionAnswer = {
  choice?: string;
  probabilities?: Record<string, number>;
  confidence?: number;
  noul?: number;
  // 0-based position on the legend, as a float
  score?: number;
};

export type DecisionResult<Q extends string> = {
  // An answer the API left out reads as undefined, never as a key the caller did not offer
  answers: Partial<Record<Q, DecisionAnswer>>;
  // USD, from usage.cost when the API reports it
  cost?: number;
  inputTokens?: number;
  ms: number;
};

export type DecideOptions = {
  label: string;
  stageId?: StageId;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export class DecisionProviderOffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionProviderOffError';
  }
}

export class DecisionService {
  constructor(private readonly ctx: Pick<ApiContext, 'settings' | 'aiExchangeLog'>) {}

  apiKey(): string | undefined {
    return this.ctx.settings.openrouterKey || process.env.OPENROUTER_KEY || undefined;
  }

  // The Jev day runs only when the setting says so AND a key resolves; otherwise every
  // caller takes the path it took before Jev existed.
  enabled(): boolean {
    return this.ctx.settings.decisionProvider === 'jev' && !!this.apiKey();
  }

  async decide<Q extends string>(
    state: unknown,
    questions: Record<Q, DecisionQuestion>,
    options: DecideOptions,
  ): Promise<DecisionResult<Q>> {
    const key = this.apiKey();
    if (!key) {
      throw new DecisionProviderOffError('No OpenRouter key set for decisions');
    }
    const model = this.ctx.settings.decisionModel;
    const body = { model, state, questions };
    // The exchange log wants a chat-shaped request: the questions ride as the system text and
    // the state as the user text, so the log view shows what was asked and of what.
    const request: OpenAICompatibleRequest = {
      messages: [
        { role: 'system', content: JSON.stringify(questions), tokens: 0 },
        { role: 'user', content: JSON.stringify(state), tokens: 0 },
      ],
      maxResponseTokens: 0,
      model,
      apiType: ApiType.OpenRouter,
    };

    return this.ctx.aiExchangeLog.runLabeled(
      options.label,
      AIActionType.DECISION,
      async () => {
        const startedAt = Date.now();
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort();
        }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        const onOuterAbort = () => {
          controller.abort();
        };
        options.signal?.addEventListener('abort', onOuterAbort);
        try {
          const response = await fetch(DECISIONS_URL, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${key}`,
              'Content-Type': 'application/json',
              ...openrouterAttributionHeaders,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          const text = await response.text();
          const durationMs = Date.now() - startedAt;
          if (!response.ok) {
            const error = `decisions ${response.status}: ${text.slice(0, 300)}`;
            this.ctx.aiExchangeLog.record({ request, responseText: text, durationMs, error });
            throw new Error(error);
          }
          const parsed = JSON.parse(text) as {
            answers?: Record<string, DecisionAnswer>;
            usage?: { cost?: number; input_tokens?: number };
          };
          const answers = (parsed.answers ?? {}) as Partial<Record<Q, DecisionAnswer>>;
          const result: DecisionResult<Q> = {
            answers,
            cost: parsed.usage?.cost,
            inputTokens: parsed.usage?.input_tokens,
            ms: durationMs,
          };
          this.ctx.aiExchangeLog.record({
            request,
            responseText: JSON.stringify({ answers, usage: parsed.usage }),
            durationMs,
          });
          return result;
        } catch (error) {
          if (controller.signal.aborted) {
            const durationMs = Date.now() - startedAt;
            const message = `decisions timed out after ${durationMs}ms`;
            this.ctx.aiExchangeLog.record({ request, responseText: '', durationMs, error: message });
            log.warn(`[Jev] ${options.label}: ${message}`);
            throw new Error(message, { cause: error });
          }
          throw error;
        } finally {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onOuterAbort);
        }
      },
      options.stageId,
    );
  }
}

// A choice answer is only trusted when it names one of the keys offered; anything else
// (an invented key, a missing answer) reads as `none`, which every caller treats as "wait".
export function chosenKey(answer: DecisionAnswer | undefined, criteria: Record<string, string>): string {
  const key = answer?.choice;
  if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(criteria, key)) {
    return key;
  }
  return 'none';
}

// The legend is 0-based on the wire; the app speaks 1..N
export function scoreLevel(answer: DecisionAnswer | undefined, levels: number): number {
  const raw = answer?.score;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return 1;
  }
  return Math.min(levels, Math.max(1, Math.round(raw) + 1));
}

export const IMPORTANCE_LEVELS = ['1 routine', '2 minor', '3 notable', '4 significant', '5 pivotal'];
