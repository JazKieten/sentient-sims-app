import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsEnum } from 'main/sentient-sims/models/SettingsEnum';
import fs from 'fs';
import { ApiType } from 'main/sentient-sims/models/ApiType';
import { ChatInteractionEvent, SSEventType } from 'main/sentient-sims/models/InteractionEvents';
import { OpenAICompatibleRequest } from 'main/sentient-sims/models/OpenAICompatibleRequest';
import { SentientSim } from 'main/sentient-sims/models/SentientSim';
import { SimAge } from 'main/sentient-sims/models/SimAge';
import { ApiContext } from 'main/sentient-sims/services/ApiContext';
import { mockApiContext } from './util';
import { devOf } from 'main/sentient-sims/tiers/dev';

const playerSim: SentientSim = {
  careers: [],
  name: 'Marisol Vega',
  age: SimAge.ADULT,
  sim_id: '882730689256095860',
  gender: 'Female',
  traits: ['trait_Cheerful'],
  moods: ['Mood_Playful'],
  is_ghost: false,
  grubby: false,
  in_pool: false,
  is_at_home: false,
  is_dying: false,
  is_human: true,
  is_inside_building: true,
  is_outside: false,
  is_pet: false,
  on_fire: false,
  on_home_lot: false,
  sleeping: false,
  is_pregnant: false,
  is_player_sim: true,
};

const targetSim: SentientSim = {
  ...playerSim,
  name: 'Nancy Landgraab',
  sim_id: '52942350254217326',
  traits: ['trait_Snob'],
  moods: ['Mood_Flirty'],
  is_player_sim: false,
};

function buildChatEvent(action: string, sims: SentientSim[]): ChatInteractionEvent {
  return {
    event_id: crypto.randomUUID(),
    event_type: SSEventType.CHAT,
    location_id: 0,
    sentient_sims: sims,
    action,
    relationships: { relationship_bits: [] },
    environment: {
      location_id: 90336000,
      world_id: 0,
      time: { second: 0, minute: 0, hour: 14, day: 2, week: 1 },
    },
  };
}

const briefing = `=== SCENE ===
A gym, midday. The two are chatting between sets.
=== PROMPT FOR Nancy Landgraab ===
You are playing Nancy Landgraab. Answer warmly and keep it moving.`;

const actorLine = 'Same here, this place beats my old gym.';

describe('Memory trace end to end', () => {
  let ctx: ApiContext;

  function mockGeneration() {
    const service = ctx.getGenerationService(ApiType.OpenAI);
    return vi.spyOn(service, 'sentientSimsGenerate').mockImplementation((request: OpenAICompatibleRequest) => {
      const systemPrompt = request.messages.find((message) => message.role === 'system')?.content ?? '';
      let text = actorLine;
      if (systemPrompt.includes('You are directing a scene')) {
        text = briefing;
      } else if (systemPrompt.includes('You are the director of a show')) {
        text = `Nancy Landgraab: ${actorLine}`;
      } else if (systemPrompt.includes('You are scoring the scene')) {
        text = '{"Nancy Landgraab": {"memory": 3, "action": 2, "action_reason": "Happy chatting."}}';
      }
      return Promise.resolve({ text, request });
    });
  }

  beforeEach(() => {
    ctx = mockApiContext();
    // These tests mock the 4.6 pipeline by stage label; the default is lean (2026-10-27)
    ctx.settings.set(SettingsEnum.SCENE_PIPELINE_MODE, 'full');
    fs.mkdirSync(ctx.directory.getSentientSimsFolder(), { recursive: true });
    ctx.db.loadDatabase({ sessionId: `trace-${Math.random().toString(36).slice(2)}`, saveId: '1' });
    ctx.settings.aiApiType = ApiType.OpenAI;
    ctx.settings.openaiKey = 'sk-test';
  });

  it('attaches the directed-scene trace when the mod posts the memory back', async () => {
    mockGeneration();

    const result = await ctx.ai.interactionEvent(buildChatEvent('Nice, me too!', [playerSim, targetSim]));
    expect(result.memory).toBeDefined();

    // The mod persists the memory it got back in the interaction result
    const saved = ctx.memoryRepository.createMemory({
      memory: { ...result.memory, location_id: 90336000 },
      participants: ctx.participantRepository.getParticipants(
        [playerSim, targetSim].map((sim) => ({ id: sim.sim_id, fullName: sim.name })),
      ),
    });

    expect(saved?.id).toBeDefined();
    const trace = devOf(ctx).memoryTrace.getTrace(String(saved?.id));
    expect(trace).toBeDefined();
    expect(trace?.pipeline).toBe('directed_scene');
    expect(trace?.exchanges.map((exchange) => exchange.label)).toEqual([
      'Director Briefing',
      'Actor: Nancy Landgraab',
      'Director Review',
      'Scene Scores',
    ]);
    expect(trace?.directorDirection).toContain('PROMPT FOR Nancy Landgraab');
    expect(trace?.review?.before).toContain(actorLine);
  });
});
