import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { FrameworkId } from "@/lib/frameworks";
import { EMBEDDING } from "@/lib/config";

/**
 * Writes for ingestion. Lives in lib/retrieval/ because it holds raw SQL (Prisma has no vector
 * type); every query uses tagged templates, so values are always sent as parameters.
 */

export interface DocumentInput {
  framework: FrameworkId;
  sourcePath: string;
  title: string;
  url: string;
  docsVersion: string;
  contentHash: string;
}

export interface ChunkInput {
  ordinal: number;
  headingPath: string;
  anchor: string | null;
  content: string;
  tokenCount: number;
  embedding: number[];
}

export interface StoredDocument {
  id: string;
  sourcePath: string;
  contentHash: string;
  title: string;
  url: string;
  docsVersion: string;
}

export function listDocuments(db: PrismaClient, framework: FrameworkId): Promise<StoredDocument[]> {
  return db.document.findMany({
    where: { framework },
    select: {
      id: true,
      sourcePath: true,
      contentHash: true,
      title: true,
      url: true,
      docsVersion: true,
    },
  });
}

/** pgvector's text format: "[0.1,0.2,...]". */
export function toVectorLiteral(embedding: number[]): string {
  if (embedding.length !== EMBEDDING.dimensions) {
    throw new Error(`Expected ${EMBEDDING.dimensions} dimensions, got ${embedding.length}`);
  }
  if (!embedding.every(Number.isFinite)) throw new Error("Embedding contains a non-finite value");
  return `[${embedding.join(",")}]`;
}

/** Upserts a document and replaces all of its chunks (with embeddings) in one transaction. */
export async function replaceDocument(
  db: PrismaClient,
  doc: DocumentInput,
  chunks: ChunkInput[],
): Promise<void> {
  const vectors = chunks.map((chunk) => toVectorLiteral(chunk.embedding));

  await db.$transaction(
    async (tx) => {
      const { id } = await tx.document.upsert({
        where: { framework_sourcePath: { framework: doc.framework, sourcePath: doc.sourcePath } },
        create: doc,
        update: doc,
        select: { id: true },
      });
      await tx.chunk.deleteMany({ where: { documentId: id } });
      if (chunks.length === 0) return;

      await tx.chunk.createMany({
        data: chunks.map((chunk) => ({
          documentId: id,
          framework: doc.framework,
          ordinal: chunk.ordinal,
          headingPath: chunk.headingPath,
          anchor: chunk.anchor,
          content: chunk.content,
          tokenCount: chunk.tokenCount,
        })),
      });

      // createMany can't write the Unsupported vector column; set all embeddings in one UPDATE.
      const rows = chunks.map(
        (chunk, i) => Prisma.sql`(${chunk.ordinal}::int, ${vectors[i]}::vector)`,
      );
      await tx.$executeRaw`
        UPDATE "Chunk" AS c
        SET embedding = v.embedding
        FROM (VALUES ${Prisma.join(rows)}) AS v(ordinal, embedding)
        WHERE c."documentId" = ${id} AND c.ordinal = v.ordinal`;
    },
    { timeout: 60_000 },
  );
}

/** Updates metadata (URL, version, title) without touching chunks or embeddings. */
export async function updateDocumentMetadata(
  db: PrismaClient,
  id: string,
  data: Pick<DocumentInput, "title" | "url" | "docsVersion">,
): Promise<void> {
  await db.document.update({ where: { id }, data });
}

export async function deleteDocuments(db: PrismaClient, ids: string[]): Promise<void> {
  if (ids.length > 0) await db.document.deleteMany({ where: { id: { in: ids } } });
}
