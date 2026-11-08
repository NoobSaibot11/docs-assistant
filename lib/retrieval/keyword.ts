import "server-only";

import { Prisma, type PrismaClient } from "@/generated/prisma/client";
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
 * Full-text search over the generated `tsv` column, ranked with ts_rank.
 *
 * plainto_tsquery ANDs every word, so a natural-language question ("how do I revalidate data
 * every 60 seconds") would match almost nothing. Its output is rewritten to OR the same lexemes
 * (`'revalid' & 'data'` → `'revalid' | 'data'`); ts_rank then favours chunks matching more and
 * rarer terms. Phrase operators (`<->`, from hyphenated words) are kept as they are. The
 * question is always a bound parameter; the rewrite happens inside Postgres.
 *
 * Normalization 1 divides the rank by 1 + log(document length), so long chunks don't win just
 * by repeating common words.
 *
 * With `embedding`, each result also gets its cosine similarity to the question (ranking is
 * still purely by keywords).
 */
export async function keywordSearch(
  db: PrismaClient,
  question: string,
  options: SearchOptions & { embedding?: number[] } = {},
): Promise<SearchResult[]> {
  if (question.trim() === "") return [];
  const limit = options.limit ?? RETRIEVAL.topK;
  const similarity = options.embedding
    ? Prisma.sql`(1 - (c.embedding <=> ${toVectorLiteral(options.embedding)}::vector))::float8`
    : Prisma.sql`NULL::float8`;

  const rows = await db.$queryRaw<ResultRow[]>`
    WITH q AS (
      SELECT replace(plainto_tsquery('english', ${question})::text, ' & ', ' | ')::tsquery AS query
    )
    SELECT ${RESULT_COLUMNS},
           ts_rank(c.tsv, q.query, 1)::float8 AS score,
           ${similarity} AS similarity
    FROM q, "Chunk" c
    JOIN "Document" d ON d.id = c."documentId"
    WHERE c.tsv @@ q.query ${frameworkFilter(options.frameworks)}
    ORDER BY score DESC, c.id
    LIMIT ${limit}`;

  return toSearchResults(rows);
}
