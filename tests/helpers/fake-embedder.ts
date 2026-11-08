import { createHash } from "node:crypto";

import { EMBEDDING } from "@/lib/config";
import type { Embedder } from "@/lib/ingest/embed";
import type { QueryEmbedder } from "@/lib/retrieval/query-embedder";

const STOPWORDS = new Set(
  "a an and are as at be by can do does for from how i in is it of on or the this to use what when with you your".split(
    " ",
  ),
);

/**
 * Hashed bag-of-words: each word adds ±1 to one of the 1024 dimensions, then the vector is
 * normalized. Texts that share words get a high cosine similarity, so vector search returns
 * meaningful results in tests without calling Voyage. Deterministic across runs.
 */
export function fakeEmbedding(text: string): number[] {
  const vector = new Array<number>(EMBEDDING.dimensions).fill(0);
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const word of words) {
    if (STOPWORDS.has(word)) continue;
    const hash = createHash("sha256").update(word).digest();
    const index = hash.readUInt16BE(0) % EMBEDDING.dimensions;
    vector[index] = (vector[index] ?? 0) + ((hash[2] ?? 0) & 1 ? 1 : -1);
  }
  const norm = Math.hypot(...vector);
  if (norm === 0) {
    vector[0] = 1; // a valid unit vector for texts with no content words
    return vector;
  }
  return vector.map((v) => v / norm);
}

/** Implements both the ingest and the query embedder, recording every call. */
export function createFakeEmbedder() {
  const documentCalls: string[][] = [];
  const queryCalls: string[] = [];
  const embedder: Embedder & QueryEmbedder = {
    async embedDocuments(texts) {
      documentCalls.push(texts);
      return { embeddings: texts.map(fakeEmbedding), totalTokens: texts.join("").length };
    },
    async embedQuery(text) {
      queryCalls.push(text);
      return fakeEmbedding(text);
    },
  };
  return { embedder, calls: documentCalls, queryCalls };
}
