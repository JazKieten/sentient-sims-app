import { LLMExchange } from './InteractionEventResult';

export type MemoryTracePipeline = 'directed_scene' | 'scene_generation' | 'scene_reflection' | 'cognition' | 'other';

export type MemoryTraceReview = {
  // What the actors delivered (or the raw scene text) before the reviewer pass
  before: string;
  // The final text after the reviewer pass
  after: string;
  // Whether the reviewer's cut actually aired (directed scenes fall back to the
  // actors' original lines when the reviewer loses a speaker)
  usedReviewerCut: boolean;
};

// Dev-mode record of every LLM stage that produced one memory. Held in memory only —
// traces exist for scenes generated since the app started.
export type MemoryTrace = {
  pipeline: MemoryTracePipeline;
  exchanges: LLMExchange[];
  // The director's raw briefing output (shared scene + per-actor prompts), directed scenes only
  directorDirection?: string;
  review?: MemoryTraceReview;
};
