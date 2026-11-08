import type { FrameworkId, RetrievalMode } from "@/lib/frameworks";

/** One retrieved chunk with everything a citation needs. */
export interface SearchResult {
  chunkId: string;
  documentId: string;
  framework: FrameworkId;
  /** Path inside the framework's docs repo (the eval compares it to expectedSourcePaths). */
  sourcePath: string;
  title: string;
  /** Public docs URL, with the chunk's anchor when it has one. */
  url: string;
  headingPath: string;
  anchor: string | null;
  content: string;
  /** 1-based position in this result list. */
  rank: number;
  /** The mode's own score: cosine similarity, ts_rank_cd, or the RRF sum. Not comparable across modes. */
  score: number;
  /**
   * Cosine similarity between the question and this chunk (−1…1, higher is closer). Present in
   * every mode when the question was embedded, so the "not found" threshold means the same thing
   * whichever mode ranked the results.
   */
  similarity: number | null;
}

export interface SearchOptions {
  /** Restrict to these frameworks; empty or omitted means all. */
  frameworks?: readonly FrameworkId[];
  /** Maximum results (defaults to RETRIEVAL.topK). */
  limit?: number;
  /** Hybrid only: weight of the keyword list in RRF (vector is 1). Defaults to 1. */
  keywordWeight?: number;
}

export interface SearchResponse {
  mode: RetrievalMode;
  results: SearchResult[];
  /** Best cosine similarity among the results (0 when nothing matched). */
  topSimilarity: number;
}
