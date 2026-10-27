// The game ending a conversation the app is airing: the sims in it walked apart, or one of
// them left the lot. See the mod's scene/ss_scene_watch.py. Core, since the mod's scene
// watch ships in every build.
import log from 'electron-log';
import type { ScenePlaybackRegistry } from '../services/ScenePlaybackRegistry';
import type { SceneFreshness } from '../services/SceneFreshness';
import type { SceneControl } from '../models/ModLogWebsocketMessage';
import { notifySceneStopAll } from './notifyRenderer';

export function onSceneControl(
  scenePlayback: ScenePlaybackRegistry,
  sceneFreshness: SceneFreshness | undefined,
  control: SceneControl,
) {
  const where = control.distance_m != null ? ` at ${control.distance_m}m` : '';
  log.info(`[Scene] the game ended ${control.scene_id ?? 'every scene'} (${control.mode}): ${control.reason}${where}`);
  if (control.action === 'stop_all') {
    scenePlayback.stopAll(control.reason);
    // The registry only knows scenes with an id; a reply to the player airs without one
    // and kept playing over the loading screen and onto the next lot (2026-10-23). The
    // renderer drops its whole queue and the line playing now, id or not.
    notifySceneStopAll();
    // The lot is going away: nobody is "gone" from the next one
    sceneFreshness?.clearDepartures();
    return;
  }
  if (control.sim_id && (control.reason === 'left_lot' || control.reason === 'absent')) {
    // A sim who is gone is gone from every conversation, not just the one the watch was
    // following: the ones queued behind it with the same sim (a fresh scene id each) would
    // otherwise air to an empty spot. Remembered so a scene generated later from an older
    // event does not air either, until the game reports the sim back.
    sceneFreshness?.markDeparted(control.sim_id);
    const others = scenePlayback.stopForSim(control.sim_id, control.reason, 'hard');
    if (others > 0) {
      log.info(`[Scene] sim ${control.sim_id} is gone: ended ${others} scene(s) they were in`);
    }
  }
  if (control.scene_id) {
    scenePlayback.stop(control.scene_id, control.reason, control.mode);
  }
}
