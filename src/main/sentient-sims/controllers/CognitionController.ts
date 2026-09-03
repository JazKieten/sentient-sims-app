import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import log from 'electron-log';
import { ApiContext } from '../services/ApiContext';
import { ActionIntent, InteractionOutcomeEvent } from '../models/ActionIntent';
import { ModRequestPerception, ModWebsocketMessageType } from '../models/ModWebsocketMessage';
import { PerceptionSnapshot } from '../models/PerceptionSnapshot';
import { SceneState } from '../services/SceneService';
import { SimStateEntry, SimStateReport } from '../models/SimStateReport';
import { DossierReport } from '../models/SimDossier';
import { ParticipantDTO } from '../db/dto/ParticipantDTO';
import { formatPerception } from '../util/formatPerception';
import { OutcomeVerdict } from '../services/OutcomeVerdictService';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function outcomeVerb(outcome: InteractionOutcomeEvent['outcome']): string {
  if (outcome === 'success') {
    return 'succeeded';
  }
  if (outcome === 'failure') {
    return 'failed';
  }
  return 'was canceled';
}

// The mod forwards cancel reasons as raw game reprs like
// "<EnqueueResult: Bills: Interaction requires a utility that is shut off. <ExecuteResult: False: (None)>>".
// Keep the human sentence, drop the machine wrappers — this text lands in a permanent memory
// row, and raw angle brackets also read as tags in the mod's Flash memories window.
export function humanizeOutcomeReason(reason: string): string {
  let text = reason.trim();
  // Unwrap <Label: ...> repr shells wherever they sit, innermost first — a prefixed
  // reason like "clean push refused: <EnqueueResult: states do not match...>" must keep
  // the inner explanation (observed live 2026-08-07: the whole-string-only unwrap never
  // fired past the prefix, so the repr-strip below deleted the entire why and the
  // memory read just "clean push refused:")
  let previous;
  do {
    previous = text;
    text = text.replace(/<\w+:\s*([^<>]*)>/g, '$1');
  } while (text !== previous);
  // Drop any leftover angle-bracket noise and the bare result plumbing the unwrap
  // exposes (ExecuteResult bodies like "False: (None)" carry no reason)
  text = text
    .replace(/<[^<>]*>/g, '')
    // An UNTERMINATED shell: the mod truncates long reasons, so "<EnqueueResult: True
    // <ExecuteResult: Interaction finished during app..." arrives with no closing '>'
    // and neither unwrap above can match it. That exact shape reached permanent memory
    // rows (live 2026-08-16, memories 2036 and 2124, stored with the leading guillemet).
    // The mod strips reprs before truncating now; this catches older and other shapes.
    .replace(/<\w+:\s*/g, '')
    .replace(/[<>]/g, '')
    .replace(/\b(?:True|False|None)\b:?\s*\(None\)/g, '')
    .replace(/\(None\)/g, '')
    .replace(/\(\s*\)/g, '');
  // Final guard against slots the unwrap emptied (P-9): "between and ." / "Sim []" /
  // dangling ':' — the mod fills names it knows; this keeps whatever slips through
  // readable rather than a permanent memory reading "between and ."
  text = text
    .replace(/\bbetween\s+and\b/gi, 'between the two of them')
    .replace(/\bSim\s*\[\s*\]/g, 'the sim')
    .replace(/\s+([.,;:])/g, '$1')
    .replace(/[.:]+\s*:\s*$/g, '.')
    .replace(/:\s*$/g, '');
  return text.replace(/\s{2,}/g, ' ').trim();
}

// The sentence that becomes the 'outcome' memory row. recovery_action is the whitelist
// verb the mod says clears the blocker (ss_failure_reasons / object_broken ->
// hire_repair_service); until night watch 2026-08-18 it reached the model type and
// nothing else, so four sims sat at hygiene <= -94 beside a broken shower while
// cognition only ever *thought* about the repair service. Naming the fix in the memory
// is how retrieval and the next tick learn it.
//
// F5: a suspect success never gets the word 'succeeded'. This row is permanent, it is
// retrieved into later prompts, and a sim who reads that a wedged action worked learns
// something false about their own agency. It says what actually happened instead: the
// game accepted the push and nothing confirmed anything after that.
export function outcomeObservation(
  attempt: string,
  outcome: InteractionOutcomeEvent['outcome'],
  reason?: string,
  recoveryAction?: string,
  verdict: OutcomeVerdict = 'unknown',
): string {
  const because = reason ? ` (${humanizeOutcomeReason(reason)})` : '';
  if (outcome === 'success' && verdict === 'suspect') {
    return `${attempt}; the game accepted it but nothing confirmed it happened${because}.`;
  }
  const fix =
    recoveryAction && outcome !== 'success' ? ` Doing '${recoveryAction}' first would clear this.` : '';
  return `${attempt} and it ${outcomeVerb(outcome)}${because}.${fix}`;
}

