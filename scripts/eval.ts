/**
 * pnpm eval [--mode vector|keyword|hybrid|all]... [--retrieval-only] [--no-judge]
 *           [--ids q001,q002] [--framework jest]... [--threshold 0.4] [--label name]
 *
 * Runs eval/questions.json through the real pipeline (real Claude, Voyage and Postgres) in each
 * retrieval mode, scores it, prints a summary and writes eval/results/<date>-<mode>[-label].json.
 *
 * Cheap runs: --retrieval-only skips Claude answers and the judge (only the Haiku rewrite and
 * cached Voyage embeddings). For a threshold sweep, run once with --threshold 0 and then
 * `pnpm eval:report --sweep <results file>`.
 */
import "dotenv/config";

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { CHUNKER_VERSION, EVAL, RETRIEVAL } from "@/lib/config";
import { getDb } from "@/lib/db";
import { getEnv, requireKey } from "@/lib/env";
import { createCachedEmbedder } from "@/lib/eval/embedding-cache";
import { createClaudeJudge } from "@/lib/eval/judge";
import { summarize, summarizeByFramework, type Summary } from "@/lib/eval/metrics";
import { runQuestion, type EvalDeps, type QuestionResult } from "@/lib/eval/run";
import { parseEvalFile, questionFrameworks } from "@/lib/eval/schema";
import { FRAMEWORK_IDS, RETRIEVAL_MODES, type RetrievalMode } from "@/lib/frameworks";
import { mapWithConcurrency } from "@/lib/ingest/fetch-source";
import { createClaudeAnswerModel } from "@/lib/llm/answer";
import { getAnthropic } from "@/lib/llm/client";
import { createClaudeQueryRewriter } from "@/lib/llm/rewrite-query";
import { createVoyageQueryEmbedder } from "@/lib/retrieval/query-embedder";
import { search } from "@/lib/retrieval/search";

const USAGE = `Usage: pnpm eval [options]
  --mode <m>          vector | keyword | hybrid | all (repeatable; default: all)
  --retrieval-only    rewrite + retrieve only: no answers, no judge (nearly free)
  --no-judge          skip the faithfulness judge
  --ids <list>        only these question ids, comma-separated
  --framework <id>    only questions about this framework (repeatable)
  --threshold <n>     not-found threshold for this run (default: NOT_FOUND_THRESHOLD; 0 for sweeps)
  --label <name>      added to the results file name
  --file <path>       question file (default: ${EVAL.questionsFile})`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    allowNegative: true,
    options: {
      mode: { type: "string", multiple: true },
      "retrieval-only": { type: "boolean", default: false },
      judge: { type: "boolean", default: true },
      ids: { type: "string" },
      framework: { type: "string", multiple: true },
      threshold: { type: "string" },
      label: { type: "string" },
      file: { type: "string", default: EVAL.questionsFile },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }

  const env = getEnv();
  const modes = parseModes(values.mode);
  const retrievalOnly = values["retrieval-only"];
  const useJudge = values.judge && !retrievalOnly;
  const threshold =
    values.threshold === undefined ? env.NOT_FOUND_THRESHOLD : Number(values.threshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(`--threshold must be between 0 and 1\n\n${USAGE}`);
  }
  if (values.label && !/^[\w-]+$/.test(values.label))
    throw new Error("--label: letters, digits, - and _ only");

  let questions = parseEvalFile(JSON.parse(await readFile(values.file, "utf8")));
  if (values.ids) {
    const ids = new Set(values.ids.split(",").map((s) => s.trim()));
    questions = questions.filter((q) => ids.has(q.id));
  }
  if (values.framework) {
    const wanted = values.framework.map((f) => oneOf(f, FRAMEWORK_IDS, "framework"));
    questions = questions.filter((q) => questionFrameworks(q).some((f) => wanted.includes(f)));
  }
  if (questions.length === 0) throw new Error("No questions selected");

  const db = getDb();
  // The Haiku rewrite runs in every mode, so the Anthropic client is always needed.
  const anthropic = getAnthropic();
  const rateLimit =
    env.VOYAGE_RPM !== undefined && env.VOYAGE_TPM !== undefined
      ? { rpm: env.VOYAGE_RPM, tpm: env.VOYAGE_TPM }
      : undefined;
  const embedder = await createCachedEmbedder(
    createVoyageQueryEmbedder({
      apiKey: requireKey("VOYAGE_API_KEY"),
      model: env.VOYAGE_MODEL,
      rateLimit,
      log: console.log,
    }),
    { file: path.resolve(EVAL.embeddingCacheFile), model: env.VOYAGE_MODEL },
  );

  const deps: EvalDeps = {
    rewriter: createClaudeQueryRewriter({
      client: anthropic,
      model: env.CLAUDE_FAST_MODEL,
      onError: (e) => console.warn("rewrite failed:", e),
    }),
    search: (request) => search({ db, embedder }, request),
    answerModel: createClaudeAnswerModel({
      client: anthropic,
      model: env.CLAUDE_MODEL,
      effort: env.ANSWER_EFFORT,
    }),
    judge: useJudge
      ? createClaudeJudge({ client: anthropic, model: env.CLAUDE_JUDGE_MODEL })
      : undefined,
    models: { answer: env.CLAUDE_MODEL, rewrite: env.CLAUDE_FAST_MODEL },
  };

  console.log(
    `Eval: ${questions.length} questions × ${modes.join(", ")}` +
      `${retrievalOnly ? " (retrieval only)" : ""}${useJudge ? `, judge ${env.CLAUDE_JUDGE_MODEL}` : ""}, threshold ${threshold}`,
  );

  const summaries: { mode: RetrievalMode; summary: Summary; file: string }[] = [];
  try {
    for (const mode of modes) {
      const started = Date.now();
      let done = 0;
      const results = await mapWithConcurrency(questions, EVAL.concurrency, async (q) => {
        const result = await runQuestion(deps, q, { mode, threshold, retrievalOnly });
        done++;
        if (result.error) console.warn(`  ${q.id}: ERROR ${result.errorMessage}`);
        if (done % 10 === 0 || done === questions.length)
          console.log(`  ${mode}: ${done}/${questions.length}`);
        return result;
      });
      await embedder.save();

      const summary = summarize(results);
      const file = await writeResults({
        mode,
        retrievalOnly,
        threshold,
        label: values.label,
        models: {
          answer: retrievalOnly ? null : env.CLAUDE_MODEL,
          rewrite: env.CLAUDE_FAST_MODEL,
          judge: useJudge ? env.CLAUDE_JUDGE_MODEL : null,
          embedding: env.VOYAGE_MODEL,
        },
        effort: env.ANSWER_EFFORT,
        questionsFile: values.file,
        results,
        summary,
        durationMs: Date.now() - started,
      });
      summaries.push({ mode, summary, file });
      printMisses(mode, results);
    }
  } finally {
    await embedder.save();
    await db.$disconnect();
  }

  printSummary(summaries, retrievalOnly);
  console.log(
    `Voyage query embeddings: ${embedder.stats.hits} cached, ${embedder.stats.misses} new`,
  );
}

