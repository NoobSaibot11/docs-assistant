import { describe, expect, it } from "vitest";

import { EMBEDDING } from "@/lib/config";
import { batchLimitsFor, batchTexts } from "@/lib/ingest/embed";
import { createRateLimiter } from "@/lib/ingest/rate-limit";
import { estimateTokens } from "@/lib/ingest/tokens";

/** A clock that only moves when the limiter sleeps, recording each wait. */
function fakeClock() {
  let time = 0;
  const waits: number[] = [];
  return {
    waits,
    get time() {
      return time;
    },
    clock: {
      now: () => time,
      sleep: async (ms: number) => {
        waits.push(ms);
        time += ms;
      },
    },
  };
}

describe("createRateLimiter", () => {
  it("lets requests through while under both limits", async () => {
    const c = fakeClock();
    const limiter = createRateLimiter({ rpm: 3, tpm: 10_000 }, { clock: c.clock });
    await limiter.acquire(1_000);
    await limiter.acquire(1_000);
    await limiter.acquire(1_000);
    expect(c.waits).toEqual([]);
  });

  it("waits for the window when the request limit is reached", async () => {
    const c = fakeClock();
    const limiter = createRateLimiter({ rpm: 3, tpm: 10_000 }, { clock: c.clock });
    for (let i = 0; i < 4; i++) await limiter.acquire(100);
    expect(c.waits).toEqual([60_000]);
    expect(c.time).toBe(60_000);
  });

  it("waits for the window when the token budget would be exceeded", async () => {
    const c = fakeClock();
    const limiter = createRateLimiter({ rpm: 100, tpm: 10_000 }, { clock: c.clock });
    await limiter.acquire(9_000);
    await limiter.acquire(2_000);
    expect(c.waits).toEqual([60_000]);
  });

  it("frees budget as old requests leave the 60s window", async () => {
    const c = fakeClock();
    const limiter = createRateLimiter({ rpm: 2, tpm: 100_000 }, { clock: c.clock });
    await limiter.acquire(1); // t=0
    await c.clock.sleep(30_000);
    await limiter.acquire(1); // t=30s
    await limiter.acquire(1); // must wait until t=60s, when the first one expires
    expect(c.time).toBe(60_000);
    await limiter.acquire(1); // must wait until t=90s
    expect(c.time).toBe(90_000);
  });

  it("keeps a long run at the configured average rate", async () => {
    const c = fakeClock();
    const limiter = createRateLimiter({ rpm: 3, tpm: 9_000 }, { clock: c.clock });
    for (let i = 0; i < 30; i++) await limiter.acquire(8_000); // one per minute fits the TPM
    expect(c.time).toBe(29 * 60_000);
  });

  it("rejects a single request larger than the whole budget", async () => {
    const limiter = createRateLimiter({ rpm: 3, tpm: 10_000 }, { clock: fakeClock().clock });
    await expect(limiter.acquire(10_001)).rejects.toThrow("can never fit");
  });
});

describe("batchLimitsFor", () => {
  it("uses the default batch limits without a rate limit", () => {
    expect(batchLimitsFor()).toEqual({
      maxInputs: EMBEDDING.maxBatchInputs,
      maxTokens: EMBEDDING.maxBatchTokens,
    });
  });

  it("keeps every batch under 90% of the per-minute token budget", () => {
    const limits = batchLimitsFor({ rpm: 3, tpm: 10_000 });
    expect(limits.maxTokens).toBe(9_000);

    const texts = Array.from({ length: 200 }, (_, i) => "word ".repeat(100 + i));
    const batches = batchTexts(texts, limits);
    for (const batch of batches) {
      expect(batch.reduce((sum, t) => sum + estimateTokens(t), 0)).toBeLessThanOrEqual(9_000);
    }
    expect(batches.flat()).toEqual(texts);
  });
});
