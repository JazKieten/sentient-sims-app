// Build tiers (release 4.5), the app side of the mod's tiers.py.
//
// One tree, three builds: dev (everything), stream (minus dev), core (the public release:
// minus stream, autonomy and dev). The stripped files are listed in tiers.json and deleted
// before a stripped build, so CORE code may only reach them through what this folder owns:
// the TierRegistration hooks below and the capability slots on ApiContext.ext. Each tier's
// entry module (stream.ts, autonomy.ts, dev.ts) registers into these; the generated index.ts
// lists the entries a build keeps. Nothing here may name a tier's own classes.
import type { Express } from 'express';
import type { IpcMain } from 'electron';
import type { ApiContext } from '../services/ApiContext';
import type { SceneClosed } from '../services/ScenePlaybackRegistry';
import type { MemoryEntity } from '../db/entities/MemoryEntity';
import type { SSEvent } from '../models/InteractionEvents';
import type { InteractionEventResult, LLMExchange } from '../models/InteractionEventResult';
import type { DirectedGenerationOptions } from '../services/AIService';
import type { ReflectionPromptContext } from '../pipeline/prompts/consolidation';
import type { TodaysPlanBlock } from '../util/formatSelfStatus';
import type { ModLogWebsocketMessage } from '../models/ModLogWebsocketMessage';
import type { MemoryTrace, MemoryTracePipeline } from '../models/MemoryTrace';
import type { PlumToolOutcome, PlumTurnKind, PlumTurnResult } from '../services/PlumService';

export type Tier = 'core' | 'stream' | 'dev';

export type TierLayer = 'stream' | 'autonomy' | 'dev';

// Every hook takes the context it runs for: tests build many contexts in one process, and
// a tier keeps its services per context (a WeakMap behind streamOf/autonomyOf/devOf).
export interface TierRegistration {
  name: TierLayer;
  // Build the tier's services and fill its ApiContext.ext slots. Runs inside the ApiContext
  // constructor, after every core service exists and before the controllers are built.
  construct?(ctx: ApiContext): void;
  // Main process only (main.ts), after IPC is bound: connect, arm hotkeys, open sockets.
  start?(ctx: ApiContext): void;
  // HTTP routes, bound after the core routes.
  routes?(app: Express, ctx: ApiContext): void;
  // Renderer IPC handlers (main.ts only; tests never bind IPC).
  ipc?(ipcMain: IpcMain, ctx: ApiContext): void;
  onSettingChanged?(ctx: ApiContext, key: string): void;
  onDatabaseLoaded?(ctx: ApiContext): void;
  // A conversation closed (ran its course or the game stopped it). Called in registration
  // order: stream's moodlet appraisal before autonomy's held conversation actions.
  onSceneClosed?(ctx: ApiContext, closed: SceneClosed): void;
  // A websocket message from the mod that core did not handle. True means handled.
  onModMessage?(ctx: ApiContext, message: ModLogWebsocketMessage): boolean;
  // The mod's websocket closed: nothing pending on it can be answered now
  onModDisconnected?(ctx: ApiContext): void;
  onMemoryUpserted?(ctx: ApiContext, memory: MemoryEntity): void;
  // App quit (main.ts will-quit).
  shutdown?(ctx: ApiContext): void;
}

// --- Capability slots (ApiContext.ext) -------------------------------------------------
// What core code may ask a tier for. Every slot is optional: a build without the tier
// leaves it undefined and core carries on without the feature. Typed with core-owned
// types only, so core never names a tier's classes.

export type AskActionPlayback = {
  priority?: boolean;
  deferPlayback?: boolean;
  // play returns whether it aired (an answer to the player always does)
  onPlaybackReady?: (play: (claimedAt?: number) => boolean) => void;
};

// AUTONOMY: a solo player line that asks the sim to DO something. Undefined on any miss,
// and the ordinary reply runs.
export interface AskActionSlot {
  tryAskedAction(
    event: SSEvent,
    options: DirectedGenerationOptions,
    playback: AskActionPlayback,
  ): Promise<InteractionEventResult | undefined>;
}

