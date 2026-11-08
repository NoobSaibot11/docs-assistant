import "dotenv/config";

import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import { createDbClient } from "@/lib/db";
import type { Embedder } from "@/lib/ingest/embed";
import { createLocalProvider } from "@/lib/ingest/fetch-source";
import { ingestSource } from "@/lib/ingest/ingest";
import { createFakeEmbedder } from "@/tests/helpers/fake-embedder";
import { getSource } from "@/sources.config";
import { FIXTURES, FIXTURE_SOURCES as SOURCES, testDatabaseUrl } from "@/tests/helpers/test-db";

describe("ingestSource (real Postgres, fake embedder)", () => {
  let db: PrismaClient;
  let fixturesDir: string;

  beforeAll(() => {
    db = createDbClient(testDatabaseUrl());
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(async () => {
    await db.document.deleteMany();
    // A writable copy, so tests can edit and delete fixture files.
    fixturesDir = await mkdtemp(path.join(tmpdir(), "docs-fixtures-"));
    await cp(FIXTURES, fixturesDir, { recursive: true });
    return () => rm(fixturesDir, { recursive: true, force: true });
  });

  async function ingestAll(embedder: Embedder) {
    const provider = createLocalProvider(fixturesDir);
    const results = [];
    for (const source of SOURCES)
      results.push(await ingestSource(source, { db, provider, embedder }));
    return results;
  }

  it("stores documents and chunks with embeddings, tsv and citation metadata", async () => {
    const { embedder } = createFakeEmbedder();
    const stats = await ingestAll(embedder);

    expect(stats.map((s) => [s.framework, s.files, s.embedded])).toEqual([
      ["nextjs", 2, 2],
      ["jest", 2, 2],
      ["angular", 2, 2],
      ["react-native", 2, 2],
    ]);
    expect(await db.document.count()).toBe(8);

    const chunkCount = await db.chunk.count();
    expect(chunkCount).toBe(stats.reduce((sum, s) => sum + s.chunks, 0));

    const [missing] = await db.$queryRaw<{ embeddings: bigint; tsv: bigint }[]>`
      SELECT count(*) FILTER (WHERE embedding IS NULL) AS embeddings,
             count(*) FILTER (WHERE tsv IS NULL) AS tsv
      FROM "Chunk"`;
    expect(missing).toEqual({ embeddings: 0n, tsv: 0n });

    const doc = await db.document.findUniqueOrThrow({
      where: {
        framework_sourcePath: {
          framework: "nextjs",
          sourcePath: "01-app/02-guides/03-revalidating-data.mdx",
        },
      },
      include: { chunks: { orderBy: { ordinal: "asc" } } },
    });
    expect(doc).toMatchObject({
      title: "Revalidating data",
      url: "https://nextjs.org/docs/app/guides/revalidating-data",
      docsVersion: "16.4.5",
    });
    expect(doc.chunks.map((c) => [c.headingPath, c.anchor])).toEqual([
      ["Revalidating data", null],
      ["Revalidating data > Time-based revalidation", "time-based-revalidation"],
      ["Revalidating data > On-demand revalidation", "on-demand-revalidation"],
    ]);
    expect(doc.chunks.every((c) => c.framework === "nextjs")).toBe(true);

    // The generated tsv column is searchable.
    const hits = await db.$queryRaw<{ headingPath: string }[]>`
      SELECT "headingPath" FROM "Chunk" WHERE tsv @@ plainto_tsquery('english', 'fake timers')`;
    expect(hits.map((h) => h.headingPath)).toContain("Timer Mocks");
  });

  it("skips unchanged files on a second run without calling the embedder", async () => {
    await ingestAll(createFakeEmbedder().embedder);
    const before = await db.chunk.findMany({ select: { id: true }, orderBy: { id: "asc" } });

    const { embedder, calls } = createFakeEmbedder();
    const stats = await ingestAll(embedder);

    expect(stats.map((s) => [s.unchanged, s.embedded, s.deleted])).toEqual([
      [2, 0, 0],
      [2, 0, 0],
      [2, 0, 0],
      [2, 0, 0],
    ]);
    expect(calls).toHaveLength(0);
    // Same chunk rows: nothing was rewritten.
    expect(await db.chunk.findMany({ select: { id: true }, orderBy: { id: "asc" } })).toEqual(
      before,
    );
  });

  it("re-embeds only the file that changed", async () => {
    await ingestAll(createFakeEmbedder().embedder);

    const file = path.join(fixturesDir, "jest", "TimerMocks.md");
    await writeFile(
      file,
      `${await readFile(file, "utf8")}\n## Clear all timers\n\nUse \`jest.clearAllTimers()\`.\n`,
    );

    const { embedder, calls } = createFakeEmbedder();
    const stats = await ingestAll(embedder);

    expect(stats.map((s) => s.embedded)).toEqual([0, 1, 0, 0]);
    expect(calls.flat().some((text) => text.includes("Clear all timers"))).toBe(true);
    expect(calls.flat().every((text) => text.startsWith("Timer Mocks"))).toBe(true);

    const anchors = await db.chunk.findMany({
      where: { document: { sourcePath: "TimerMocks.md" } },
      select: { anchor: true },
      orderBy: { ordinal: "asc" },
    });
    expect(anchors.at(-1)?.anchor).toBe("clear-all-timers");
  });

  it("deletes documents whose files were removed upstream", async () => {
    await ingestAll(createFakeEmbedder().embedder);
    await rm(path.join(fixturesDir, "nextjs", "01-app", "01-getting-started", "index.mdx"));

    const stats = await ingestAll(createFakeEmbedder().embedder);

    expect(stats[0]?.deleted).toBe(1);
    expect(await db.document.count({ where: { framework: "nextjs" } })).toBe(1);
  });

  it("changes nothing in a dry run", async () => {
    const { embedder, calls } = createFakeEmbedder();
    const provider = createLocalProvider(fixturesDir);
    const stats = await ingestSource(
      getSource("jest"),
      { db, provider, embedder },
      { dryRun: true },
    );

    expect(stats.embedded).toBe(2);
    expect(stats.chunks).toBeGreaterThan(0);
    expect(calls).toHaveLength(0);
    expect(await db.document.count()).toBe(0);
  });
});
