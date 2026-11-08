import "server-only";

import { VoyageAIClient } from "voyageai";

import { EMBEDDING } from "@/lib/config";
import { createRateLimiter, type RateLimit } from "@/lib/ingest/rate-limit";
import { estimateTokens } from "@/lib/ingest/tokens";

/** Embeds a search question. An interface so tests can use a deterministic fake. */
export interface QueryEmbedder {
  embedQuery(text: string): Promise<number[]>;
}

/**
 * Voyage with input type "query": Voyage prepends a retrieval prompt for queries that differs
 * from the one used for documents, and the two kinds of vectors are meant to be compared.
 */
export function createVoyageQueryEmbedder(options: {
  apiKey: string;
  model: string;
  /** Client-side throttle for batch use (the eval) on Voyage's no-payment-method tier. */
  rateLimit?: RateLimit;
  log?: (message: string) => void;
}): QueryEmbedder {
  const client = new VoyageAIClient({ apiKey: options.apiKey });
  const limiter = options.rateLimit
    ? createRateLimiter(options.rateLimit, {
        onWait: (ms) => options.log?.(`Voyage rate limit: waiting ${Math.ceil(ms / 1000)}s`),
      })
    : undefined;
  return {
    async embedQuery(text) {
      await limiter?.acquire(estimateTokens(text));
      const response = await client.embed(
        {
          input: [text],
          model: options.model,
          inputType: "query",
          outputDimension: EMBEDDING.dimensions,
        },
        { maxRetries: 3, timeoutInSeconds: 30 },
      );
      const embedding = response.data?.[0]?.embedding;
      if (embedding?.length !== EMBEDDING.dimensions) {
        throw new Error(`Voyage returned a query embedding of length ${embedding?.length}`);
      }
      return embedding;
    },
  };
}