export type ConversationActionRequest = {
  score: number;
  reason?: string;
  thought?: string;
  speaker: string;
  transcript: string;
  sceneId?: string;
  suggestOnly?: boolean;
  // Who spoke: a Sim, the player (chat window, voice, conscience) or a Twitch viewer. A
  // viewer is not in the world: the Sim cannot talk to, leave or confront them there, and
  // their lines never arm an action unless conversationActionsFromViewers is on.
  speakerKind?: 'sim' | 'player' | 'viewer';
};

export type ConversationActionOutcome = { acted: boolean; action?: string; target?: string };

// AUTONOMY: a scene's action verdicts. A player-facing beat acts once its scene has aired;
// any other scene arms a desire for the sim's next tick.
export interface ConversationActionsSlot {
  actOnConversation(simId: string, request: ConversationActionRequest): Promise<ConversationActionOutcome>;
  armDesireFromScene(
    simId: string,
    desire: { score: number; reason?: string; thought?: string; targetSimId?: string },
  ): void;
  // The Jev day (2026-10-27): a scene whose scores were skipped asks the decision model, per
  // household performer, whether it leaves them wanting to act; yes arms a scene row
  armSceneImpulses?(
    performers: Array<{ sim_id: string; name: string }>,
    scene: { summary?: string; dialogue: string },
  ): Promise<void>;
}

// AUTONOMY: the nightly planner riding the sleep diary. prepare() returns undefined when
// there is nothing to plan tonight, and the reflection is the plain diary.
export interface SleepPlan {
  // The combined diary + plan system prompt, built around the diary's own context
  systemPrompt(reflection: ReflectionPromptContext): string;
  // Records the review and accepts the plan out of the model's reply; returns the diary
  // prose (never the JSON), before cleanup
  accept(raw: string): string;
}

export interface SleepPlannerSlot {
  prepare(
    pov: { simId: string; simName: string },
    sleepClock?: { hour?: number; absolute_day?: number },
  ): SleepPlan | undefined;
}

// AUTONOMY: an order spoken on the voice command chord
export interface VoiceCommandSlot {
  handleCommand(text: string): Promise<boolean>;
}

// DEV: the Memories window's pipeline view. Core records what produced each memory only when
// a tier keeps it.
export interface TraceSlot {
  recordPending(contents: (string | undefined)[], trace: MemoryTrace): void;
  appendExchange(memoryId: string, exchange: LLMExchange | undefined, pipeline?: MemoryTracePipeline): void;
}

// AUTONOMY: Plum's director mode (improv-watch as a service). Core's PlumService reports
// director_available from this slot and routes the tab's start/stop buttons to it.
export interface DirectorSlot {
  start(brief?: string): void;
  stop(): void;
  status(): { active: boolean; arc?: string };
  // A wake-up trigger of Plum's fired (PlumWake): the next tick carries `text` and runs now
  // if it can. False when the director is not active.
  wake(text: string): boolean;
}

// AUTONOMY: what Plum's cognition_status tool reads for one Sim: today's plan and the
// last few graded outcomes. Shapes are plain data so core never names the tier's types.
export type PlumCognitionView = {
  plan?: { goals: unknown[]; persona?: string; source?: string };
  outcomes: unknown[];
};

// AUTONOMY: a push_action of Plum's registered with the dispatcher so its outcome is graded
export type PlumPushRegistration = (
  requestId: string,
  push: { sim_id: string; action: string; target?: string },
) => void;

// DEV: one Plum turn handed to a brain other than the API loop (a local Claude Code session,
// services/plum/ClaudeCodeBrain.ts). PlumService builds the port; the brain delivers the
// text, runs the tools its model asks for through runTool (rows, guards and push cap stay
// PlumService's) and shows its replies through say.
export type PlumTurnPort = {
  id: string;
  kind: PlumTurnKind;
  // A director turn (tick, script wake): on the API path a detached request that carries only
  // <live>, the director's note and the text; the brain gets the same opening in `live` and
  // should take no seed for it (the seed is the chat's)
  detached: boolean;
  // The <live> block, built once for the turn (plus the <director_note> block when detached)
  live: string;
  // Plum's notes and the tail of the last conversation, rendered fresh when asked
  seed(): string;
  text: string;
  runTool(name: string, args: Record<string, unknown>): Promise<PlumToolOutcome>;
  say(text: string): void;
};

