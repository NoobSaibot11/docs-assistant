import { describe, expect, it, vi } from "vitest";

import { ERROR_MESSAGES, runChat, type ChatDeps } from "@/lib/chat/pipeline";
import { ChatRequestSchema, type ChatEvent, type ChatRequestInput } from "@/lib/chat/protocol";
import type { QueryLogEntry } from "@/lib/chat/query-log";
import type { FrameworkId } from "@/lib/frameworks";
import type { AnswerEvent, AnswerModel } from "@/lib/llm/answer";
import { NOT_FOUND_ANSWER } from "@/lib/llm/prompts";
import type { RewriteResult } from "@/lib/llm/rewrite-query";
import type { SearchRequest } from "@/lib/retrieval/search";
import type { SearchResult } from "@/lib/retrieval/types";
import { eventReader, makeResult, readEvents } from "@/tests/helpers/chat";

const USAGE = { inputTokens: 900, outputTokens: 120, cacheReadTokens: 0 };

function answerOf(chunks: string[], stopReason = "end_turn"): AnswerModel["stream"] {
  return async function* () {
    for (const text of chunks) yield { type: "text", text } satisfies AnswerEvent;
    yield { type: "done", usage: USAGE, stopReason, model: "claude-sonnet-5-5" };
  };
}

function setup(
  options: {
    results?: SearchResult[];
    topSimilarity?: number;
    rewrite?: Partial<RewriteResult>;
    answer?: AnswerModel["stream"];
    search?: ChatDeps["search"];
    logQuery?: ChatDeps["logQuery"];
  } = {},
) {
  const results = options.results ?? [
    makeResult({ chunkId: "c1", url: "https://nextjs.org/docs/a#x", similarity: 0.62 }),
    makeResult({ chunkId: "c2", url: "https://nextjs.org/docs/b", similarity: 0.55 }),
    makeResult({ chunkId: "c3", framework: "jest", url: "https://jestjs.io/docs/c" }),
  ];
  const rewriterCalls: { question: string; history: unknown[] }[] = [];
  const searchCalls: SearchRequest[] = [];
  const answerCalls: { system: string; user: string; signal?: AbortSignal }[] = [];
  const logs: QueryLogEntry[] = [];
  const errors: unknown[] = [];
  const answer = options.answer ?? answerOf(["Use `revalidate` [1]", ", or tags [2]."]);
  let clock = 0;

  const deps: ChatDeps = {
    rewriter: {
      async rewrite(input) {
        rewriterCalls.push({ question: input.question, history: [...input.history] });
        return {
          standaloneQuestion: input.question,
          frameworks: ["nextjs"],
          usage: { inputTokens: 40, outputTokens: 12 },
          ...options.rewrite,
        };
      },
    },
    search:
      options.search ??
      (async (request) => {
        searchCalls.push(request);
        return {
          mode: request.mode,
          results,
          topSimilarity: options.topSimilarity ?? 0.62,
        };
      }),
    answerModel: {
      stream(input, signal) {
        answerCalls.push({ ...input, signal });
        return answer(input, signal);
      },
    },
    logQuery:
      options.logQuery ??
      (async (entry) => {
        logs.push(entry);
      }),
    mode: "hybrid",
    notFoundThreshold: 0.4,
    now: () => (clock += 10),
    onError: (error) => errors.push(error),
  };
  return { deps, rewriterCalls, searchCalls, answerCalls, logs, errors };
}

const request = (input: ChatRequestInput) => ChatRequestSchema.parse(input);
const types = (events: ChatEvent[]) => events.map((e) => e.type);
const textOf = (events: ChatEvent[]) =>
  events.map((e) => (e.type === "text" ? e.text : "")).join("");

