import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import { createDbClient } from "@/lib/db";
import { RETRIEVAL_MODES, type FrameworkId } from "@/lib/frameworks";
import { createLocalProvider } from "@/lib/ingest/fetch-source";
import { ingestSource } from "@/lib/ingest/ingest";
import { keywordSearch } from "@/lib/retrieval/keyword";
import { search } from "@/lib/retrieval/search";
import { vectorSearch } from "@/lib/retrieval/vector";
import { createFakeEmbedder, fakeEmbedding } from "@/tests/helpers/fake-embedder";
import { FIXTURES, FIXTURE_SOURCES, testDatabaseUrl } from "@/tests/helpers/test-db";

describe("retrieval (real Postgres, fake embedder)", () => {
  let db: PrismaClient;
  const { embedder, queryCalls } = createFakeEmbedder();

  beforeAll(async () => {
    db = createDbClient(testDatabaseUrl());
    await db.document.deleteMany();
    const provider = createLocalProvider(FIXTURES);
    for (const source of FIXTURE_SOURCES) await ingestSource(source, { db, provider, embedder });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  // Questions whose answer lives in exactly one fixture, phrased so each mode can find it.
  const cases: { question: string; framework: FrameworkId; sourcePath: string }[] = [
    {
      question: "How do I enable fake timers in a test?",
      framework: "jest",
      sourcePath: "TimerMocks.md",
    },
    {
      question: "revalidate fetched data every 60 seconds",
      framework: "nextjs",
      sourcePath: "01-app/02-guides/03-revalidating-data.mdx",
    },
    {
      question: "flexDirection row or column layout",
      framework: "react-native",
      sourcePath: "flexbox.md",
    },
    {
      question: "read the route id parameter with ActivatedRoute paramMap",
      framework: "angular",
      sourcePath: "guide/routing.md",
    },
  ];

  describe.each(RETRIEVAL_MODES)("%s mode", (mode) => {
    it.each(cases)("finds $sourcePath first for “$question”", async (c) => {
      const { results, topSimilarity } = await search(
        { db, embedder },
        { question: c.question, mode },
      );

      expect(results[0]).toMatchObject({
        framework: c.framework,
        sourcePath: c.sourcePath,
        rank: 1,
      });
      expect(results.length).toBeLessThanOrEqual(5);
      expect(results.map((r) => r.rank)).toEqual(results.map((_, i) => i + 1));
      // Every mode reports cosine similarity, so the not-found threshold works the same way.
      expect(results.every((r) => r.similarity !== null)).toBe(true);
      expect(topSimilarity).toBe(Math.max(...results.map((r) => r.similarity ?? 0)));
      expect(topSimilarity).toBeGreaterThan(0.2);
    });

    it("returns only the requested frameworks", async () => {
      // A Jest question, filtered to Angular: results must still all be Angular.
      const { results } = await search(
        { db, embedder },
        { question: cases[0]!.question, mode, frameworks: ["angular"] },
      );
      expect(results.every((r) => r.framework === "angular")).toBe(true);

      const both = await search(
        { db, embedder },
        {
          question: "layout and routing",
          mode,
          frameworks: ["angular", "react-native"],
          limit: 10,
        },
      );
      expect(new Set(both.results.map((r) => r.framework))).toEqual(
        new Set(["angular", "react-native"]),
      );
    });

    it("links each result to its docs page and anchor", async () => {
      const { results } = await search({ db, embedder }, { question: cases[1]!.question, mode });
      const hit = results.find((r) => r.anchor === "time-based-revalidation");
      expect(hit).toBeDefined();
      expect(hit).toMatchObject({
        title: "Revalidating data",
        headingPath: "Revalidating data > Time-based revalidation",
        url: "https://nextjs.org/docs/app/guides/revalidating-data#time-based-revalidation",
      });
      expect(hit?.content).toContain("revalidate");
    });
  });

  it("embeds the question once per search", async () => {
    const before = queryCalls.length;
    await search({ db, embedder }, { question: "  fake timers  ", mode: "hybrid" });
    expect(queryCalls.slice(before)).toEqual(["fake timers"]);
  });

  it("rejects an empty question", async () => {
    await expect(search({ db, embedder }, { question: "   ", mode: "vector" })).rejects.toThrow(
      "empty",
    );
  });

  describe("vectorSearch", () => {
    it("orders by cosine similarity and respects the limit", async () => {
      const results = await vectorSearch(db, fakeEmbedding("fake timers jest"), { limit: 3 });
      expect(results).toHaveLength(3);
      const scores = results.map((r) => r.score);
      expect(scores).toEqual([...scores].sort((a, b) => b - a));
      expect(results.every((r) => r.score === r.similarity)).toBe(true);
    });

    it("fills the limit even when a filter matches few rows", async () => {
      const angularChunks = await db.chunk.count({ where: { framework: "angular" } });
      const results = await vectorSearch(db, fakeEmbedding("fake timers"), {
        frameworks: ["angular"],
        limit: 50,
      });
      expect(results).toHaveLength(angularChunks);
    });
  });

  describe("keywordSearch", () => {
    it("matches any of the question's terms, not all of them", async () => {
      // No chunk contains both "timers" and "flexDirection"; an AND query would return nothing.
      const results = await keywordSearch(db, "timers flexDirection", { limit: 10 });
      const frameworks = results.map((r) => r.framework);
      expect(frameworks).toContain("jest");
      expect(frameworks).toContain("react-native");
    });

    it("returns nothing for words that appear nowhere, or only stopwords", async () => {
      expect(await keywordSearch(db, "zebracorn quuxify")).toEqual([]);
      expect(await keywordSearch(db, "how do I the")).toEqual([]);
      expect(await keywordSearch(db, "   ")).toEqual([]);
    });

    it("treats punctuation and quotes in the question as plain text", async () => {
      const results = await keywordSearch(db, `'timers' & | ! :* "fake" (setTimeout)`);
      expect(results[0]?.framework).toBe("jest");
    });

    it("leaves similarity empty when no embedding is given", async () => {
      const results = await keywordSearch(db, "fake timers");
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.similarity === null)).toBe(true);
    });
  });
});
