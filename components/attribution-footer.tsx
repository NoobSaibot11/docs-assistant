import { SOURCES } from "@/sources.config";

/** Credits each docs source and its license (React Native's CC BY 4.0 requires attribution). */
export function AttributionFooter() {
  return (
    <footer className="border-t border-zinc-200 px-4 py-6 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
      <p className="mx-auto max-w-2xl">
        Answers are based on the official documentation of{" "}
        {SOURCES.map((source, i) => (
          <span key={source.framework}>
            {i > 0 && (i === SOURCES.length - 1 ? " and " : ", ")}
            <a
              href={source.siteUrl}
              className="underline hover:text-zinc-700 dark:hover:text-zinc-200"
            >
              {source.name}
            </a>{" "}
            (
            <a
              href={source.license.url}
              className="underline hover:text-zinc-700 dark:hover:text-zinc-200"
            >
              {source.license.name}
            </a>
            , v{source.docsVersion})
          </span>
        ))}
        . Documentation content belongs to its respective authors; excerpts are shown with links to
        the original pages.
      </p>
    </footer>
  );
}
