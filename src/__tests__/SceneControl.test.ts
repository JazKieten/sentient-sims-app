import { vi, describe, it, expect, beforeEach } from 'vitest';
import { ScenePlaybackRegistry } from 'main/sentient-sims/services/ScenePlaybackRegistry';
import { SceneFreshness } from 'main/sentient-sims/services/SceneFreshness';
import { onSceneControl } from 'main/sentient-sims/util/sceneControl';

const notify = vi.hoisted(() => ({ notifySceneStopAll: vi.fn() }));
vi.mock('main/sentient-sims/util/notifyRenderer', () => notify);

// scene_control is core (every build ships the mod's scene watch), so this runs without tiers
function registry() {
  return new ScenePlaybackRegistry({
    notifyStop: vi.fn(),
    notifySceneEnded: vi.fn(),
    rewriteMemory: vi.fn(),
    onSceneClosed: vi.fn(),
  });
}

function freshness() {
  return new SceneFreshness({ maxAgeMs: () => 60_000 });
}

describe('onSceneControl', () => {
  beforeEach(() => {
    notify.notifySceneStopAll.mockClear();
  });

  it('stops the named scene with the mode the game asked for', () => {
    const playback = registry();
    const stop = vi.spyOn(playback, 'stop');
    onSceneControl(playback, freshness(), {
      action: 'stop',
      mode: 'soft',
      scene_id: 'scene-1',
      reason: 'walked_away',
      distance_m: 7.2,
    });
    expect(stop).toHaveBeenCalledWith('scene-1', 'walked_away', 'soft');
  });

  it('stops everything when the lot is going away', () => {
    const playback = registry();
    const stopAll = vi.spyOn(playback, 'stopAll');
    const fresh = freshness();
    fresh.markDeparted('2');
    onSceneControl(playback, fresh, { action: 'stop_all', mode: 'hard', reason: 'zone_unload' });
    expect(stopAll).toHaveBeenCalledWith('zone_unload');
    // Nobody is "gone" from the lot that comes next
    expect(fresh.isDeparted('2')).toBe(false);
    expect(notify.notifySceneStopAll).toHaveBeenCalledTimes(1);
  });

  it('ends every scene a sim was in when the game says they left the lot', () => {
    const playback = registry();
    playback.roundQueued('scene-1', ['1', '2'], 1, [{ speaker: 'Augustus', text: 'Hi.' }]);
    playback.roundQueued('scene-2', ['1', '2'], 1, [{ speaker: 'Augustus', text: 'Hi again.' }]);
    playback.roundQueued('scene-3', ['1', '3'], 1, [{ speaker: 'Augustus', text: 'Hello Dirk.' }]);
    const fresh = freshness();

    onSceneControl(playback, fresh, {
      action: 'stop',
      mode: 'hard',
      scene_id: 'scene-1',
      reason: 'left_lot',
      sim_id: '2',
    });

    expect(playback.isStopped('scene-1')).toBe(true);
    expect(playback.isStopped('scene-2')).toBe(true);
    expect(playback.isStopped('scene-3')).toBe(false);
    expect(fresh.isDeparted('2')).toBe(true);
  });

  it('treats a sim the watch found absent like one who left', () => {
    const playback = registry();
    playback.roundQueued('scene-2', ['1', '2'], 1, [{ speaker: 'Augustus', text: 'Hi again.' }]);
    const fresh = freshness();

    onSceneControl(playback, fresh, {
      action: 'stop',
      mode: 'hard',
      scene_id: 'scene-1',
      reason: 'absent',
      sim_id: '2',
    });

    expect(playback.isStopped('scene-2')).toBe(true);
    expect(fresh.isDeparted('2')).toBe(true);
  });

  it('stops only the named scene when a sim merely walked away', () => {
    const playback = registry();
    playback.roundQueued('scene-1', ['1', '2'], 1, [{ speaker: 'Augustus', text: 'Hi.' }]);
    playback.roundQueued('scene-2', ['1', '2'], 1, [{ speaker: 'Augustus', text: 'Hi again.' }]);
    const fresh = freshness();

    onSceneControl(playback, fresh, {
      action: 'stop',
      mode: 'soft',
      scene_id: 'scene-1',
      reason: 'walked_away',
      sim_id: '2',
      distance_m: 7.2,
    });

    expect(playback.isStopped('scene-1')).toBe(true);
    expect(playback.isStopped('scene-2')).toBe(false);
    expect(fresh.isDeparted('2')).toBe(false);
  });

  it('leaves the renderer alone when only one scene stops', () => {
    const playback = registry();
    vi.spyOn(playback, 'stop');
    onSceneControl(playback, freshness(), { action: 'stop', mode: 'hard', reason: 'walked_away', scene_id: 'scene-1' });
    expect(notify.notifySceneStopAll).not.toHaveBeenCalled();
  });

  it('ignores a stop without a scene id', () => {
    const playback = registry();
    const stop = vi.spyOn(playback, 'stop');
    const stopAll = vi.spyOn(playback, 'stopAll');
    onSceneControl(playback, freshness(), { action: 'stop', mode: 'soft', reason: 'walked_away' });
    expect(stop).not.toHaveBeenCalled();
    expect(stopAll).not.toHaveBeenCalled();
    expect(notify.notifySceneStopAll).not.toHaveBeenCalled();
  });
});
