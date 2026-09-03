import { Repository } from './Repository';
import { AIActionType } from '../models/AIActionType';
import { AIExchangeDetail, AIExchangeSummary } from '../models/AIExchangeLog';
import { ApiType } from '../models/ApiType';
import { OpenAICompatibleRequest } from '../models/OpenAICompatibleRequest';
import { StageId } from '../pipeline/stages';

// ai_exchange row without the two big text columns. memory_id is TEXT: memory ids are
// 64-bit game handles that travel as strings everywhere else in the app (see MemoryEntity).
type AIExchangeSummaryRow = {
  id: number;
  at: string;
  label: string;
  action_type: string | null;
  stage_id: string | null;
  api_type: string | null;
  model: string | null;
  duration_ms: number;
  prompt_chars: number;
  response_preview: string;
  memory_id: string | null;
  prompt_overflow: string | null;
  error: string | null;
};

type AIExchangeDetailRow = AIExchangeSummaryRow & {
  request: string;
  response_text: string;
};

const SUMMARY_COLUMNS =
  'id, at, label, action_type, stage_id, api_type, model, duration_ms, prompt_chars, response_preview, memory_id, prompt_overflow, error';

function toSummary(row: AIExchangeSummaryRow): AIExchangeSummary {
  return {
    id: row.id,
    at: row.at,
    label: row.label,
    actionType: (row.action_type as AIActionType | null) ?? undefined,
    stageId: (row.stage_id as StageId | null) ?? undefined,
    apiType: (row.api_type as ApiType | null) ?? undefined,
    model: row.model ?? undefined,
    durationMs: row.duration_ms,
    promptChars: row.prompt_chars,
    responsePreview: row.response_preview,
    memoryId: row.memory_id ?? undefined,
    promptOverflow: row.prompt_overflow
      ? (JSON.parse(row.prompt_overflow) as AIExchangeSummary['promptOverflow'])
      : undefined,
    error: row.error ?? undefined,
  };
}

function toDetail(row: AIExchangeDetailRow): AIExchangeDetail {
  return {
    ...toSummary(row),
    request: JSON.parse(row.request) as OpenAICompatibleRequest,
    responseText: row.response_text,
  };
}

/**
 * The persisted AI exchange log: one row per provider call, in the loaded save's database,
 * so prompts can be read back after an app restart (Phase 3.0 F4). Written through by
 * AIExchangeLogService, which owns the ids — they continue above whatever the save holds.
 */
export class AIExchangeRepository extends Repository {
  isLoaded(): boolean {
    return this.dbService.isLoaded();
  }

  insert(exchange: AIExchangeDetail) {
    return this.dbService
      .getDb()
      .prepare(
        `INSERT INTO ai_exchange(id, at, label, action_type, stage_id, api_type, model, duration_ms, prompt_chars,
                                 response_preview, response_text, request, prompt_overflow, error, memory_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run([
        exchange.id,
        exchange.at,
        exchange.label,
        exchange.actionType ?? null,
        exchange.stageId ?? null,
        exchange.apiType ?? null,
        exchange.model ?? null,
        exchange.durationMs,
        exchange.promptChars,
        exchange.responsePreview,
        exchange.responseText,
        JSON.stringify(exchange.request),
        exchange.promptOverflow ? JSON.stringify(exchange.promptOverflow) : null,
        exchange.error ?? null,
        exchange.memoryId ?? null,
      ]);
  }

  // Newest first, without the prompt bodies
  list(limit: number): AIExchangeSummary[] {
    const rows = this.dbService
      .getDb()
      .prepare(`SELECT ${SUMMARY_COLUMNS} FROM ai_exchange ORDER BY id DESC LIMIT ?`)
      .all([limit]) as AIExchangeSummaryRow[];
    return rows.map(toSummary);
  }

  get(id: number): AIExchangeDetail | undefined {
    const row = this.dbService.getDb().prepare('SELECT * FROM ai_exchange WHERE id = ?').get([id]) as
      | AIExchangeDetailRow
      | undefined;
    return row ? toDetail(row) : undefined;
  }

  // Stamps the memory a set of calls produced onto their rows; a row already linked keeps its memory
  setMemoryId(ids: number[], memoryId: string) {
    if (ids.length === 0) {
      return;
    }
    const placeholders = ids.map(() => '?').join(', ');
    this.dbService
      .getDb()
      .prepare(`UPDATE ai_exchange SET memory_id = ? WHERE memory_id IS NULL AND id IN (${placeholders})`)
      .run([memoryId, ...ids]);
  }

  maxId(): number {
    const row = this.dbService.getDb().prepare('SELECT MAX(id) AS max_id FROM ai_exchange').get() as {
      max_id: number | null;
    };
    return row.max_id ?? 0;
  }

  // Keeps the newest `keep` rows. Prompts run tens of kilobytes each and the save database
  // is copied whole on every game save, so the table is bounded.
  prune(keep: number) {
    this.dbService
      .getDb()
      .prepare('DELETE FROM ai_exchange WHERE id NOT IN (SELECT id FROM ai_exchange ORDER BY id DESC LIMIT ?)')
      .run([keep]);
  }
}
