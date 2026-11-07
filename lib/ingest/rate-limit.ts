/**
 * Client-side limiter for a per-minute request (RPM) and token (TPM) budget, using a sliding
 * 60-second window. Used to stay under Voyage's limits (3 RPM / 10K TPM for accounts without a
 * payment method) instead of hammering the API into 429s.
 */

export interface RateLimit {
  rpm: number;
  tpm: number;
}

export interface RateLimiter {
  /** Waits until a request costing `tokens` fits in the window, then records it. */
  acquire(tokens: number): Promise<void>;
}

interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const WINDOW_MS = 60_000;

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function createRateLimiter(
  limit: RateLimit,
  options: { clock?: Clock; onWait?: (ms: number) => void } = {},
): RateLimiter {
  const clock = options.clock ?? realClock;
  const log: { at: number; tokens: number }[] = [];

  return {
    async acquire(tokens) {
      if (tokens > limit.tpm) {
        throw new Error(`A request of ~${tokens} tokens can never fit a ${limit.tpm} TPM limit`);
      }
      for (;;) {
        const now = clock.now();
        while (log.length > 0 && (log[0]?.at ?? 0) <= now - WINDOW_MS) log.shift();
        const used = log.reduce((sum, entry) => sum + entry.tokens, 0);
        if (log.length < limit.rpm && used + tokens <= limit.tpm) {
          log.push({ at: now, tokens });
          return;
        }
        // Wait until the oldest request leaves the window, then re-check.
        const wait = Math.max(1, (log[0]?.at ?? now) + WINDOW_MS - now);
        options.onWait?.(wait);
        await clock.sleep(wait);
      }
    },
  };
}
