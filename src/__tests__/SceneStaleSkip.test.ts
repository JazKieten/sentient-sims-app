import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import { ApiContext } from 'main/sentient-sims/services/ApiContext';
import { NoopEmbeddingService } from 'main/sentient-sims/services/EmbeddingService';
import { InteractionEventStatus } from 'main/sentient-sims/models/InteractionEventResult';
import { SettingsEnum } from 'main/sentient-sims/models/SettingsEnum';
import { SimAge } from 'main/sentient-sims/models/SimAge';
import { SentientSim } from 'main/sentient-sims/models/SentientSim';
import { InteractionEvent, SSEventType } from 'main/sentient-sims/models/InteractionEvents';
import { ScenePlay } from 'main/sentient-sims/services/AIService';
import { MOVED_ON_GAP_MS } from 'main/sentient-sims/services/SceneFreshness';
import { mockApiContext } from './util';

// The 2026-10-11 stream: fans at a VIP rope came one after another, and a scene with the
// previous fan was still airing minutes after the game had moved the celebrity on to the
// next. These pin the three places a scene is judged against its game event.

function makeSim(name: string, simId: string): SentientSim {
  return {
    careers: [],
    name,
    age: SimAge.ADULT,
    sim_id: simId,
    gender: 'Female',
    traits: [],
    moods: [],
    is_ghost: false,
    grubby: false,
    in_pool: false,
    is_at_home: false,
    is_dying: false,
    is_human: true,
    is_inside_building: false,
    is_outside: false,
    is_pet: false,
    on_fire: false,
    on_home_lot: false,
    sleeping: false,
    is_pregnant: false,
    is_player_sim: false,
  };
}

function sceneEvent(): InteractionEvent {
  return {
    event_id: 'event-1',
    event_type: SSEventType.INTERACTION,
    location_id: 5,
    environment: {
      location_id: 5,
      world_id: 0,
      time: { second: 0, minute: 0, hour: 0, day: 0, week: 0 },
    },
    sentient_sims: [makeSim('Augustus St.Fleur', '1'), makeSim('Travis Scott', '2')],
    interaction_name: 'social_Chat',
  };
}

const AUGUSTUS = { simId: '1', name: 'Augustus St.Fleur' };
const TRAVIS = { simId: '2', name: 'Travis Scott' };
const DIRK = { simId: '3', name: 'Dirk Dreamer' };

const SCORES_WANTING_MORE = JSON.stringify({
  'Augustus St.Fleur': { memory: 5, action: 1, action_reason: '', unfinished: true, continue: 10 },
  'Travis Scott': { memory: 5, action: 1, action_reason: '', unfinished: true, continue: 10 },
});

function scene(sessionId: string, options: { onLabel?: (label: string) => void } = {}) {
  const ctx: ApiContext = mockApiContext();
  // These tests mock the 4.6 pipeline by stage label; the default is lean (2026-10-27)
  ctx.settings.set(SettingsEnum.SCENE_PIPELINE_MODE, 'full');
  fs.mkdirSync(ctx.directory.getSentientSimsFolder(), { recursive: true });
  ctx.db.loadDatabase({ sessionId, saveId: '1' });
  ctx.settings.set(SettingsEnum.GENERATED_DEFAULT_DESCRIPTIONS, false);
  vi.spyOn(ctx, 'embedding', 'get').mockReturnValue(new NoopEmbeddingService());
  vi.spyOn(ctx.modelSettings, 'getModelSettings').mockResolvedValue({
    temperature: undefined,
    top_p: undefined,
    top_k: undefined,
    repetition_penalty: undefined,
    max_tokens: 5000,
  });
  const labels: string[] = [];
  vi.spyOn(ctx.ai, 'runOneShot').mockImplementation((label: string) => {
    labels.push(label);
    options.onLabel?.(label);
    let text = 'SAY: Tell me more.\nTHINK: I want to hear the rest.';
    if (label === 'Scene Scores') {
      text = SCORES_WANTING_MORE;
    } else if (label === 'Director Briefing' || label === 'Director Review') {
      text = '';
    }
    return Promise.resolve({
      exchange: { label, request: { messages: [], maxResponseTokens: 120 }, responseText: text },
      text,
    });
  });
  const roundQueued = vi.spyOn(ctx.scenePlayback, 'roundQueued');
  const continuations = vi.spyOn(ctx.generationQueue, 'runExclusive');
  const settle = async () => {
    let settled = 0;
    while (settled < continuations.mock.results.length) {
      const pending = continuations.mock.results.slice(settled).map((queued) => queued.value as Promise<unknown>);
      settled = continuations.mock.results.length;
      await Promise.allSettled(pending);
    }
  };
  return { ctx, labels, roundQueued, settle };
}

