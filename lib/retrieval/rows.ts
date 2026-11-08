import { Prisma } from "@/generated/prisma/client";
import type { FrameworkId } from "@/lib/frameworks";
import type { SearchResult } from "@/lib/retrieval/types";

/** Columns every search query selects, from "Chunk" c joined to "Document" d. */
export const RESULT_COLUMNS = Prisma.sql`
  c.id AS "chunkId", c."documentId", c.framework, d."sourcePath", d.title, d.url,
  c."headingPath", c.anchor, c.content`;

export interface ResultRow {
  chunkId: string;
  documentId: string;
  framework: string;
  sourcePath: string;
  title: string;
  url: string;
  headingPath: string;
  anchor: string | null;
  content: string;
  score: number;
  similarity: number | null;
}

/** `AND c.framework = ANY(...)`, or nothing when no filter is set. */
export function frameworkFilter(frameworks: readonly FrameworkId[] | undefined): Prisma.Sql {
  return frameworks && frameworks.length > 0
    ? Prisma.sql`AND c.framework = ANY(${[...frameworks]}::text[])`
    : Prisma.empty;
}

export function toSearchResults(rows: ResultRow[]): SearchResult[] {
  return rows.map((row, i) => ({
    chunkId: row.chunkId,
    documentId: row.documentId,
    framework: row.framework as FrameworkId,
    sourcePath: row.sourcePath,
    title: row.title,
    url: row.anchor ? `${row.url}#${row.anchor}` : row.url,
    headingPath: row.headingPath,
    anchor: row.anchor,
    content: row.content,
    rank: i + 1,
    // float8 columns arrive as numbers; Number() also guards against a driver returning strings.
    score: Number(row.score),
    similarity: row.similarity === null ? null : Number(row.similarity),
  }));
}
