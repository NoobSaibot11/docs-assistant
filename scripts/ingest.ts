/**
 * pnpm ingest [--framework nextjs --framework jest] [--dry-run]
 *
 * Downloads each framework's docs at its pinned ref (cached in .cache/docs), cleans and chunks
 * them, embeds new or changed files with Voyage, and stores them in Postgres. Unchanged files
 * (same content hash) are skipped. --dry-run stops before embedding and prints what would change.
 */
import "dotenv/config";

import path from "node:path";
import { parseArgs } from "node:util";

import { getDb } from "@/lib/db";
import { getEnv, requireKey } from "@/lib/env";
import { FRAMEWORK_IDS, type FrameworkId } from "@/lib/frameworks";
import { createVoyageEmbedder } from "@/lib/ingest/embed";
import { createGitHubProvider } from "@/lib/ingest/fetch-source";
import { ingestSource, type IngestStats } from "@/lib/ingest/ingest";
import type { RateLimit } from "@/lib/ingest/rate-limit";
import { getSource } from "@/sources.config";

const USAGE = `Usage: pnpm ingest [--framework <id>]... [--dry-run]
  --framework  one of: ${FRAMEWORK_IDS.join(", ")} (repeatable; default: INGEST_FRAMEWORKS)
  --dry-run    fetch, clean and chunk only; no embedding or database writes`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      framework: { type: "string", multiple: true },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }

  const env = getEnv();
  const frameworks = values.framework ? parseFrameworks(values.framework) : env.INGEST_FRAMEWORKS;
  const dryRun = values["dry-run"];

  const db = getDb();
  const provider = createGitHubProvider({
    token: env.GITHUB_TOKEN,
    cacheDir: path.resolve(".cache", "docs"),
  });
  const embedder = dryRun
    ? undefined
    : createVoyageEmbedder({
        apiKey: requireKey("VOYAGE_API_KEY"),
        model: env.VOYAGE_MODEL,
        rateLimit: voyageRateLimit(env.VOYAGE_RPM, env.VOYAGE_TPM),
        log: console.log,
      });

  console.log(`${dryRun ? "Dry run" : "Ingesting"}: ${frameworks.join(", ")}`);
  const started = Date.now();
  const results: IngestStats[] = [];
  try {
    for (const framework of frameworks) {
      results.push(
        await ingestSource(
          getSource(framework),
          { db, provider, embedder, log: console.log },
          { dryRun },
        ),
      );
    }
  } finally {
    await db.$disconnect();
  }

  printSummary(results, dryRun, Date.now() - started);
}

/** Throttle only when both limits are set; one without the other is a config mistake. */
function voyageRateLimit(rpm?: number, tpm?: number): RateLimit | undefined {
  if (rpm === undefined && tpm === undefined) return undefined;
  if (rpm === undefined || tpm === undefined) {
    throw new Error("Set both VOYAGE_RPM and VOYAGE_TPM (or neither) in .env");
  }
  console.log(`Throttling Voyage to ${rpm} requests and ${tpm} tokens per minute`);
  return { rpm, tpm };
}

function parseFrameworks(values: string[]): FrameworkId[] {
  const valid = FRAMEWORK_IDS as readonly string[];
  const bad = values.filter((v) => !valid.includes(v));
  if (bad.length > 0) throw new Error(`Unknown framework(s): ${bad.join(", ")}\n\n${USAGE}`);
  return values as FrameworkId[];
}

function printSummary(results: IngestStats[], dryRun: boolean, ms: number): void {
  console.log();
  console.table(
    results.map((r) => ({
      framework: r.framework,
      files: r.files,
      unchanged: r.unchanged,
      [dryRun ? "to embed" : "embedded"]: r.embedded,
      empty: r.empty,
      [dryRun ? "to delete" : "deleted"]: r.deleted,
      chunks: r.chunks,
      "est. tokens": r.estimatedTokens,
      "billed tokens": r.billedTokens,
      "md fallbacks": r.mdFallbacks,
      inlined: r.partialsInlined + r.codeExamplesInlined,
    })),
  );

  for (const r of results) {
    const jsx = Object.entries(r.jsx).sort((a, b) => b[1] - a[1]);
    if (jsx.length > 0) {
      console.log(
        `${r.framework} JSX components removed: ${jsx.map(([n, c]) => `${n}×${c}`).join(", ")}`,
      );
    }
    if (r.partialsInlined + r.codeExamplesInlined > 0) {
      console.log(
        `${r.framework} inlined: ${r.partialsInlined} MDX partials, ${r.codeExamplesInlined} code examples`,
      );
    }
    if (r.missingIncludes.length > 0) {
      console.log(`${r.framework} includes that couldn't be read (${r.missingIncludes.length}):`);
      for (const m of r.missingIncludes.slice(0, 20)) console.log(`  ${m}`);
    }
    if (r.docsCodeRefs > 0)
      console.log(`${r.framework} <docs-code path> embeds not inlined: ${r.docsCodeRefs}`);
  }
  console.log(`\nDone in ${(ms / 1000).toFixed(1)}s`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