describe('a scene the game has moved on from', () => {
  it('is skipped before any model call when its event is too old', async () => {
    const { ctx, labels } = scene('scene-stale-age');
    const eventAt = Date.now() - ctx.settings.sceneEventMaxAgeMs - 1_000;

    const result = await ctx.ai.runDirectedGeneration(sceneEvent(), { action: 'chat', eventAt });

    expect(result.status).toEqual(InteractionEventStatus.NOOP);
    expect(labels).toEqual([]);
  });

  it('is skipped before any model call when a sim has since been with somebody else', async () => {
    const { ctx, labels } = scene('scene-stale-moved-on');
    const eventAt = Date.now() - MOVED_ON_GAP_MS - 5_000;
    ctx.sceneFreshness.recordEvent([AUGUSTUS, TRAVIS], eventAt);
    ctx.sceneFreshness.recordEvent([AUGUSTUS, DIRK], eventAt + MOVED_ON_GAP_MS + 1_000);

    const result = await ctx.ai.runDirectedGeneration(sceneEvent(), { action: 'chat', eventAt });

    expect(result.status).toEqual(InteractionEventStatus.NOOP);
    expect(labels).toEqual([]);
  });

  it('still generates when the later event is for the same pair', async () => {
    const { ctx, labels } = scene('scene-fresh-same-pair');
    const eventAt = Date.now() - MOVED_ON_GAP_MS - 5_000;
    ctx.sceneFreshness.recordEvent([AUGUSTUS, TRAVIS], eventAt);
    ctx.sceneFreshness.recordEvent([TRAVIS, AUGUSTUS], eventAt + MOVED_ON_GAP_MS + 1_000);
    ctx.settings.set(SettingsEnum.SCENE_MAX_ROUNDS, 1);

    const result = await ctx.ai.runDirectedGeneration(sceneEvent(), { action: 'chat', eventAt });

    expect(result.status).toEqual(InteractionEventStatus.GENERATED);
    expect(labels).toContain('Director Briefing');
  });

  it('is skipped when a sim in it left the lot after the event', async () => {
    const { ctx, labels } = scene('scene-stale-departed');
    const eventAt = Date.now() - 5_000;
    ctx.sceneFreshness.markDeparted('2', eventAt + 1_000);

    const result = await ctx.ai.runDirectedGeneration(sceneEvent(), { action: 'chat', eventAt });

    expect(result.status).toEqual(InteractionEventStatus.NOOP);
    expect(labels).toEqual([]);
  });

  it('still airs a scene when a side social with somebody else arrived moments later', async () => {
    const { ctx, labels, roundQueued } = scene('scene-fresh-side-social');
    ctx.settings.set(SettingsEnum.SCENE_MAX_ROUNDS, 1);
    const eventAt = Date.now() - 5_000;
    ctx.sceneFreshness.recordEvent([AUGUSTUS, TRAVIS], eventAt);
    ctx.sceneFreshness.recordEvent([AUGUSTUS, DIRK], eventAt + 300);

    const result = await ctx.ai.runDirectedGeneration(sceneEvent(), { action: 'chat', eventAt });

    expect(result.status).toEqual(InteractionEventStatus.GENERATED);
    expect(labels).toContain('Director Briefing');
    expect(roundQueued).toHaveBeenCalledTimes(1);
  });

  it('declines to air a prefetched scene whose sim left before its claim could play', async () => {
    const { ctx, roundQueued } = scene('scene-stale-at-play');
    ctx.settings.set(SettingsEnum.SCENE_MAX_ROUNDS, 1);
    let play: ScenePlay = () => true;
    const result = await ctx.ai.runDirectedGeneration(
      sceneEvent(),
      { action: 'chat' },
      {
        deferPlayback: true,
        onPlaybackReady: (ready) => {
          play = ready;
        },
      },
    );
    expect(result.status).toEqual(InteractionEventStatus.GENERATED);

    // Claimed, then Travis despawned before the scene could air
    const claimedAt = Date.now() - 2_000;
    ctx.sceneFreshness.markDeparted('2', claimedAt + 500);

    expect(play(claimedAt)).toBe(false);
    expect(roundQueued).not.toHaveBeenCalled();
  });

  it('airs a prefetched scene whose claim is the latest word on the pair', async () => {
    const { ctx, roundQueued } = scene('scene-fresh-at-play');
    ctx.settings.set(SettingsEnum.SCENE_MAX_ROUNDS, 1);
    let play: ScenePlay = () => true;
    await ctx.ai.runDirectedGeneration(
      sceneEvent(),
      { action: 'chat' },
      {
        deferPlayback: true,
        onPlaybackReady: (ready) => {
          play = ready;
        },
      },
    );
    const claimedAt = Date.now();
    ctx.sceneFreshness.recordEvent([AUGUSTUS, TRAVIS], claimedAt);

    expect(play(claimedAt)).toBe(true);
    expect(roundQueued).toHaveBeenCalledTimes(1);
    // The scene's event time rides into the registry so a later event can drop it unaired
    expect(roundQueued.mock.calls[0][7]).toBe(claimedAt);
  });

  it('does not continue a conversation the game has moved on from', async () => {
    const ref: { ctx?: ApiContext } = {};
    let briefings = 0;
    const { ctx, labels, roundQueued, settle } = scene('scene-stale-continuation', {
      onLabel: (label) => {
        if (label === 'Director Briefing') {
          briefings += 1;
          if (briefings === 2 && ref.ctx) {
            // Round 1 is on air (heard) and round 2 is being briefed when the game
            // pairs Augustus with Dirk, well after the scene's own event
            ref.ctx.scenePlayback.lineShown(roundQueued.mock.calls[0][0]);
            ref.ctx.sceneFreshness.recordEvent([AUGUSTUS, DIRK]);
          }
        }
      },
    });
    ref.ctx = ctx;
    const eventAt = Date.now() - MOVED_ON_GAP_MS - 1_000;

    const result = await ctx.ai.runDirectedGeneration(sceneEvent(), { action: 'chat', eventAt });
    await settle();

    expect(result.status).toEqual(InteractionEventStatus.GENERATED);
    // Round 2 was already generating when the game moved on, so it still airs (a scene
    // about to play is never cut for a side event); round 3 is never started
    expect(labels.filter((label) => label === 'Scene Scores').length).toBe(2);
    expect(roundQueued).toHaveBeenCalledTimes(2);
    expect(ctx.scenePlayback.isStopped(roundQueued.mock.calls[0][0])).toBe(false);
  });
});
