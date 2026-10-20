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
  // Offered only when the context has this tier slot (the scripted whisper tools need the
  // director, the chat poll the stream tier): PlumService filters by it when it builds the
  // catalogue
  onlyWith?: 'director' | 'chatPoll';
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

// The API allows at most this many strict tools in one request (measured live 2026-10-15:
// "Too many strict tools (25). The maximum number of strict tools supported is 20").
export const MAX_STRICT_TOOLS = 20;
// And at most this many union-typed (nullable) parameters across the strict tools (measured
// live 2026-10-17: "Schemas contains too many parameters with union types (18 ...). Reduce
// the number of nullable or union-typed parameters (limit: 16 parameters with unions)").
export const MAX_STRICT_UNIONS = 16;
// And the compiled grammar has a size cap of its own (measured live 2026-10-17 with three
// tools carrying arrays of objects: "The compiled grammar is too large ... Simplify your tool
// schemas or reduce the number of strict tools"). A tool whose schema nests objects inside an
// array (plan_arc, plan_script, script) is never strict; the app validates its arguments.
const RISK_RANK: Record<PlumRisk, number> = { destructive: 0, write: 1, read: 2 };

// How many parameters of a schema are union-typed (`type: [..]` or anyOf / oneOf), nested
// objects and array items included
export function countUnions(schema: unknown): number {
  if (!schema || typeof schema !== 'object') {
    return 0;
  }
  const node = schema as { type?: unknown; anyOf?: unknown; oneOf?: unknown; properties?: unknown; items?: unknown };
  let count = Array.isArray(node.type) || Array.isArray(node.anyOf) || Array.isArray(node.oneOf) ? 1 : 0;
  if (node.properties && typeof node.properties === 'object') {
    for (const child of Object.values(node.properties as Record<string, unknown>)) {
      count += countUnions(child);
    }
  }
  if (node.items) {
    count += countUnions(node.items);
  }
  return count;
}

// True when the schema has an array whose items are objects (the grammar-heavy shape)
export function hasObjectArray(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') {
    return false;
  }
  const node = schema as { items?: { type?: unknown; properties?: unknown }; properties?: unknown };
  if (node.items && (node.items.type === 'object' || node.items.properties)) {
    return true;
  }
  if (node.properties && typeof node.properties === 'object') {
    return Object.values(node.properties as Record<string, unknown>).some(hasObjectArray);
  }
  return false;
}

// Which tools get the schema guarantee when the catalogue is bigger than the caps: the ones
// whose arguments move the game, destructive first, each taken while it still fits both
// budgets. Deterministic for a given catalogue, so the cache prefix never moves; the mod
// validates and coerces every call anyway.
export function strictNames(catalogue: CatalogueEntry[]): Set<string> {
  const ranked = [...catalogue].sort(
    (a, b) =>
      RISK_RANK[a.definition.risk] - RISK_RANK[b.definition.risk] || a.definition.name.localeCompare(b.definition.name),
  );
  const names = new Set<string>();
  let unions = 0;
  for (const entry of ranked) {
    if (names.size >= MAX_STRICT_TOOLS) {
      break;
    }
    if (hasObjectArray(entry.definition.input_schema)) {
      continue;
    }
    const own = countUnions(entry.definition.input_schema);
    if (unions + own <= MAX_STRICT_UNIONS) {
      names.add(entry.definition.name);
      unions += own;
    }
  }
  return names;
}

export function toApiTools(catalogue: CatalogueEntry[]): Anthropic.Beta.Messages.BetaTool[] {
  const strict = strictNames(catalogue);
  return catalogue.map(({ definition }) => ({
    name: definition.name,
    description: definition.description,
    input_schema: {
      ...(definition.input_schema as Anthropic.Beta.Messages.BetaTool.InputSchema),
      type: 'object' as const,
    },
    ...(strict.has(definition.name) ? { strict: true } : {}),
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
    case 'pie_menu':
      return `looked at ${sim ?? 'a Sim'}'s pie menu`;
    case 'wake_me':
      return 'setting a wake-up';
    case 'whisper':
      return `whispering to ${sim ?? 'a Sim'}`;
    case 'hand_off':
      return 'handing over to the player';
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
