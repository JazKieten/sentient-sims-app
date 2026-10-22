import { afterEach, describe, expect, it, vi } from 'vitest';
import { DISCONNECTED, ModQueryService, NOT_CONNECTED } from 'main/sentient-sims/services/ModQueryService';
import { ModCognitionQuery, WebsocketNotification } from 'main/sentient-sims/models/ModWebsocketMessage';
import { autonomyOf, autonomyTier } from 'main/sentient-sims/tiers/autonomy';
import { mockApiContext } from './util';

// Cognition's question channel to the mod (autonomy part 1, 2026-10-21): one cognition_query
// frame out, one {cognition: {kind: 'query_result'}} back by request id; a held click's end
// reaches the listeners; the wire failing resolves every pending question instead of hanging.

function service(connected = true) {
  const sent: WebsocketNotification[] = [];
  const query = new ModQueryService();
  query.sendToMod = (message) => {
    sent.push(message);
  };
  query.isModConnected = () => connected;
  return { query, sent };
}

describe('ModQueryService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends a cognition_query frame and resolves the answer by request id', async () => {
    const { query, sent } = service();
    const pending = query.query<{ ok: boolean }>('moment', { sim_id: '100', lane: 'tick' }, 3_000);
    expect(sent).toHaveLength(1);
    const frame = sent[0] as ModCognitionQuery;
    expect(frame).toMatchObject({
      type: 'cognition_query',
      kind: 'moment',
      args: { sim_id: '100', lane: 'tick' },
      timeout_ms: 3_000,
    });
    expect(frame.request_id).toMatch(/^cq-/);

    expect(
      query.onModMessage({ kind: 'query_result', request_id: frame.request_id, ok: true, result: { ok: false } }),
    ).toBe(true);
    await expect(pending).resolves.toEqual({ ok: true, result: { ok: false } });
    expect(query.pendingCount).toBe(0);
  });

  it('an error answer resolves ok:false with the mod text', async () => {
    const { query, sent } = service();
    const pending = query.query('weather', {}, 3_000);
    const frame = sent[0] as ModCognitionQuery;
    query.onModMessage({
      kind: 'query_result',
      request_id: frame.request_id,
      ok: false,
      error: 'unknown kind weather',
    });
    await expect(pending).resolves.toEqual({ ok: false, error: 'unknown kind weather' });
  });

  it('times out when the mod never answers', async () => {
    vi.useFakeTimers();
    const { query } = service();
    const pending = query.query('moment', { sim_id: '100' }, 3_000);
    vi.advanceTimersByTime(3_001);
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('timed out');
    }
    expect(query.pendingCount).toBe(0);
  });

  it('a disconnect resolves every pending question', async () => {
    const { query } = service();
    const first = query.query('moment', { sim_id: '100' }, 3_000);
    const second = query.query('vocabulary', { sim_id: '200' }, 5_000);
    query.onModDisconnected();
    await expect(first).resolves.toEqual({ ok: false, error: DISCONNECTED });
    await expect(second).resolves.toEqual({ ok: false, error: DISCONNECTED });
  });

  it('answers at once when the mod is not connected', async () => {
    const { query, sent } = service(false);
    await expect(query.query('moment', { sim_id: '100' }, 3_000)).resolves.toEqual({ ok: false, error: NOT_CONNECTED });
    expect(sent).toHaveLength(0);
  });

  it('hold_released reaches the listeners; an unknown kind is not ours', () => {
    const { query } = service();
    const heard: unknown[] = [];
    query.onHoldReleased((event) => heard.push(event));
    expect(query.onModMessage({ kind: 'hold_released', sim_id: '100', interaction_id: '777', name: 'sim_Chat' })).toBe(
      true,
    );
    expect(heard).toEqual([{ kind: 'hold_released', sim_id: '100', interaction_id: '777', name: 'sim_Chat' }]);
    expect(query.onModMessage({ kind: 'weather' } as never)).toBe(false);
    expect(query.onModMessage(undefined)).toBe(false);
  });

  it('a late answer is consumed without a pending entry', () => {
    const { query } = service();
    expect(query.onModMessage({ kind: 'query_result', request_id: 'cq-gone', ok: true, result: {} })).toBe(true);
  });

  it('the autonomy tier claims {cognition} messages and nothing else', () => {
    const ctx = mockApiContext({ port: 25241 });
    const spy = vi.spyOn(autonomyOf(ctx).modQuery, 'onModMessage');
    expect(
      autonomyTier.onModMessage?.(ctx, { cognition: { kind: 'hold_released', sim_id: '1', interaction_id: '2' } }),
    ).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(autonomyTier.onModMessage?.(ctx, { log: { level: 'info', message: 'x' } as never })).toBe(false);
    autonomyTier.onModDisconnected?.(ctx);
  });
});
