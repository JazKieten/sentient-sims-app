import { MemoryEntity } from './MemoryEntity';

export type MemoryIndexEntity = {
  memory_id: number;
  importance?: number | null;
  embedding?: Buffer | null;
  embedding_model?: string | null;
  // Participant id (64-bit game handle) that privately owns this memory — an inner
  // monologue line is retrievable only by its own sim. Null = shared with everyone.
  owner_participant_id?: number | bigint | null;
};

// A memory row joined with its (possibly missing) retrieval metadata.
export type MemoryWithIndex = MemoryEntity & {
  importance?: number | null;
  embedding?: Buffer | null;
  embedding_model?: string | null;
  owner_participant_id?: number | bigint | null;
};
