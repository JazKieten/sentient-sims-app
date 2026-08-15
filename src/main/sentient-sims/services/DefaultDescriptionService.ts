import log from 'electron-log';
import { ApiContext } from './ApiContext';
import { AIActionType } from '../models/AIActionType';
import { SentientSim } from '../models/SentientSim';
import { LocationEntity } from '../db/entities/LocationEntity';
import { LotBlock } from '../models/SimStateReport';
import { cleanupAIOutput, formatSentientSim } from '../formatter/PromptFormatter';

// V-6: nobody should meet a character called "The Residence". A sim or a location that has
// never been described gets ONE cheap fire-and-forget one-shot written from what the game
// already knows (traits, likes, career, mood for a sim; venue, ownership, conditions and
// the zone name for a lot). It is a STARTING POINT the player is expected to edit, so it
// is written once and never overwrites: the persist step re-reads the row and stores only
// if the description is still empty (sim) or still the stock default (location). Nothing
// here blocks a generation — callers fire and forget, and a failure just means the old
// default text is used for another tick.

const SIM_SYSTEM_PROMPT = `You write a short character description for one Sim in The Sims 4, for use as story context.
Write 2-3 sentences of plain prose in the third person, present tense, about who this Sim is: their personality, how they come across to others, and what they care about.
Rules:
- Use ONLY what the facts below support. Never invent family, jobs, history, or events.
- Do not restate the fact list, do not use bullet points, and do not mention traits, moods or game mechanics by name.
- Do not describe what they are doing right now — moods pass, this description is permanent.
- Reply with the description text only.`;

const LOCATION_SYSTEM_PROMPT = `You write a short description of one place in The Sims 4, for use as story context.
Write 2-3 sentences of plain prose in the third person, present tense, describing the place: what kind of place it is and what it feels like to be there.
Rules:
- Use ONLY what the facts below support. Never invent rooms, owners, or history that is not listed.
- Do not use bullet points and do not mention game mechanics by name.
- Reply with the description text only.`;

// A generated description is a one-shot per entity per app run: a miss that fails (no API
// key, provider down, refusal) must not re-queue on every single prompt build.
const MAX_DESCRIPTION_TOKENS = 220;

function isBlank(text?: string | null): boolean {
  return !text || text.trim().length === 0;
}

export class DefaultDescriptionService {
  private readonly ctx: ApiContext;

  private readonly attemptedSims = new Set<string>();

  private readonly attemptedLocations = new Set<string>();

  constructor(ctx: ApiContext) {
    this.ctx = ctx;
  }

  private enabled(): boolean {
    return this.ctx.settings.generatedDefaultDescriptions;
  }

  // Called from the prompt builder after the participant join: the SentientSim in hand is
  // the richest picture of this character the app ever gets, and it is only complete while
  // an event is being formatted.
  considerSim(sentientSim: SentientSim, existingDescription?: string) {
    if (!this.enabled() || !isBlank(existingDescription)) {
      return;
    }
    const simId = sentientSim.sim_id;
    if (!simId || this.attemptedSims.has(simId)) {
      return;
    }
    this.attemptedSims.add(simId);
    // Fire and forget: prompt building is on the request path and must never wait on an LLM
    this.generateSimDescription(sentientSim).catch((error: unknown) => {
      log.warn(`[DefaultDescription] sim ${simId} failed`, error);
    });
  }

  considerLocation(location: LocationEntity, lot?: LotBlock, zoneName?: string) {
    if (!this.enabled() || !location.is_generic) {
      return;
    }
    const locationId = String(location.id);
    if (this.attemptedLocations.has(locationId)) {
      return;
    }
    this.attemptedLocations.add(locationId);
    this.generateLocationDescription(location, lot, zoneName).catch((error: unknown) => {
      log.warn(`[DefaultDescription] location ${locationId} failed`, error);
    });
  }

  private async generateSimDescription(sentientSim: SentientSim) {
    // formatSentientSim minus the description clause (there isn't one — that is the point)
    // and minus the trait-consistency instruction, which is direction for an actor, not fact
    // The list formatters index straight into these arrays; a sparse sim off the wire
    // would otherwise take the whole (fire-and-forget) call down silently. The casts are
    // deliberate: the type says non-null, the HTTP body does not.
    const sparse = sentientSim as Partial<SentientSim>;
    const facts = formatSentientSim(
      {
        ...sentientSim,
        traits: sparse.traits ?? [],
        moods: sparse.moods ?? [],
        careers: sparse.careers ?? [],
        description: undefined,
      },
      { traitConsistencyNote: false },
    );
    const name = sparse.name ?? 'this Sim';
    const oneShot = await this.ctx.ai.runOneShot(
      `Default Description: ${name}`,
      SIM_SYSTEM_PROMPT,
      `Facts about ${name}:\n${facts}`,
      MAX_DESCRIPTION_TOKENS,
      undefined,
      AIActionType.DESCRIPTION_DEFAULT,
    );
    const description = cleanupAIOutput(oneShot.text).trim();
    if (description.length < 20) {
      log.warn(`[DefaultDescription] sim ${name} produced nothing usable`);
      return;
    }
    const stored = this.ctx.participantRepository.setDescriptionIfEmpty(sentientSim.sim_id, description, name);
    log.info(`[DefaultDescription] sim ${name}: ${stored ? 'stored' : 'skipped (already described)'}`);
  }

  private async generateLocationDescription(location: LocationEntity, lot?: LotBlock, zoneName?: string) {
    const facts = this.locationFacts(location, lot, zoneName);
    const label = zoneName || location.name || 'this place';
    const oneShot = await this.ctx.ai.runOneShot(
      `Default Description: ${label}`,
      LOCATION_SYSTEM_PROMPT,
      `Facts about ${label}:\n${facts}`,
      MAX_DESCRIPTION_TOKENS,
      undefined,
      AIActionType.DESCRIPTION_DEFAULT,
    );
    const description = cleanupAIOutput(oneShot.text).trim();
    if (description.length < 20) {
      log.warn(`[DefaultDescription] location ${label} produced nothing usable`);
      return;
    }
    const stored = this.ctx.locationRepository.setDescriptionIfGeneric(location, description, zoneName);
    log.info(`[DefaultDescription] location ${label}: ${stored ? 'stored' : 'skipped (already described)'}`);
  }

  private locationFacts(location: LocationEntity, lot?: LotBlock, zoneName?: string): string {
    const facts: string[] = [];
    facts.push(`Name: ${zoneName || location.name || 'unnamed lot'}`);
    if (location.lot_type) {
      facts.push(`Lot type: ${location.lot_type}`);
    }
    if (lot?.venue) {
      facts.push(`Venue type: ${lot.venue}`);
    }
    if (lot?.is_home) {
      facts.push('This is the household home lot.');
    }
    const owned = Object.entries(lot?.owned ?? {})
      .filter(([, count]) => count > 0)
      .map(([kind, count]) => (count > 1 ? `${kind} x${count}` : kind));
    if (owned.length > 0) {
      facts.push(`Objects on the lot: ${owned.join(', ')}`);
    }
    const conditions = (lot?.conditions ?? [])
      .map((condition) => `${condition.name ?? 'an object'} is ${condition.conditions.join(' and ')}`)
      .filter((text) => text.length > 0);
    if (conditions.length > 0) {
      facts.push(`Current state of repair: ${conditions.join('; ')}`);
    }
    if (lot?.situations && lot.situations.length > 0) {
      facts.push(`Happening here right now: ${lot.situations.join(', ')}`);
    }
    return facts.join('\n');
  }
}
