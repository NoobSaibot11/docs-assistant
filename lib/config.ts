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

export const CHAT = {
  /** Earlier turns (user + assistant messages) sent with a question; older ones are dropped. */
  historyMessages: 6,
  maxQuestionChars: 2_000,
  /** Long assistant turns in history are cut to this many characters before the rewrite call. */
  maxHistoryMessageChars: 4_000,
  /** Answer budget, including adaptive thinking. Generous so answers aren't cut off mid-code. */
  answerMaxTokens: 8_192,
  rewriteMaxTokens: 1_024,
} as const;

/**
 * Claude prices in USD per million tokens, for the eval's cost column (checked 2026-10-06 in
 * Anthropic's model table; update when prices change). Unknown models count as $0, with a warning.
 */
export const MODEL_PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

export const EVAL = {
  /** Default question file. */
  questionsFile: "eval/questions.json",
  resultsDir: "eval/results",
  /** Query embeddings are cached here so reruns and the three modes embed each question once. */
  embeddingCacheFile: ".cache/eval/embeddings.json",
  /** Questions run in parallel per mode. */
  concurrency: 3,
  /** Targets from the spec, shown by `pnpm eval:check`. */
  answerablePerFramework: 15,
  unanswerable: 10,
} as const;
