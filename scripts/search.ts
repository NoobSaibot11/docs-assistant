/**
 * pnpm run search "question" [--mode vector|keyword|hybrid] [--framework jest]... [--limit 5]
 *
 * Embeds the question with Voyage (input type "query"), runs one retrieval mode against the
 * ingested docs and prints the top chunks with their scores. For checking retrieval by hand.
 */
import "dotenv/config";

import { parseArgs } from "node:util";

import { RETRIEVAL } from "@/lib/config";
import { getDb } from "@/lib/db";
import { getEnv, requireKey } from "@/lib/env";
import {
  FRAMEWORK_IDS,
  RETRIEVAL_MODES,
  type FrameworkId,
  type RetrievalMode,
} from "@/lib/frameworks";
import { createVoyageQueryEmbedder } from "@/lib/retrieval/query-embedder";
import { search } from "@/lib/retrieval/search";
import type { SearchResult } from "@/lib/retrieval/types";

const USAGE = `Usage: pnpm run search "question" [--mode <mode>] [--framework <id>]... [--limit <n>]
  --mode       one of: ${RETRIEVAL_MODES.join(", ")} (default: RETRIEVAL_MODE)
  --framework  one of: ${FRAMEWORK_IDS.join(", ")} (repeatable; default: all)
  --limit      number of chunks to show (default: ${RETRIEVAL.topK})`;

const EXCERPT_CHARS = 240;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      mode: { type: "string" },
      framework: { type: "string", multiple: true },
      limit: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  const question = positionals.join(" ").trim();
  if (values.help || question === "") {
    console.log(USAGE);
    if (!values.help) process.exitCode = 1;
    return;
  }

  const env = getEnv();
  const mode = values.mode ? oneOf(values.mode, RETRIEVAL_MODES, "mode") : env.RETRIEVAL_MODE;
  const frameworks = (values.framework ?? []).map((f) => oneOf(f, FRAMEWORK_IDS, "framework"));
  const limit = values.limit ? positiveInt(values.limit) : RETRIEVAL.topK;

  const db = getDb();
  const embedder = createVoyageQueryEmbedder({
    apiKey: requireKey("VOYAGE_API_KEY"),
    model: env.VOYAGE_MODEL,
  });

  try {
    const started = Date.now();
    const response = await search({ db, embedder }, { question, mode, frameworks, limit });
    printResults(response.results, mode, frameworks);
    const verdict = response.topSimilarity >= env.NOT_FOUND_THRESHOLD ? "above" : "BELOW";
    console.log(
      `Top similarity ${response.topSimilarity.toFixed(3)} (${verdict} NOT_FOUND_THRESHOLD ` +
        `${env.NOT_FOUND_THRESHOLD}) · ${Date.now() - started} ms incl. embedding`,
    );
  } finally {
    await db.$disconnect();
  }
}

function printResults(
  results: SearchResult[],
  mode: RetrievalMode,
  frameworks: FrameworkId[],
): void {
  const scope = frameworks.length > 0 ? frameworks.join(", ") : "all frameworks";
  console.log(`\n${mode} search over ${scope}: ${results.length} result(s)\n`);
  for (const r of results) {
    const excerpt = r.content.replace(/\s+/g, " ").slice(0, EXCERPT_CHARS);
    console.log(
      `[${r.rank}] score ${formatScore(mode, r.score)}  similarity ${r.similarity?.toFixed(3) ?? "—"}  (${r.framework})`,
    );
    console.log(`    ${r.headingPath}`);
    console.log(`    ${r.url}`);
    console.log(`    ${excerpt}${r.content.length > EXCERPT_CHARS ? "…" : ""}\n`);
  }
}

/** RRF sums are tiny (≈0.03), so show more digits for them. */
function formatScore(mode: RetrievalMode, score: number): string {
  return score.toFixed(mode === "hybrid" ? 5 : 3);
}

function oneOf<T extends string>(value: string, allowed: readonly T[], name: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`Unknown ${name} "${value}"\n\n${USAGE}`);
  }
  return value as T;
}

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`--limit must be a positive integer\n\n${USAGE}`);
  return n;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
