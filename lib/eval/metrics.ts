/**
 * Eval metrics. Pure functions over recorded results, so they're unit-tested and can be
 * recomputed offline (e.g. a threshold sweep) without calling any API.
 */
import { MODEL_PRICES } from "@/lib/config";
import { isRegexPattern, toRegex } from "@/lib/eval/schema";
import type { FrameworkId } from "@/lib/frameworks";

/** "<framework>/<sourcePath>", the key questions use in expectedSourcePaths. */
export function sourceKey(r: { framework: string; sourcePath: string }): string {
  return `${r.framework}/${r.sourcePath}`;
}

/** 1-based rank of the first retrieved chunk from an expected document, or null. */
export function firstHitRank(
  retrievedKeys: readonly string[],
  expected: readonly string[],
): number | null {
  const wanted = new Set(expected);
  const index = retrievedKeys.findIndex((key) => wanted.has(key));
  return index === -1 ? null : index + 1;
}

export function reciprocalRank(rank: number | null): number {
  return rank === null ? 0 : 1 / rank;
}

/** Whitespace- and case-insensitive text match, or a /regex/ match. */
export function mentions(answer: string, pattern: string): boolean {
  if (isRegexPattern(pattern)) return toRegex(pattern).test(answer);
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return normalize(answer).includes(normalize(pattern));
}

export interface MentionResult {
  matched: string[];
  missing: string[];
  /** Share of must-mention facts present (1 when there are none). */
  score: number;
}

export function mustMention(answer: string, patterns: readonly string[]): MentionResult {
  const matched = patterns.filter((p) => mentions(answer, p));
  const missing = patterns.filter((p) => !matched.includes(p));
  return { matched, missing, score: patterns.length === 0 ? 1 : matched.length / patterns.length };
}

/** Share of retrieved chunks that belong to the question's frameworks (null if it has none). */
export function frameworkAccuracy(
  retrieved: readonly FrameworkId[],
  expected: readonly FrameworkId[],
): number | null {
  if (expected.length === 0 || retrieved.length === 0) return null;
  return retrieved.filter((f) => expected.includes(f)).length / retrieved.length;
}

/** Nearest-rank percentile (p in 0–100); null for an empty list. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

export function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
}

/** USD cost of one call; unknown models cost 0 (the caller warns). */
export function costUsd(model: string, usage: TokenCounts): number {
  const price = MODEL_PRICES[model];
  if (!price) return 0;
  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      (usage.cacheReadTokens ?? 0) * price.cacheRead) /
    1_000_000
  );
}

/** Per-question record the summary is computed from (a subset of what results files store). */
export interface ScoredQuestion {
  id: string;
  frameworks: FrameworkId[];
  answerable: boolean;
  hitRank: number | null;
  frameworkAccuracy: number | null;
  topSimilarity: number;
  /** Null in retrieval-only runs. */
  answered: boolean | null;
  mustMentionScore: number | null;
  faithfulness: number | null;
  ttftMs: number | null;
  totalMs: number | null;
  costUsd: number;
  error: boolean;
}

export interface Summary {
  questions: number;
  answerable: number;
  /** Retrieval (answerable questions only). */
  hitRateAt5: number | null;
  mrr: number | null;
  frameworkAccuracy: number | null;
  /** Answers (null in retrieval-only runs). */
  mustMentionRate: number | null;
  faithfulness: number | null;
  refusalAccuracy: number | null;
  ttftP50Ms: number | null;
  ttftP95Ms: number | null;
  totalP50Ms: number | null;
  costPerQuestionUsd: number | null;
  errors: number;
}

const nonNull = <T>(values: (T | null)[]): T[] => values.filter((v): v is T => v !== null);

export function summarize(records: readonly ScoredQuestion[]): Summary {
  const answerable = records.filter((r) => r.answerable && !r.error);
  const answeredRuns = records.filter((r) => r.answered !== null && !r.error);
  return {
    questions: records.length,
    answerable: records.filter((r) => r.answerable).length,
    hitRateAt5: mean(answerable.map((r) => (r.hitRank !== null ? 1 : 0))),
    mrr: mean(answerable.map((r) => reciprocalRank(r.hitRank))),
    frameworkAccuracy: mean(nonNull(answerable.map((r) => r.frameworkAccuracy))),
    mustMentionRate: mean(nonNull(answerable.map((r) => r.mustMentionScore))),
    faithfulness: mean(nonNull(answeredRuns.map((r) => r.faithfulness))),
    refusalAccuracy: mean(answeredRuns.map((r) => (r.answered === r.answerable ? 1 : 0))),
    ttftP50Ms: percentile(nonNull(answeredRuns.map((r) => r.ttftMs)), 50),
    ttftP95Ms: percentile(nonNull(answeredRuns.map((r) => r.ttftMs)), 95),
    totalP50Ms: percentile(nonNull(answeredRuns.map((r) => r.totalMs)), 50),
    costPerQuestionUsd: answeredRuns.length > 0 ? mean(answeredRuns.map((r) => r.costUsd)) : null,
    errors: records.filter((r) => r.error).length,
  };
}

/** Summary per framework (cross-framework questions count toward each of theirs). */
export function summarizeByFramework(
  records: readonly ScoredQuestion[],
): Partial<Record<FrameworkId, Summary>> {
  const out: Partial<Record<FrameworkId, Summary>> = {};
  const frameworks = new Set(records.flatMap((r) => r.frameworks));
  for (const f of frameworks) out[f] = summarize(records.filter((r) => r.frameworks.includes(f)));
  return out;
}

/**
 * Refusal accuracy at other thresholds, from a run made with the threshold at 0 (so every
 * question reached the model): below t → "not found"; above → whatever the model answered.
 */
export function thresholdSweep(
  records: readonly Pick<ScoredQuestion, "answerable" | "answered" | "topSimilarity" | "error">[],
  thresholds: readonly number[],
): {
  threshold: number;
  refusalAccuracy: number;
  answerableAnswered: number;
  unanswerableRefused: number;
}[] {
  const usable = records.filter((r) => r.answered !== null && !r.error);
  const answerable = usable.filter((r) => r.answerable);
  const unanswerable = usable.filter((r) => !r.answerable);
  return thresholds.map((threshold) => {
    const answeredAt = (r: (typeof usable)[number]) =>
      r.topSimilarity >= threshold && r.answered === true;
    return {
      threshold,
      refusalAccuracy: mean(usable.map((r) => (answeredAt(r) === r.answerable ? 1 : 0))) ?? 0,
      answerableAnswered: mean(answerable.map((r) => (answeredAt(r) ? 1 : 0))) ?? 0,
      unanswerableRefused: mean(unanswerable.map((r) => (answeredAt(r) ? 0 : 1))) ?? 0,
    };
  });
}
