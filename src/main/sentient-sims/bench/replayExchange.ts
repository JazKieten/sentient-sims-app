import { AIActionType } from '../models/AIActionType';
import { AIExchangeDetail, ReplayAnswer, ReplayResult } from '../models/AIExchangeLog';
import { OpenAICompatibleRequest } from '../models/OpenAICompatibleRequest';
import type { ApiContext } from '../services/ApiContext';
import { parseActorPerformance } from '../services/AIService';

export const MAX_REPLAY_CONFIGS = 4;
const REPLAY_TIMEOUT_MS = 60_000;

function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => word.length > 0).length;
}

// "Actor: Alex Alder" -> "Alex Alder"
function actorName(label: string): string | undefined {
  const match = /^Actor:\s*(.+)$/.exec(label);
  return match ? match[1].trim() : undefined;
}

function withParse(answer: ReplayAnswer, exchange: AIExchangeDetail): ReplayAnswer {
  if (exchange.actionType !== AIActionType.DIRECTED_SCENE_ACTOR || !answer.text) {
    return answer;
  }
  const name = actorName(exchange.label);
  const { say, think } = parseActorPerformance(answer.text, name ? [name] : [], {
    multiLineSay: exchange.request.maxResponseTokens > 120,
  });
  return { ...answer, say, think, sayWords: countWords(say) };
}

/**
 * Sends a logged prompt, byte for byte, to other provider presets: same messages, same reply
 * budget, only the provider and model swapped. Each replay is itself logged ("Replay of #N"),
 * and is left out of provider health, since a failed comparison is not a dead pipeline.
 */
export async function replayExchange(
  ctx: ApiContext,
  exchange: AIExchangeDetail,
  configIds: string[],
): Promise<ReplayResult> {
  const original = withParse(
    {
      name: 'Original',
      apiType: exchange.apiType,
      model: exchange.model,
      text: exchange.responseText,
      durationMs: exchange.durationMs,
      error: exchange.error,
    },
    exchange,
  );

  const replays = await Promise.all(
    configIds.map(async (configId): Promise<ReplayAnswer> => {
      const config = ctx.providerConfigs.getConfig(configId);
      if (!config) {
        return { configId, name: configId, text: '', durationMs: 0, error: `No provider preset ${configId}` };
      }
      const resolved = ctx.providerConfigs.resolve(config);
      const request: OpenAICompatibleRequest = {
        ...exchange.request,
        messages: exchange.request.messages.map((message) => ({ ...message })),
        apiType: resolved.apiType,
        model: resolved.model,
        purpose: 'replay',
      };
      const startedAt = Date.now();
      try {
        const response = await ctx.aiExchangeLog.runLabeled(
          `Replay of #${exchange.id}: ${resolved.name}`,
          exchange.actionType,
          () =>
            ctx.getGenerationService(resolved.apiType).sentientSimsGenerate(request, { timeoutMs: REPLAY_TIMEOUT_MS }),
          exchange.stageId,
          { health: false },
        );
        return withParse(
          {
            configId,
            name: resolved.name,
            apiType: resolved.apiType,
            model: resolved.model,
            text: response.text,
            durationMs: Date.now() - startedAt,
          },
          exchange,
        );
      } catch (err) {
        return {
          configId,
          name: resolved.name,
          apiType: resolved.apiType,
          model: resolved.model,
          text: '',
          durationMs: Date.now() - startedAt,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  return { exchangeId: exchange.id, label: exchange.label, original, replays };
}
