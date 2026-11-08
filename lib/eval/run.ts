import "server-only";

import { resolveQuestion, runChat, type ChatDeps } from "@/lib/chat/pipeline";
import { ChatRequestSchema } from "@/lib/chat/protocol";
import type { QueryLogEntry } from "@/lib/chat/query-log";
import { readChatEvents } from "@/lib/chat/read-stream";
import type { FaithfulnessJudge, JudgedClaim } from "@/lib/eval/judge";
import {
  costUsd,
  firstHitRank,
  frameworkAccuracy,
  mustMention,
  sourceKey,
  type MentionResult,
  type ScoredQuestion,
} from "@/lib/eval/metrics";
import { questionFrameworks, type EvalQuestion } from "@/lib/eval/schema";
import type { FrameworkId, RetrievalMode } from "@/lib/frameworks";
import type { AnswerModel } from "@/lib/llm/answer";
import type { QueryRewriter } from "@/lib/llm/rewrite-query";
import type { SearchResponse, SearchResult } from "@/lib/retrieval/types";

export interface EvalDeps {
  rewriter: QueryRewriter;
  search: ChatDeps["search"];
  answerModel: AnswerModel;
  judge?: FaithfulnessJudge;
  models: { answer: string; rewrite: string };
}

export interface EvalRunOptions {
  mode: RetrievalMode;
  /** The not-found threshold for this run (0 = always ask the model, for threshold sweeps). */
  threshold: number;
  /** Rewrite + retrieve only: no answer, no judge. */
  retrievalOnly: boolean;
}

/** Everything recorded for one question in one mode (stored in the results file). */
export interface QuestionResult extends ScoredQuestion {
  question: string;
  /** The question as searched (after rewriting). */
  searchedQuestion: string;
  detectedFrameworks: FrameworkId[];
  expectedSourcePaths: string[];
  retrieved: {
    rank: number;
    source: string;
    framework: FrameworkId;
    headingPath: string;
    score: number;
    similarity: number | null;
  }[];
  outcome: string | null;
  answer: string | null;
  citations: number[];
  mustMentionDetail: MentionResult | null;
  claims: JudgedClaim[] | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    rewriteInputTokens: number;
    rewriteOutputTokens: number;
  };
  judgeCostUsd: number;
  errorMessage: string | null;
}

const NO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  rewriteInputTokens: 0,
  rewriteOutputTokens: 0,
};

/**
 * Runs one question through the real pipeline (the same `runChat` the API uses), with the
 * search step wrapped so the retrieved chunks, including their source paths, are recorded.
 * Timings and token usage come from the pipeline's QueryLog entry, which isn't written to the
 * database during evals.
 */
