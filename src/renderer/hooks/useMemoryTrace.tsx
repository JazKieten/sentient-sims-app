import { useQuery } from '@tanstack/react-query';
import { SentientSimsAppClient } from 'main/sentient-sims/clients/SentientSimsAppClient';
import { MemoryTrace } from 'main/sentient-sims/models/MemoryTrace';

const client = new SentientSimsAppClient();

export type MemoryTraceHook = {
  trace?: MemoryTrace;
  isLoading: boolean;
};

/**
 * The LLM pipeline that produced one memory (dev mode). Traces are held in the main process
 * only for the current app session, so a memory from an earlier run simply has none — hence
 * `null` for "looked, found nothing" rather than an error state.
 */
export function useMemoryTrace(memoryId?: number, enabled = true): MemoryTraceHook {
  const { data, isLoading } = useQuery({
    queryKey: ['memoryTrace', memoryId],
    queryFn: async () => (await client.memories.getMemoryTrace(memoryId as number)) ?? null,
    enabled: enabled && memoryId !== undefined,
    staleTime: Infinity,
  });

  return { trace: data ?? undefined, isLoading };
}
