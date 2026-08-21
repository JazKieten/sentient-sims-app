import { MemoryEntity } from './MemoryEntity';

export type MemoryIndexEntity = {
  memory_id: string;
  importance?: number | null;
  // Participant id (64-bit game handle) that privately owns this memory — an inner
  // monologue line is retrievable only by its own sim. Null = shared with everyone.
  owner_participant_id?: number | bigint | null;
};

// One model's embedding of a memory. Vectors from different models share no space, so
// each model keeps its own row and a provider switch never destroys earlier work.
export type MemoryEmbeddingEntity = {
  memory_id: string;
  embedding_model: string;
  embedding: Buffer;
};

// A memory row joined with its (possibly missing) retrieval metadata: importance from
// memory_index, plus the embedding for whichever model the caller asked for.
export type MemoryWithIndex = MemoryEntity & {
  importance?: number | null;
  embedding?: Buffer | null;
  embedding_model?: string | null;
  owner_participant_id?: string | number | bigint | null;
};
