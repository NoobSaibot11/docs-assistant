/**
 * Tuning constants shared by ingestion and (later) retrieval. Model names and thresholds that
 * change per environment live in lib/env.ts; these are fixed per code version.
 */

export const CHUNKING = {
  /** Sections smaller than this are merged with the next one when they share a parent heading. */
  minTokens: 300,
  /** Hard ceiling for one chunk (except a single code block that can't be split further). */
  maxTokens: 500,
  /** Roughly this many tokens from the end of a chunk are repeated at the start of the next. */
  overlapTokens: 50,
} as const;

/**
 * Bump when cleaning or chunking output changes. It's part of every document's content hash,
 * so a bump makes the next `pnpm ingest` re-chunk and re-embed everything.
 */
export const CHUNKER_VERSION = 1;

export const EMBEDDING = {
  /** Must match vector(1024) in the schema and the HNSW index. */
  dimensions: 1024,
  /** Voyage allows 1,000 inputs and 320K tokens per request; stay well under both. */
  maxBatchInputs: 128,
  maxBatchTokens: 100_000,
} as const;

export const RETRIEVAL = {
  /** Chunks returned to the caller (and numbered [1]–[n] in the prompt). */
  topK: 5,
  /** Candidates each mode contributes to hybrid fusion. */
  candidates: 20,
  /** Reciprocal Rank Fusion constant: score = Σ 1 / (rrfK + rank). 60 is the usual default. */
  rrfK: 60,
  /**
   * HNSW candidate list size (pgvector default 40). With iterative scans on, filtered queries
   * keep scanning past it, so this mainly trades recall for speed on unfiltered queries.
   */
  efSearch: 100,
} as const;
