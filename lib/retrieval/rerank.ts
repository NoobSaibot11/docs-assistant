import "server-only";

import { VoyageAIClient } from "voyageai";

import { embeddingInput } from "@/lib/ingest/embed";
import type { SearchResult } from "@/lib/retrieval/types";

/** Reorders retrieved chunks by relevance to the question and keeps the best `topK`. */
export interface Reranker {
  rerank(question: string, results: readonly SearchResult[], topK: number): Promise<SearchResult[]>;
}

/**
 * Applies a reranker's ordering: results come back as `order` lists them (indexes into
 * `results`), re-ranked 1..n, with the reranker's relevance as `score`. Cosine `similarity` is
 * kept, so the "not found" threshold means the same thing with or without reranking.
 */
export function applyRerank(
  results: readonly SearchResult[],
  order: readonly { index: number; relevance: number }[],
  topK: number,
): SearchResult[] {
  return order
    .filter(({ index }) => index >= 0 && index < results.length)
    .slice(0, topK)
    .map(({ index, relevance }, i) => ({ ...results[index]!, rank: i + 1, score: relevance }));
}

/** Voyage's reranker (a cross-encoder): reads the question and each chunk together. */
export function createVoyageReranker(options: { apiKey: string; model: string }): Reranker {
  const client = new VoyageAIClient({ apiKey: options.apiKey });
  return {
    async rerank(question, results, topK) {
      if (results.length === 0) return [];
      const response = await client.rerank(
        {
          query: question,
          documents: results.map(embeddingInput),
          model: options.model,
          topK,
          truncation: true,
        },
        { maxRetries: 3, timeoutInSeconds: 30 },
      );
      const order = (response.data ?? []).map((item) => ({
        index: item.index ?? -1,
        relevance: item.relevanceScore ?? 0,
      }));
      return applyRerank(results, order, topK);
    },
  };
}