export async function runQuestion(
  deps: EvalDeps,
  q: EvalQuestion,
  options: EvalRunOptions,
): Promise<QuestionResult> {
  const frameworks = questionFrameworks(q);
  let searched: SearchResponse | null = null;
  const search: ChatDeps["search"] = async (request) => {
    searched = await deps.search(request);
    return searched;
  };
  const request = ChatRequestSchema.parse({ question: q.question });

  const base = {
    id: q.id,
    frameworks,
    answerable: q.answerable,
    question: q.question,
    expectedSourcePaths: q.expectedSourcePaths,
  };

  try {
    let searchedQuestion = q.question;
    let detectedFrameworks: FrameworkId[] = [];
    let answer: string | null = null;
    let outcome: string | null = null;
    let answered: boolean | null = null;
    let citations: number[] = [];
    let entry: QueryLogEntry | null = null;
    let streamError: string | null = null;
    let rewriteUsage = { inputTokens: 0, outputTokens: 0 };

    if (options.retrievalOnly) {
      const resolved = await resolveQuestion(deps.rewriter, request);
      searchedQuestion = resolved.question;
      detectedFrameworks = resolved.frameworks;
      rewriteUsage = resolved.rewriteUsage;
      await search({
        question: resolved.question,
        mode: options.mode,
        frameworks: resolved.frameworks,
      });
    } else {
      const chatDeps: ChatDeps = {
        rewriter: deps.rewriter,
        search,
        answerModel: deps.answerModel,
        logQuery: async (e) => {
          entry = e;
        },
        mode: options.mode,
        notFoundThreshold: options.threshold,
        onError: (error) => {
          streamError = error instanceof Error ? error.message : String(error);
        },
      };
      let text = "";
      for await (const event of readChatEvents(runChat(chatDeps, request))) {
        if (event.type === "meta") {
          searchedQuestion = event.question;
          detectedFrameworks = event.frameworks;
        } else if (event.type === "text") {
          text += event.text;
        } else if (event.type === "done") {
          answered = event.answered;
          outcome = event.outcome;
          citations = event.citations.map((c) => c.n);
        } else {
          streamError ??= event.message;
        }
      }
      answer = text;
      if (streamError !== null) throw new Error(streamError);
    }

    const response = searched as SearchResponse | null;
    const results: SearchResult[] = response?.results ?? [];
    const keys = results.map(sourceKey);
    const log = entry as QueryLogEntry | null;
    const usage = log
      ? {
          inputTokens: log.inputTokens,
          outputTokens: log.outputTokens,
          cacheReadTokens: log.cacheReadTokens,
          rewriteInputTokens: log.rewriteInputTokens,
          rewriteOutputTokens: log.rewriteOutputTokens,
        }
      : {
          ...NO_USAGE,
          rewriteInputTokens: rewriteUsage.inputTokens,
          rewriteOutputTokens: rewriteUsage.outputTokens,
        };

    const mention = answer !== null && q.answerable ? mustMention(answer, q.mustMention) : null;

    let claims: JudgedClaim[] | null = null;
    let faithfulness: number | null = null;
    let judgeCostUsd = 0;
    if (deps.judge && answered === true && answer) {
      const judgement = await deps.judge.judge({
        question: searchedQuestion,
        answer,
        sources: results,
      });
      claims = judgement.claims;
      faithfulness = judgement.score;
      judgeCostUsd = costUsd(judgement.model, judgement.usage);
    }

    return {
      ...base,
      searchedQuestion,
      detectedFrameworks,
      retrieved: results.map((r) => ({
        rank: r.rank,
        source: sourceKey(r),
        framework: r.framework,
        headingPath: r.headingPath,
        score: r.score,
        similarity: r.similarity,
      })),
      hitRank: q.answerable ? firstHitRank(keys, q.expectedSourcePaths) : null,
      frameworkAccuracy: frameworkAccuracy(
        results.map((r) => r.framework),
        frameworks,
      ),
      topSimilarity: response?.topSimilarity ?? 0,
      answered,
      outcome,
      answer,
      citations,
      mustMentionScore: mention?.score ?? null,
      mustMentionDetail: mention,
      faithfulness,
      claims,
      ttftMs: log?.ttftMs ?? null,
      totalMs: log?.totalMs ?? null,
      usage,
      costUsd:
        costUsd(deps.models.answer, usage) +
        costUsd(deps.models.rewrite, {
          inputTokens: usage.rewriteInputTokens,
          outputTokens: usage.rewriteOutputTokens,
        }),
      judgeCostUsd,
      error: false,
      errorMessage: null,
    };
  } catch (error) {
    return {
      ...base,
      searchedQuestion: q.question,
      detectedFrameworks: [],
      retrieved: [],
      hitRank: null,
      frameworkAccuracy: null,
      topSimilarity: 0,
      answered: null,
      outcome: null,
      answer: null,
      citations: [],
      mustMentionScore: null,
      mustMentionDetail: null,
      faithfulness: null,
      claims: null,
      ttftMs: null,
      totalMs: null,
      usage: NO_USAGE,
      costUsd: 0,
      judgeCostUsd: 0,
      error: true,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}
