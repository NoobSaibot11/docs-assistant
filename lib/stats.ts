import "server-only";

import type { PrismaClient } from "@/generated/prisma/client";
import { OUTCOMES, type Outcome } from "@/lib/chat/protocol";
import { costUsd, mean, percentile } from "@/lib/eval/metrics";

export interface StatsRow {
  createdAt: Date;
  outcome: string;
  ttftMs: number | null;
  totalMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  rewriteInputTokens: number;
  rewriteOutputTokens: number;
  rating: number | null;
}

export interface Stats {
  days: number;
  questions: number;
  outcomes: Record<Outcome, number>;
  /** Share of finished questions (answered + not found) that were "not found". */
  notFoundRate: number | null;
  ttftP50Ms: number | null;
  ttftP95Ms: number | null;
  totalP50Ms: number | null;
  avgCostUsd: number | null;
  totalCostUsd: number;
  feedback: { up: number; down: number };
  /** Questions per UTC day, oldest first, including empty days. */
  perDay: { date: string; questions: number }[];
}

/**
 * Aggregates QueryLog rows. Pure, so it's unit-tested. Cost uses the configured models' current
 * prices (QueryLog stores tokens, not prices), so it's an estimate if models changed.
 */
export function summarizeLogs(
  rows: readonly StatsRow[],
  options: { days: number; models: { answer: string; rewrite: string }; now?: Date },
): Stats {
  const outcomes = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>;
  for (const row of rows) {
    if ((OUTCOMES as readonly string[]).includes(row.outcome)) outcomes[row.outcome as Outcome]++;
  }
  const finished = outcomes.answered + outcomes.not_found;
  const costs = rows.map(
    (r) =>
      costUsd(options.models.answer, r) +
      costUsd(options.models.rewrite, {
        inputTokens: r.rewriteInputTokens,
        outputTokens: r.rewriteOutputTokens,
      }),
  );
  const ttfts = rows.flatMap((r) => (r.ttftMs === null ? [] : [r.ttftMs]));
  const completed = rows.filter((r) => r.outcome === "answered" || r.outcome === "not_found");

  const now = options.now ?? new Date();
  const perDay = Array.from({ length: options.days }, (_, i) => {
    const date = new Date(now.getTime() - (options.days - 1 - i) * 86_400_000);
    return date.toISOString().slice(0, 10);
  }).map((date) => ({
    date,
    questions: rows.filter((r) => r.createdAt.toISOString().slice(0, 10) === date).length,
  }));

  return {
    days: options.days,
    questions: rows.length,
    outcomes,
    notFoundRate: finished === 0 ? null : outcomes.not_found / finished,
    ttftP50Ms: percentile(ttfts, 50),
    ttftP95Ms: percentile(ttfts, 95),
    totalP50Ms: percentile(
      completed.map((r) => r.totalMs),
      50,
    ),
    avgCostUsd: mean(costs),
    totalCostUsd: costs.reduce((a, b) => a + b, 0),
    feedback: {
      up: rows.filter((r) => r.rating === 1).length,
      down: rows.filter((r) => r.rating === -1).length,
    },
    perDay,
  };
}

/** Loads the last `days` of QueryLog (with feedback) and summarizes it. */
export async function loadStats(
  db: PrismaClient,
  options: { days: number; models: { answer: string; rewrite: string } },
): Promise<Stats> {
  const since = new Date(Date.now() - options.days * 86_400_000);
  const logs = await db.queryLog.findMany({
    where: { createdAt: { gte: since } },
    select: {
      createdAt: true,
      outcome: true,
      ttftMs: true,
      totalMs: true,
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      rewriteInputTokens: true,
      rewriteOutputTokens: true,
      feedback: { select: { rating: true } },
    },
  });
  return summarizeLogs(
    logs.map(({ feedback, ...row }) => ({ ...row, rating: feedback?.rating ?? null })),
    options,
  );
}
