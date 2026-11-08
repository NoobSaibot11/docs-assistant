import "dotenv/config";

import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type * as RouteModuleType from "@/app/api/chat/route";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ChatEvent } from "@/lib/chat/protocol";
import { createDbClient } from "@/lib/db";
import { createLocalProvider } from "@/lib/ingest/fetch-source";
import { ingestSource } from "@/lib/ingest/ingest";
import { NOT_FOUND_ANSWER } from "@/lib/llm/prompts";
import { hashClient } from "@/lib/chat/rate-limit";
import { readEvents } from "@/tests/helpers/chat";
import { createFakeEmbedder } from "@/tests/helpers/fake-embedder";
import { FIXTURES, FIXTURE_SOURCES, testDatabaseUrl } from "@/tests/helpers/test-db";

/**
 * The real route, pipeline, retrieval and Postgres; only the two API clients are faked.
 * Claude: the rewrite echoes the question with no frameworks, the answer cites [1].
 */
const claude = vi.hoisted(() => ({ answerCalls: 0, answer: "Call `jest.useFakeTimers()` [1]." }));

vi.mock("@/lib/llm/client", () => ({
  getAnthropic: () => {
    const fake = {
      messages: {
        parse: async (params: { messages: { content: string }[] }) => {
          const input = params.messages[0]?.content ?? "";
          const question = /<latest_question>\n([\s\S]*)\n<\/latest_question>/.exec(input)?.[1];
          return {
            parsed_output: { standaloneQuestion: question ?? "", frameworks: [] },
            stop_reason: "end_turn",
            usage: { input_tokens: 30, output_tokens: 10 },
          };
        },
      },
      beta: {
        messages: {
          stream: () => {
            claude.answerCalls++;
            const words = claude.answer.split(/(?<= )/);
            return {
              async *[Symbol.asyncIterator]() {
                for (const text of words) {
                  yield { type: "content_block_delta", delta: { type: "text_delta", text } };
                }
              },
              finalMessage: async () => ({
                model: "claude-sonnet-5-5",
                stop_reason: "end_turn",
                usage: { input_tokens: 800, output_tokens: 25, cache_read_input_tokens: 0 },
              }),
            };
          },
        },
      },
    };
    return fake as unknown as Anthropic;
  },
}));

vi.mock("@/lib/retrieval/query-embedder", async () => {
  const { createFakeEmbedder: fake } = await import("@/tests/helpers/fake-embedder");
  return { createVoyageQueryEmbedder: () => fake().embedder };
});

/** The reranker is on by default (RERANK_MODEL=rerank-3); this fake keeps the vector order. */
const reranker = vi.hoisted(() => ({ calls: [] as { candidates: number; topK: number }[] }));
vi.mock("@/lib/retrieval/rerank", () => ({
  createVoyageReranker: () => ({
    rerank: async (_q: string, results: { rank: number }[], topK: number) => {
      reranker.calls.push({ candidates: results.length, topK });
      return results.slice(0, topK).map((r, i) => ({ ...r, rank: i + 1 }));
    },
  }),
}));

type RouteModule = typeof RouteModuleType;

async function loadRoute(env: Record<string, string | undefined>): Promise<RouteModule> {
  vi.resetModules(); // fresh getEnv() cache and route-level client cache
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return import("@/app/api/chat/route");
}

/** A minimal QueryLog row, for filling up rate limits. */
const LOG_ROW = {
  question: "earlier question",
  retrievalMode: "vector",
  frameworks: [],
  topChunkIds: [],
  topScore: 0.5,
  answered: true,
  outcome: "answered",
  totalMs: 1000,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
};

function post(body: unknown, raw?: string, ip = "203.0.113.9"): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: raw ?? JSON.stringify(body),
  });
}

