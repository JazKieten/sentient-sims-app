import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import log from 'electron-log';
import { ApiContext } from '../services/ApiContext';
import type { AutonomyServices } from '../tiers/autonomy';
import { ActionIntent, InteractionOutcomeEvent } from '../models/ActionIntent';
import { ModRequestPerception, ModWebsocketMessageType } from '../models/ModWebsocketMessage';
import { PerceptionSnapshot } from '../models/PerceptionSnapshot';
import { SimStateEntry } from '../models/SimStateReport';
import { lookupParticipantName } from './SimStateController';
import { CatchErrors } from './decorators/CatchError';
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
  const fix = recoveryAction && outcome !== 'success' ? ` Doing '${recoveryAction}' first would clear this.` : '';
  return `${attempt} and it ${outcomeVerb(outcome)}${because}.${fix}`;
}

export class CognitionController {
  private readonly ctx: ApiContext;

  // Latest snapshot per sim, kept ephemeral (never persisted as memories). Block 8's
  // SimStateCache supersedes this once snapshots arrive with every state report.
  private readonly latestPerception = new Map<string, PerceptionSnapshot>();

  private readonly autonomy: AutonomyServices;

  constructor(ctx: ApiContext, autonomy: AutonomyServices) {
    this.ctx = ctx;
    this.autonomy = autonomy;
  }