export class CognitionController {
  private readonly ctx: ApiContext;

  // Latest snapshot per sim, kept ephemeral (never persisted as memories). Block 8's
  // SimStateCache supersedes this once snapshots arrive with every state report.
  private readonly latestPerception = new Map<string, PerceptionSnapshot>();

  constructor(ctx: ApiContext) {
    this.ctx = ctx;
  }

  getPerception(simId: string): SimStateEntry | undefined {
    // The state cache supersedes the request/reply Map; fall back for snapshots that
    // arrived before any state report
    return this.ctx.simStateCache.getSim(simId) ?? this.latestPerception.get(simId);
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

  // Phase 3.1 H1/H2: ground truth about who each sim IS. The mod hash-gates these, so a
  // report arriving at all usually means something structural changed; ingestion diffs it
  // against the sim's current `game` facts and retires what is no longer true.
  postDossier = (req: Request, res: Response) => {
    try {
      const report = req.body as Partial<DossierReport>;
      const dossiers = Array.isArray(report.dossiers) ? report.dossiers : undefined;
      if (!dossiers) {
        return res.status(400).json({ error: 'dossiers[] is required' });
      }
      // The mod sends the clock with the report; fall back to the state cache for an
      // older mod build that does not.
      const day = report.clock?.absolute_day ?? this.ctx.simStateCache.getReport()?.lot?.clock?.absolute_day;
      let inserted = 0;
      let retired = 0;
      let ingested = 0;
      for (const dossier of dossiers) {
        if (!dossier.sim_id) {
          continue;
        }
        const result = this.ctx.semanticMemory.ingestDossier(dossier, { day });
        inserted += result.inserted;
        retired += result.retired;
        if (!result.skipped) {
          ingested += 1;
        }
      }
      log.info(
        `Dossier report seq=${report.seq ?? '?'} reason=${report.reason ?? '?'}: ` +
          `${ingested}/${dossiers.length} ingested, ${inserted} facts added, ${retired} retired`,
      );
      return res.json({ ok: true, seq: report.seq, ingested, inserted, retired });
    } catch (err) {
      log.error('Error handling dossier report', err);
      return res.status(500).json({ error: errorMessage(err) });
    }
  };

  private lookupParticipantName(simId?: string): string | undefined {
    if (!simId) {
      return undefined;
    }
    try {
      return this.ctx.participantRepository.getParticipantNames([simId])[0];
    } catch {
      // No DB loaded (or unknown id) — caller falls back to the raw id
      return undefined;
    }
  }

  // The mod reports what actually happened to a dispatched interaction. The result becomes an
  // 'outcome' memory row so retrieval and future cognition ticks can see the consequences of
  // acting — this closes the act -> observe loop.
  postOutcome = (req: Request, res: Response) => {
    try {
      const event = req.body as Partial<InteractionOutcomeEvent>;
      if (!event.sim_id || !event.outcome) {
        return res.status(400).json({ error: 'sim_id and outcome are required' });
      }

      // Grade BEFORE resolving: resolve() moves the dispatch into the dispatcher's
      // recently-closed ring, which is exactly what 'late' is read from.
      const known = this.ctx.actionDispatcher.lookup(event.request_id);
      const late = this.ctx.actionDispatcher.wasClosed(event.request_id);
      const dispatchAgeMs = known ? Date.now() - known.dispatchedAt : undefined;
      const source = known?.intent.source;
      // An ask or a debug dispatch is not cognition's to close; the old 'late' flag
      // conflated those with a genuinely late answer.
      const unowned = source !== undefined && source !== 'cognition';
      const verdict = this.ctx.outcomeVerdict.grade(event as InteractionOutcomeEvent, {
        dispatchAgeMs,
        late,
        blockedBy: this.ctx.simStateCache.getSim(event.sim_id)?.activity?.blocked_by,
        instantSuccessMs: this.ctx.settings.outcomeInstantSuccessMs,
      });

      const pending = this.ctx.actionDispatcher.resolve(event.request_id);
      const action =
        pending?.intent.action ?? known?.intent.action ?? event.action ?? event.interaction_name ?? 'an interaction';
      // The mod can't always resolve names (the sim may already be gone); fall back to the
      // participant DB before writing a raw id into a permanent memory row
      const actor = event.sim_name || this.lookupParticipantName(event.sim_id) || `Sim ${event.sim_id}`;
      const target =
        event.target_sim_name ||
        this.lookupParticipantName(event.target_sim_id) ||
        (event.target_sim_id ? `Sim ${event.target_sim_id}` : undefined);
      const attempt = target ? `${actor} tried '${action}' with ${target}` : `${actor} tried '${action}'`;
      const observation = outcomeObservation(attempt, event.outcome, event.reason, event.recovery_action, verdict);

      const participants: ParticipantDTO[] = [{ id: event.sim_id }];
      if (event.target_sim_id) {
        participants.push({ id: event.target_sim_id });
      }

      // Outcome rows are bookkeeping for retrieval/cognition; notifyMod false keeps them from
      // being subtitled and pausing the game like dialogue memories
      const memory = this.ctx.memoryRepository.createMemory(
        {
          memory: {
            observation,
            // The motivating thought (when the dispatch is still known) heads the memory the
            // same way a pre_action heads an interaction memory
            pre_action: pending?.intent.motivation,
            location_id: event.location_id ?? this.ctx.sceneService.getCurrentScene()?.locationId ?? 0,
            event_type: 'outcome',
            action,
            interaction_name: event.interaction_name,
          },
          participants,
        },
        { notifyMod: false },
      );

      // The provenance behind the memory row: what was claimed, where it was decided,
      // and how it was graded (F5). Best-effort — no save loaded means no row, and the
      // outcome still reaches cognition.
      this.ctx.outcomeVerdict.record({
        at: new Date().toISOString(),
        requestId: event.request_id,
        simId: event.sim_id,
        action,
        interactionName: event.interaction_name,
        outcome: event.outcome,
        verdict,
        decidedAt: event.decided_at,
        claim: event.claim,
        pushId: event.push_id ?? undefined,
        ran: event.ran ?? undefined,
        finishing: event.finishing,
        simRunning: event.sim_running,
        gameClock: event.game_clock,
        dispatchAgeMs,
        late,
        unowned,
        source,
        cause: event.cause,
        reason: event.reason,
        memoryId: memory?.id,
      });

      // Close the sim's PENDING_OUTCOME state — success is only ever declared here,
      // never at dispatch time, and a suspect success is not declared at all
      this.ctx.cognitionService.onOutcome({
        ...event,
        sim_id: event.sim_id,
        outcome: event.outcome,
        action,
        verdict,
        late,
        unowned,
        dispatch_age_ms: dispatchAgeMs,
      });

      log.info(`[Cognition] outcome ${event.request_id ?? '(uncorrelated)'} [${verdict}]: ${observation}`);
      return res.json({ ok: true, correlated: pending !== undefined, verdict, memory_id: memory?.id });
    } catch (err) {
      log.error('Error handling cognition outcome', err);
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
      const who = simName || this.lookupParticipantName(simId) || `Sim ${simId}`;
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

  // The mod's reply to a REQUEST_PERCEPTION message: one sim's scene snapshot. Ephemeral
  // by design — cached for the next cognition tick, never written as a memory.
  postPerception = (req: Request, res: Response) => {
    try {
      const snapshot = req.body as Partial<PerceptionSnapshot>;
      if (!snapshot.sim_id) {
        return res.status(400).json({ error: 'sim_id is required' });
      }
      if (snapshot.error) {
        // The mod couldn't build the snapshot; don't cache a hollow one over real data
        log.warn(
          `[Cognition] perception ${snapshot.request_id ?? ''} failed for sim ${snapshot.sim_id}: ${snapshot.error}`,
        );
        return res.json({ ok: false, error: snapshot.error });
      }
      const full: PerceptionSnapshot = { sims: [], objects: [], ...snapshot, sim_id: snapshot.sim_id };
      this.latestPerception.set(full.sim_id, full);
      this.ctx.simStateCache.ingestPerception(full);
      const formatted = formatPerception(full);
      log.info(`[Cognition] perception ${full.request_id ?? ''} for sim ${full.sim_id}:\n${formatted}`);
      return res.json({ ok: true, formatted });
    } catch (err) {
      log.error('Error handling perception snapshot', err);
      return res.status(500).json({ error: errorMessage(err) });
    }
  };

  // Dev seam: ask the mod for a sim's perception snapshot; the mod replies by POSTing
  // it back to /cognition/perception with the same request_id
  debugRequestPerception = (req: Request, res: Response) => {
    try {
      const { sim_id: simId } = req.body as { sim_id?: string };
      if (!simId) {
        return res.status(400).json({ error: 'sim_id is required' });
      }
      const message: ModRequestPerception = {
        type: ModWebsocketMessageType.REQUEST_PERCEPTION,
        request_id: randomUUID(),
        sim_id: simId,
      };
      this.ctx.actionDispatcher.sendToMod(message);
      return res.json({ request_id: message.request_id });
    } catch (err) {
      log.error('Error dispatching perception request', err);
      return res.status(500).json({ error: errorMessage(err) });
    }
  };

  // Dev seam: curl an ActionIntent at the app and watch the sim act in-game
  debugEnqueue = (req: Request, res: Response) => {
    try {
      const intent = req.body as ActionIntent;
      if (!intent.sim_id || !intent.action) {
        return res.status(400).json({ error: 'sim_id and action are required' });
      }

      const requestId = this.ctx.actionDispatcher.dispatch(intent);
      return res.json({ request_id: requestId });
    } catch (err) {
      log.error('Error dispatching debug enqueue', err);
      return res.status(500).json({ error: errorMessage(err) });
    }
  };
}