describe("POST /api/chat (real route + Postgres, mocked Claude and Voyage)", () => {
  let db: PrismaClient;
  let route: RouteModule;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    const url = testDatabaseUrl();
    db = createDbClient(url);
    await db.document.deleteMany();
    const provider = createLocalProvider(FIXTURES);
    const { embedder } = createFakeEmbedder();
    for (const source of FIXTURE_SOURCES) await ingestSource(source, { db, provider, embedder });

    route = await loadRoute({
      DATABASE_URL: url,
      ANTHROPIC_API_KEY: "test-anthropic-key",
      VOYAGE_API_KEY: "test-voyage-key",
      RETRIEVAL_MODE: "hybrid",
      // The fake bag-of-words embedder gives lower similarities than Voyage does.
      NOT_FOUND_THRESHOLD: "0.2",
      RATE_LIMIT_PER_HOUR: "3",
      DAILY_QUESTION_LIMIT: "100",
      RATE_LIMIT_SALT: "test-salt",
    });
  });

  beforeEach(async () => {
    await db.queryLog.deleteMany();
    claude.answerCalls = 0;
    reranker.calls.length = 0;
  });

  afterAll(async () => {
    process.env = savedEnv;
    await db.$disconnect();
  });

  it("streams a cited answer as NDJSON and logs the query", async () => {
    const response = await route.POST(post({ question: "How do I enable fake timers in a test?" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    const events = await readEvents(response.body!);

    // Retrieval fetched candidates for the reranker, which kept the top 5.
    expect(reranker.calls).toEqual([{ candidates: expect.any(Number) as number, topK: 5 }]);
    expect(reranker.calls[0]!.candidates).toBeGreaterThan(5);
    expect(events.map((e) => e.type)).toEqual(["meta", "text", "text", "text", "done"]);
    const meta = events[0] as Extract<ChatEvent, { type: "meta" }>;
    expect(meta.frameworksSource).toBe("all");
    expect(meta.sources[0]).toMatchObject({
      n: 1,
      framework: "jest",
      url: "https://jestjs.io/docs/timer-mocks#enable-fake-timers",
    });

    const done = events.at(-1) as Extract<ChatEvent, { type: "done" }>;
    expect(done).toMatchObject({ answered: true, outcome: "answered" });
    expect(done.citations).toEqual([
      { n: 1, chunkId: meta.sources[0]!.chunkId, url: meta.sources[0]!.url },
    ]);

    const [log] = await db.queryLog.findMany();
    expect(log).toMatchObject({
      question: "How do I enable fake timers in a test?",
      retrievalMode: "hybrid",
      outcome: "answered",
      answered: true,
      inputTokens: 800,
      outputTokens: 25,
      rewriteInputTokens: 30,
      rewriteOutputTokens: 10,
    });
    expect(log?.topChunkIds[0]).toBe(meta.sources[0]?.chunkId);
    expect(log?.ttftMs).not.toBeNull();
    // done is sent after the row is written, and points at it (for feedback).
    expect(done.queryId).toBe(log?.id);
    expect(log?.clientHash).toBe(hashClient("203.0.113.9", "test-salt"));
  });

  it("applies the framework filter", async () => {
    const response = await route.POST(
      post({ question: "How do I enable fake timers in a test?", frameworks: ["angular"] }),
    );
    const events = await readEvents(response.body!);
    const meta = events[0] as Extract<ChatEvent, { type: "meta" }>;
    expect(meta).toMatchObject({ frameworks: ["angular"], frameworksSource: "user" });
    expect(meta.sources.every((s) => s.framework === "angular")).toBe(true);
  });

  it("takes the not-found path without calling Claude for an unrelated question", async () => {
    const response = await route.POST(post({ question: "zebracorn quuxify blorptastic" }));
    const events = await readEvents(response.body!);

    expect(claude.answerCalls).toBe(0);
    expect(events.filter((e) => e.type === "text").map((e) => e.text)).toEqual([NOT_FOUND_ANSWER]);
    expect(events.at(-1)).toMatchObject({ type: "done", answered: false, outcome: "not_found" });
    const [log] = await db.queryLog.findMany();
    expect(log).toMatchObject({ outcome: "not_found", answered: false, inputTokens: 0 });
  });

  it.each([
    ["malformed JSON", undefined, "{not json", "Request body must be JSON"],
    ["a missing question", {}, undefined, "Invalid request"],
    [
      "an unknown framework",
      { question: "Q", frameworks: ["remix"] },
      undefined,
      "Invalid request",
    ],
  ])("returns 400 for %s", async (_name, body, raw, error) => {
    const response = await route.POST(post(body, raw));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error });
    expect(await db.queryLog.count()).toBe(0);
  });

  it("limits questions per visitor per hour", async () => {
    const clientHash = hashClient("198.51.100.4", "test-salt");
    await db.queryLog.createMany({
      data: Array.from({ length: 3 }, () => ({ ...LOG_ROW, clientHash })),
    });

    const limited = await route.POST(post({ question: "One more?" }, undefined, "198.51.100.4"));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({ error: expect.stringContaining("last hour") });

    // Another visitor isn't affected.
    const other = await route.POST(
      post({ question: "zebracorn quuxify" }, undefined, "198.51.100.5"),
    );
    expect(other.status).toBe(200);
    await readEvents(other.body!);
  });

  it("stops at the daily limit for everyone", async () => {
    await db.queryLog.createMany({ data: Array.from({ length: 100 }, () => LOG_ROW) });
    const response = await route.POST(post({ question: "Q?" }, undefined, "192.0.2.1"));
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("daily") });
  });

  it("returns 503 when an API key is missing", async () => {
    // getAnthropic is mocked here, so drop the key the route itself checks.
    const unconfigured = await loadRoute({ VOYAGE_API_KEY: undefined });
    try {
      const response = await unconfigured.POST(post({ question: "Q?" }));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining("API key") });
    } finally {
      route = await loadRoute({ VOYAGE_API_KEY: "test-voyage-key" });
    }
  });
});
