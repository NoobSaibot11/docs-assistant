import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { SourceConfig } from "@/sources.config";

/** Where a source's Markdown files come from: GitHub at a pinned ref, or a local folder (tests). */
export interface DocFileProvider {
  /** Paths relative to the source's rootPath, sorted. */
  listFiles(source: SourceConfig): Promise<string[]>;
  readFile(source: SourceConfig, filePath: string): Promise<string>;
}

const MARKDOWN_FILE = /\.mdx?$/;

/** Markdown files under one of the include folders, skipping partials like `_shared.md`. */
export function isIncludedDoc(source: SourceConfig, filePath: string): boolean {
  if (!MARKDOWN_FILE.test(filePath)) return false;
  const fileName = filePath.split("/").pop() ?? "";
  if (fileName.startsWith("_")) return false;
  return source.include.some((dir) => dir === "" || filePath.startsWith(`${dir}/`));
}

const treeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(z.object({ path: z.string(), type: z.string() })),
});

interface GitHubProviderOptions {
  token?: string;
  /** Files at a pinned ref never change, so they're cached here forever. */
  cacheDir: string;
  fetchImpl?: typeof fetch;
}

/**
 * Lists files with one GitHub API call per source (trees API with `ref:path`), then downloads each
 * file from raw.githubusercontent.com, which doesn't count against the 60/hour API limit.
 */
export function createGitHubProvider(options: GitHubProviderOptions): DocFileProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const cacheRoot = (source: SourceConfig) =>
    path.join(options.cacheDir, source.framework, source.ref.replace(/[^\w.-]/g, "_"));

  return {
    async listFiles(source) {
      const treeCache = path.join(cacheRoot(source), ".tree.json");
      let paths = await readJsonArray(treeCache);
      if (!paths) {
        const url = `https://api.github.com/repos/${source.repo}/git/trees/${source.ref}:${source.rootPath}?recursive=1`;
        const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
        if (options.token) headers.Authorization = `Bearer ${options.token}`;
        const response = await fetchWithRetry(fetchImpl, url, { headers });
        const tree = treeSchema.parse(await response.json());
        if (tree.truncated) {
          throw new Error(`GitHub tree for ${source.repo}:${source.rootPath} is truncated`);
        }
        paths = tree.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path);
        await mkdir(path.dirname(treeCache), { recursive: true });
        await writeFile(treeCache, JSON.stringify(paths));
      }
      return paths.filter((p) => isIncludedDoc(source, p)).sort();
    },

    async readFile(source, filePath) {
      const cached = path.join(cacheRoot(source), filePath);
      try {
        return await readFile(cached, "utf8");
      } catch {
        // Not cached yet.
      }
      const url = `https://raw.githubusercontent.com/${source.repo}/${source.ref}/${source.rootPath}/${filePath}`;
      const content = await (await fetchWithRetry(fetchImpl, url)).text();
      await mkdir(path.dirname(cached), { recursive: true });
      await writeFile(cached, content);
      return content;
    },
  };
}

/** Reads `<rootDir>/<framework>/<path>`; used by integration tests with tests/fixtures. */
export function createLocalProvider(rootDir: string): DocFileProvider {
  return {
    async listFiles(source) {
      const base = path.join(rootDir, source.framework);
      const entries = await readdir(base, { recursive: true, withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => path.relative(base, path.join(entry.parentPath, entry.name)))
        .map((p) => p.split(path.sep).join("/"))
        .filter((p) => isIncludedDoc(source, p))
        .sort();
    },
    readFile(source, filePath) {
      return readFile(path.join(rootDir, source.framework, filePath), "utf8");
    },
  };
}

async function readJsonArray(file: string): Promise<string[] | undefined> {
  try {
    return z.array(z.string()).parse(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return undefined;
  }
}

/** A hung connection must not block a download worker forever. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Retries 429 and 5xx responses, network errors and timeouts with exponential backoff. The
 * timeout signal stays attached to the response, so it also bounds reading the body.
 */
async function fetchWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init?: RequestInit,
  attempts = 5,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** attempt);
    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) return response;
      if (response.status !== 429 && response.status < 500) {
        throw new FetchError(`GET ${url} failed: ${response.status} ${response.statusText}`);
      }
      lastError = new Error(`GET ${url} failed: ${response.status}`);
    } catch (error) {
      if (error instanceof FetchError) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

class FetchError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `fn` over `items` with at most `limit` in flight, preserving order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
