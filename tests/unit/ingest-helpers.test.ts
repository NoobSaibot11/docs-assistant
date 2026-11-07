import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { batchTexts, embeddingInput } from "@/lib/ingest/embed";
import { createGitHubProvider, isIncludedDoc, mapWithConcurrency } from "@/lib/ingest/fetch-source";
import { contentHash } from "@/lib/ingest/ingest";
import { toVectorLiteral } from "@/lib/retrieval/chunk-store";
import { getSource, type SourceConfig } from "@/sources.config";

const nextjs = getSource("nextjs");
const jest = getSource("jest");

describe("sources.config URLs", () => {
  it("maps Next.js file paths to nextjs.org routes", () => {
    const url = (p: string) => nextjs.toUrl({ path: p, frontmatter: {} });
    expect(url("01-app/02-guides/03-caching.mdx")).toBe(
      "https://nextjs.org/docs/app/guides/caching",
    );
    expect(url("01-app/01-getting-started/index.mdx")).toBe(
      "https://nextjs.org/docs/app/getting-started",
    );
    expect(url("03-architecture/fast-refresh.mdx")).toBe(
      "https://nextjs.org/docs/architecture/fast-refresh",
    );
  });

  it("maps Jest pages by slug, then id, then file name", () => {
    const url = (frontmatter: Record<string, unknown>) =>
      jest.toUrl({ path: "MockFunctions.md", frontmatter });
    expect(url({ id: "mock-functions", slug: "/mocks" })).toBe("https://jestjs.io/docs/mocks");
    expect(url({ id: "mock-functions" })).toBe("https://jestjs.io/docs/mock-functions");
    expect(url({})).toBe("https://jestjs.io/docs/MockFunctions");
  });
});

describe("isIncludedDoc", () => {
  it("keeps Markdown under the include folders and skips partials", () => {
    expect(isIncludedDoc(nextjs, "01-app/02-guides/caching.mdx")).toBe(true);
    expect(isIncludedDoc(nextjs, "02-pages/01-routing.mdx")).toBe(false);
    expect(isIncludedDoc(nextjs, "01-app/image.png")).toBe(false);
    expect(isIncludedDoc(jest, "_shared-note.md")).toBe(false);
    expect(isIncludedDoc(jest, "Configuration.md")).toBe(true);
  });
});

describe("mapWithConcurrency", () => {
  it("preserves order and respects the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const result = await mapWithConcurrency([5, 1, 3, 2, 4], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, n));
      inFlight--;
      return n * 10;
    });
    expect(result).toEqual([50, 10, 30, 20, 40]);
    expect(peak).toBe(2);
  });
});

describe("createGitHubProvider", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), "docs-cache-"));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  const source: SourceConfig = { ...jest, rootPath: "website/docs", include: [""] };

  it("lists files with one API call and caches the tree and file contents", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.startsWith("https://api.github.com/")) {
        return Response.json({
          truncated: false,
          tree: [
            { path: "B.md", type: "blob" },
            { path: "A.md", type: "blob" },
            { path: "_partial.md", type: "blob" },
            { path: "img", type: "tree" },
          ],
        });
      }
      return new Response(`content of ${href.split("/").pop()}`);
    });
    const provider = createGitHubProvider({ cacheDir, fetchImpl: fetchImpl as typeof fetch });

    expect(await provider.listFiles(source)).toEqual(["A.md", "B.md"]);
    expect(await provider.readFile(source, "A.md")).toBe("content of A.md");
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.github.com/repos/${jest.repo}/git/trees/${jest.ref}:website/docs?recursive=1`,
      expect.anything(),
    );

    // Second round is served from the cache.
    fetchImpl.mockClear();
    expect(await provider.listFiles(source)).toEqual(["A.md", "B.md"]);
    expect(await provider.readFile(source, "A.md")).toBe("content of A.md");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a truncated tree", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ truncated: true, tree: [] }));
    const provider = createGitHubProvider({ cacheDir, fetchImpl: fetchImpl as typeof fetch });
    await expect(provider.listFiles(source)).rejects.toThrow("truncated");
  });

  it("passes a timeout signal and retries a request that timed out", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal);
      if (signals.length === 1) throw new DOMException("The operation timed out.", "TimeoutError");
      return new Response("recovered");
    });
    const provider = createGitHubProvider({ cacheDir, fetchImpl: fetchImpl as typeof fetch });
    expect(await provider.readFile(source, "Slow.md")).toBe("recovered");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
  });

  it("doesn't retry a 404", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404 }));
    const provider = createGitHubProvider({ cacheDir, fetchImpl: fetchImpl as typeof fetch });
    await expect(provider.readFile(source, "Missing.md")).rejects.toThrow("404");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("batchTexts", () => {
  it("splits on the input-count limit", () => {
    const batches = batchTexts(["a", "b", "c", "d", "e"], { maxInputs: 2, maxTokens: 1000 });
    expect(batches).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  it("splits on the token limit", () => {
    const big = "x".repeat(400); // ~100 tokens
    const batches = batchTexts([big, big, big], { maxInputs: 100, maxTokens: 250 });
    expect(batches.map((b) => b.length)).toEqual([2, 1]);
  });
});

describe("embeddingInput", () => {
  it("prefixes the heading path", () => {
    expect(embeddingInput({ headingPath: "Caching > Revalidating", content: "Body" })).toBe(
      "Caching > Revalidating\n\nBody",
    );
  });
});

describe("contentHash", () => {
  it("is stable and changes with the content", () => {
    expect(contentHash("abc")).toBe(contentHash("abc"));
    expect(contentHash("abc")).not.toBe(contentHash("abd"));
  });
});

describe("toVectorLiteral", () => {
  it("formats a 1024-dimension vector", () => {
    const literal = toVectorLiteral(Array.from({ length: 1024 }, () => 0.5));
    expect(literal.startsWith("[0.5,0.5")).toBe(true);
  });

  it("rejects the wrong dimension or non-finite values", () => {
    expect(() => toVectorLiteral([1, 2, 3])).toThrow("1024");
    expect(() => toVectorLiteral(Array.from({ length: 1024 }, () => Number.NaN))).toThrow(
      "non-finite",
    );
  });
});
