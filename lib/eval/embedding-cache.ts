import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { QueryEmbedder } from "@/lib/retrieval/query-embedder";

/**
 * Wraps a query embedder with an on-disk cache keyed by model + text, so the three retrieval
 * modes and every rerun embed each question once. Call `save()` when done.
 */
export async function createCachedEmbedder(
  inner: QueryEmbedder,
  options: { file: string; model: string },
): Promise<QueryEmbedder & { save(): Promise<void>; stats: { hits: number; misses: number } }> {
  let cache: Record<string, number[]> = {};
  try {
    cache = z
      .record(z.string(), z.array(z.number()))
      .parse(JSON.parse(await readFile(options.file, "utf8")));
  } catch {
    // No cache yet (or unreadable): start empty.
  }
  const stats = { hits: 0, misses: 0 };
  const key = (text: string) =>
    createHash("sha256").update(`${options.model}\n${text}`).digest("hex");

  return {
    stats,
    async embedQuery(text) {
      const k = key(text);
      const hit = cache[k];
      if (hit) {
        stats.hits++;
        return hit;
      }
      stats.misses++;
      const embedding = await inner.embedQuery(text);
      cache[k] = embedding;
      return embedding;
    },
    async save() {
      await mkdir(path.dirname(options.file), { recursive: true });
      await writeFile(options.file, JSON.stringify(cache));
    },
  };
}