  getPerception(simId: string): SimStateEntry | undefined {
    // The state cache supersedes the request/reply Map; fall back for snapshots that
    // arrived before any state report
    return this.ctx.simStateCache.getSim(simId) ?? this.latestPerception.get(simId);
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
      // Plum's wake-up triggers hear every outcome (sim_finishes says how the action went)
      this.ctx.plum.wake.onOutcome({ ...event, sim_id: event.sim_id, outcome: event.outcome });

      // Grade BEFORE resolving: resolve() moves the dispatch into the dispatcher's
      // recently-closed ring, which is exactly what 'late' is read from.
      const known = this.autonomy.actionDispatcher.lookup(event.request_id);
      const late = this.autonomy.actionDispatcher.wasClosed(event.request_id);
      const dispatchAgeMs = known ? Date.now() - known.dispatchedAt : undefined;
      const source = known?.intent.source;
      // An ask or a debug dispatch is not cognition's to close; the old 'late' flag
      // conflated those with a genuinely late answer.
      const unowned = source !== undefined && source !== 'cognition';
      const verdict = this.autonomy.outcomeVerdict.grade(event as InteractionOutcomeEvent, {
        dispatchAgeMs,
        late,
        blockedBy: this.ctx.simStateCache.getSim(event.sim_id)?.activity?.blocked_by,
        instantSuccessMs: this.ctx.settings.outcomeInstantSuccessMs,
      });

      const pending = this.autonomy.actionDispatcher.resolve(event.request_id);
      const action =
        pending?.intent.action ?? known?.intent.action ?? event.action ?? event.interaction_name ?? 'an interaction';
      // The mod can't always resolve names (the sim may already be gone); fall back to the
      // participant DB before writing a raw id into a permanent memory row
      const actor = event.sim_name || lookupParticipantName(this.ctx, event.sim_id) || `Sim ${event.sim_id}`;
      const target =
        event.target_sim_name ||
        lookupParticipantName(this.ctx, event.target_sim_id) ||
        (event.target_sim_id ? `Sim ${event.target_sim_id}` : undefined);
      // A pie-menu click reads by its label ("tried 'Ask about Day'"); the key stays on
      // memory.action for the suppression maps
      const tried = pending?.intent.pie?.label ?? known?.intent.pie?.label ?? event.label ?? action;
      const attempt = target ? `${actor} tried '${tried}' with ${target}` : `${actor} tried '${tried}'`;
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
      this.autonomy.outcomeVerdict.record({
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
      this.autonomy.cognitionService.onOutcome({
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

  // F5: the graded outcome log for the loaded save, newest first. `verdict=suspect` is
  // the query the night watch and the bench ask — "did the action loop lie during this
  // window?" — which used to need someone reading the log as it scrolled past.
  @CatchErrors()
  getOutcomes = (req: Request, res: Response) => {
    const { sim_id: simId, verdict, limit } = req.query;
    const parsedLimit = typeof limit === 'string' ? Number(limit) : undefined;
    res.json(
      this.autonomy.outcomeVerdict.list({
        simId: typeof simId === 'string' ? simId : undefined,
        verdict: typeof verdict === 'string' ? (verdict as OutcomeVerdict) : undefined,
        limit: parsedLimit && parsedLimit > 0 ? parsedLimit : undefined,
      }),
    );
  };

  // Intention rows (autonomy part 5): the whole list per Sim, or one Sim's (decision 13:
  // this and the mod's `[Rows]` log lines are the inspection surface)
  @CatchErrors()
  getRows = (req: Request, res: Response) => {
    const { simId } = req.params as { simId?: string };
    if (simId) {
      res.json({ sim_id: simId, rows: this.autonomy.intentions.rowsFor(simId) });
      return;
    }
    res.json(this.autonomy.intentions.all());
  };

  // Row memory (renovation R1): every key's counters across days, the retired keys, and for one
  // Sim today's fire log and the household's interactions by origin. Chat 4's stream review
  // reads this (or greps the `[Rows] <Sim> day <D>:` lines) instead of counting by hand.
  @CatchErrors()
  getRowStats = (req: Request, res: Response) => {
    const { simId } = req.params as { simId?: string };
    const { rowMemory } = this.autonomy;
    if (!simId) {
      const stats = rowMemory.allStats();
      res.json({ stats, retired: stats.filter((entry) => entry.retiredDay !== undefined) });
      return;
    }
    const day = this.ctx.simStateCache.getReport()?.lot?.clock?.absolute_day;
    const stats = rowMemory.statsFor(simId);
    res.json({
      sim_id: simId,
      day,
      stats,
      retired: stats.filter((entry) => entry.retiredDay !== undefined),
      fires: rowMemory.firesFor(simId, day),
      interactions: rowMemory.interactionCounts(simId, day),
    });
  };

  // Dev seam: fire one row now, past the pace and the preconditions (the gate still applies)
  debugFireRow = async (req: Request, res: Response) => {
    try {
      const { sim_id: simId, row_id: rowId } = req.body as { sim_id?: string; row_id?: string };
      if (!simId || !rowId) {
        return res.status(400).json({ error: 'sim_id and row_id are required' });
      }
      const result = await this.autonomy.cognitionService.fireRowNow(simId, rowId);
      return res.status(result.ok ? 200 : 409).json(result);
    } catch (err) {
      log.error('Error firing an intention row', err);
      return res.status(500).json({ error: errorMessage(err) });
    }
  };

  // Procedures and pitfalls (R4): the Sim's own and everyone's here, or every one in the save
  getProcedures = (req: Request, res: Response) => {
    const { simId } = req.params as { simId?: string };
    res.json({ sim_id: simId, ...this.autonomy.procedures.view(simId) });
  };

  // Dev seam (the R4 live check): one structural failure on a Sim's procedure, through the same
  // code an outcome takes, so the next night call is asked to revise it
  debugProcedureFail = (req: Request, res: Response) => {
    try {
      const { sim_id: simId, key, cause } = req.body as { sim_id?: string; key?: string; cause?: string };
      if (!simId || !key) {
        return res.status(400).json({ error: 'sim_id and key are required' });
      }
      const procedure = this.autonomy.procedures.recordFailureNow(simId, key, cause);
      return procedure
        ? res.json({ ok: true, procedure })
        : res.status(404).json({ ok: false, error: `no procedure [${key}] for sim ${simId}` });
    } catch (err) {
      log.error('Error forcing a procedure failure', err);
      return res.status(500).json({ error: errorMessage(err) });
    }
  };

  // Dev seam: run the night call for one Sim now (autonomy part 6); the turn runs on
  // after the answer, its end is the `[Night] ... call ended` log line
  debugNightCall = (req: Request, res: Response) => {
    try {
      const { sim_id: simId } = req.body as { sim_id?: string };
      if (!simId) {
        return res.status(400).json({ error: 'sim_id is required' });
      }
      const result = this.autonomy.nightCall.runNow(simId);
      return res.status(result.ok ? 200 : 409).json(result);
    } catch (err) {
      log.error('Error starting a night call', err);
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
      this.autonomy.actionDispatcher.sendToMod(message);
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

      const requestId = this.autonomy.actionDispatcher.dispatch(intent);
      return res.json({ request_id: requestId });
    } catch (err) {
      log.error('Error dispatching debug enqueue', err);
      return res.status(500).json({ error: errorMessage(err) });
    }
  };
}
