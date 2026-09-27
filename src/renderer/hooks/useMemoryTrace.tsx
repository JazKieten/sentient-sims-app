import { useQuery } from '@tanstack/react-query';
import { appApiUrl } from 'main/sentient-sims/constants';
import { axiosClient } from 'main/sentient-sims/clients/AxiosClient';
import { MemoryTrace } from 'main/sentient-sims/models/MemoryTrace';

// GET /memories/:memoryId/trace, a dev tier route (release 4.5): the fetch lives with its only
// caller so the core client carries no trace code. Undefined when the memory predates this
// app session or wasn't produced by a traced pipeline.
async function getMemoryTrace(memoryId: string): Promise<MemoryTrace | undefined> {
  try {
    const response = await axiosClient.get<MemoryTrace>(`${appApiUrl}/memories/${memoryId}/trace`);
    return response.data;
  } catch {
    return undefined;
  }
}

export type MemoryTraceHook = {
  trace?: MemoryTrace;
  isLoading: boolean;
};

/**
 * The LLM pipeline that produced one memory (dev mode). Traces are held in the main process
 * only for the current app session, so a memory from an earlier run simply has none — hence
 * `null` for "looked, found nothing" rather than an error state.
 */
export function useMemoryTrace(memoryId?: string, enabled = true): MemoryTraceHook {
  const { data, isLoading } = useQuery({
    queryKey: ['memoryTrace', memoryId],
    queryFn: async () => (await getMemoryTrace(memoryId as string)) ?? null,
    enabled: enabled && memoryId !== undefined,
    staleTime: Infinity,
  });

  return { trace: data ?? undefined, isLoading };
}
