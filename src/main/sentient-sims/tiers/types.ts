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
  onModMessage?(ctx: ApiContext, message: Record<string, unknown>): boolean;
  onMemoryUpserted?(ctx: ApiContext, memory: MemoryEntity): void;
  // App quit (main.ts will-quit).
  shutdown?(ctx: ApiContext): void;
}
