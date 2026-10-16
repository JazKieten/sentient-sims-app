// Plum's tool catalogue on the app side: the mod's tools (sent on every websocket open as
// {plum: {kind: 'catalogue'}}) merged with the app's own, serialized the way the Messages API
// wants them. Sorted by name and strict, because the catalogue is cache position 0.
import Anthropic from '@anthropic-ai/sdk';

export type PlumRisk = 'read' | 'write' | 'destructive';

// One tool as the mod describes it (plum/ss_plum_tools.py catalogue())
export type ModToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  risk: PlumRisk;
  timeout_ms: number;
  tier: string;
};

// One tool the app runs itself (memories, facts, notes): same definition shape plus run
export type AppTool = {
  definition: ModToolDef;
  run(args: Record<string, unknown>): Promise<unknown>;
};

export type CatalogueEntry = {
  definition: ModToolDef;
  // undefined = the mod runs it
  app?: AppTool;
};

export function mergeCatalogue(modTools: ModToolDef[], appTools: AppTool[]): CatalogueEntry[] {
  const byName = new Map<string, CatalogueEntry>();
  for (const definition of modTools) {
    byName.set(definition.name, { definition });
  }
  for (const app of appTools) {
    // The mod's tool wins a name clash: its catalogue is what the player's build ships
    if (!byName.has(app.definition.name)) {
      byName.set(app.definition.name, { definition: app.definition, app });
    }
  }
  return [...byName.values()].sort((a, b) => a.definition.name.localeCompare(b.definition.name));
}

export function toApiTools(catalogue: CatalogueEntry[]): Anthropic.Beta.Messages.BetaTool[] {
  return catalogue.map(({ definition }) => ({
    name: definition.name,
    description: definition.description,
    input_schema: {
      ...(definition.input_schema as Anthropic.Beta.Messages.BetaTool.InputSchema),
      type: 'object' as const,
    },
    strict: true,
  }));
}

// A stable fingerprint of the catalogue: a reconnect with a different one starts a new thread
// rather than swapping tools under a transcript.
export function catalogueFingerprint(catalogue: CatalogueEntry[]): string {
  return JSON.stringify(catalogue.map(({ definition }) => [definition.name, definition.input_schema]));
}

function simArg(args: Record<string, unknown>): string | undefined {
  const sim = args.sim;
  if (typeof sim === 'string' && sim.trim()) {
    return sim.trim();
  }
  if (typeof sim === 'number') {
    return String(sim);
  }
  return undefined;
}

// What a tool row says while a read tool runs / after it ran
export function readSummary(name: string, args: Record<string, unknown>): string {
  const sim = simArg(args);
  switch (name) {
    case 'look_at_lot':
      return 'looked at the lot';
    case 'look_at_sim':
      return `looked at ${sim ?? 'a Sim'}`;
    case 'relationships':
      return `looked at ${sim ?? 'a Sim'}'s relationships`;
    case 'list_actions':
      return sim ? `listed what ${sim} can do` : 'listed the lot actions';
    case 'get_settings':
      return 'read the settings';
    case 'clock':
      return 'read the clock';
    case 'recent_memories':
      return 'read recent memories';
    case 'sim_facts':
      return `read what is known about ${sim ?? 'a Sim'}`;
    case 'cognition_status':
      return `read ${sim ?? 'a Sim'}'s plan`;
    case 'recall':
      return "read Plum's notes";
    default:
      return `ran ${name}`;
  }
}

export const TOOL_DETAIL_MAX_CHARS = 4096;

export function trimDetail(value: unknown): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
  } catch {
    text = String(value);
  }
  if (text.length > TOOL_DETAIL_MAX_CHARS) {
    return `${text.slice(0, TOOL_DETAIL_MAX_CHARS)}\n... (${text.length - TOOL_DETAIL_MAX_CHARS} more characters)`;
  }
  return text;
}
