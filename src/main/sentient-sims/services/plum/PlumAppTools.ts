// Plum's app-side tools: what the companion app knows that the game does not (the memory
// store, the fact store, the autonomy tier's plans and outcomes). Same catalogue shape as
// the mod's tools (PlumTools.ts); PlumService merges them in sorted by name.
import { ApiContext } from '../ApiContext';
import { MemoryEntity } from '../../db/entities/MemoryEntity';
import { AppTool } from './PlumTools';

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

export function buildAppTools(ctx: ApiContext): AppTool[] {
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

  return [recentMemories, simFacts, cognitionStatus, remember, recall];
}
