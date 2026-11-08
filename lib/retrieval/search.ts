import "server-only";

import type { PrismaClient } from "@/generated/prisma/client";
import type { FrameworkId, RetrievalMode } from "@/lib/frameworks";
import { RETRIEVAL } from "@/lib/config";
import { hybridSearch } from "@/lib/retrieval/hybrid";
import { keywordSearch } from "@/lib/retrieval/keyword";
import type { QueryEmbedder } from "@/lib/retrieval/query-embedder";
import type { Reranker } from "@/lib/retrieval/rerank";
import type { SearchResponse } from "@/lib/retrieval/types";
import { vectorSearch } from "@/lib/retrieval/vector";

export interface SearchRequest {
  question: string;
  mode: RetrievalMode;
  frameworks?: readonly FrameworkId[];
  limit?: number;
  /** Hybrid only: keyword list weight in RRF (HYBRID_KEYWORD_WEIGHT). */
  keywordWeight?: number;
}

/**
 * Runs one retrieval mode. The question is embedded in every mode, keyword included: keyword
 * results still rank purely by ts_rank, but carry a cosine similarity so the "not found"
 * threshold compares the same kind of number whichever mode is active.
 */
export async function search(
  /** With a reranker, each mode fetches RETRIEVAL.candidates chunks and the reranker keeps the best. */
  deps: { db: PrismaClient; embedder: QueryEmbedder; reranker?: Reranker },
  request: SearchRequest,
): Promise<SearchResponse> {
  const question = request.question.trim();
  if (question === "") throw new Error("Search question is empty");

  const { db } = deps;
  const limit = request.limit ?? RETRIEVAL.topK;
  const options = {
    frameworks: request.frameworks,
    limit: deps.reranker ? Math.max(RETRIEVAL.candidates, limit) : limit,
    keywordWeight: request.keywordWeight,
  };
  const embedding = await deps.embedder.embedQuery(question);

  const candidates =
    request.mode === "vector"
      ? await vectorSearch(db, embedding, options)
      : request.mode === "keyword"
        ? await keywordSearch(db, question, { ...options, embedding })
        : await hybridSearch(db, question, embedding, options);

  const results = deps.reranker
    ? await deps.reranker.rerank(question, candidates, limit)
    : candidates;

  const topSimilarity = Math.max(0, ...results.map((r) => r.similarity ?? 0));
  return { mode: request.mode, results, topSimilarity };
}
