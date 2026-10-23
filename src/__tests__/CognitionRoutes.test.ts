import { Server } from 'http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runApi } from 'main/sentient-sims/api';
import { CreateMemoryRequest } from 'main/sentient-sims/models/GetMemoryRequest';
import { WebsocketNotification } from 'main/sentient-sims/models/ModWebsocketMessage';
import { mockApiContext } from './util';
import { autonomyOf } from 'main/sentient-sims/tiers/autonomy';

describe('cognition routes', () => {
  const ctx = mockApiContext({ port: 25204 });
  const apiUrl = `http://localhost:${ctx.port}`;
  let server: Server;

  const sentToMod: WebsocketNotification[] = [];
  const createdMemories: CreateMemoryRequest[] = [];

  async function post(path: string, body: unknown) {
    const response = await fetch(`${apiUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.json() as Promise<Record<string, unknown>>;
  }

  beforeAll(() => {
    vi.spyOn(autonomyOf(ctx).actionDispatcher, 'sendToMod').mockImplementation((message) => {
      sentToMod.push(message);
    });
    // dispatch() fails fast without a connected mod websocket — pretend one is attached
    vi.spyOn(autonomyOf(ctx).actionDispatcher, 'isModConnected').mockReturnValue(true);
    vi.spyOn(ctx.memoryRepository, 'createMemory').mockImplementation((request) => {
      createdMemories.push(request);
      return { ...request.memory, id: '7' };
    });
    server = runApi(ctx);
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  });

  it('the intention rows are inspectable and the debug fire answers without a report', async () => {
    const list = await fetch(`${apiUrl}/cognition/rows/555`).then(
      (response) => response.json() as Promise<Record<string, unknown>>,
    );
    expect(list).toEqual({ sim_id: '555', rows: [] });
    const all = await fetch(`${apiUrl}/cognition/rows`).then(
      (response) => response.json() as Promise<Record<string, unknown>>,
    );
    expect(all).toEqual({});
    const missing = await fetch(`${apiUrl}/cognition/debug/rows/fire`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sim_id: '555' }),
    });
    expect(missing.status).toBe(400);
    const fire = await fetch(`${apiUrl}/cognition/debug/rows/fire`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sim_id: '555', row_id: 'i000001' }),
    });
    expect(fire.status).toBe(409);
    expect(await fire.json()).toMatchObject({ ok: false });
  });

  it('debug enqueue dispatches an ENQUEUE_INTERACTION message and the outcome becomes a memory', async () => {
    const enqueue = await post('/cognition/debug/enqueue', {
      sim_id: '123',
      action: 'tell_joke',
      target_sim_id: '456',
      motivation: 'wants to cheer Peyton up',
    });

    const requestId = enqueue.request_id as string;
    expect(requestId).toBeTruthy();
    expect(autonomyOf(ctx).actionDispatcher.pendingCount).toBe(1);
    expect(sentToMod).toHaveLength(1);
    expect(sentToMod[0]).toMatchObject({
      type: 'enqueue_interaction',
      request_id: requestId,
      sim_id: '123',
      action: 'tell_joke',
      target_sim_id: '456',
      source: 'cognition',
    });

    const outcome = await post('/cognition/outcome', {
      request_id: requestId,
      sim_id: '123',
      sim_name: 'Marisol Rocca',
      target_sim_id: '456',
      target_sim_name: 'Peyton Puckett',
      interaction_name: 'mixer_socials_TellJoke_group_Funny_alwaysOn',
      outcome: 'success',
      location_id: 88,
    });

    expect(outcome).toMatchObject({ ok: true, correlated: true, memory_id: '7' });
    expect(autonomyOf(ctx).actionDispatcher.pendingCount).toBe(0);
    expect(createdMemories).toHaveLength(1);
    expect(createdMemories[0].memory).toMatchObject({
      event_type: 'outcome',
      location_id: 88,
      action: 'tell_joke',
      interaction_name: 'mixer_socials_TellJoke_group_Funny_alwaysOn',
      pre_action: 'wants to cheer Peyton up',
    });
    expect(createdMemories[0].memory.observation).toBe(
      "Marisol Rocca tried 'tell_joke' with Peyton Puckett and it succeeded.",
    );
    expect(createdMemories[0].participants.map((participant) => participant.id)).toEqual(['123', '456']);

    // A duplicate outcome for the same request is uncorrelated: the pending dispatch was consumed
    const duplicate = await post('/cognition/outcome', {
      request_id: requestId,
      sim_id: '123',
      outcome: 'failure',
    });
    expect(duplicate).toMatchObject({ ok: true, correlated: false });
  });

  it('a pie click is echoed to the mod and its outcome reads by the label', async () => {
    createdMemories.length = 0;
    sentToMod.length = 0;
    const enqueue = await post('/cognition/debug/enqueue', {
      sim_id: '123',
      action: 'mixer_social_AskAboutDay',
      target_sim_id: '456',
      pie: { target_id: '456', target_kind: 'sim', item: 'mixer_social_AskAboutDay', label: 'Ask about Day' },
    });
    const requestId = enqueue.request_id as string;
    expect(sentToMod[0]).toMatchObject({
      type: 'enqueue_interaction',
      request_id: requestId,
      pie: { target_id: '456', target_kind: 'sim', item: 'mixer_social_AskAboutDay', label: 'Ask about Day' },
    });
    await post('/cognition/outcome', {
      request_id: requestId,
      sim_id: '123',
      sim_name: 'Marisol Rocca',
      target_sim_id: '456',
      target_sim_name: 'Peyton Puckett',
      action: 'mixer_social_AskAboutDay',
      label: 'Ask about Day',
      interaction_name: 'mixer_social_AskAboutDay_targeted_Friendly_alwaysOn',
      outcome: 'success',
    });
    expect(createdMemories[0].memory.observation).toBe(
      "Marisol Rocca tried 'Ask about Day' with Peyton Puckett and it succeeded.",
    );
    expect(createdMemories[0].memory.action).toBe('mixer_social_AskAboutDay');
  });

  it('an uncorrelated outcome with a label reads by the label too', async () => {
    createdMemories.length = 0;
    await post('/cognition/outcome', {
      sim_id: '123',
      sim_name: 'Marisol Rocca',
      action: 'stereo_Listen',
      label: 'Jazz',
      outcome: 'failure',
    });
    expect(createdMemories[0].memory.observation).toBe("Marisol Rocca tried 'Jazz' and it failed.");
  });

  it('writes an uncorrelated failure outcome using the reported names', async () => {
    createdMemories.length = 0;

    const outcome = await post('/cognition/outcome', {
      sim_id: '123',
      sim_name: 'Marisol Rocca',
      action: 'grab_snack',
      interaction_name: 'fridge_GrabSnackAutonomously',
      outcome: 'failure',
      location_id: 5,
    });

    expect(outcome).toMatchObject({ ok: true, correlated: false });
    expect(createdMemories[0].memory.observation).toBe("Marisol Rocca tried 'grab_snack' and it failed.");
    expect(createdMemories[0].memory.pre_action).toBeUndefined();
  });

  it('humanizes a raw game repr in the outcome reason', async () => {
    createdMemories.length = 0;

    const outcome = await post('/cognition/outcome', {
      sim_id: '123',
      sim_name: 'Marisol Rocca',
      action: 'take_shower',
      interaction_name: 'shower_TakeShower',
      outcome: 'canceled',
      reason: '<EnqueueResult: Bills: Interaction requires a utility that is shut off. <ExecuteResult: False: (None)>>',
      location_id: 5,
    });

    expect(outcome).toMatchObject({ ok: true, correlated: false });
    expect(createdMemories[0].memory.observation).toBe(
      "Marisol Rocca tried 'take_shower' and it was canceled (Bills: Interaction requires a utility that is shut off.).",
    );
  });

  // F5: the phantom, end to end. On 2026-08-26 a sim wedged in a shower transition loop
  // was told 'take_shower succeeded' 126ms after dispatch, with nothing registered in the
  // game. That sentence went into a permanent memory row and into later prompts.
  it('never writes a dispatch-time success with no claim as a success', async () => {
    createdMemories.length = 0;

    const outcome = await post('/cognition/outcome', {
      sim_id: '123',
      sim_name: 'Marisol Rocca',
      action: 'take_shower',
      outcome: 'success',
      decided_at: 'dispatch',
      push_id: null,
      ran: null,
      location_id: 5,
    });

    expect(outcome).toMatchObject({ ok: true, verdict: 'suspect' });
    expect(createdMemories[0].memory.observation).toBe(
      "Marisol Rocca tried 'take_shower'; the game accepted it but nothing confirmed it happened.",
    );
    // 'succeeded' is what retrieval and the scene filters key on — it must not appear
    expect(createdMemories[0].memory.observation).not.toContain('succeeded');
  });

  it('writes an outcome the game decided as a plain success', async () => {
    createdMemories.length = 0;

    const outcome = await post('/cognition/outcome', {
      sim_id: '123',
      sim_name: 'Marisol Rocca',
      action: 'take_shower',
      interaction_name: 'shower_TakeShower',
      outcome: 'success',
      decided_at: 'finished',
      push_id: '4242',
      ran: true,
      location_id: 5,
    });

    expect(outcome).toMatchObject({ ok: true, verdict: 'confirmed' });
    expect(createdMemories[0].memory.observation).toBe("Marisol Rocca tried 'take_shower' and it succeeded.");
  });

  it('keeps a dispatch-time success that names its claim', async () => {
    createdMemories.length = 0;

    // 'sit' never completes, so the successful push IS the outcome. The prose is not
    // hedged; the verdict records that nothing confirmed it.
    const outcome = await post('/cognition/outcome', {
      sim_id: '123',
      sim_name: 'Marisol Rocca',
      action: 'sit',
      outcome: 'success',
      decided_at: 'dispatch',
      claim: 'instant_verb',
      location_id: 5,
    });

    expect(outcome).toMatchObject({ ok: true, verdict: 'claimed' });
    expect(createdMemories[0].memory.observation).toBe("Marisol Rocca tried 'sit' and it succeeded.");
  });

  it('grades an outcome from a mod with no provenance exactly as before', async () => {
    createdMemories.length = 0;

    const outcome = await post('/cognition/outcome', {
      sim_id: '123',
      sim_name: 'Marisol Rocca',
      action: 'grab_snack',
      outcome: 'success',
      location_id: 5,
    });

    expect(outcome).toMatchObject({ ok: true, verdict: 'unknown' });
    expect(createdMemories[0].memory.observation).toBe("Marisol Rocca tried 'grab_snack' and it succeeded.");
  });

  it('flags a success the sim is too wedged to have had', async () => {
    createdMemories.length = 0;
    // The mod's stuck watchdog says this sim's pushes are starving behind a shower SI,
    // and the outcome reports that same SI as what the sim is still running. Stubbed
    // rather than ingested: the cache is shared across this file and drops stale seqs.
    const blocked = vi
      .spyOn(ctx.simStateCache, 'getSim')
      .mockReturnValue({ sim_id: '123', sims: [], objects: [], activity: { blocked_by: 'shower_TakeShower' } });

    const outcome = await post('/cognition/outcome', {
      sim_id: '123',
      sim_name: 'Marisol Rocca',
      action: 'grab_snack',
      outcome: 'success',
      decided_at: 'dispatch',
      claim: 'merged_social',
      sim_running: 'shower_TakeShower',
      location_id: 5,
    });

    expect(outcome).toMatchObject({ ok: true, verdict: 'suspect' });
    expect(createdMemories[0].memory.observation).toContain('nothing confirmed it happened');
    blocked.mockRestore();
  });

  // F5: 'late' now means the DISPATCHER had already let go of this request. The old flag
  // meant 'the sim's runtime is not PENDING_OUTCOME', which was equally true for every ask
  // and debug dispatch the runtime never owned — one name over two different facts.
  it('grades an outcome that arrives after the dispatch was released as late', async () => {
    createdMemories.length = 0;
    const enqueue = await post('/cognition/debug/enqueue', {
      sim_id: '123',
      action: 'play_guitar',
      source: 'cognition',
    });
    const requestId = enqueue.request_id as string;

    // The pending timeout gave up on it
    autonomyOf(ctx).actionDispatcher.release(requestId);
    expect(autonomyOf(ctx).actionDispatcher.wasClosed(requestId)).toBe(true);
    // ...but the dispatch is still there to grade against
    expect(autonomyOf(ctx).actionDispatcher.lookup(requestId)?.intent.action).toBe('play_guitar');

    // The mod answers late: it left the action running and it really did succeed
    const real = await post('/cognition/outcome', {
      request_id: requestId,
      sim_id: '123',
      sim_name: 'Marisol Rocca',
      action: 'play_guitar',
      outcome: 'success',
      decided_at: 'app_cancel',
      ran: true,
      location_id: 5,
    });
    expect(real).toMatchObject({ ok: true, verdict: 'confirmed' });
    expect(createdMemories[0].memory.observation).toContain('succeeded');

    // A late success for something that never ran is a different story
    const enqueue2 = await post('/cognition/debug/enqueue', {
      sim_id: '123',
      action: 'play_guitar',
      source: 'cognition',
    });
    const requestId2 = enqueue2.request_id as string;
    autonomyOf(ctx).actionDispatcher.release(requestId2);
    createdMemories.length = 0;

    const phantom = await post('/cognition/outcome', {
      request_id: requestId2,
      sim_id: '123',
      sim_name: 'Marisol Rocca',
      action: 'play_guitar',
      outcome: 'success',
      decided_at: 'finished',
      ran: false,
      location_id: 5,
    });
    expect(phantom).toMatchObject({ ok: true, verdict: 'suspect' });
    expect(createdMemories[0].memory.observation).toContain('nothing confirmed it happened');
  });

  it('requests a perception snapshot and formats the reply', async () => {
    sentToMod.length = 0;

    const request = await post('/cognition/debug/perception', { sim_id: '123' });
    const requestId = request.request_id as string;
    expect(requestId).toBeTruthy();
    expect(sentToMod).toHaveLength(1);
    expect(sentToMod[0]).toMatchObject({
      type: 'request_perception',
      request_id: requestId,
      sim_id: '123',
    });

    const reply = await post('/cognition/perception', {
      type: 'perception_snapshot',
      request_id: requestId,
      sim_id: '123',
      sim_name: 'Marisol Rocca',
      room_id: 5,
      location: { zone_id: 9, outdoors: false },
      sims: [{ sim_id: '456', tier: 'same_room', distance: 3.0, name: 'Peyton Puckett', doing: 'chat' }],
      objects: [
        { object_id: '100', action_keys: ['grab_snack'], name: 'object_fridge_01', tier: 'same_room', distance: 4.0 },
      ],
      ambient: { sim_mood: 'Happy' },
    });

    expect(reply.ok).toBe(true);
    expect(reply.formatted).toContain(
      'You can see: Peyton Puckett (chat, 3m away); a fridge (could grab snack, 4m away).',
    );
    expect(autonomyOf(ctx).controller.getPerception('123')).toMatchObject({ request_id: requestId, sim_id: '123' });
  });

  it('reads perception through the SimStateCache once state reports flow', async () => {
    const result = await post('/cognition/state', {
      type: 'state_report',
      seq: 1,
      sims: [
        {
          sim_id: '123',
          sims: [],
          objects: [],
          self: { mood: 'Happy', needs: { bladder: 20 } },
          activity: { queue: [], running: null, in_social: false },
        },
      ],
    });
    expect(result).toMatchObject({ ok: true, seq: 1 });
    expect(autonomyOf(ctx).controller.getPerception('123')?.self?.mood).toBe('Happy');
  });

  it('rejects invalid requests', async () => {
    expect(await post('/cognition/debug/enqueue', { sim_id: '123' })).toMatchObject({
      error: 'sim_id and action are required',
    });
    expect(await post('/cognition/outcome', { outcome: 'success' })).toMatchObject({
      error: 'sim_id and outcome are required',
    });
    expect(await post('/cognition/perception', { sims: [] })).toMatchObject({
      error: 'sim_id is required',
    });
    expect(await post('/cognition/debug/perception', {})).toMatchObject({
      error: 'sim_id is required',
    });
  });
});