// DEV: Plum's thinking outside the API (settings plumBrain = 'claude-code')
export interface PlumBrainSlot {
  // Why a turn cannot run now (session not running, plan limit), or undefined
  unavailable(): string | undefined;
  runTurn(port: PlumTurnPort): Promise<PlumTurnResult>;
  // The tool catalogue changed (the mod reconnected)
  onCatalogueChanged?(): void;
  // A new conversation began (database loaded, New conversation): the next turn carries the seed
  onThreadReset?(): void;
}

// AUTONOMY: edits to one Sim's intention rows for today (the night call's edit_intentions
// tool, also open to a chat turn). Plain data, defined here so core's PlumAppTools never
// names the tier's row model; models/IntentionRow.ts re-exports them.
export type IntentionRewrite = { row_id: string; why?: string; say?: string; rank?: number };

// Where a story row clicks (renovation R3): self, a Sim, or an object kind
export type IntentionClickTarget = {
  target_kind: 'self' | 'sim' | 'kind' | 'phone';
  target_id?: string;
  target_name?: string;
};

// The click a story row makes: 1-3 items copied from the menus the Sim saw yesterday
export type IntentionClick = IntentionClickTarget & { items: string[]; fallback?: IntentionClickTarget };

// A story row: something the Sim means to do today, in their own words. `from_hour` /
// `to_hour` are hours of the day (0..23) the row may fire in; a named Sim must be present.
export type IntentionStoryAdd = {
  why: string;
  say: string;
  target_sim_id?: string;
  target_name?: string;
  from_hour?: number;
  to_hour?: number;
  click?: IntentionClick;
  // The row's aim as an exact key (renovation R4: make_up, calm_down): what worked for it is
  // kept under this key, and a listed procedure with the key fills a null click
  key?: string;
};

// The night call's one-line reading of why a dead or failed key died (R3), by its [key]
export type IntentionDiagnosis = { key: string; text: string };

// A failed procedure revised in place (R4, Memp's adjust): a new target and 1-3 items for the key.
// A Sim target is the procedure's variable: it binds to whoever the row names.
export type IntentionProcedureRevision = IntentionClickTarget & { key: string; items: string[]; why?: string };

// A lesson a failure taught (R4, ReasoningBank): about a key, a Sim or an object kind; `shared`
// = about the lot, kept for everyone here
export type IntentionPitfallAdd = { about: string; text: string; shared: boolean };

export type IntentionEdits = {
  drop: string[];
  rewrite: IntentionRewrite[];
  add: IntentionStoryAdd[];
  diagnoses?: IntentionDiagnosis[];
  revise_procedure?: IntentionProcedureRevision[];
  add_pitfall?: IntentionPitfallAdd[];
};

export interface IntentionEditSlot {
  // Throws when the Sim has no list today or an id is unknown; `changed` is the row summary
  applyEdits(simId: string, edits: IntentionEdits): { changed: string };
}

// STREAM: a vote Twitch chat casts for Plum (ChatPollService), one at a time. The result
// wakes Plum with a <chat_poll> turn (PlumWakeService.wakeWith).
export type ChatPollMode = 'native' | 'chat';

export type ChatPollRequest = { question: string; options: string[]; seconds: number; note: string };

export type ChatPollOpened = {
  id: string;
  mode: ChatPollMode;
  seconds: number;
  // Why a native poll became a chat vote
  fellBack?: string;
};

export type ChatPollView = {
  id: string;
  question: string;
  mode: ChatPollMode;
  options: { title: string; votes: number }[];
  secondsLeft: number;
};

export interface ChatPollSlot {
  open(request: ChatPollRequest): Promise<ChatPollOpened>;
  // False when no poll was open
  cancel(): Promise<boolean>;
  current(): ChatPollView | undefined;
}

export interface TierExtensions {
  director?: DirectorSlot;
  chatPoll?: ChatPollSlot;
  plumPush?: PlumPushRegistration;
  plumCognition?: (simId: string) => PlumCognitionView;
  trace?: TraceSlot;
  askAction?: AskActionSlot;
  conversationActions?: ConversationActionsSlot;
  sleepPlanner?: SleepPlannerSlot;
  voiceCommand?: VoiceCommandSlot;
  // AUTONOMY: today's plan as the self-status block renders it
  selfStatusPlan?: (simId: string, absoluteDay: number) => TodaysPlanBlock | undefined;
  plumBrain?: PlumBrainSlot;
  // AUTONOMY: the intention rows' edit door (edit_intentions)
  intentions?: IntentionEditSlot;
}
