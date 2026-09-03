import log from 'electron-log';
import { MemoryTraceRepository } from '../db/MemoryTraceRepository';
import { MemoryEntity } from '../db/entities/MemoryEntity';
import { LLMExchange } from '../models/InteractionEventResult';
import { MemoryTrace, StoredMemoryTrace, StoredTraceExchange } from '../models/MemoryTrace';
import { stripArtifacts } from '../util/memoryHygiene';
import { AIExchangeLogService } from './AIExchangeLogService';

const MAX_PENDING = 20;
const MAX_ATTACHED = 200;

// The pipeline can't know its memory's id up front: game-driven scenes are persisted by the
// mod POSTing /memories later, with only the text in common. Content has to be compared
// loosely — createMemory strips artifacts before storing, and the chat-window formatting
// rejoins lines — so whitespace runs collapse to a single space on both sides.
function normalize(text: string): string {
  return stripArtifacts(text).replace(/\s+/g, ' ').trim();
}

/**
 * Dev-mode store linking each generated memory to the LLM pipeline that produced it
 * (director briefing, actor turns, reviewer pass, cognition deliberation, importance rating).
 * Generation records a pending trace keyed by the memory text it produced; when that memory
 * row is actually created — by the app or by the mod posting it back — the trace is attached
 * to the memory id and becomes queryable via GET /memories/:id/trace.
 *
 * An attached trace is written to the loaded save (memory_trace, F4), with each stage stored
 * as a reference into ai_exchange so the prompt lives once; pending traces stay in memory,
 * since a trace with no memory row yet has nothing to key on. With no save loaded the store
 * behaves as it did before: in memory, gone on restart.
 */
export class MemoryTraceService {
  private pending: { keys: string[]; trace: MemoryTrace }[] = [];

  private byMemoryId = new Map<string, MemoryTrace>();

  private readonly exchangeLog?: AIExchangeLogService;

  private readonly repository?: MemoryTraceRepository;

  constructor(exchangeLog?: AIExchangeLogService, repository?: MemoryTraceRepository) {
    this.exchangeLog = exchangeLog;
    this.repository = repository;
  }

  private get persistence(): MemoryTraceRepository | undefined {
    return this.repository?.isLoaded() ? this.repository : undefined;
  }

  recordPending(contents: (string | undefined)[], trace: MemoryTrace) {
    const keys = contents
      .filter((content): content is string => Boolean(content))
      .map((content) => normalize(content))
      .filter((key) => key.length > 0);
    if (keys.length === 0) {
      return;
    }
    this.pending.push({ keys, trace });
    if (this.pending.length > MAX_PENDING) {
      this.pending.splice(0, this.pending.length - MAX_PENDING);
    }
  }

  // Wired to MemoryRepository's upsert hook via ApiContext. Must never throw.
  attach(memory: MemoryEntity) {
    if (memory.id === undefined || !memory.content) {
      return;
    }
    const key = normalize(memory.content);
    // Newest first: a repeated action can produce near-identical text, and the latest
    // pending trace is the one that just generated this memory
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      if (this.pending[i].keys.includes(key)) {
        const [{ trace }] = this.pending.splice(i, 1);
        this.store(memory.id, trace);
        return;
      }
    }
  }

  // Adds one more stage to a memory's trace after the fact — the importance rating runs in
  // the background once the row exists, so it can be attached by id directly.
  appendExchange(memoryId: string, exchange: LLMExchange | undefined, pipeline: MemoryTrace['pipeline'] = 'other') {
    if (!exchange) {
      return;
    }
    // The stored trace, not just the in-memory one: the importance rating lands after the
    // memory row exists, and on a restart-crossing save that row is all there is
    const existing = this.byMemoryId.get(memoryId) ?? this.getTrace(memoryId);
    if (existing) {
      existing.exchanges.push(exchange);
      this.byMemoryId.set(memoryId, existing);
      this.exchangeLog?.linkRequestsToMemory([exchange.request], memoryId);
      this.persist(memoryId, existing);
      return;
    }
    this.store(memoryId, { pipeline, exchanges: [exchange] });
  }

  private store(memoryId: string, trace: MemoryTrace) {
    this.byMemoryId.set(memoryId, trace);
    this.exchangeLog?.linkRequestsToMemory(
      trace.exchanges.map((exchange) => exchange.request),
      memoryId,
    );
    if (this.byMemoryId.size > MAX_ATTACHED) {
      const oldest = this.byMemoryId.keys().next().value;
      if (oldest !== undefined) {
        this.byMemoryId.delete(oldest);
      }
    }
    this.persist(memoryId, trace);
  }

  // Best-effort, like everything else here: a trace is debug bookkeeping and must never cost
  // a sim its memory.
  private persist(memoryId: string, trace: MemoryTrace) {
    const repository = this.persistence;
    if (!repository) {
      return;
    }
    try {
      repository.upsert(memoryId, this.toStored(trace));
    } catch (err) {
      log.error('Unable to persist a memory trace', err);
    }
  }

  private toStored(trace: MemoryTrace): StoredMemoryTrace {
    return {
      ...trace,
      exchanges: trace.exchanges.map((exchange) => {
        const exchangeId = this.exchangeLog?.idForRequest(exchange.request);
        // No logged row means the call never reached the provider seam (a stubbed provider,
        // or a call made before this save was loaded), so the prompt is inlined instead
        return exchangeId === undefined ? { label: exchange.label, exchange } : { label: exchange.label, exchangeId };
      }),
    };
  }

  private fromStored(stored: StoredMemoryTrace): MemoryTrace {
    const exchanges = stored.exchanges
      .map((entry) => this.resolveExchange(entry))
      .filter((exchange): exchange is LLMExchange => exchange !== undefined);
    return { ...stored, exchanges };
  }

  private resolveExchange(entry: StoredTraceExchange): LLMExchange | undefined {
    if (entry.exchange) {
      return entry.exchange;
    }
    if (entry.exchangeId === undefined) {
      return undefined;
    }
    const logged = this.exchangeLog?.get(entry.exchangeId);
    // A pruned exchange row leaves the stage in the trace with its label and no prompt,
    // which reads better than dropping the stage out of the pipeline entirely
    return {
      label: entry.label,
      request: logged?.request ?? { messages: [], maxResponseTokens: 0 },
      responseText: logged?.responseText ?? '',
    };
  }

  getTrace(memoryId: string): MemoryTrace | undefined {
    const attached = this.byMemoryId.get(memoryId);
    if (attached) {
      return attached;
    }

    try {
      const stored = this.persistence?.get(memoryId);
      return stored ? this.fromStored(stored) : undefined;
    } catch (err) {
      log.error('Unable to read a persisted memory trace', err);
      return undefined;
    }
  }
}
