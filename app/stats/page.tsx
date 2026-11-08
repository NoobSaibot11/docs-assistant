import type { Metadata } from "next";
import Link from "next/link";

import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { loadStats } from "@/lib/stats";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Stats · Docs Assistant",
  description: "Usage, latency, cost and feedback for the Docs Assistant.",
};

const DAYS = 30;

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
const sec = (v: number | null) => (v === null ? "—" : `${(v / 1000).toFixed(1)} s`);
const usd = (v: number | null, digits = 4) => (v === null ? "—" : `$${v.toFixed(digits)}`);

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <p className="text-xs font-medium tracking-wide text-zinc-500 uppercase">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-zinc-500">{hint}</p>}
    </div>
  );
}

/** Usage over the last 30 days, from QueryLog. Aggregates only: question text isn't shown. */
export default async function StatsPage() {
  const env = getEnv();
  const stats = await loadStats(getDb(), {
    days: DAYS,
    models: { answer: env.CLAUDE_MODEL, rewrite: env.CLAUDE_FAST_MODEL },
  });
  const rated = stats.feedback.up + stats.feedback.down;
  const busiest = Math.max(1, ...stats.perDay.map((d) => d.questions));
  const outcomeLabels: Record<keyof typeof stats.outcomes, string> = {
    answered: "Answered",
    not_found: "Not found",
    aborted: "Stopped",
    error: "Errors",
  };

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Stats</h1>
        <Link href="/" className="text-sm text-blue-700 hover:underline dark:text-blue-400">
          ← Back to chat
        </Link>
      </div>
      <p className="mt-1 text-sm text-zinc-500">
        Last {DAYS} days · {stats.questions} questions
      </p>

      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3" aria-label="Summary">
        <Tile
          label="Time to first token"
          value={sec(stats.ttftP50Ms)}
          hint={`p95 ${sec(stats.ttftP95Ms)}`}
        />
        <Tile label="Full answer" value={sec(stats.totalP50Ms)} hint="median" />
        <Tile label="Not found" value={pct(stats.notFoundRate)} hint="of finished questions" />
        <Tile
          label="Cost per question"
          value={usd(stats.avgCostUsd)}
          hint={`${usd(stats.totalCostUsd, 2)} total (Claude only)`}
        />
        <Tile
          label="Helpful"
          value={rated === 0 ? "—" : pct(stats.feedback.up / rated)}
          hint={`${rated} rating${rated === 1 ? "" : "s"}`}
        />
        <Tile
          label="Stopped or failed"
          value={String(stats.outcomes.aborted + stats.outcomes.error)}
          hint={`${stats.outcomes.aborted} stopped · ${stats.outcomes.error} errors`}
        />
      </section>

      <section className="mt-8" aria-label="Outcomes">
        <h2 className="text-sm font-semibold">Outcomes</h2>
        <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
          {(Object.keys(stats.outcomes) as (keyof typeof stats.outcomes)[]).map((o) => (
            <div key={o} className="flex justify-between gap-2">
              <dt className="text-zinc-500">{outcomeLabels[o]}</dt>
              <dd className="tabular-nums">{stats.outcomes[o]}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mt-8" aria-label="Questions per day">
        <h2 className="text-sm font-semibold">Questions per day</h2>
        <ol className="mt-3 flex h-32 items-end gap-0.5">
          {stats.perDay.map((d) => (
            <li
              key={d.date}
              title={`${d.date}: ${d.questions}`}
              className="flex-1 rounded-t bg-blue-500/70 dark:bg-blue-400/60"
              style={{
                height: `${(d.questions / busiest) * 100}%`,
                minHeight: d.questions ? 2 : 0,
              }}
            >
              <span className="sr-only">
                {d.date}: {d.questions}
              </span>
            </li>
          ))}
        </ol>
        <div className="mt-1 flex justify-between text-xs text-zinc-500">
          <span>{stats.perDay[0]?.date}</span>
          <span>{stats.perDay.at(-1)?.date}</span>
        </div>
      </section>

      <p className="mt-8 text-xs text-zinc-500">
        Costs are estimated from logged tokens at current prices for {env.CLAUDE_MODEL} and{" "}
        {env.CLAUDE_FAST_MODEL}; Voyage embeddings and reranking aren&apos;t included.
      </p>
    </main>
  );
}
