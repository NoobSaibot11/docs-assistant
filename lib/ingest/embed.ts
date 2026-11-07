import "server-only";

import { VoyageAIClient } from "voyageai";

import { EMBEDDING } from "@/lib/config";
import { createRateLimiter, type RateLimit } from "@/lib/ingest/rate-limit";
import { estimateTokens } from "@/lib/ingest/tokens";

export interface EmbedResult {
  embeddings: number[][];
  /** Tokens billed by Voyage. */
  totalTokens: number;
}

/** Embeds document chunks. An interface so tests can use a deterministic fake. */
export interface Embedder {
  embedDocuments(texts: string[]): Promise<EmbedResult>;
}

/**
 * Text sent to the embedding model for a chunk: the title and heading path give the chunk its
 * context ("Caching > Revalidating" means something a bare paragraph doesn't).
 */
export function embeddingInput(chunk: { headingPath: string; content: string }): string {
  return `${chunk.headingPath}\n\n${chunk.content}`;
}

/** Splits inputs into batches under Voyage's per-request limits (with headroom). */
export function batchTexts(
  texts: string[],
  limits: { maxInputs: number; maxTokens: number } = {
    maxInputs: EMBEDDING.maxBatchInputs,
    maxTokens: EMBEDDING.maxBatchTokens,
  },
): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let tokens = 0;
  for (const text of texts) {
    const size = estimateTokens(text);
    if (
      current.length > 0 &&
      (current.length >= limits.maxInputs || tokens + size > limits.maxTokens)
    ) {
      batches.push(current);
      current = [];
      tokens = 0;
    }
    current.push(text);
    tokens += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Share of a TPM budget we plan to use: token counts are estimates, so leave headroom. */
const TPM_HEADROOM = 0.9;

/** Batch limits for a given rate limit: each request must fit the per-minute token budget. */
export function batchLimitsFor(rateLimit?: RateLimit): { maxInputs: number; maxTokens: number } {
  const maxTokens = rateLimit
    ? Math.min(EMBEDDING.maxBatchTokens, Math.floor(rateLimit.tpm * TPM_HEADROOM))
    : EMBEDDING.maxBatchTokens;
  return { maxInputs: EMBEDDING.maxBatchInputs, maxTokens };
}

export function createVoyageEmbedder(options: {
  apiKey: string;
  model: string;
  /** Client-side throttle, e.g. { rpm: 3, tpm: 10_000 } on Voyage's no-payment-method tier. */
  rateLimit?: RateLimit;
  log?: (message: string) => void;
}): Embedder {
  // The SDK retries 408/429/5xx with exponential backoff.
  const client = new VoyageAIClient({ apiKey: options.apiKey });
  const limits = batchLimitsFor(options.rateLimit);
  const limiter = options.rateLimit
    ? createRateLimiter(
        { rpm: options.rateLimit.rpm, tpm: Math.floor(options.rateLimit.tpm * TPM_HEADROOM) },
        { onWait: (ms) => options.log?.(`Voyage rate limit: waiting ${Math.ceil(ms / 1000)}s`) },
      )
    : undefined;

  return {
    async embedDocuments(texts) {
      const embeddings: number[][] = [];
      let totalTokens = 0;
      for (const batch of batchTexts(texts, limits)) {
        await limiter?.acquire(batch.reduce((sum, text) => sum + estimateTokens(text), 0));
        const response = await client.embed(
          {
            input: batch,
            model: options.model,
            inputType: "document",
            outputDimension: EMBEDDING.dimensions,
          },
          { maxRetries: 5, timeoutInSeconds: 120 },
        );
        const data = [...(response.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        if (data.length !== batch.length) {
          throw new Error(`Voyage returned ${data.length} embeddings for ${batch.length} inputs`);
        }
        for (const item of data) {
          if (item.embedding?.length !== EMBEDDING.dimensions) {
            throw new Error(`Voyage returned an embedding of length ${item.embedding?.length}`);
          }
          embeddings.push(item.embedding);
        }
        totalTokens += response.usage?.totalTokens ?? 0;
      }
      return { embeddings, totalTokens };
    },
  };
}
