// Plum's app-side tools: what the companion app knows that the game does not (the memory
// store, the fact store, the autonomy tier's plans and outcomes). Same catalogue shape as
// the mod's tools (PlumTools.ts); PlumService merges them in sorted by name.
import { ApiContext } from '../ApiContext';
import { MemoryEntity } from '../../db/entities/MemoryEntity';
import { AppTool } from './PlumTools';
import {
  ArcBeat,
  describe as describeWake,
  MAX_ARC_BEATS,
  MAX_REAL_MINUTES,
  PlumWakeService,
  ScriptBeat,
  WakeAction,
  WakeKind,
} from './PlumWake';
import { PlumWhisperService, WhisperItem } from './PlumWhisper';
import { DIRECTOR_NOTE_MAX_CHARS } from './plumPrompt';

// The one thing the director_note tool needs of the PlumService running the turn
export type DirectorNoteStore = { setDirectorNote(note: string): void };

const MEMORY_TEXT_CHARS = 400;
const DEFAULT_MEMORIES = 10;
const MAX_MEMORIES = 40;

// A Sim as the player names them -> the game's sim id: the state report first (the Sims
// on the lot), then the participant table (everyone the app has met). Null when unknown.
export function resolveSimId(ctx: ApiContext, spec: string): string | undefined {
  const wanted = spec.trim();
  if (!wanted) {
    return undefined;
  }
  if (/^\d+$/.test(wanted)) {
    return wanted;
  }
  const lowered = wanted.toLowerCase();
  const fullMatches: string[] = [];
  const firstMatches: string[] = [];
  const seen = new Set<string>();
  const consider = (id: string | undefined, name: string | undefined) => {
    if (!id || !name || seen.has(id)) {
      return;
    }
    seen.add(id);
    const full = name.trim().toLowerCase();
    if (full === lowered) {
      fullMatches.push(id);
    } else if (full.split(/\s+/)[0] === lowered) {
      firstMatches.push(id);
    }
  };
  for (const sim of ctx.simStateCache.getReport()?.sims ?? []) {
    consider(sim.sim_id, sim.sim_name);
  }
  try {
    for (const participant of ctx.participantRepository.getAllParticipants()) {
      consider(participant.id, participant.name);
    }
  } catch {
    // No database loaded: the state report alone decides
  }
  const matches = fullMatches.length > 0 ? fullMatches : firstMatches;
  return matches.length === 1 ? matches[0] : undefined;
}

function trim(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MEMORY_TEXT_CHARS ? `${flat.slice(0, MEMORY_TEXT_CHARS)}...` : flat;
}

function memoryRow(memory: MemoryEntity) {
  return {
    id: memory.id,
    when: memory.timestamp,
    type: memory.event_type,
    participants: memory.participant_names ?? [],
    ...(memory.owner_name ? { owner: memory.owner_name } : {}),
    ...(memory.pre_action ? { about: trim(memory.pre_action) } : {}),
    text: trim(memory.content) ?? trim(memory.action) ?? '',
  };
}

// A whisper's nudge as the tools take it: the pie-menu item (key or label) and its target
// (a Sim name or id, an object id or kind), resolved to a WhisperItem. Undefined when no
// item was given (a chat whisper that is only talk).
function whisperItem(ctx: ApiContext, item: unknown, target: unknown): WhisperItem | undefined {
  const key = typeof item === 'string' ? item.trim() : '';
  if (!key) {
    return undefined;
  }
  const resolved: WhisperItem = { key, label: key };
  const targetSpec = typeof target === 'string' ? target.trim() : '';
  if (targetSpec) {
    // A Sim resolves to an id (the mod's click_pie_menu takes either); anything else (an
    // object id or kind) goes through as typed
    const simId = resolveSimId(ctx, targetSpec);
    resolved.targetId = simId ?? targetSpec;
    resolved.targetName = simId ? (ctx.simStateCache.getSim(simId)?.sim_name ?? targetSpec) : targetSpec;
  }
  return resolved;
}

