import "dotenv/config";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type * as RouteModuleType from "@/app/api/feedback/route";
import type { PrismaClient } from "@/generated/prisma/client";
import { createDbClient } from "@/lib/db";
import { testDatabaseUrl } from "@/tests/helpers/test-db";

type RouteModule = typeof RouteModuleType;

describe("POST /api/feedback (real Postgres)", () => {
  let db: PrismaClient;
  let route: RouteModule;
  const savedEnv = { ...process.env };
  const queryId = "4b0a8a2e-6f0e-4c1e-9a55-2f0f7c1c9a01";

  const post = (body: unknown) =>
    route.POST(
      new Request("http://localhost/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  beforeAll(async () => {
    const url = testDatabaseUrl();
    db = createDbClient(url);
    vi.resetModules();
    process.env["DATABASE_URL"] = url;
    route = await import("@/app/api/feedback/route");
  });

  beforeEach(async () => {
    await db.queryLog.deleteMany();
    await db.queryLog.create({
      data: {
        id: queryId,
        question: "Q?",
        retrievalMode: "vector",
        frameworks: [],
        topChunkIds: [],
        topScore: 0.6,
        answered: true,
        outcome: "answered",
        totalMs: 1000,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
      },
    });
  });

  afterAll(async () => {
    process.env = savedEnv;
    await db.$disconnect();
  });

  it("stores a rating and lets the user change it", async () => {
    expect((await post({ queryId, rating: "up" })).status).toBe(200);
    expect(await db.feedback.findUnique({ where: { queryLogId: queryId } })).toMatchObject({
      rating: 1,
    });

    expect((await post({ queryId, rating: "down" })).status).toBe(200);
    expect(await db.feedback.count()).toBe(1);
    expect(await db.feedback.findUnique({ where: { queryLogId: queryId } })).toMatchObject({
      rating: -1,
    });
  });

  it("rejects unknown answers and invalid input", async () => {
    expect(
      (await post({ queryId: "9f1c2d3e-0000-4000-8000-000000000000", rating: "up" })).status,
    ).toBe(404);
    expect((await post({ queryId, rating: "meh" })).status).toBe(400);
    expect((await post({ queryId: "not-a-uuid", rating: "up" })).status).toBe(400);
    expect(await db.feedback.count()).toBe(0);
  });

  it("is deleted with its query", async () => {
    await post({ queryId, rating: "up" });
    await db.queryLog.delete({ where: { id: queryId } });
    expect(await db.feedback.count()).toBe(0);
  });
});
