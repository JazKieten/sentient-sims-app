import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import { AIActionType } from 'main/sentient-sims/models/AIActionType';
import { OpenAICompatibleRequest } from 'main/sentient-sims/models/OpenAICompatibleRequest';
import { ApiContext } from 'main/sentient-sims/services/ApiContext';
import { DirectoryService } from 'main/sentient-sims/services/DirectoryService';
import { SettingsService } from 'main/sentient-sims/services/SettingsService';
import { mockApiContext, mockEnvironment } from './util';
import { devOf } from 'main/sentient-sims/tiers/dev';

function request(content: string): OpenAICompatibleRequest {
  return { messages: [{ role: 'system', content, tokens: 4 }], maxResponseTokens: 10 };
}

// F4: a memory's pipeline trace is stored in the save alongside the exchange log, with each
// stage held as a reference into ai_exchange rather than a second copy of the prompt.
describe('Memory trace persistence', () => {
  let ctx: ApiContext;
  let directoryService: DirectoryService;
  let settingsService: SettingsService;
  let sessionId: string;

  function restart(): ApiContext {
    const restarted = mockApiContext({ directoryService, settingsService });
    restarted.db.loadDatabase({ sessionId, saveId: '1' });
    return restarted;
  }

  // Records a call through the log the way the provider seam does, then hands back the
  // pipeline-level exchange that references the same request object
  function generated(label: string, prompt: string, responseText: string) {
    const openAIRequest = request(prompt);
    return ctx.aiExchangeLog
      .runLabeled(label, AIActionType.COGNITION, () => {
        ctx.aiExchangeLog.record({ request: openAIRequest, responseText, durationMs: 2 });
        return Promise.resolve();
      })
      .then(() => ({ label, request: openAIRequest, responseText }));
  }

  beforeEach(() => {
    ({ directoryService, settingsService } = mockEnvironment());
    ctx = mockApiContext({ directoryService, settingsService });
    fs.mkdirSync(ctx.directory.getSentientSimsFolder(), { recursive: true });
    sessionId = `trace-${Math.random().toString(36).slice(2)}`;
    ctx.db.loadDatabase({ sessionId, saveId: '1' });
  });

  it('reads a trace back after a restart, prompts included', async () => {
    const exchange = await generated('Cognition: Alice', 'You are Alice.', 'I could go for a snack.');
    devOf(ctx).memoryTrace.recordPending(['I could go for a snack.'], { pipeline: 'cognition', exchanges: [exchange] });
    devOf(ctx).memoryTrace.attach({ id: '42', content: 'I could go for a snack.', location_id: 1 });

    const trace = devOf(restart()).memoryTrace.getTrace('42');

    expect(trace?.pipeline).toBe('cognition');
    expect(trace?.exchanges).toHaveLength(1);
    expect(trace?.exchanges[0].label).toBe('Cognition: Alice');
    expect(trace?.exchanges[0].request.messages[0].content).toBe('You are Alice.');
    expect(trace?.exchanges[0].responseText).toBe('I could go for a snack.');
  });

  it('stores a stage as a reference, not a second copy of the prompt', async () => {
    const exchange = await generated('Cognition: Alice', 'You are Alice.', 'A snack.');
    devOf(ctx).memoryTrace.recordPending(['A snack.'], { pipeline: 'cognition', exchanges: [exchange] });
    devOf(ctx).memoryTrace.attach({ id: '43', content: 'A snack.', location_id: 1 });

    const stored = devOf(ctx).memoryTraceRepository.get('43');
    expect(stored?.exchanges[0].exchangeId).toBe(1);
    expect(stored?.exchanges[0].exchange).toBeUndefined();
  });

  it('inlines a stage that never reached the provider seam', () => {
    const exchange = { label: 'Stubbed', request: request('unlogged'), responseText: 'out' };
    devOf(ctx).memoryTrace.recordPending(['A line.'], { pipeline: 'other', exchanges: [exchange] });
    devOf(ctx).memoryTrace.attach({ id: '44', content: 'A line.', location_id: 1 });

    expect(devOf(ctx).memoryTraceRepository.get('44')?.exchanges[0].exchange?.responseText).toBe('out');
    expect(devOf(restart()).memoryTrace.getTrace('44')?.exchanges[0].request.messages[0].content).toBe('unlogged');
  });

  it('appends a later stage onto a trace stored before the restart', async () => {
    const exchange = await generated('Cognition: Alice', 'You are Alice.', 'A snack.');
    devOf(ctx).memoryTrace.recordPending(['A snack.'], { pipeline: 'cognition', exchanges: [exchange] });
    devOf(ctx).memoryTrace.attach({ id: '45', content: 'A snack.', location_id: 1 });

    // The importance rating runs against the row later — after a restart, only the stored
    // trace exists to append to
    const restarted = restart();
    devOf(restarted).memoryTrace.appendExchange('45', {
      label: 'Memory Importance',
      request: request('rate it'),
      responseText: '4',
    });

    expect(
      devOf(restart())
        .memoryTrace.getTrace('45')
        ?.exchanges.map((entry) => entry.label),
    ).toEqual(['Cognition: Alice', 'Memory Importance']);
  });

  it('keeps working in memory when no save is loaded', () => {
    const noDb = mockApiContext();
    devOf(noDb).memoryTrace.recordPending(['A line.'], { pipeline: 'other', exchanges: [] });
    devOf(noDb).memoryTrace.attach({ id: '46', content: 'A line.', location_id: 1 });

    expect(devOf(noDb).memoryTrace.getTrace('46')?.pipeline).toBe('other');
  });
});