function scriptBeats(ctx: ApiContext, raw: unknown): ScriptBeat[] {
  const entries = Array.isArray(raw) ? raw : [];
  if (entries.length < 1 || entries.length > MAX_ARC_BEATS) {
    throw new Error(`a script is 1 to ${MAX_ARC_BEATS} beats, not ${entries.length}`);
  }
  return entries.map((entry, index) => {
    const beat = (entry ?? {}) as { sim?: unknown; line?: unknown; item?: unknown; target?: unknown };
    const spec = typeof beat.sim === 'string' ? beat.sim.trim() : '';
    const line = typeof beat.line === 'string' ? beat.line.trim() : '';
    if (!spec || !line) {
      throw new Error(`beat ${index + 1} needs \`sim\` and \`line\``);
    }
    const simId = resolveSimId(ctx, spec);
    if (!simId) {
      throw new Error(`beat ${index + 1}: no Sim called '${spec}' is known; look_at_lot lists who is here`);
    }
    const item = whisperItem(ctx, beat.item, beat.target);
    if (!item) {
      throw new Error(`beat ${index + 1} needs \`item\`: the pie-menu item you hope ${spec} picks`);
    }
    return { simId, simName: ctx.simStateCache.getSim(simId)?.sim_name ?? spec, line, item };
  });
}