describe("runChat", () => {
  it("streams meta, text deltas, then done with citations and usage", async () => {
    const t = setup();
    const events = await readEvents(runChat(t.deps, request({ question: "How do I revalidate?" })));

    expect(types(events)).toEqual(["meta", "text", "text", "done"]);
    expect(events[0]).toMatchObject({
      type: "meta",
      question: "How do I revalidate?",
      frameworks: ["nextjs"],
      frameworksSource: "detected",
    });
    const meta = events[0] as Extract<ChatEvent, { type: "meta" }>;
    expect(meta.sources.map((s) => [s.n, s.chunkId])).toEqual([
      [1, "c1"],
      [2, "c2"],
      [3, "c3"],
    ]);
    expect(textOf(events)).toBe("Use `revalidate` [1], or tags [2].");
    expect(events.at(-1)).toEqual({
      type: "done",
      answered: true,
      outcome: "answered",
      citations: [
        { n: 1, chunkId: "c1", url: "https://nextjs.org/docs/a#x" },
        { n: 2, chunkId: "c2", url: "https://nextjs.org/docs/b" },
      ],
      usage: { ...USAGE, rewriteInputTokens: 40, rewriteOutputTokens: 12 },
      topSimilarity: 0.62,
      queryId: t.logs[0]!.id,
    });
    expect(t.logs[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("builds the prompt from the numbered chunks and searches the detected frameworks", async () => {
    const t = setup();
    await readEvents(runChat(t.deps, request({ question: "How do I revalidate?" })));

    expect(t.searchCalls).toEqual([
      { question: "How do I revalidate?", mode: "hybrid", frameworks: ["nextjs"] },
    ]);
    expect(t.answerCalls).toHaveLength(1);
    expect(t.answerCalls[0]?.system).toContain("Answer only from the numbered context");
    expect(t.answerCalls[0]?.user).toContain("[1] Next.js:");
    expect(t.answerCalls[0]?.user).toContain("[3] Jest:");
    expect(t.answerCalls[0]?.user).toMatch(/Question: How do I revalidate\?$/);
  });

  it("writes one QueryLog row with timings, tokens and the outcome", async () => {
    const t = setup();
    await readEvents(runChat(t.deps, request({ question: "How do I revalidate?" })));

    expect(t.logs).toEqual([
      {
        id: expect.any(String) as string,
        clientHash: null,
        question: "How do I revalidate?",
        retrievalMode: "hybrid",
        frameworks: ["nextjs"],
        topChunkIds: ["c1", "c2", "c3"],
        topScore: 0.62,
        outcome: "answered",
        ttftMs: expect.any(Number) as number,
        totalMs: expect.any(Number) as number,
        ...USAGE,
        rewriteInputTokens: 40,
        rewriteOutputTokens: 12,
      },
    ]);
    expect(t.logs[0]!.ttftMs!).toBeGreaterThan(0);
    expect(t.logs[0]!.totalMs).toBeGreaterThan(t.logs[0]!.ttftMs!);
  });

  it("uses the rewritten question for search, the prompt and the log", async () => {
    const t = setup({
      rewrite: { standaloneQuestion: "How do I revalidate data on demand in Next.js?" },
    });
    const history = [
      { role: "user" as const, content: "How do I revalidate data?" },
      { role: "assistant" as const, content: "Use revalidate [1]." },
    ];
    const events = await readEvents(
      runChat(t.deps, request({ question: "And on demand?", history })),
    );

    expect(t.rewriterCalls).toEqual([{ question: "And on demand?", history }]);
    expect(events[0]).toMatchObject({ question: "How do I revalidate data on demand in Next.js?" });
    expect(t.searchCalls[0]?.question).toBe("How do I revalidate data on demand in Next.js?");
    expect(t.logs[0]?.question).toBe("How do I revalidate data on demand in Next.js?");
  });

  it("skips the rewrite call when the user picked a framework and there's no history", async () => {
    const t = setup();
    const events = await readEvents(
      runChat(t.deps, request({ question: "How do I mock timers?", frameworks: ["jest"] })),
    );

    expect(t.rewriterCalls).toEqual([]);
    expect(t.searchCalls[0]?.frameworks).toEqual(["jest"]);
    expect(events[0]).toMatchObject({ frameworks: ["jest"], frameworksSource: "user" });
    expect(t.logs[0]).toMatchObject({ rewriteInputTokens: 0, rewriteOutputTokens: 0 });
  });

  it("keeps the user's filter over detected frameworks when there is history", async () => {
    const t = setup({ rewrite: { frameworks: ["nextjs"] } });
    await readEvents(
      runChat(
        t.deps,
        request({
          question: "And for that?",
          history: [{ role: "user", content: "Mock timers?" }],
          frameworks: ["jest"],
        }),
      ),
    );
    expect(t.rewriterCalls).toHaveLength(1);
    expect(t.searchCalls[0]?.frameworks).toEqual(["jest"]);
  });

  it("searches all frameworks when none are detected", async () => {
    const t = setup({ rewrite: { frameworks: [] as FrameworkId[] } });
    const events = await readEvents(runChat(t.deps, request({ question: "Hello?" })));
    expect(t.searchCalls[0]?.frameworks).toEqual([]);
    expect(events[0]).toMatchObject({ frameworksSource: "all" });
  });

  it("answers 'not found' without calling Claude when retrieval is below the threshold", async () => {
    const t = setup({ topSimilarity: 0.39 });
    const events = await readEvents(runChat(t.deps, request({ question: "Remix loaders?" })));

    expect(t.answerCalls).toEqual([]);
    expect(types(events)).toEqual(["meta", "text", "done"]);
    expect(textOf(events)).toBe(NOT_FOUND_ANSWER);
    expect(events.at(-1)).toMatchObject({
      answered: false,
      outcome: "not_found",
      citations: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(t.logs[0]).toMatchObject({ outcome: "not_found", topScore: 0.39 });
    expect(t.logs[0]?.ttftMs).not.toBeNull();
  });

  it("answers 'not found' when retrieval returns nothing", async () => {
    const t = setup({ results: [], topSimilarity: 0 });
    const events = await readEvents(runChat(t.deps, request({ question: "zzz" })));
    expect(t.answerCalls).toEqual([]);
    expect(events.at(-1)).toMatchObject({ outcome: "not_found" });
  });

  it("marks the answer unanswered when Claude says the context doesn't cover it", async () => {
    const t = setup({ answer: answerOf([NOT_FOUND_ANSWER]) });
    const events = await readEvents(runChat(t.deps, request({ question: "Something odd?" })));

    expect(events.at(-1)).toMatchObject({ answered: false, outcome: "not_found", citations: [] });
    expect(t.logs[0]).toMatchObject({ outcome: "not_found", inputTokens: USAGE.inputTokens });
  });

  it("sends an error event when Claude refuses", async () => {
    const t = setup({ answer: answerOf([], "refusal") });
    const events = await readEvents(runChat(t.deps, request({ question: "Q?" })));

    expect(types(events)).toEqual(["meta", "error"]);
    expect(events.at(-1)).toEqual({ type: "error", message: ERROR_MESSAGES.refused });
    expect(t.logs[0]?.outcome).toBe("error");
  });

  it("sends a generic error event and reports the cause when the answer stream fails", async () => {
    const t = setup({
      answer: async function* () {
        yield { type: "text", text: "Partial" };
        throw new Error("Anthropic 529 overloaded");
      },
    });
    const events = await readEvents(runChat(t.deps, request({ question: "Q?" })));

    expect(types(events)).toEqual(["meta", "text", "error"]);
    expect(events.at(-1)).toEqual({ type: "error", message: ERROR_MESSAGES.failed });
    expect(String(t.errors[0])).toContain("529 overloaded");
    expect(t.logs[0]).toMatchObject({ outcome: "error" });
  });

  it("sends only an error event when retrieval fails", async () => {
    const t = setup({
      search: async () => {
        throw new Error("connection refused");
      },
    });
    const events = await readEvents(runChat(t.deps, request({ question: "Q?" })));
    expect(types(events)).toEqual(["error"]);
    expect(t.logs[0]).toMatchObject({ outcome: "error", ttftMs: null, topChunkIds: [] });
  });

  it("records the client hash for rate limiting", async () => {
    const t = setup();
    await readEvents(
      runChat(t.deps, request({ question: "Q?" }), undefined, { clientHash: "abc" }),
    );
    expect(t.logs[0]?.clientHash).toBe("abc");
  });

  it("sends done only after the QueryLog row is written", async () => {
    const order: string[] = [];
    const t = setup({
      logQuery: async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push("logged");
      },
    });
    const events = eventReader(runChat(t.deps, request({ question: "Q?" })));
    for (let e = await events.next(); e; e = await events.next()) {
      if (e.type === "done") order.push("done");
    }
    expect(order).toEqual(["logged", "done"]);
  });

  it("still finishes the response when writing the log fails", async () => {
    const t = setup({
      logQuery: async () => {
        throw new Error("db down");
      },
    });
    const events = await readEvents(runChat(t.deps, request({ question: "Q?" })));
    // No row was written, so there's nothing to attach feedback to.
    expect(events.at(-1)).toMatchObject({ type: "done", answered: true, queryId: null });
    expect(String(t.errors[0])).toContain("db down");
  });

  /** An answer that sends one delta, then waits until it's aborted, like a real stream. */
  const hangingAnswer: AnswerModel["stream"] = async function* (_input, signal) {
    yield { type: "text", text: "Partial" };
    await new Promise<never>((_, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };

  it("aborts the Claude call and logs 'aborted' when the request signal fires", async () => {
    const t = setup({ answer: hangingAnswer });
    const client = new AbortController();
    const events = eventReader(runChat(t.deps, request({ question: "Q?" }), client.signal));

    expect((await events.next())?.type).toBe("meta");
    expect(await events.next()).toEqual({ type: "text", text: "Partial" });
    client.abort();

    expect(await events.next()).toBeNull(); // no error event after a user stop
    await vi.waitFor(() => expect(t.logs).toHaveLength(1));
    expect(t.answerCalls[0]?.signal?.aborted).toBe(true);
    expect(t.logs[0]).toMatchObject({ outcome: "aborted" });
    expect(t.logs[0]?.ttftMs).not.toBeNull();
    expect(t.errors).toEqual([]);
  });

  it("aborts the Claude call when the consumer cancels the stream", async () => {
    const t = setup({ answer: hangingAnswer });
    const events = eventReader(runChat(t.deps, request({ question: "Q?" })));

    await events.next(); // meta
    await events.next(); // text
    await events.reader.cancel();

    await vi.waitFor(() => expect(t.logs).toHaveLength(1));
    expect(t.answerCalls[0]?.signal?.aborted).toBe(true);
    expect(t.logs[0]?.outcome).toBe("aborted");
  });

  it("does nothing beyond logging when the request was already aborted", async () => {
    const t = setup();
    const client = new AbortController();
    client.abort();
    const events = await readEvents(runChat(t.deps, request({ question: "Q?" }), client.signal));

    expect(events).toEqual([]);
    expect(t.answerCalls).toEqual([]);
    expect(t.logs[0]?.outcome).toBe("aborted");
  });
});
