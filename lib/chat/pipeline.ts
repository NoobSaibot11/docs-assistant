import "server-only";

import { markdownExcerpt } from "@/lib/citations/excerpt";
import { buildCitations } from "@/lib/citations/parse";
import {
  encodeEvent,
  type ChatEvent,
  type ChatRequest,
  type Outcome,
  type Source,
} from "@/lib/chat/protocol";
import type { QueryLogger } from "@/lib/chat/query-log";
import type { FrameworkId, RetrievalMode } from "@/lib/frameworks";
import type { AnswerModel } from "@/lib/llm/answer";
import {
  ANSWER_SYSTEM_PROMPT,
  buildAnswerUserMessage,
  isNotFoundAnswer,
  NOT_FOUND_ANSWER,
} from "@/lib/llm/prompts";
import type { QueryRewriter } from "@/lib/llm/rewrite-query";
import type { SearchRequest } from "@/lib/retrieval/search";
import type { SearchResponse, SearchResult } from "@/lib/retrieval/types";

export interface ChatDeps {
  rewriter: QueryRewriter;
  search: (request: SearchRequest) => Promise<SearchResponse>;
  answerModel: AnswerModel;
  logQuery: QueryLogger;
  mode: RetrievalMode;
  notFoundThreshold: number;
  now?: () => number;
  /** Server-side error reporting; the client only gets a generic message. */
  onError?: (error: unknown) => void;
}

const EXCERPT_CHARS = 280;

/** User-facing error text; details stay in the server log. */
export const ERROR_MESSAGES = {
  failed: "Something went wrong while answering. Please try again.",
  refused: "Claude declined to answer this question.",
} as const;

export function toSources(results: readonly SearchResult[]): Source[] {
  return results.map((r, i) => ({
    n: i + 1,
    chunkId: r.chunkId,
    framework: r.framework,
    title: r.title,
    headingPath: r.headingPath,
    url: r.url,
    excerpt: markdownExcerpt(r.content, EXCERPT_CHARS),
  }));
}

export interface ResolvedQuestion {
  /** The question as searched: rewritten to stand alone when there was history. */
  question: string;
  frameworks: FrameworkId[];
  frameworksSource: "user" | "detected" | "all";
  rewriteUsage: { inputTokens: number; outputTokens: number };
}

/**
 * Step 1 of the pipeline (also used by the eval's retrieval-only runs): the standalone question
 * and the frameworks to search. The user's filter wins over detected frameworks. With no history
 * and a filter set there is nothing to rewrite or detect, so the rewrite call is skipped.
 */
export async function resolveQuestion(
  rewriter: QueryRewriter,
  request: ChatRequest,
  signal?: AbortSignal,
): Promise<ResolvedQuestion> {
  const userFrameworks = request.frameworks;
  const needsRewrite = request.history.length > 0 || userFrameworks.length === 0;
  const rewrite = needsRewrite
    ? await rewriter.rewrite({ question: request.question, history: request.history }, signal)
    : null;
  const frameworks = userFrameworks.length > 0 ? userFrameworks : (rewrite?.frameworks ?? []);
  return {
    question: rewrite?.standaloneQuestion ?? request.question,
    frameworks,
    frameworksSource:
      userFrameworks.length > 0 ? "user" : frameworks.length > 0 ? "detected" : "all",
    rewriteUsage: rewrite?.usage ?? { inputTokens: 0, outputTokens: 0 },
  };
}

/**
 * One chat request as an NDJSON stream: rewrite + tag → retrieve → (not found | stream answer)
 * → citations and usage → QueryLog row.
 *
 * `signal` is the HTTP request's abort signal; cancelling the returned stream has the same
 * effect. Either one aborts the in-flight Claude call and logs the request as "aborted".
 *
 * The final "done" event is sent after the QueryLog row is written, so the `queryId` it carries
 * (used for feedback) always refers to an existing row.
 */