async function writeResults(input: {
  mode: RetrievalMode;
  retrievalOnly: boolean;
  threshold: number;
  label?: string;
  models: Record<string, string | null>;
  effort: string;
  questionsFile: string;
  results: QuestionResult[];
  summary: Summary;
  durationMs: number;
}): Promise<string> {
  const date = new Date().toISOString().slice(0, 10);
  const name = [date, input.mode, input.retrievalOnly ? "retrieval" : null, input.label]
    .filter(Boolean)
    .join("-");
  const file = path.join(EVAL.resultsDir, `${name}.json`);
  const judgeUsd = input.results.reduce((sum, r) => sum + r.judgeCostUsd, 0);
  const pipelineUsd = input.results.reduce((sum, r) => sum + r.costUsd, 0);
  const content = {
    meta: {
      createdAt: new Date().toISOString(),
      commit: gitCommit(),
      mode: input.mode,
      retrievalOnly: input.retrievalOnly,
      threshold: input.threshold,
      topK: RETRIEVAL.topK,
      chunkerVersion: CHUNKER_VERSION,
      models: input.models,
      effort: input.effort,
      questionsFile: input.questionsFile,
      questions: input.results.length,
      durationMs: input.durationMs,
      costUsd: { pipeline: round(pipelineUsd, 4), judge: round(judgeUsd, 4) },
    },
    summary: input.summary,
    byFramework: summarizeByFramework(input.results),
    questions: input.results,
  };
  await mkdir(EVAL.resultsDir, { recursive: true });
  await writeFile(file, `${JSON.stringify(content, null, 2)}\n`);
  return file;
}

function printMisses(mode: RetrievalMode, results: QuestionResult[]): void {
  const misses = results.filter((r) => r.answerable && !r.error && r.hitRank === null);
  const wrongRefusals = results.filter((r) => r.answered !== null && r.answered !== r.answerable);
  if (misses.length > 0)
    console.log(`  ${mode} retrieval misses: ${misses.map((r) => r.id).join(", ")}`);
  if (wrongRefusals.length > 0) {
    console.log(
      `  ${mode} wrong answer/refusal: ${wrongRefusals.map((r) => `${r.id}(${r.answered ? "answered" : "refused"})`).join(", ")}`,
    );
  }
}

function printSummary(
  summaries: { mode: RetrievalMode; summary: Summary; file: string }[],
  retrievalOnly: boolean,
): void {
  const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
  const num = (v: number | null, digits = 3) => (v === null ? "—" : v.toFixed(digits));
  const ms = (v: number | null) => (v === null ? "—" : `${Math.round(v)} ms`);
  console.log();
  console.table(
    summaries.map(({ mode, summary: s }) => ({
      mode,
      "hit@5": pct(s.hitRateAt5),
      MRR: num(s.mrr),
      "framework acc.": pct(s.frameworkAccuracy),
      ...(retrievalOnly
        ? {}
        : {
            "must-mention": pct(s.mustMentionRate),
            faithfulness: pct(s.faithfulness),
            "refusal acc.": pct(s.refusalAccuracy),
            "TTFT p50": ms(s.ttftP50Ms),
            "TTFT p95": ms(s.ttftP95Ms),
            "$/question":
              s.costPerQuestionUsd === null ? "—" : `$${s.costPerQuestionUsd.toFixed(4)}`,
          }),
      errors: s.errors,
    })),
  );
  for (const { file } of summaries) console.log(`Wrote ${file}`);
}

function parseModes(values: string[] | undefined): RetrievalMode[] {
  if (!values || values.includes("all")) return [...RETRIEVAL_MODES];
  return [...new Set(values.map((m) => oneOf(m, RETRIEVAL_MODES, "mode")))];
}

function oneOf<T extends string>(value: string, allowed: readonly T[], name: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`Unknown ${name} "${value}"\n\n${USAGE}`);
  }
  return value as T;
}

function gitCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const round = (v: number, digits: number) => Number(v.toFixed(digits));

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
