import { MemoryEntity } from '../db/entities/MemoryEntity';
import { LLMExchange } from '../models/InteractionEventResult';
import { MemoryTrace } from '../models/MemoryTrace';
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
 * to the memory id and becomes queryable via GET /memories/:id/trace. Everything lives in
 * memory: restarting the app drops traces.
 */
export class MemoryTraceService {
  private pending: { keys: string[]; trace: MemoryTrace }[] = [];

  private byMemoryId = new Map<string, MemoryTrace>();

  private readonly exchangeLog?: AIExchangeLogService;

  constructor(exchangeLog?: AIExchangeLogService) {
    this.exchangeLog = exchangeLog;
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
    const existing = this.byMemoryId.get(memoryId);
    if (existing) {
      existing.exchanges.push(exchange);
      this.exchangeLog?.linkRequestsToMemory([exchange.request], memoryId);
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
  }

  getTrace(memoryId: string): MemoryTrace | undefined {
    return this.byMemoryId.get(memoryId);
  }
}