export function runChat(
  deps: ChatDeps,
  request: ChatRequest,
  signal?: AbortSignal,
  context: { clientHash?: string } = {},
): ReadableStream<Uint8Array> {
  const queryId = crypto.randomUUID();
  const now = deps.now ?? (() => performance.now());
  const encoder = new TextEncoder();
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  if (signal?.aborted) abort.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const started = now();
      let open = true;
      const send = (event: ChatEvent) => {
        if (!open || abort.signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(encodeEvent(event)));
        } catch {
          open = false; // the consumer went away
        }
      };

      const log = {
        question: request.question,
        frameworks: [] as FrameworkId[],
        topChunkIds: [] as string[],
        topScore: 0,
        ttftMs: null as number | null,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          rewriteInputTokens: 0,
          rewriteOutputTokens: 0,
        },
      };
      let outcome: Outcome = "error";
      let text = "";
      let done: Omit<Extract<ChatEvent, { type: "done" }>, "queryId"> | null = null;

      const sendText = (chunk: string) => {
        if (chunk === "") return;
        log.ttftMs ??= Math.round(now() - started);
        text += chunk;
        send({ type: "text", text: chunk });
      };

      try {
        abort.signal.throwIfAborted();
        // 1. Standalone question + frameworks.
        const { question, frameworks, frameworksSource, rewriteUsage } = await resolveQuestion(
          deps.rewriter,
          request,
          abort.signal,
        );
        log.question = question;
        log.usage.rewriteInputTokens = rewriteUsage.inputTokens;
        log.usage.rewriteOutputTokens = rewriteUsage.outputTokens;
        log.frameworks = frameworks;
        abort.signal.throwIfAborted();

        // 2. Retrieve.
        const { results, topSimilarity } = await deps.search({
          question,
          mode: deps.mode,
          frameworks,
        });
        log.topChunkIds = results.map((r) => r.chunkId);
        log.topScore = topSimilarity;
        abort.signal.throwIfAborted();

        const sources = toSources(results);
        send({ type: "meta", question, frameworks, frameworksSource, sources });

        // 3. Not found: skip the answer model entirely.
        if (results.length === 0 || topSimilarity < deps.notFoundThreshold) {
          sendText(NOT_FOUND_ANSWER);
          outcome = "not_found";
        } else {
          // 4. Stream the answer.
          let stopReason: string | null = null;
          for await (const event of deps.answerModel.stream(
            { system: ANSWER_SYSTEM_PROMPT, user: buildAnswerUserMessage(question, results) },
            abort.signal,
          )) {
            if (event.type === "text") {
              sendText(event.text);
            } else {
              stopReason = event.stopReason;
              log.usage.inputTokens = event.usage.inputTokens;
              log.usage.outputTokens = event.usage.outputTokens;
              log.usage.cacheReadTokens = event.usage.cacheReadTokens;
            }
          }
          abort.signal.throwIfAborted();
          if (stopReason === "refusal") {
            outcome = "error";
            send({ type: "error", message: ERROR_MESSAGES.refused });
            return;
          }
          outcome = isNotFoundAnswer(text) ? "not_found" : "answered";
        }

        done = {
          type: "done",
          answered: outcome === "answered",
          outcome,
          citations: outcome === "answered" ? buildCitations(text, sources) : [],
          usage: log.usage,
          topSimilarity,
        };
      } catch (error) {
        if (abort.signal.aborted) {
          outcome = "aborted";
        } else {
          outcome = "error";
          deps.onError?.(error);
          send({ type: "error", message: ERROR_MESSAGES.failed });
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
        let logged = false;
        try {
          await deps.logQuery({
            id: queryId,
            clientHash: context.clientHash ?? null,
            question: log.question,
            retrievalMode: deps.mode,
            frameworks: log.frameworks,
            topChunkIds: log.topChunkIds,
            topScore: log.topScore,
            outcome,
            ttftMs: log.ttftMs,
            totalMs: Math.round(now() - started),
            ...log.usage,
          });
          logged = true;
        } catch (error) {
          deps.onError?.(error); // logging must never break the response
        }
        if (done) send({ ...done, queryId: logged ? queryId : null });
        if (open) {
          open = false;
          try {
            controller.close();
          } catch {
            // already closed or cancelled by the consumer
          }
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });
}
