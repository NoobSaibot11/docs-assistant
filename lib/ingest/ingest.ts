import { createHash } from "node:crypto";

import type { PrismaClient } from "@/generated/prisma/client";
import { CHUNKER_VERSION, EMBEDDING } from "@/lib/config";
import { chunkDocument, documentTitle, type DocChunk } from "@/lib/ingest/chunker";
import { embeddingInput, type Embedder } from "@/lib/ingest/embed";
import { mapWithConcurrency, type DocFileProvider } from "@/lib/ingest/fetch-source";
import { cleanDocument } from "@/lib/ingest/mdx-clean";
import {
  deleteDocuments,
  listDocuments,
  replaceDocument,
  updateDocumentMetadata,
  type DocumentInput,
} from "@/lib/retrieval/chunk-store";
import type { SourceConfig } from "@/sources.config";

export interface IngestDeps {
  db: PrismaClient;
  provider: DocFileProvider;
  /** Required unless dryRun. */
  embedder?: Embedder;
  log?: (message: string) => void;
}

export interface IngestOptions {
  /** Fetch, clean and chunk, and report what would change, without embedding or writing. */
  dryRun?: boolean;
  /** Parallel file downloads. */
  concurrency?: number;
}

export interface IngestStats {
  framework: string;
  files: number;
  unchanged: number;
  /** New or changed documents that were (or, in a dry run, would be) embedded. */
  embedded: number;
  /** Documents that produced no chunks (e.g. index pages that are only links). */
  empty: number;
  /** Documents removed because the file no longer exists upstream. */
  deleted: number;
  /** Chunks across embedded documents. */
  chunks: number;
  estimatedTokens: number;
  /** Tokens Voyage billed (0 in a dry run). */
  billedTokens: number;
  /** .md files that weren't valid MDX and were parsed as plain Markdown. */
  mdFallbacks: number;
  jsx: Record<string, number>;
  docsCodeRefs: number;
}

interface PreparedDoc {
  input: DocumentInput;
  chunks: DocChunk[];
}

/** Hash of the raw file plus the chunker version: a chunker change re-embeds everything. */
export function contentHash(raw: string): string {
  return createHash("sha256").update(`chunker:${CHUNKER_VERSION}\n${raw}`).digest("hex");
}

/** Cleans and chunks one file. Pure: no I/O. */
export function prepareDocument(source: SourceConfig, sourcePath: string, raw: string) {
  const cleaned = cleanDocument(raw, { syntax: source.syntax });
  const fallbackTitle = (sourcePath.split("/").pop() ?? sourcePath).replace(/\.mdx?$/, "");
  const title = documentTitle(cleaned, fallbackTitle);
  const url = source.toUrl({ path: sourcePath, frontmatter: cleaned.frontmatter });
  const chunks = chunkDocument(cleaned, title);
  return { title, url, chunks, stats: cleaned.stats };
}

export async function ingestSource(
  source: SourceConfig,
  deps: IngestDeps,
  options: IngestOptions = {},
): Promise<IngestStats> {
  const log = deps.log ?? (() => {});
  if (!options.dryRun && !deps.embedder) throw new Error("An embedder is required unless dryRun");

  const stats: IngestStats = {
    framework: source.framework,
    files: 0,
    unchanged: 0,
    embedded: 0,
    empty: 0,
    deleted: 0,
    chunks: 0,
    estimatedTokens: 0,
    billedTokens: 0,
    mdFallbacks: 0,
    jsx: {},
    docsCodeRefs: 0,
  };

  const files = await deps.provider.listFiles(source);
  stats.files = files.length;
  log(`${source.name}: ${files.length} files at ${source.repo}@${source.ref}`);

  const existing = new Map(
    (await listDocuments(deps.db, source.framework)).map((d) => [d.sourcePath, d]),
  );
  const raws = await mapWithConcurrency(files, options.concurrency ?? 8, (file) =>
    deps.provider.readFile(source, file),
  );

  const pending: PreparedDoc[] = [];
  for (const [i, sourcePath] of files.entries()) {
    const raw = raws[i] ?? "";
    let prepared: ReturnType<typeof prepareDocument>;
    try {
      prepared = prepareDocument(source, sourcePath, raw);
    } catch (error) {
      throw new Error(`Failed to process ${source.framework}/${sourcePath}`, { cause: error });
    }

    if (prepared.stats.parsedAs !== source.syntax) stats.mdFallbacks++;
    stats.docsCodeRefs += prepared.stats.docsCodeRefs;
    for (const [name, count] of Object.entries(prepared.stats.jsx)) {
      stats.jsx[name] = (stats.jsx[name] ?? 0) + count;
    }

    const input: DocumentInput = {
      framework: source.framework,
      sourcePath,
      title: prepared.title,
      url: prepared.url,
      docsVersion: source.docsVersion,
      contentHash: contentHash(raw),
    };

    const stored = existing.get(sourcePath);
    if (stored?.contentHash === input.contentHash) {
      stats.unchanged++;
      const metadataChanged =
        stored.title !== input.title ||
        stored.url !== input.url ||
        stored.docsVersion !== input.docsVersion;
      if (metadataChanged && !options.dryRun) {
        await updateDocumentMetadata(deps.db, stored.id, input);
      }
      continue;
    }

    if (prepared.chunks.length === 0) stats.empty++;
    stats.embedded++;
    stats.chunks += prepared.chunks.length;
    stats.estimatedTokens += prepared.chunks.reduce((sum, c) => sum + c.tokenCount, 0);
    pending.push({ input, chunks: prepared.chunks });
  }

  if (!options.dryRun && deps.embedder) {
    let done = 0;
    for (const group of groupByChunkCount(pending, EMBEDDING.maxBatchInputs)) {
      const texts = group.flatMap((doc) => doc.chunks.map(embeddingInput));
      const { embeddings, totalTokens } =
        texts.length > 0
          ? await deps.embedder.embedDocuments(texts)
          : { embeddings: [], totalTokens: 0 };
      stats.billedTokens += totalTokens;

      let offset = 0;
      for (const doc of group) {
        const chunks = doc.chunks.map((chunk, i) => {
          const embedding = embeddings[offset + i];
          if (!embedding) throw new Error(`Missing embedding for ${doc.input.sourcePath}#${i}`);
          return { ...chunk, embedding };
        });
        offset += doc.chunks.length;
        await replaceDocument(deps.db, doc.input, chunks);
      }
      done += group.length;
      log(`${source.name}: embedded ${done}/${pending.length} changed documents`);
    }
  }

  const current = new Set(files);
  const stale = [...existing.values()].filter((doc) => !current.has(doc.sourcePath));
  stats.deleted = stale.length;
  if (!options.dryRun)
    await deleteDocuments(
      deps.db,
      stale.map((doc) => doc.id),
    );

  return stats;
}

/** Groups documents so each group has about `target` chunks (one embedding call each). */
function groupByChunkCount(docs: PreparedDoc[], target: number): PreparedDoc[][] {
  const groups: PreparedDoc[][] = [];
  let current: PreparedDoc[] = [];
  let count = 0;
  for (const doc of docs) {
    if (current.length > 0 && count + doc.chunks.length > target) {
      groups.push(current);
      current = [];
      count = 0;
    }
    current.push(doc);
    count += doc.chunks.length;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}
