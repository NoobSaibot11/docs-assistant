import { describe, expect, it } from "vitest";

import { clientIp, hashClient } from "@/lib/chat/rate-limit";
import { summarizeLogs, type StatsRow } from "@/lib/stats";

describe("rate-limit helpers", () => {
  it("takes the first x-forwarded-for address, then x-real-ip", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe(
      "203.0.113.7",
    );
    expect(clientIp(new Headers({ "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
    expect(clientIp(new Headers())).toBe("unknown");
  });

  it("hashes IPs with a salt, never returning the IP", () => {
    const a = hashClient("203.0.113.7", "salt-1");
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toContain("203");
    expect(hashClient("203.0.113.7", "salt-1")).toBe(a);
    expect(hashClient("203.0.113.7", "salt-2")).not.toBe(a);
  });
});

describe("summarizeLogs", () => {
  const now = new Date("2026-11-08T12:00:00Z");
  const row = (overrides: Partial<StatsRow>): StatsRow => ({
    createdAt: now,
    outcome: "answered",
    ttftMs: 2000,
    totalMs: 5000,
    inputTokens: 2500,
    outputTokens: 500,
    cacheReadTokens: 0,
    rewriteInputTokens: 600,
    rewriteOutputTokens: 50,
    rating: null,
    ...overrides,
  });
  const models = { answer: "claude-sonnet-5-5", rewrite: "claude-haiku-5-5" };

  it("aggregates outcomes, latency, cost, feedback and questions per day", () => {
    const stats = summarizeLogs(
      [
        row({ rating: 1 }),
        row({ ttftMs: 4000, rating: -1 }),
        row({ outcome: "not_found", ttftMs: 1000, totalMs: 1500, inputTokens: 0, outputTokens: 0 }),
        row({ outcome: "aborted", ttftMs: null, createdAt: new Date("2026-11-07T08:00:00Z") }),
        row({ outcome: "error", ttftMs: null, rating: 1 }),
      ],
      { days: 3, models, now },
    );
    expect(stats.questions).toBe(5);
    expect(stats.outcomes).toEqual({ answered: 2, not_found: 1, aborted: 1, error: 1 });
    expect(stats.notFoundRate).toBeCloseTo(1 / 3);
    expect(stats.ttftP50Ms).toBe(2000);
    expect(stats.ttftP95Ms).toBe(4000);
    expect(stats.totalP50Ms).toBe(5000);
    expect(stats.feedback).toEqual({ up: 2, down: 1 });
    expect(stats.perDay).toEqual([
      { date: "2026-11-06", questions: 0 },
      { date: "2026-11-07", questions: 1 },
      { date: "2026-11-08", questions: 4 },
    ]);
    // Answered row: Sonnet 2500×$2 + 500×$10, Haiku 600×$0.10 + 50×$0.50, per million tokens.
    expect(stats.avgCostUsd).toBeGreaterThan(0);
    expect(stats.totalCostUsd).toBeCloseTo(4 * 0.010085 + 0.000085, 5);
  });

  it("handles no data", () => {
    const stats = summarizeLogs([], { days: 2, models, now });
    expect(stats).toMatchObject({
      questions: 0,
      notFoundRate: null,
      ttftP50Ms: null,
      avgCostUsd: null,
    });
    expect(stats.perDay).toHaveLength(2);
  });
});
