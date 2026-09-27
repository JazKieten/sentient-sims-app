import { Request, Response } from 'express';
import log from 'electron-log';
import { ApiContext } from '../services/ApiContext';
import { SceneState } from '../services/SceneService';
import { SimStateReport } from '../models/SimStateReport';
import { isBelowChild, lifeStageOf } from '../util/simLifeStage';

// Core (release 4.5): the state report and the sleep diary ship in every build (decisions
// 14 and 15). Split out of CognitionController, which keeps the autonomy routes.

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The mod can't always resolve names (the sim may already be gone); the participant DB is
// the fallback before a raw id goes into a permanent memory row
export function lookupParticipantName(ctx: ApiContext, simId?: string): string | undefined {
  if (!simId) {
    return undefined;
  }
  try {
    return ctx.participantRepository.getParticipantNames([simId])[0];
  } catch {
    // No DB loaded (or unknown id) — caller falls back to the raw id
    return undefined;
  }
}

export class SimStateController {
  private readonly ctx: ApiContext;

  constructor(ctx: ApiContext) {
    this.ctx = ctx;
  }

  // Block 8: the mod's periodic state report — the event stream CognitionService ticks
  // against. Ingestion must stay cheap; deliberation happens in the cache's listeners.
  postState = (req: Request, res: Response) => {
    try {
      const report = req.body as Partial<SimStateReport>;
      if (report.type !== 'state_report' || typeof report.seq !== 'number') {
        return res.status(400).json({ error: 'not a state_report' });
      }
      this.ctx.simStateCache.ingest(report as SimStateReport);
      return res.json({ ok: true, seq: report.seq });
    } catch (err) {
      log.error('Error handling state report', err);
      return res.status(500).json({ error: errorMessage(err) });
    }
  };

  // Did this sim actually take part in the scene? Judged by memory ownership, which is
  // what the reflection's transcript is built from. An empty scene (no memories yet)
  // counts as theirs — there is nothing to misattribute.
  private simIsInScene(simId: string, scene: SceneState): boolean {
    try {
      const participantIds = this.ctx.memoryRepository.getSceneParticipantIds(scene.locationId, scene.startedAt);
      return participantIds.length === 0 || participantIds.includes(simId);
    } catch {
      // No DB loaded / query failed: fall back to the old behaviour rather than
      // silently dropping every sleep boundary
      return true;
    }
  }

  // The mod reports a household sim falling asleep. Sleep closes out the sim's stretch of
  // activity the way travel does: reflect on the current scene, then start a fresh scene at
  // the same location so the next boundary only covers what happens after the nap.
  postSleepBoundary = async (req: Request, res: Response) => {
    try {
      const {
        sim_id: simId,
        sim_name: simName,
        clock,
        passed_out: passedOut,
      } = req.body as {
        sim_id?: string;
        sim_name?: string;
        // Game clock at the moment of falling asleep (newer mods) — keys the overnight
        // daily plan to the day the sim wakes into
        clock?: { hour?: number; absolute_day?: number };
        // The mod also fires the boundary when a sim passes out from exhaustion
        passed_out?: boolean;
      };
      if (!simId) {
        return res.status(400).json({ error: 'sim_id is required' });
      }
      const who = simName || lookupParticipantName(this.ctx, simId) || `Sim ${simId}`;
      // J8: an infant naps several times a day and has no diary to write; ending the
      // household's scene at every nap chopped everyone else's evening into fragments and
      // wrote first-person entries for a Sim who cannot talk (Jaz's 09-04 handoff, cause 8).
      // Below CHILD the boundary is a no-op and the scene keeps running.
      const stage = lifeStageOf(this.ctx, simId);
      if (isBelowChild(stage)) {
        log.info(`[Cognition] sleep boundary for ${who}: ${stage} writes no diary; leaving the scene running`);
        return res.json({
          ok: true,
          reflected: false,
          reason: `sleeper is ${stage?.toLowerCase()}: no diary below child`,
        });
      }
      // A sleeper who took no part in the active scene must not end it: the scene belongs
      // to the sims who are in it, and closing it here both loses THEIR reflection and
      // hands the sleeper a first-person diary of an evening they never attended (live
      // 2026-08-16 — Ariel slept at home while the app's active scene was still the bar
      // Mackenzie had travelled to). The sleeper's own next boundary writes their diary.
      const activeScene = this.ctx.sceneService.getCurrentScene();
      if (activeScene && !this.simIsInScene(simId, activeScene)) {
        log.info(
          `[Cognition] sleep boundary for ${who}: not a participant of scene ${activeScene.sceneId} ` +
            `(location ${activeScene.locationId}); leaving the scene running`,
        );
        return res.json({ ok: true, reflected: false, reason: 'sleeper was not in the active scene' });
      }
      const previousScene = this.ctx.sceneService.endCurrentScene(
        passedOut ? `${who} passed out from exhaustion` : `${who} fell asleep`,
      );
      if (!previousScene) {
        return res.json({ ok: true, reflected: false, reason: 'no active scene' });
      }
      log.info(`[Cognition] sleep boundary for ${who}: reflecting on scene ${previousScene.sceneId}`);
      // The sleeper is the reflecting mind — their day closes as a diary entry in their voice
      await this.ctx.ai.runSceneReflection(previousScene, { simId, simName: who }, 'sleep', clock);
      return res.json({ ok: true, reflected: true, scene_id: previousScene.sceneId });
    } catch (err) {
      log.error('Error handling sleep boundary', err);
      return res.status(500).json({ error: errorMessage(err) });
    }
  };
}