// `wakeOf` names the PlumService whose wake-ups wake_me sets (the one running the turn);
// resolved at call time because the service builds its tools before its wake list exists.
// `whisperOf` the same for the whisper tools, `noteOf` for director_note.
export function buildAppTools(
  ctx: ApiContext,
  wakeOf: () => PlumWakeService = () => ctx.plum.wake,
  whisperOf: () => PlumWhisperService = () => ctx.plum.whisper,
  noteOf: () => DirectorNoteStore = () => ctx.plum,
): AppTool[] {
  const recentMemories: AppTool = {
    definition: {
      name: 'recent_memories',
      description:
        'The newest memories the app has stored for this save: conversations, scenes, thoughts and ' +
        'reflections, with who took part. With `sim` set, only the ones that Sim was part of.',
      input_schema: {
        type: 'object',
        properties: {
          n: {
            type: ['integer', 'null'],
            description: `How many, newest last (null = ${DEFAULT_MEMORIES}, max ${MAX_MEMORIES})`,
          },
          sim: { type: ['string', 'null'], description: 'Sim name or id to filter by (null = everyone)' },
        },
        required: ['n', 'sim'],
        additionalProperties: false,
      },
      risk: 'read',
      timeout_ms: 5000,
      tier: 'core',
    },
    run: (args) => {
      const n = Math.max(1, Math.min(MAX_MEMORIES, typeof args.n === 'number' ? Math.floor(args.n) : DEFAULT_MEMORIES));
      const simSpec = typeof args.sim === 'string' ? args.sim.trim() : '';
      let memories = ctx.memoryRepository.getMemories();
      if (simSpec) {
        const simId = resolveSimId(ctx, simSpec);
        const lowered = simSpec.toLowerCase();
        memories = memories.filter((memory) => {
          const names = (memory.participant_names ?? []).map((name) => name.toLowerCase());
          const ownerMatch = memory.owner_participant_id !== undefined && memory.owner_participant_id === simId;
          return ownerMatch || names.some((name) => name === lowered || name.split(/\s+/)[0] === lowered);
        });
      }
      return Promise.resolve({ memories: memories.slice(-n).map(memoryRow) });
    },
  };

  const simFacts: AppTool = {
    definition: {
      name: 'sim_facts',
      description:
        'What the app believes about a Sim from their memories: standing facts such as who they like, ' +
        'what they want, what they do (the fact store behind the prompts). With `about` set, only the ' +
        'facts that concern that other Sim.',
      input_schema: {
        type: 'object',
        properties: {
          sim: { type: 'string', description: 'Sim name or id' },
          about: { type: ['string', 'null'], description: 'Another Sim, name or id (null = every fact)' },
        },
        required: ['sim', 'about'],
        additionalProperties: false,
      },
      risk: 'read',
      timeout_ms: 5000,
      tier: 'core',
    },
    run: (args) => {
      const simSpec = typeof args.sim === 'string' ? args.sim : '';
      const simId = resolveSimId(ctx, simSpec);
      if (!simId) {
        return Promise.reject(
          new Error(`no Sim called '${simSpec}' is known to the app; look_at_lot lists who is here`),
        );
      }
      const aboutSpec = typeof args.about === 'string' ? args.about.trim() : '';
      const about = aboutSpec ? resolveSimId(ctx, aboutSpec) : undefined;
      if (aboutSpec && !about) {
        return Promise.reject(new Error(`no Sim called '${aboutSpec}' is known to the app`));
      }
      const facts = ctx.semanticMemory.getCurrentFacts(simId, { about });
      const names = ctx.semanticMemory.namesForIds([
        simId,
        ...facts.map((fact) => fact.objectSimId ?? '').filter(Boolean),
      ]);
      return Promise.resolve({
        sim: names[simId] ?? simId,
        facts: facts.map((fact) => ({
          predicate: fact.predicate,
          object: fact.objectSimId ? (names[fact.objectSimId] ?? fact.objectSimId) : fact.objectText,
          confidence: fact.confidence,
          since_day: fact.validFromDay,
        })),
      });
    },
  };

  const cognitionStatus: AppTool = {
    definition: {
      name: 'cognition_status',
      description:
        "A household Sim's own mind in the app: today's plan (goals, persona) and the last few actions " +
        'their cognition chose, with how each turned out. Only in a build with Full Autonomy.',
      input_schema: {
        type: 'object',
        properties: { sim: { type: 'string', description: 'Sim name or id' } },
        required: ['sim'],
        additionalProperties: false,
      },
      risk: 'read',
      timeout_ms: 5000,
      tier: 'core',
    },
    run: (args) => {
      const cognition = ctx.ext.plumCognition;
      if (!cognition) {
        return Promise.reject(
          new Error('this build of the companion app has no Full Autonomy; there is no plan to read'),
        );
      }
      const simSpec = typeof args.sim === 'string' ? args.sim : '';
      const simId = resolveSimId(ctx, simSpec);
      if (!simId) {
        return Promise.reject(new Error(`no Sim called '${simSpec}' is known to the app`));
      }
      return Promise.resolve(cognition(simId));
    },
  };

  const remember: AppTool = {
    definition: {
      name: 'remember',
      description:
        'Keep a note for your future self in this save: a promise to the player, a fact about the household, ' +
        'how the player likes things done. Notes come back at the start of every later conversation.',
      input_schema: {
        type: 'object',
        properties: {
          note: { type: 'string', description: 'One or two sentences' },
          sims: {
            type: ['array', 'null'],
            items: { type: 'string' },
            description: 'Sim names or ids the note is about (null = none)',
          },
        },
        required: ['note', 'sims'],
        additionalProperties: false,
      },
      risk: 'write',
      timeout_ms: 5000,
      tier: 'core',
    },
    run: (args) => {
      const note = typeof args.note === 'string' ? args.note.trim() : '';
      if (!note) {
        return Promise.reject(new Error('an empty note is nothing to remember'));
      }
      if (!ctx.plumRepository.isLoaded()) {
        return Promise.reject(new Error('no save is loaded, so there is nowhere to keep the note'));
      }
      const specs = Array.isArray(args.sims) ? args.sims.filter((sim): sim is string => typeof sim === 'string') : [];
      const simIds = specs.map((spec) => resolveSimId(ctx, spec) ?? spec);
      const gameDay = ctx.simStateCache.getReport()?.lot?.clock?.absolute_day;
      ctx.plumRepository.addNote('note', note, simIds, gameDay);
      return Promise.resolve({ changed: `noted: ${note.length > 80 ? `${note.slice(0, 80)}...` : note}` });
    },
  };

  const recall: AppTool = {
    definition: {
      name: 'recall',
      description:
        'Every note you kept in this save (remember) and the summaries of earlier conversations, oldest first.',
      input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      risk: 'read',
      timeout_ms: 5000,
      tier: 'core',
    },
    run: () => {
      if (!ctx.plumRepository.isLoaded()) {
        return Promise.resolve({ notes: [] });
      }
      return Promise.resolve({
        notes: ctx.plumRepository.notes(40).map((note) => ({
          kind: note.kind,
          day: note.game_day,
          text: note.text,
          sims: note.sim_ids,
        })),
      });
    },
  };

  const wakeMe: AppTool = {
    definition: {
      name: 'wake_me',
      description:
        'Set yourself a wake-up: the app wakes you with a <wake> message (nobody typed it) when the condition ' +
        'is met, carrying your note. `when`: sim_finishes = the Sim finishes what they are doing now (or a ' +
        'push of yours on them ends; with `doing` = the key you pushed, when THAT ends), game_time = the lot ' +
        'clock reaches `at`, real_minutes = `minutes` from now, cancel = drop every wake-up. Use it after a ' +
        'push or a click instead of guessing when it ends.',
      input_schema: {
        type: 'object',
        properties: {
          when: {
            type: 'string',
            enum: ['sim_finishes', 'game_time', 'real_minutes', 'cancel'],
            description: 'The condition',
          },
          sim: { type: ['string', 'null'], description: 'The Sim to watch for sim_finishes (name or id); else null' },
          doing: {
            type: ['string', 'null'],
            description:
              'For sim_finishes: the interaction to wait for, the key a click_pie_menu or push_action result ' +
              'returned (e.g. Solo_Stargazing); the wake comes when the Sim STOPS doing it, even if they have ' +
              'not started yet. Null = whatever they are doing this moment.',
          },
          at: { type: ['string', 'null'], description: '"HH:MM" on the 24-hour lot clock for game_time; else null' },
          minutes: {
            type: ['integer', 'null'],
            description: `Real minutes from now for real_minutes (1-${MAX_REAL_MINUTES}); else null`,
          },
          note: { type: 'string', description: 'What to check or do when woken, one line (empty for cancel)' },
        },
        required: ['when', 'sim', 'doing', 'at', 'minutes', 'note'],
        additionalProperties: false,
      },
      risk: 'read',
      timeout_ms: 5000,
      tier: 'core',
    },
    run: (args) => {
      const when = typeof args.when === 'string' ? args.when : '';
      const wake = wakeOf();
      if (when === 'cancel') {
        const count = wake.cancelAll();
        return Promise.resolve({
          changed: count > 0 ? `cancelled ${count} wake-up${count === 1 ? '' : 's'}` : 'no wake-ups were set',
        });
      }
      const note = typeof args.note === 'string' ? args.note.trim() : '';
      if (!note) {
        return Promise.reject(new Error('a wake-up needs a note saying what to check when it fires'));
      }
      let simId: string | undefined;
      let simName: string | undefined;
      if (when === 'sim_finishes') {
        const spec = typeof args.sim === 'string' ? args.sim.trim() : '';
        simId = resolveSimId(ctx, spec);
        if (!simId) {
          return Promise.reject(new Error(`no Sim called '${spec}' is known; look_at_lot lists who is here`));
        }
        simName = ctx.simStateCache.getSim(simId)?.sim_name ?? spec;
      }
      try {
        const trigger = wake.set({
          kind: when as WakeKind,
          note,
          simId,
          simName,
          doing: typeof args.doing === 'string' ? args.doing : undefined,
          at: typeof args.at === 'string' ? args.at : undefined,
          minutes: typeof args.minutes === 'number' ? args.minutes : undefined,
        });
        return Promise.resolve({
          changed: `will wake ${describeWake(trigger)}: ${note}`,
          id: trigger.id,
          pending: wake.list().length,
        });
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };

  const setTrigger: AppTool = {
    definition: {
      name: 'set_trigger',
      description:
        'A wake_me that acts for you: when the condition is met the app runs the action itself, with no ' +
        'turn of yours. `when`: sim_finishes = `sim` stops doing `doing` (the key a push_action or ' +
        'click_pie_menu returned; null = what they are doing now), game_time = the lot clock reaches `at`. ' +
        '`then`: push_action = push `push_action` on `push_sim` (with `push_target` for a social verb), ' +
        'wake = wake you with the note (same as wake_me). A push_action trigger pushes only if the beat ' +
        'it waited for ended well; if it ended canceled or failed, or the push is refused, you are woken ' +
        'with the note instead. plan_arc chains a whole arc in one call; use set_trigger with `after` to ' +
        'patch one beat onto an armed push trigger (it then fires when the interaction THAT trigger pushes ' +
        'ends, by id). wake_me cancel drops every trigger.',
      input_schema: {
        type: 'object',
        properties: {
          when: { type: 'string', enum: ['sim_finishes', 'game_time'], description: 'The condition' },
          sim: { type: ['string', 'null'], description: 'The Sim to watch for sim_finishes (name or id); else null' },
          doing: {
            type: ['string', 'null'],
            description:
              'For sim_finishes: the interaction to wait for (a key a tool returned); null = whatever they are doing now',
          },
          after: {
            type: ['string', 'null'],
            description:
              'A trigger id this one waits on: it fires when the interaction THAT trigger pushes ends; sim and ' +
              'doing are then taken from it (pass null for both). Null = no chaining.',
          },
          at: { type: ['string', 'null'], description: '"HH:MM" on the 24-hour lot clock for game_time; else null' },
          then: { type: 'string', enum: ['push_action', 'wake'], description: 'What to do when it fires' },
          push_sim: {
            type: ['string', 'null'],
            description: 'For then=push_action: the acting Sim (name or id); else null',
          },
          push_action: {
            type: ['string', 'null'],
            description: 'For then=push_action: the whitelisted action key (list_actions); else null',
          },
          push_target: {
            type: ['string', 'null'],
            description: 'For then=push_action: the other Sim for a social verb (name or id); else null',
          },
          note: {
            type: 'string',
            description:
              'What to check or do if you are woken instead (the beat ended badly, the push was refused), one line',
          },
        },
        required: ['when', 'sim', 'doing', 'after', 'at', 'then', 'push_sim', 'push_action', 'push_target', 'note'],
        additionalProperties: false,
      },
      risk: 'write',
      timeout_ms: 5000,
      tier: 'core',
    },
    run: (args) => {
      const when = typeof args.when === 'string' ? args.when : '';
      if (when !== 'sim_finishes' && when !== 'game_time') {
        return Promise.reject(new Error('`when` must be sim_finishes or game_time'));
      }
      const note = typeof args.note === 'string' ? args.note.trim() : '';
      if (!note) {
        return Promise.reject(new Error('a trigger needs a note saying what to check if you are woken instead'));
      }
      const thenKind = typeof args.then === 'string' ? args.then : '';
      if (thenKind !== 'push_action' && thenKind !== 'wake') {
        return Promise.reject(new Error('`then` must be push_action or wake'));
      }
      const nameOf = (simId: string, spec: string) => ctx.simStateCache.getSim(simId)?.sim_name ?? spec;
      const after = typeof args.after === 'string' && args.after.trim() ? args.after.trim() : undefined;
      let simId: string | undefined;
      let simName: string | undefined;
      if (when === 'sim_finishes' && !after) {
        const spec = typeof args.sim === 'string' ? args.sim.trim() : '';
        simId = resolveSimId(ctx, spec);
        if (!simId) {
          return Promise.reject(new Error(`no Sim called '${spec}' is known; look_at_lot lists who is here`));
        }
        simName = nameOf(simId, spec);
      }
      let then: WakeAction | undefined;
      if (thenKind === 'push_action') {
        const pushSpec = typeof args.push_sim === 'string' ? args.push_sim.trim() : '';
        const action = typeof args.push_action === 'string' ? args.push_action.trim() : '';
        if (!pushSpec || !action) {
          return Promise.reject(new Error('then=push_action needs `push_sim` and `push_action`'));
        }
        const pushSimId = resolveSimId(ctx, pushSpec);
        if (!pushSimId) {
          return Promise.reject(new Error(`no Sim called '${pushSpec}' is known; look_at_lot lists who is here`));
        }
        then = { do: 'push_action', simId: pushSimId, simName: nameOf(pushSimId, pushSpec), action };
        const targetSpec = typeof args.push_target === 'string' ? args.push_target.trim() : '';
        if (targetSpec) {
          const targetId = resolveSimId(ctx, targetSpec);
          if (!targetId) {
            return Promise.reject(new Error(`no Sim called '${targetSpec}' is known; look_at_lot lists who is here`));
          }
          then.targetId = targetId;
          then.targetName = nameOf(targetId, targetSpec);
        }
      }
      try {
        const wake = wakeOf();
        const trigger = wake.set({
          kind: when,
          note,
          simId,
          simName,
          doing: typeof args.doing === 'string' ? args.doing : undefined,
          at: typeof args.at === 'string' ? args.at : undefined,
          then,
          after,
        });
        return Promise.resolve({
          changed: `armed ${trigger.id}: ${describeWake(trigger)}${then ? '' : `: ${note}`}`,
          id: trigger.id,
          pending: wake.list().length,
        });
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };

  // The director's arc in one call (PlumWake.planArc): every Sim is resolved before anything
  // is pushed, so an unknown name rejects with nothing half-armed
  const planArc: AppTool = {
    definition: {
      name: 'plan_arc',
      description:
        "Plan a whole arc in one call: pushes beat 1 now, chains beats 2..N on each beat's actual end (by " +
        "interaction id, so a later beat never fires on the other Sim's side of a social), and wakes you with " +
        'recap_note when the last beat ends. Use after the survey instead of push_action + set_trigger x N. ' +
        'A beat that ends canceled or a refused push wakes you and drops the rest of the chain. Each beat is ' +
        'one whitelisted action (list_actions) from one actor to one target.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The arc\'s name, as in your "ARC: <name>" line' },
          beats: {
            type: 'array',
            description: `The beats in order, 1 to ${MAX_ARC_BEATS}`,
            items: {
              type: 'object',
              properties: {
                sim: { type: 'string', description: 'The acting Sim (name or id)' },
                action: { type: 'string', description: 'The whitelisted action key' },
                target: { type: ['string', 'null'], description: 'The other Sim for a social verb; else null' },
              },
              required: ['sim', 'action', 'target'],
              additionalProperties: false,
            },
          },
          recap_note: {
            type: 'string',
            description: 'What to do when woken after the last beat (recap, plan the next arc)',
          },
          beat_note: {
            type: ['string', 'null'],
            description: 'What to do if woken because a beat ended badly or a push was refused; null = a default',
          },
        },
        required: ['name', 'beats', 'recap_note', 'beat_note'],
        additionalProperties: false,
      },
      risk: 'write',
      timeout_ms: 25000,
      tier: 'core',
    },
    run: async (args) => {
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      if (!name) {
        throw new Error('an arc needs a name');
      }
      const recapNote = typeof args.recap_note === 'string' ? args.recap_note.trim() : '';
      if (!recapNote) {
        throw new Error('an arc needs a recap_note saying what to do when it completes');
      }
      const raw = Array.isArray(args.beats) ? args.beats : [];
      if (raw.length < 1 || raw.length > MAX_ARC_BEATS) {
        throw new Error(`an arc is 1 to ${MAX_ARC_BEATS} beats, not ${raw.length}`);
      }
      const nameOf = (simId: string, spec: string) => ctx.simStateCache.getSim(simId)?.sim_name ?? spec;
      const beats: ArcBeat[] = raw.map((entry, index) => {
        const beat = (entry ?? {}) as { sim?: unknown; action?: unknown; target?: unknown };
        const spec = typeof beat.sim === 'string' ? beat.sim.trim() : '';
        const action = typeof beat.action === 'string' ? beat.action.trim() : '';
        if (!spec || !action) {
          throw new Error(`beat ${index + 1} needs \`sim\` and \`action\``);
        }
        const simId = resolveSimId(ctx, spec);
        if (!simId) {
          throw new Error(`beat ${index + 1}: no Sim called '${spec}' is known; look_at_lot lists who is here`);
        }
        const resolved: ArcBeat = { simId, simName: nameOf(simId, spec), action };
        const targetSpec = typeof beat.target === 'string' ? beat.target.trim() : '';
        if (targetSpec) {
          const targetId = resolveSimId(ctx, targetSpec);
          if (!targetId) {
            throw new Error(`beat ${index + 1}: no Sim called '${targetSpec}' is known; look_at_lot lists who is here`);
          }
          resolved.targetId = targetId;
          resolved.targetName = nameOf(targetId, targetSpec);
        }
        return resolved;
      });
      return wakeOf().planArc({
        name,
        beats,
        recapNote,
        beatNote: typeof args.beat_note === 'string' ? args.beat_note : undefined,
      });
    },
  };

  // Plum as the voice in a Sim's head (core): the Sim answers in character and may refuse
  const whisper: AppTool = {
    definition: {
      name: 'whisper',
      description:
        'Say something to a Sim as a quiet voice in their head (they never learn it is you), and optionally ' +
        'nudge them toward ONE pie-menu item (`item` = a key or label from pie_menu for that Sim, `target` = ' +
        'the same target as in pie_menu: a Sim, an object id or kind; null = self). The Sim answers in ' +
        "character and decides: an agreed item runs as THEIR choice (it yields to the player's clicks) and " +
        'the thought they have about it airs in the game; a refusal costs nothing. The reply comes back ' +
        'here and shows in the tab as two rows. Prefer this to push_action when the Sim should have a say.',
      input_schema: {
        type: 'object',
        properties: {
          sim: { type: 'string', description: 'The Sim to whisper to (name or id)' },
          line: { type: 'string', description: 'What the voice says to them, one or two sentences' },
          item: {
            type: ['string', 'null'],
            description: 'The pie-menu item (key or label) you hope they pick; null = just talk',
          },
          target: {
            type: ['string', 'null'],
            description: "The item's target as pie_menu took it (a Sim, an object id or kind); null = self",
          },
        },
        required: ['sim', 'line', 'item', 'target'],
        additionalProperties: false,
      },
      risk: 'write',
      timeout_ms: 60000,
      tier: 'core',
    },
    run: async (args) => {
      const spec = typeof args.sim === 'string' ? args.sim.trim() : '';
      const line = typeof args.line === 'string' ? args.line.trim() : '';
      if (!spec || !line) {
        throw new Error('a whisper needs `sim` and `line`');
      }
      const simId = resolveSimId(ctx, spec);
      if (!simId) {
        throw new Error(`no Sim called '${spec}' is known; look_at_lot lists who is here`);
      }
      const simName = ctx.simStateCache.getSim(simId)?.sim_name ?? spec;
      const item = whisperItem(ctx, args.item, args.target);
      const result = await whisperOf().whisper({ simId, simName, line, ...(item ? { item } : {}), origin: 'chat' });
      let changed: string;
      if (!item) {
        changed = `${simName}: "${result.reply}"`;
      } else if (!result.accepted) {
        changed = `${simName} declined: "${result.reply}"`;
      } else if (result.refused) {
        changed = `${simName} agreed ("${result.reply}") but ${result.refused}`;
      } else {
        changed = `${simName} agreed: ${result.clicked?.changed ?? 'clicked'}`;
      }
      return {
        changed,
        reply: result.reply,
        accepted: result.accepted,
        ...(result.thought ? { thought: result.thought } : {}),
        ...(result.clicked?.key ? { key: result.clicked.key } : {}),
        ...(result.clicked?.interaction_id ? { interaction_id: result.clicked.interaction_id } : {}),
        ...(result.refused ? { refused: result.refused } : {}),
      };
    },
  };

  // The director's script of whispers in one call (PlumWake.planScript); director tier only
  const planScript: AppTool = {
    definition: {
      name: 'plan_script',
      description:
        'Plan a whole scene as WHISPERS in one call: beat 1 is whispered now, each later beat when the ' +
        "previous beat's interaction actually ends (by id), and you are woken with recap_note after the " +
        'last. Each beat is a line you say to one Sim as the voice in their head plus the pie-menu item ' +
        '(key or label from pie_menu) you hope they pick, with its target ("" = self). A Sim may refuse: ' +
        'the script then FREEZES (nothing below it fires, nothing is dropped) and you are woken with their ' +
        'reply to decide with the script tool (resume, replace_from, cancel). Prefer it to plan_arc.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The script\'s name, as in your "ARC: <name>" line' },
          beats: {
            type: 'array',
            description: `The beats in order, 1 to ${MAX_ARC_BEATS}`,
            items: {
              type: 'object',
              properties: {
                sim: { type: 'string', description: 'The Sim to whisper to (name or id)' },
                line: { type: 'string', description: 'What the voice says to them' },
                item: { type: 'string', description: 'The pie-menu item (key or label) you hope they pick' },
                target: {
                  type: 'string',
                  description: 'The item\'s target as pie_menu took it (a Sim, an object id or kind); "" = self',
                },
              },
              required: ['sim', 'line', 'item', 'target'],
              additionalProperties: false,
            },
          },
          recap_note: {
            type: 'string',
            description: 'What to do when woken after the last beat (recap, plan the next script)',
          },
        },
        required: ['name', 'beats', 'recap_note'],
        additionalProperties: false,
      },
      risk: 'write',
      timeout_ms: 90000,
      tier: 'core',
    },
    onlyWith: 'director',
    run: async (args) => {
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      if (!name) {
        throw new Error('a script needs a name');
      }
      const recapNote = typeof args.recap_note === 'string' ? args.recap_note.trim() : '';
      if (!recapNote) {
        throw new Error('a script needs a recap_note saying what to do when it completes');
      }
      const beats = scriptBeats(ctx, args.beats);
      return wakeOf().planScript({ name, beats, recapNote });
    },
  };

  // Deciding a frozen script (and looking at one); director tier only
  const script: AppTool = {
    definition: {
      name: 'script',
      description:
        'Your whisper script. `do`: show = the beats and whether it is frozen; resume = go on from the next ' +
        'beat (it fires when the Sim who froze it finishes what they are doing now); replace_from = drop beat ' +
        '`from_beat` and everything after it and chain `beats` in their place (the first is whispered at once ' +
        'when the beat before it is already spent); cancel = drop the whole script. A frozen script stays ' +
        'frozen until you decide.',
      input_schema: {
        type: 'object',
        properties: {
          do: { type: 'string', enum: ['show', 'resume', 'replace_from', 'cancel'], description: 'What to do' },
          from_beat: {
            type: 'integer',
            description: 'For replace_from: the first beat number to replace (0 otherwise)',
          },
          beats: {
            type: 'array',
            description: 'For replace_from: the new beats from from_beat on (empty otherwise)',
            items: {
              type: 'object',
              properties: {
                sim: { type: 'string', description: 'The Sim to whisper to (name or id)' },
                line: { type: 'string', description: 'What the voice says to them' },
                item: { type: 'string', description: 'The pie-menu item (key or label) you hope they pick' },
                target: { type: 'string', description: 'The item\'s target as pie_menu took it; "" = self' },
              },
              required: ['sim', 'line', 'item', 'target'],
              additionalProperties: false,
            },
          },
          recap_note: {
            type: 'string',
            description: 'For replace_from: what to do when woken after the last beat ("" otherwise)',
          },
        },
        required: ['do', 'from_beat', 'beats', 'recap_note'],
        additionalProperties: false,
      },
      risk: 'write',
      timeout_ms: 90000,
      tier: 'core',
    },
    onlyWith: 'director',
    run: async (args) => {
      const wake = wakeOf();
      const action = typeof args.do === 'string' ? args.do : '';
      switch (action) {
        case 'show': {
          const lines = wake.describeScript();
          return { changed: lines.length > 0 ? 'looked at the script' : 'no script is set', script: lines };
        }
        case 'resume':
          return { changed: `script ${wake.resume()}`, script: wake.describeScript() };
        case 'cancel': {
          const count = wake.cancelAll();
          return { changed: count > 0 ? `script cancelled (${count} triggers dropped)` : 'no script was set' };
        }
        case 'replace_from': {
          const from = typeof args.from_beat === 'number' ? Math.floor(args.from_beat) : 0;
          if (from < 1) {
            throw new Error('replace_from needs `from_beat` (1 = the whole script)');
          }
          const recapNote = typeof args.recap_note === 'string' ? args.recap_note.trim() : '';
          if (!recapNote) {
            throw new Error('replace_from needs a recap_note for the new ending');
          }
          const beats = scriptBeats(ctx, args.beats);
          return wake.replaceFrom(from, beats, recapNote);
        }
        default:
          throw new Error('`do` must be show, resume, replace_from or cancel');
      }
    },
  };

  // The director's memory between ticks (roadmap C1): a director tick is a detached request
  // that sees only the <live> block, this note and the tick text, so the note is rewritten at
  // the end of every tick and comes back at the start of the next one. Core: a script's wake
  // with the director off takes the same detached path.
  const directorNote: AppTool = {
    definition: {
      name: 'director_note',
      description:
        'Rewrite the note you carry between director ticks (it is your ONLY memory of the show: the next tick ' +
        'sees the <live> block, this note and the tick text, nothing of this conversation). Put in it the ' +
        "arc's name and premise, the cast in a line each, which beats landed and how the Sims played them, " +
        `and what the player said about the show. At most ${DIRECTOR_NOTE_MAX_CHARS} characters; the whole ` +
        'note is replaced, so carry forward what still matters. An empty note clears it.',
      input_schema: {
        type: 'object',
        properties: {
          note: { type: 'string', description: `The whole note, at most ${DIRECTOR_NOTE_MAX_CHARS} characters` },
        },
        required: ['note'],
        additionalProperties: false,
      },
      risk: 'write',
      timeout_ms: 5000,
      tier: 'core',
    },
    run: (args) => {
      const full = typeof args.note === 'string' ? args.note.trim() : '';
      const note = full.slice(0, DIRECTOR_NOTE_MAX_CHARS);
      noteOf().setDirectorNote(note);
      if (!note) {
        return Promise.resolve({ changed: 'director note cleared' });
      }
      const cut = full.length > note.length ? `, cut to ${DIRECTOR_NOTE_MAX_CHARS}` : '';
      return Promise.resolve({ changed: `director note updated (${note.length} chars${cut})` });
    },
  };

  return [
    recentMemories,
    simFacts,
    cognitionStatus,
    remember,
    recall,
    wakeMe,
    setTrigger,
    planArc,
    whisper,
    planScript,
    script,
    directorNote,
  ];
}
