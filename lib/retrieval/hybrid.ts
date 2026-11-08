import "server-only";

import type { PrismaClient } from "@/generated/prisma/client";
import { RETRIEVAL } from "@/lib/config";
import { keywordSearch } from "@/lib/retrieval/keyword";
import { reciprocalRankFusion } from "@/lib/retrieval/rrf";
import type { SearchOptions, SearchResult } from "@/lib/retrieval/types";
import { vectorSearch } from "@/lib/retrieval/vector";

/**
 * Vector and keyword search fused with Reciprocal Rank Fusion. Each mode contributes its top
 * RETRIEVAL.candidates chunks; the fused list is cut to `limit`. `score` is the RRF sum and
 * `similarity` is the chunk's cosine similarity (keyword-only hits get it computed in SQL).
 */
export async function hybridSearch(
  db: PrismaClient,
  question: string,
  embedding: number[],
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const limit = options.limit ?? RETRIEVAL.topK;
  const candidates = {
    frameworks: options.frameworks,
    limit: Math.max(RETRIEVAL.candidates, limit),
  };

  const [vector, keyword] = await Promise.all([
    vectorSearch(db, embedding, candidates),
    keywordSearch(db, question, { ...candidates, embedding }),
  ]);

  return reciprocalRankFusion([vector, keyword], (r) => r.chunkId, RETRIEVAL.rrfK)
    .slice(0, limit)
    .map(({ item, score }, i) => ({ ...item, rank: i + 1, score }));
}
