/**
 * pnpm eval:report [--print]          README table from the latest full run of each mode
 * pnpm eval:report --sweep <file>     refusal accuracy at other not-found thresholds
 *
 * The README table goes between <!-- eval-results:start --> and <!-- eval-results:end -->.
 * A sweep needs a results file from a run with `--threshold 0`, so every question reached the
 * model; it's computed offline from that file, with no API calls.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

import { EVAL } from "@/lib/config";
import { thresholdSweep } from "@/lib/eval/metrics";
import { FRAMEWORK_IDS, FRAMEWORK_NAMES, RETRIEVAL_MODES } from "@/lib/frameworks";

const README = "README.md";
const START = "<!-- eval-results:start -->";
const END = "<!-- eval-results:end -->";

const num = z.number().nullable();
const SummarySchema = z.object({
  questions: z.number(),
  answerable: z.number(),
  hitRateAt5: num,
  mrr: num,
  frameworkAccuracy: num,
  mustMentionRate: num,
  faithfulness: num,
  refusalAccuracy: num,
  ttftP50Ms: num,
  ttftP95Ms: num,
  costPerQuestionUsd: num,
  errors: z.number(),
});

const ResultsFileSchema = z.object({
  meta: z.object({
    createdAt: z.string(),
    commit: z.string().nullable(),
    mode: z.enum(RETRIEVAL_MODES),
    retrievalOnly: z.boolean(),
    threshold: z.number(),
    topK: z.number(),
    chunkerVersion: z.number(),
    models: z.record(z.string(), z.string().nullable()),
    effort: z.string(),
    questions: z.number(),
  }),
  summary: SummarySchema,
  byFramework: z.record(z.string(), SummarySchema),
  questions: z.array(
    z.object({
      answerable: z.boolean(),
      answered: z.boolean().nullable(),
      topSimilarity: z.number(),
      error: z.boolean(),
    }),
  ),
});

type ResultsFile = z.infer<typeof ResultsFileSchema> & { file: string };

const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
const dec = (v: number | null) => (v === null ? "—" : v.toFixed(3));
const ms = (v: number | null) => (v === null ? "—" : `${(v / 1000).toFixed(1)} s`);
const usd = (v: number | null) => (v === null ? "—" : `$${v.toFixed(4)}`);

async function loadResults(): Promise<ResultsFile[]> {
  const files = (await readdir(EVAL.resultsDir).catch(() => [])).filter((f) => f.endsWith(".json"));
  const out: ResultsFile[] = [];
  for (const name of files) {
    const file = path.join(EVAL.resultsDir, name);
    const parsed = ResultsFileSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    if (parsed.success) out.push({ ...parsed.data, file });
    else console.warn(`Skipping ${file}: not a results file`);
  }
  return out;
}

/** The newest full (answers included) run per mode. */
function latestPerMode(results: ResultsFile[]): ResultsFile[] {
  return RETRIEVAL_MODES.flatMap((mode) => {
    const runs = results
      .filter((r) => r.meta.mode === mode && !r.meta.retrievalOnly)
      .sort((a, b) => b.meta.createdAt.localeCompare(a.meta.createdAt));
    return runs[0] ? [runs[0]] : [];
  });
}

function renderTables(runs: ResultsFile[]): string {
  const first = runs[0]!;
  const lines = [
    `Latest run: ${first.meta.createdAt.slice(0, 10)}${first.meta.commit ? ` (commit \`${first.meta.commit}\`)` : ""}, ` +
      `${first.meta.questions} questions, top-${first.meta.topK}, not-found threshold ${first.meta.threshold}. ` +
      `Answers: \`${first.meta.models["answer"]}\` (effort ${first.meta.effort}); ` +
      `judge: \`${first.meta.models["judge"] ?? "none"}\`; embeddings: \`${first.meta.models["embedding"]}\`.`,
    "",
    "| Mode | Hit@5 | MRR | Framework acc. | Must-mention | Faithfulness | Refusal acc. | TTFT p50 | TTFT p95 | Cost / question |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...runs.map(
      ({ meta, summary: s }) =>
        `| ${meta.mode} | ${pct(s.hitRateAt5)} | ${dec(s.mrr)} | ${pct(s.frameworkAccuracy)} | ${pct(s.mustMentionRate)} | ` +
        `${pct(s.faithfulness)} | ${pct(s.refusalAccuracy)} | ${ms(s.ttftP50Ms)} | ${ms(s.ttftP95Ms)} | ${usd(s.costPerQuestionUsd)} |`,
    ),
    "",
    "Hit@5 by framework:",
    "",
    `| Mode | ${FRAMEWORK_IDS.map((f) => FRAMEWORK_NAMES[f]).join(" | ")} |`,
    `| --- | ${FRAMEWORK_IDS.map(() => "---").join(" | ")} |`,
    ...runs.map(
      ({ meta, byFramework }) =>
        `| ${meta.mode} | ${FRAMEWORK_IDS.map((f) => pct(byFramework[f]?.hitRateAt5 ?? null)).join(" | ")} |`,
    ),
  ];
  return lines.join("\n");
}

async function writeReadme(table: string): Promise<void> {
  const readme = await readFile(README, "utf8");
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`${README} needs the markers ${START} and ${END}`);
  }
  const updated = `${readme.slice(0, start + START.length)}\n\n${table}\n\n${readme.slice(end)}`;
  await writeFile(README, updated);
}

async function sweep(file: string): Promise<void> {
  const results = ResultsFileSchema.parse(JSON.parse(await readFile(file, "utf8")));
  if (results.meta.retrievalOnly)
    throw new Error("A sweep needs a run with answers, not --retrieval-only");
  if (results.meta.threshold > 0) {
    console.warn(
      `Warning: this run used threshold ${results.meta.threshold}; questions below it never reached the model, ` +
        "so the sweep is only valid at or above it. Run with --threshold 0 for a full sweep.",
    );
  }
  const thresholds = Array.from({ length: 21 }, (_, i) => Number((0.2 + i * 0.025).toFixed(3)));
  const rows = thresholdSweep(results.questions, thresholds);
  console.table(
    rows.map((r) => ({
      threshold: r.threshold,
      "refusal acc.": pct(r.refusalAccuracy),
      "answerable answered": pct(r.answerableAnswered),
      "unanswerable refused": pct(r.unanswerableRefused),
    })),
  );
  const best = [...rows].sort(
    (a, b) => b.refusalAccuracy - a.refusalAccuracy || b.answerableAnswered - a.answerableAnswered,
  )[0];
  if (best)
    console.log(
      `Best: threshold ${best.threshold} → refusal accuracy ${pct(best.refusalAccuracy)}`,
    );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { print: { type: "boolean", default: false }, sweep: { type: "string" } },
  });
  if (values.sweep) return sweep(values.sweep);

  const runs = latestPerMode(await loadResults());
  if (runs.length === 0)
    throw new Error(`No full eval runs in ${EVAL.resultsDir}; run \`pnpm eval\` first`);
  const table = renderTables(runs);
  console.log(table);
  if (!values.print) {
    await writeReadme(table);
    console.log(`\nUpdated ${README} from ${runs.map((r) => r.file).join(", ")}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
