"use client";

import { useEffect, useRef } from "react";

import { StreamingMarkdown } from "@/components/chat/streaming-markdown";
import { citedSources, type Turn } from "@/components/chat/use-chat";
import { FrameworkBadge } from "@/components/citations/framework-badge";
import { SourcesList } from "@/components/citations/sources-list";

/** Distance from the bottom (px) within which new content keeps the view pinned to the end. */
const STICK_THRESHOLD = 160;

/**
 * The page itself scrolls (the input is sticky), so "the end" is the bottom of the document:
 * scrolling an element into view would leave the last lines under the sticky input.
 */
function scrollToEnd() {
  window.scrollTo({ top: document.documentElement.scrollHeight });
}

function Answer({ turn, isLast, onRetry }: { turn: Turn; isLast: boolean; onRetry: () => void }) {
  const sources = turn.meta?.sources ?? [];
  const notFound = turn.done?.answered === false;
  const detected = turn.meta?.frameworksSource === "detected" ? turn.meta.frameworks : [];

  return (
    <div className="min-w-0" aria-busy={turn.status === "searching" || turn.status === "streaming"}>
      {detected.length > 0 && (
        <p className="mb-2 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
          Searched
          {detected.map((f) => (
            <FrameworkBadge key={f} framework={f} />
          ))}
        </p>
      )}

      {turn.status === "searching" && (
        <p role="status" className="flex items-center gap-2 text-sm text-zinc-500">
          <span className="size-2 animate-pulse rounded-full bg-zinc-400" aria-hidden />
          Searching the docs…
        </p>
      )}

      {turn.text !== "" && (
        <div className={notFound ? "text-zinc-500 italic dark:text-zinc-400" : undefined}>
          <StreamingMarkdown
            text={turn.text}
            sources={sources}
            streaming={turn.status === "streaming"}
          />
        </div>
      )}

      {turn.status === "done" && <SourcesList sources={citedSources(turn)} />}

      {(turn.status === "error" || turn.status === "stopped") && (
        <div
          role={turn.status === "error" ? "alert" : "status"}
          className={`mt-3 flex flex-wrap items-center gap-3 rounded-lg px-3 py-2 text-sm ${
            turn.status === "error"
              ? "bg-red-50 text-red-800 dark:bg-red-950/50 dark:text-red-300"
              : "bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400"
          }`}
        >
          <span>{turn.status === "error" ? turn.error : "Stopped."}</span>
          {isLast && (
            <button
              type="button"
              onClick={onRetry}
              className="rounded-md border border-current/30 px-2 py-0.5 font-medium hover:bg-white/60 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-black/30"
            >
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function MessageList({ turns, onRetry }: { turns: Turn[]; onRetry: () => void }) {
  const pinnedRef = useRef(true);

  // Track whether the reader is near the bottom; only then follow new content.
  useEffect(() => {
    const onScroll = () => {
      const { scrollY, innerHeight } = window;
      pinnedRef.current =
        scrollY + innerHeight >= document.documentElement.scrollHeight - STICK_THRESHOLD;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // A new question always scrolls into view (and re-pins the view to the bottom). Declared
  // before the follow effect so it runs first in the same commit.
  useEffect(() => {
    pinnedRef.current = true;
    scrollToEnd();
  }, [turns.length]);

  // While pinned, follow the streaming answer.
  const last = turns.at(-1);
  useEffect(() => {
    if (pinnedRef.current) scrollToEnd();
  }, [last?.text, last?.status, last?.meta]);

  return (
    <>
      <ol className="space-y-8" aria-label="Conversation">
        {turns.map((turn, i) => (
          <li key={turn.id} className="space-y-4">
            <div className="flex justify-end">
              <p className="max-w-[85%] rounded-2xl rounded-br-md bg-zinc-100 px-4 py-2 text-[15px] break-words whitespace-pre-wrap dark:bg-zinc-800">
                {turn.question}
              </p>
            </div>
            <Answer turn={turn} isLast={i === turns.length - 1} onRetry={onRetry} />
          </li>
        ))}
      </ol>
    </>
  );
}
