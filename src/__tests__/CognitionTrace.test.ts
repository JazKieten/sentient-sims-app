import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import { ApiType } from 'main/sentient-sims/models/ApiType';
import { OpenAICompatibleRequest } from 'main/sentient-sims/models/OpenAICompatibleRequest';
import { SimStateReport } from 'main/sentient-sims/models/SimStateReport';
import { SettingsEnum } from 'main/sentient-sims/models/SettingsEnum';
import { ApiContext } from 'main/sentient-sims/services/ApiContext';
import { OpenAIService } from 'main/sentient-sims/services/OpenAIService';
import { mockApiContext } from './util';
import { devOf } from 'main/sentient-sims/tiers/dev';

const MONOLOGUE = 'I could really go for a snack.';
// memory 6: above the storage floor, so the tick's thought is written down and can
// carry the trace this test reads back
const SCORES = '{"memory": 6, "action": 2, "action_reason": "Just a bit peckish."}';

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
  for (let i = 0; i < 64; i += 1) {
    await Promise.resolve();
  }
}

// A cognition tick driven through the real ApiContext (real CognitionService, real memory
// repository, real exchange log) with only the provider mocked — the same path the game
// takes when a sim's inner monologue is generated and scored.
describe('Cognition tick tracing', () => {
  let ctx: ApiContext;

  beforeEach(() => {
    ctx = mockApiContext();
    fs.mkdirSync(ctx.directory.getSentientSimsFolder(), { recursive: true });
    ctx.db.loadDatabase({ sessionId: `cog-${Math.random().toString(36).slice(2)}`, saveId: '1' });
    ctx.settings.aiApiType = ApiType.OpenAI;
    ctx.settings.openaiKey = 'sk-test';
    // Cognition knobs are read-only properties over the settings store
    ctx.settings.set(SettingsEnum.COGNITION_ENABLED, true);
    ctx.settings.set(SettingsEnum.COGNITION_AUTONOMY_LEVEL, 'suggest');
    // The tick stages traced here run with the legacy tick only (part 7)
    ctx.settings.set(SettingsEnum.COGNITION_LEGACY_TICK, true);

    // The provider mock dispatches on the stage's system prompt — labels are an
    // exchange-log concern, invisible at this layer
    vi.spyOn(OpenAIService.prototype, 'sentientSimsGenerate').mockImplementation((request: OpenAICompatibleRequest) => {
      const system = request.messages.find((message) => message.role === 'system')?.content ?? '';
      let text = '';
      if (system.includes('private inner voice')) {
        text = MONOLOGUE;
      } else if (system.includes('scoring one Sim')) {
        text = SCORES;
      }
      return Promise.resolve({ text, request });
    });
  });

  it('logs the tick stages under the sim name and traces them onto the thought memory', async () => {
    ctx.simStateCache.ingest(idleSimReport(1));
    await settle();

    // Newest first: the scores call closed the tick
    const entries = ctx.aiExchangeLog.list();
    expect(entries.map((entry) => entry.label)).toEqual(['Cognition Scores: Elliot', 'Cognition Monologue: Elliot']);
    expect(entries[1].actionType).toBe('cognition');

    // The prompt the sim's monologue grew from is readable in full — the perception and
    // the offered actions (rendered human-readably, "grab snack")
    const detail = ctx.aiExchangeLog.get(entries[1].id);
    const prompt = (detail?.request.messages ?? []).map((message) => message.content).join('\n');
    expect(prompt).toContain('You are Elliot');
    expect(prompt).toContain('grab snack');

    // ...and the thought it produced carries both tick stages as its trace
    const thought = ctx.memoryRepository.getMemories().find((memory) => memory.content === MONOLOGUE);
    expect(thought?.id).toBeDefined();
    const trace = devOf(ctx).memoryTrace.getTrace(String(thought?.id));
    expect(trace?.pipeline).toBe('cognition');
    expect(trace?.exchanges.map((exchange) => exchange.label)).toEqual([
      'Cognition Monologue: Elliot',
      'Cognition Scores: Elliot',
    ]);
  });
});
