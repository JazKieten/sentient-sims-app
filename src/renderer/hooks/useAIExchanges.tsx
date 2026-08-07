import { useQuery } from '@tanstack/react-query';
import { AIClient } from 'main/sentient-sims/clients/AIClient';
import { AIExchangeDetail, AIExchangeSummary } from 'main/sentient-sims/models/AIExchangeLog';

const client = new AIClient();

/**
 * The live list of AI provider calls, newest first. Polled so the log tails the game as it
 * plays; the list carries no prompt text, so refetching stays cheap.
 */
export function useAIExchanges(enabled = true): { exchanges: AIExchangeSummary[]; isLoading: boolean } {
  const { data, isLoading } = useQuery({
    queryKey: ['aiExchanges'],
    queryFn: () => client.getExchanges(),
    enabled,
    refetchInterval: 2000,
  });

  return { exchanges: data ?? [], isLoading };
}

// One call's full prompt and response, fetched only when a row is expanded
export function useAIExchange(exchangeId?: number): { exchange?: AIExchangeDetail; isLoading: boolean } {
  const { data, isLoading } = useQuery({
    queryKey: ['aiExchange', exchangeId],
    queryFn: async () => (await client.getExchange(exchangeId as number)) ?? null,
    enabled: exchangeId !== undefined,
    staleTime: Infinity,
  });

  return { exchange: data ?? undefined, isLoading };
}
