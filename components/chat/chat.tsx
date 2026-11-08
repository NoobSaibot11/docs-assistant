"use client";

import Link from "next/link";
import { useState } from "react";

import { FrameworkFilter } from "@/components/chat/framework-filter";
import { MessageInput } from "@/components/chat/message-input";
import { MessageList } from "@/components/chat/message-list";
import { useChat, type FrameworkFilter as Filter } from "@/components/chat/use-chat";

const EXAMPLES = [
  "How do I revalidate fetched data every 60 seconds?",
  "How do I mock a module in Jest?",
  "When should I use a signal instead of an observable?",
  "How do I handle the Android back button?",
];

export function Chat() {
  const { turns, busy, ask, retry, stop, clear, rate } = useChat();
  const [filter, setFilter] = useState<Filter>("all");
  const send = (question: string) => ask(question, filter);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4">
      <header className="sticky top-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 bg-white/90 px-4 py-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold tracking-tight">Docs Assistant</h1>
          <Link
            href="/stats"
            className="text-xs text-zinc-500 hover:text-zinc-900 hover:underline dark:hover:text-zinc-100"
          >
            Stats
          </Link>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <FrameworkFilter value={filter} onChange={setFilter} />
          {turns.length > 0 && (
            <button
              type="button"
              onClick={clear}
              className="shrink-0 rounded-md px-2 py-1 text-sm text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
            >
              New chat
            </button>
          )}
        </div>
      </header>

      <main className="flex-1 py-6">
        {turns.length === 0 ? (
          <section className="mx-auto mt-[12vh] max-w-xl text-center">
            <h2 className="text-2xl font-semibold tracking-tight">Ask the docs</h2>
            <p className="mt-2 text-zinc-600 dark:text-zinc-400">
              Answers come only from the official React Native, Next.js, Angular and Jest docs, with
              a link to every section they use.
            </p>
            <ul className="mt-6 grid gap-2 text-left sm:grid-cols-2">
              {EXAMPLES.map((example) => (
                <li key={example}>
                  <button
                    type="button"
                    onClick={() => send(example)}
                    className="h-full w-full rounded-lg border border-zinc-200 px-3 py-2 text-left text-sm text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-zinc-800 dark:text-zinc-300 dark:hover:border-zinc-700 dark:hover:bg-zinc-900"
                  >
                    {example}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <MessageList turns={turns} onRetry={retry} onRate={(id, r) => void rate(id, r)} />
        )}
      </main>

      <div className="sticky bottom-0 -mx-4 bg-gradient-to-t from-white from-70% px-4 pt-4 pb-4 dark:from-zinc-950">
        <MessageInput busy={busy} onSend={send} onStop={stop} />
      </div>
    </div>
  );
}
