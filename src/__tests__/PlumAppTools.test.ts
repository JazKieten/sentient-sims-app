import * as fs from 'fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('main/sentient-sims/websocketServer', () => ({
  sendModNotification: vi.fn(),
  getModClockState: () => undefined,
}));

import { ApiContext } from 'main/sentient-sims/services/ApiContext';
import { SimStateReport } from 'main/sentient-sims/models/SimStateReport';
import { buildAppTools, resolveSimId } from 'main/sentient-sims/services/plum/PlumAppTools';
import { mockApiContext } from './util';

const BELLA = '100';
const DON = '200';

function reportWith(...sims: [string, string][]): SimStateReport {
  return {
    type: 'state_report',
    seq: 1,
    sims: sims.map(([sim_id, sim_name]) => ({ sim_id, sim_name, sims: [], objects: [] })),
  };
}

function loadedContext(): ApiContext {
  const ctx = mockApiContext({ tiers: [] });
  fs.mkdirSync(ctx.directory.getSentientSimsFolder(), { recursive: true });
  ctx.db.loadDatabase({ sessionId: `plum-${Date.now()}`, saveId: '1' });
  ctx.participantRepository.updateParticipant({ id: BELLA, name: 'Bella Goth' });
  ctx.participantRepository.updateParticipant({ id: DON, name: 'Don Lothario' });
  return ctx;
}

function tool(ctx: ApiContext, name: string) {
  const found = buildAppTools(ctx).find((candidate) => candidate.definition.name === name);
  if (!found) {
    throw new Error(`no app tool ${name}`);
  }
  return found;
}

describe('Plum app-side tools', () => {
  it('resolves a Sim by id, full name or first name from the state report, then the participants', () => {
    const ctx = mockApiContext({ tiers: [] });
    ctx.simStateCache.ingest(reportWith([BELLA, 'Bella Goth'], [DON, 'Don Lothario'], ['300', 'Bella Bachelor']));
    expect(resolveSimId(ctx, '200')).toBe('200');
    expect(resolveSimId(ctx, 'bella goth')).toBe(BELLA);
    expect(resolveSimId(ctx, 'Don')).toBe(DON);
    // Two Bellas: ambiguous
    expect(resolveSimId(ctx, 'Bella')).toBeUndefined();
    expect(resolveSimId(ctx, 'Mortimer')).toBeUndefined();
    expect(resolveSimId(ctx, '')).toBeUndefined();
  });

  it('recent_memories lists the newest memories, filtered to one Sim', async () => {
    const ctx = loadedContext();
    ctx.memoryRepository.createMemory({
      memory: { location_id: 1, content: 'Bella and Don talked about the weather.', action: 'chat' },
      participants: [{ id: BELLA }, { id: DON }],
    });
    ctx.memoryRepository.createMemory({
      memory: { location_id: 1, content: 'Don cooked alone.', action: 'cook' },
      participants: [{ id: DON }],
    });
    const all = (await tool(ctx, 'recent_memories').run({ n: null, sim: null })) as { memories: { text: string }[] };
    expect(all.memories.map((memory) => memory.text)).toEqual([
      'Bella and Don talked about the weather.',
      'Don cooked alone.',
    ]);
    const bella = (await tool(ctx, 'recent_memories').run({ n: 5, sim: 'Bella' })) as {
      memories: { text: string; participants: string[] }[];
    };
    expect(bella.memories).toHaveLength(1);
    expect(bella.memories[0].participants).toContain('Bella Goth');
    const one = (await tool(ctx, 'recent_memories').run({ n: 1, sim: null })) as { memories: unknown[] };
    expect(one.memories).toHaveLength(1);
  });

  it('sim_facts names the Sims in the facts and refuses an unknown Sim', async () => {
    const ctx = loadedContext();
    ctx.semanticMemory.addFact({
      subjectSimId: BELLA,
      predicate: 'likes',
      objectSimId: DON,
      source: 'told',
      confidence: 0.8,
    });
    const facts = (await tool(ctx, 'sim_facts').run({ sim: 'Bella Goth', about: null })) as {
      sim: string;
      facts: { predicate: string; object: string }[];
    };
    expect(facts.sim).toBe('Bella Goth');
    expect(facts.facts).toEqual([expect.objectContaining({ predicate: 'likes', object: 'Don Lothario' })]);
    await expect(tool(ctx, 'sim_facts').run({ sim: 'Mortimer', about: null })).rejects.toThrow('Mortimer');
  });

  it('cognition_status needs the autonomy slot and reads it when present', async () => {
    const ctx = loadedContext();
    await expect(tool(ctx, 'cognition_status').run({ sim: 'Bella' })).rejects.toThrow('Full Autonomy');
    ctx.ext.plumCognition = (simId) => ({ plan: { goals: [{ key: `goal for ${simId}` }] }, outcomes: [] });
    const status = (await tool(ctx, 'cognition_status').run({ sim: 'Bella' })) as { plan: { goals: unknown[] } };
    expect(status.plan.goals).toEqual([{ key: `goal for ${BELLA}` }]);
  });

  it('every app tool is strict with every property required', () => {
    const ctx = mockApiContext({ tiers: [] });
    for (const { definition } of buildAppTools(ctx)) {
      const schema = definition.input_schema as {
        properties: Record<string, unknown>;
        required: string[];
        additionalProperties: boolean;
      };
      expect(schema.additionalProperties).toBe(false);
      expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
    }
  });
});
