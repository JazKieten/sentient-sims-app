import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import { ApiType } from 'main/sentient-sims/models/ApiType';
import { AIActionType } from 'main/sentient-sims/models/AIActionType';
import { OpenAICompatibleRequest } from 'main/sentient-sims/models/OpenAICompatibleRequest';
import { StageId } from 'main/sentient-sims/pipeline/stages';
import { ApiContext } from 'main/sentient-sims/services/ApiContext';
import { OpenAIService } from 'main/sentient-sims/services/OpenAIService';
import { DirectoryService } from 'main/sentient-sims/services/DirectoryService';
import { SettingsService } from 'main/sentient-sims/services/SettingsService';
import { mockApiContext, mockEnvironment } from './util';

// F4: the exchange log and memory traces live in the loaded save, so the bench and the
// watches can read a prompt back after the app has been restarted.
describe('AI exchange persistence', () => {
  let ctx: ApiContext;
  let directoryService: DirectoryService;
  let settingsService: SettingsService;
  let sessionId: string;

  function record(label: string, text: string, stageId?: StageId) {
    return ctx.aiExchangeLog.runLabeled(
      label,
      AIActionType.COGNITION,
      () => {
        ctx.aiExchangeLog.record({
          request: { messages: [{ role: 'user', content: text, tokens: 1 }], maxResponseTokens: 1 },
          responseText: `reply to ${text}`,
          durationMs: 3,
        });
        return Promise.resolve();
      },
      stageId,
    );
  }

  beforeEach(() => {
    ({ directoryService, settingsService } = mockEnvironment());
    ctx = mockApiContext({ directoryService, settingsService });
    fs.mkdirSync(ctx.directory.getSentientSimsFolder(), { recursive: true });
    sessionId = `exchange-${Math.random().toString(36).slice(2)}`;
    ctx.db.loadDatabase({ sessionId, saveId: '1' });
  });

  it('serves rows written before a restart, with ids that never repeat', async () => {
    await record('Cognition: Alice', 'first', StageId.DEFAULT_MODE_MONOLOGUE);
    await record('Cognition: Bob', 'second');

    // A restart: a brand new context over the same save file, so nothing is left in memory
    const restarted = mockApiContext({ directoryService, settingsService });
    restarted.db.loadDatabase({ sessionId, saveId: '1' });

    const listed = restarted.aiExchangeLog.list();
    expect(listed.map((entry) => entry.label)).toEqual(['Cognition: Bob', 'Cognition: Alice']);
    expect(listed[1].stageId).toBe(StageId.DEFAULT_MODE_MONOLOGUE);
    expect(restarted.aiExchangeLog.get(listed[1].id)?.request.messages[0].content).toBe('first');

    // Ids continue above the stored rows instead of colliding with them
    restarted.aiExchangeLog.record({
      request: { messages: [], maxResponseTokens: 1 },
      responseText: '',
      durationMs: 1,
    });
    const ids = restarted.aiExchangeLog.list().map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Math.max(...ids)).toBe(3);
  });

  it('keeps each save’s log in its own database', async () => {
    await record('Cognition: Alice', 'first');

    ctx.db.loadDatabase({ sessionId: `${sessionId}-other`, saveId: '2' });
    await record('Cognition: Carl', 'elsewhere');

    expect(ctx.aiExchangeLog.list().map((entry) => entry.label)).toEqual(['Cognition: Carl']);
  });

  it('links a memory onto the stored rows, not just the in-memory ones', () => {
    const request: OpenAICompatibleRequest = { messages: [], maxResponseTokens: 1 };
    ctx.aiExchangeLog.record({ request, responseText: '', durationMs: 1 });
    ctx.aiExchangeLog.record({ request: { messages: [], maxResponseTokens: 1 }, responseText: '', durationMs: 1 });

    ctx.aiExchangeLog.linkRequestsToMemory([request], '77');

    const restarted = mockApiContext({ directoryService, settingsService });
    restarted.db.loadDatabase({ sessionId, saveId: '1' });
    expect(restarted.aiExchangeLog.list().filter((entry) => entry.memoryId === '77')).toHaveLength(1);
  });

  it('still logs in memory when no save is loaded', () => {
    const noDb = mockApiContext();
    noDb.aiExchangeLog.record({
      request: { messages: [], maxResponseTokens: 1 },
      responseText: 'menu',
      durationMs: 1,
    });

    expect(noDb.aiExchangeLog.list()).toHaveLength(1);
  });

  it('records the call even when the row cannot be written', async () => {
    vi.spyOn(ctx.aiExchangeRepository, 'insert').mockImplementation(() => {
      throw new Error('disk is on fire');
    });
    vi.spyOn(OpenAIService.prototype, 'sentientSimsGenerate').mockImplementation((request: OpenAICompatibleRequest) =>
      Promise.resolve({ text: 'rated 4', request }),
    );
    ctx.settings.aiApiType = ApiType.OpenAI;
    ctx.settings.openaiKey = 'sk-test';

    await expect(ctx.ai.runOneShot('Memory Importance', 'rate it', 'something happened', 5)).resolves.toBeDefined();
    // The list reads the table, which never got the row; the detail still comes from the ring
    expect(ctx.aiExchangeLog.get(1)?.label).toBe('Memory Importance');
  });
});
