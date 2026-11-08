import { FrameworkBadge } from "@/components/citations/framework-badge";
import type { Source } from "@/lib/chat/protocol";

/** The sources an answer cited, in order of first citation, linking to the official docs. */
export function SourcesList({ sources }: { sources: readonly Source[] }) {
  if (sources.length === 0) return null;
  return (
    <section
      aria-label="Sources"
      className="mt-4 border-t border-zinc-200 pt-3 dark:border-zinc-800"
    >
      <h3 className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">Sources</h3>
      <ol className="mt-2 space-y-1.5">
        {sources.map((source) => (
          <li key={source.n} className="flex min-w-0 items-start gap-2 text-sm">
            <span className="w-6 shrink-0 text-xs leading-5 font-semibold text-zinc-500 tabular-nums">
              [{source.n}]
            </span>
            <FrameworkBadge framework={source.framework} />
            <a
              href={source.url}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 leading-5 break-words text-blue-700 underline-offset-2 hover:underline dark:text-blue-400"
            >
              {source.headingPath}
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}
