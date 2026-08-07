import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import { ApiType } from 'main/sentient-sims/models/ApiType';
import { OpenAICompatibleRequest } from 'main/sentient-sims/models/OpenAICompatibleRequest';
import { SimStateReport } from 'main/sentient-sims/models/SimStateReport';
import { SettingsEnum } from 'main/sentient-sims/models/SettingsEnum';
import { ApiContext } from 'main/sentient-sims/services/ApiContext';
import { OpenAIService } from 'main/sentient-sims/services/OpenAIService';
import { mockApiContext } from './util';

const INTENT = JSON.stringify({
  kind: 'action',
  action: 'grab_snack',
  target_object_id: '900',
  thought: 'I could really go for a snack.',
  motivation: 'hungry',
});

function idleSimReport(seq: number): SimStateReport {
  return {
    type: 'state_report',
    seq,
    lot: { zone_id: 1, clock: { hour: 10, paused: false } },
    sims: [
      {
        sim_id: '100',
        sim_name: 'Elliot',
        location: { zone_id: 1 },
        sims: [],
        objects: [
          { object_id: '900', action_keys: ['grab_snack'], name: 'object_fridge', tier: 'same_room', distance: 4 },
        ],
        self: { mood: 'Fine', needs: { hunger: -40 } },
        activity: { queue: [], running: null, in_social: false },
      },
    ],
  };
}

async function settle() {
  for (let i = 0; i < 12; i += 1) {
    await Promise.resolve();
  }
}

// A cognition tick driven through the real ApiContext (real CognitionService, real memory
// repository, real exchange log) with only the provider mocked — the same path the game
// takes when a sim decides what to do next.
describe('Cognition tick tracing', () => {
  let ctx: ApiContext;

  beforeEach(() => {
    ctx = mockApiContext();
    fs.mkdirSync(ctx.directory.getSentientSimsFolder(), { recursive: true });
    ctx.db.loadDatabase({ sessionId: `cog-${Math.random().toString(36).slice(2)}`, saveId: '1' });
    ctx.settings.aiApiType = ApiType.OpenAI;
    ctx.settings.openaiKey = 'sk-test';
    ctx.settings.memoryRetrievalEnabled = false;
    // Cognition knobs are read-only properties over the settings store
    ctx.settings.set(SettingsEnum.COGNITION_ENABLED, true);
    ctx.settings.set(SettingsEnum.COGNITION_AUTONOMY_LEVEL, 'suggest');
    ctx.settings.set(SettingsEnum.COGNITION_PIPELINE, 'off');

    vi.spyOn(OpenAIService.prototype, 'sentientSimsGenerate').mockImplementation((request: OpenAICompatibleRequest) =>
      Promise.resolve({ text: INTENT, request }),
    );
  });

  it('logs the deliberation under the sim name and traces it onto the thought memory', async () => {
    ctx.simStateCache.ingest(idleSimReport(1));
    await settle();

    const [entry] = ctx.aiExchangeLog.list();
    expect(entry.label).toBe('Cognition: Elliot');
    expect(entry.actionType).toBe('cognition');

    // The prompt the sim actually deliberated on is readable in full — the perception and
    // the offered actions it chose from (rendered human-readably, "grab snack")
    const detail = ctx.aiExchangeLog.get(entry.id);
    const prompt = (detail?.request.messages ?? []).map((message) => message.content).join('\n');
    expect(prompt).toContain('You are Elliot');
    expect(prompt).toContain('grab snack');

    // ...and the thought it produced carries the deliberation as its trace
    const thought = ctx.memoryRepository
      .getMemories()
      .find((memory) => memory.content === 'I could really go for a snack.');
    expect(thought?.id).toBeDefined();
    const trace = ctx.memoryTrace.getTrace(String(thought?.id));
    expect(trace?.pipeline).toBe('cognition');
    expect(trace?.exchanges[0].label).toBe('Cognition: Elliot');
  });
});
