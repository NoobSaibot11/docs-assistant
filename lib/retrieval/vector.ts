import "server-only";

import type { PrismaClient } from "@/generated/prisma/client";
import { RETRIEVAL } from "@/lib/config";
import { toVectorLiteral } from "@/lib/retrieval/chunk-store";
import {
  frameworkFilter,
  RESULT_COLUMNS,
  toSearchResults,
  type ResultRow,
} from "@/lib/retrieval/rows";
import type { SearchOptions, SearchResult } from "@/lib/retrieval/types";

/**
 * Nearest chunks by cosine distance (the HNSW index uses vector_cosine_ops).
 *
 * pgvector filters *after* the index scan, and a scan returns at most hnsw.ef_search rows, so a
 * framework filter could leave too few results. Iterative scans (pgvector 0.8+) keep scanning
 * until the LIMIT is met. "relaxed_order" can return rows slightly out of order, so the outer
 * query re-sorts the materialized candidates by exact distance. Both settings are transaction-
 * local (set_config(..., true)), so they never leak to other queries on the pooled connection.
 */
export async function vectorSearch(
  db: PrismaClient,
  embedding: number[],
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const vector = toVectorLiteral(embedding);
  const limit = options.limit ?? RETRIEVAL.topK;

  // A batch (not interactive) transaction: the three statements run in order on one connection
  // inside one transaction, without the interactive API's 2 s start timeout, which concurrent
  // requests on a cold pool can exceed.
  const [, , rows] = await db.$transaction([
    db.$queryRaw`SELECT set_config('hnsw.ef_search', ${String(RETRIEVAL.efSearch)}, true)`,
    db.$queryRaw`SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true)`,
    db.$queryRaw<ResultRow[]>`
      WITH nearest AS MATERIALIZED (
        SELECT c.id, c.embedding <=> ${vector}::vector AS distance
        FROM "Chunk" c
        WHERE c.embedding IS NOT NULL ${frameworkFilter(options.frameworks)}
        ORDER BY c.embedding <=> ${vector}::vector
        LIMIT ${limit}
      )
      SELECT ${RESULT_COLUMNS},
             (1 - n.distance)::float8 AS score,
             (1 - n.distance)::float8 AS similarity
      FROM nearest n
      JOIN "Chunk" c ON c.id = n.id
      JOIN "Document" d ON d.id = c."documentId"
      ORDER BY n.distance, c.id`,
  ]);

  return toSearchResults(rows);
}
