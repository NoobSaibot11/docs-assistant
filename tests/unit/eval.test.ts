import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import { createCachedEmbedder } from "@/lib/eval/embedding-cache";
import { buildJudgeMessage, createClaudeJudge, scoreClaims } from "@/lib/eval/judge";
import {
  costUsd,
  firstHitRank,
  frameworkAccuracy,
  mentions,
  mustMention,
  percentile,
  summarize,
  thresholdSweep,
  type ScoredQuestion,
} from "@/lib/eval/metrics";
import { runQuestion, type EvalDeps } from "@/lib/eval/run";
import { parseEvalFile, questionFrameworks, type EvalQuestion } from "@/lib/eval/schema";
import type { AnswerEvent } from "@/lib/llm/answer";
import { makeResult } from "@/tests/helpers/chat";

describe("eval schema", () => {
  const valid = {
    id: "q001",
    framework: "nextjs",
    question: "How do I revalidate fetched data every 60 seconds?",
    expectedSourcePaths: ["nextjs/01-app/02-guides/caching.mdx"],
    mustMention: ["next: { revalidate: 60 }", "/revalidate\\s*=\\s*60/"],
    answerable: true,
  };

  it("accepts answerable, cross-framework and unanswerable questions", () => {
    const questions = parseEvalFile([
      valid,
      {
        ...valid,
        id: "q002",
        framework: ["nextjs", "jest"],
        expectedSourcePaths: ["jest/TimerMocks.md"],
      },
      {
        id: "q003",
        framework: null,
        question: "How do I write a Remix loader?",
        answerable: false,
      },
    ]);
    expect(questions.map(questionFrameworks)).toEqual([["nextjs"], ["nextjs", "jest"], []]);
    expect(questions[2]).toMatchObject({ expectedSourcePaths: [], mustMention: [] });
  });

  it.each([
    [{ ...valid, id: "1" }, "q001"],
    [{ ...valid, expectedSourcePaths: [] }, "at least one expected source"],
    [{ ...valid, framework: null }, "need a framework"],
    [{ ...valid, answerable: false }, "no expected sources"],
    [{ ...valid, expectedSourcePaths: ["remix/app.md"] }, 'Unknown framework prefix "remix"'],
    [{ ...valid, expectedSourcePaths: ["nextjs/caching"] }, "expectedSourcePaths.0"],
    [{ ...valid, mustMention: ["/unclosed(/"] }, "Invalid regex"],
  ])("rejects invalid questions %#", (question, message) => {
    expect(() => parseEvalFile([question])).toThrow(message);
  });

  it("rejects duplicate ids", () => {
    expect(() => parseEvalFile([valid, valid])).toThrow("Duplicate id q001");
  });
});

describe("metrics", () => {
  it("finds the rank of the first chunk from an expected document", () => {
    const retrieved = ["jest/a.md", "nextjs/b.mdx", "nextjs/b.mdx", "nextjs/c.mdx"];
    expect(firstHitRank(retrieved, ["nextjs/b.mdx"])).toBe(2);
    expect(firstHitRank(retrieved, ["nextjs/c.mdx", "jest/a.md"])).toBe(1);
    expect(firstHitRank(retrieved, ["angular/x.md"])).toBeNull();
  });

  it("matches must-mention facts as loose text or regex", () => {
    const answer =
      "Use `fetch(url, { next: {  revalidate: 60 } })` or export const revalidate = 60.";
    expect(mentions(answer, "NEXT: { revalidate: 60 }")).toBe(true);
    expect(mentions(answer, "/revalidate\\s*=\\s*60/")).toBe(true);
    expect(mentions(answer, "revalidatePath")).toBe(false);
    expect(mustMention(answer, ["revalidate: 60", "revalidateTag"])).toEqual({
      matched: ["revalidate: 60"],
      missing: ["revalidateTag"],
      score: 0.5,
    });
    expect(mustMention(answer, []).score).toBe(1);
  });

  it("measures framework accuracy over the retrieved chunks", () => {
    expect(frameworkAccuracy(["nextjs", "nextjs", "jest", "angular"], ["nextjs", "jest"])).toBe(
      0.75,
    );
    expect(frameworkAccuracy(["nextjs"], [])).toBeNull();
  });

  it("computes nearest-rank percentiles", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(percentile([], 50)).toBeNull();
  });

  it("prices calls from the model table", () => {
    expect(
      costUsd("claude-sonnet-5-5", { inputTokens: 1_000_000, outputTokens: 100_000 }),
    ).toBeCloseTo(3);
    expect(costUsd("unknown-model", { inputTokens: 1_000_000, outputTokens: 0 })).toBe(0);
  });

  const record = (overrides: Partial<ScoredQuestion>): ScoredQuestion => ({
    id: "q",
    frameworks: ["nextjs"],
    answerable: true,
    hitRank: 1,
    frameworkAccuracy: 1,
    topSimilarity: 0.6,
    answered: true,
    mustMentionScore: 1,
    faithfulness: 1,
    ttftMs: 1000,
    totalMs: 3000,
    costUsd: 0.01,
    error: false,
    ...overrides,
  });

  it("summarizes retrieval over answerable questions and refusals over all", () => {
    const s = summarize([
      record({ hitRank: 1 }),
      record({ hitRank: 4, mustMentionScore: 0.5, faithfulness: 0.8, ttftMs: 3000 }),
      record({ hitRank: null, answered: false, mustMentionScore: 0, faithfulness: null }),
      record({
        answerable: false,
        hitRank: null,
        answered: false,
        frameworks: [],
        mustMentionScore: null,
      }),
      record({
        answerable: false,
        hitRank: null,
        answered: true,
        frameworks: [],
        mustMentionScore: null,
      }),
      record({ error: true }),
    ]);
    expect(s).toMatchObject({ questions: 6, answerable: 4, errors: 1 });
    expect(s.hitRateAt5).toBeCloseTo(2 / 3);
    expect(s.mrr).toBeCloseTo((1 + 0.25 + 0) / 3);
    expect(s.mustMentionRate).toBeCloseTo(0.5);
    expect(s.faithfulness).toBeCloseTo((1 + 0.8 + 1 + 1) / 4);
    // Right: answered answerable ×2, refused unanswerable ×1. Wrong: the other two.
    expect(s.refusalAccuracy).toBeCloseTo(3 / 5);
    expect(s.ttftP50Ms).toBe(1000);
  });

  it("leaves answer metrics empty in retrieval-only runs", () => {
    const s = summarize([
      record({ answered: null, mustMentionScore: null, faithfulness: null, ttftMs: null }),
    ]);
    expect(s).toMatchObject({
      hitRateAt5: 1,
      refusalAccuracy: null,
      mustMentionRate: null,
      costPerQuestionUsd: null,
    });
  });

  it("sweeps the not-found threshold offline", () => {
    const rows = thresholdSweep(
      [
        { answerable: true, answered: true, topSimilarity: 0.6, error: false },
        { answerable: true, answered: true, topSimilarity: 0.45, error: false },
        { answerable: false, answered: true, topSimilarity: 0.42, error: false },
        { answerable: false, answered: false, topSimilarity: 0.55, error: false },
      ],
      [0.4, 0.44, 0.5],
    );
    expect(rows.map((r) => [r.threshold, r.refusalAccuracy])).toEqual([
      [0.4, 0.75],
      [0.44, 1],
      [0.5, 0.75],
    ]);
    expect(rows[2]).toMatchObject({ answerableAnswered: 0.5, unanswerableRefused: 1 });
  });
});

describe("faithfulness judge", () => {
  it("scores the share of supported claims", () => {
    const claim = (supported: boolean) => ({ claim: "c", supported, sources: [] });
    expect(scoreClaims([claim(true), claim(true), claim(false), claim(true)])).toBe(0.75);
    expect(scoreClaims([])).toBeNull();
  });

  it("sends numbered passages, the question and the answer with structured output", async () => {
    const calls: Record<string, unknown>[] = [];
    const client = {
      messages: {
        parse: async (params: Record<string, unknown>) => {
          calls.push(params);
          return {
            model: "claude-opus-5-5",
            stop_reason: "end_turn",
            parsed_output: {
              claims: [
                { claim: "Use revalidate", supported: true, sources: [1] },
                { claim: "It runs every 10s", supported: false, sources: [] },
              ],
            },
            usage: { input_tokens: 3000, output_tokens: 400, cache_read_input_tokens: 0 },
          };
        },
      },
    } as unknown as Anthropic;
    const sources = [makeResult({ content: "Set revalidate to 60." })];
    const judgement = await createClaudeJudge({ client, model: "claude-opus-5-5" }).judge({
      question: "Q?",
      answer: "Use revalidate [1].",
      sources,
    });

    expect(judgement).toMatchObject({ score: 0.5, model: "claude-opus-5-5" });
    expect(calls[0]).toMatchObject({
      model: "claude-opus-5-5",
      messages: [
        { role: "user", content: buildJudgeMessage("Q?", "Use revalidate [1].", sources) },
      ],
    });
    expect(buildJudgeMessage("Q?", "A", sources)).toMatch(
      /^<passages>\n\[1\] Next\.js: .*Set revalidate to 60\.\n<\/passages>\n\n<question>\nQ\?\n<\/question>\n\n<answer>\nA\n<\/answer>$/s,
    );
  });
});

describe("createCachedEmbedder", () => {
  it("embeds each text once per model and persists the cache", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "eval-cache-"));
    try {
      const file = path.join(dir, "nested", "embeddings.json");
      let calls = 0;
      const inner = {
        embedQuery: async (text: string) => {
          calls++;
          return [text.length, 1];
        },
      };
      const first = await createCachedEmbedder(inner, { file, model: "voyage-4" });
      expect(await first.embedQuery("abc")).toEqual([3, 1]);
      expect(await first.embedQuery("abc")).toEqual([3, 1]);
      await first.save();
      expect(first.stats).toEqual({ hits: 1, misses: 1 });

      const second = await createCachedEmbedder(inner, { file, model: "voyage-4" });
      await second.embedQuery("abc");
      const otherModel = await createCachedEmbedder(inner, { file, model: "voyage-5" });
      await otherModel.embedQuery("abc");
      expect(calls).toBe(2); // second run hit the cache; another model doesn't share it
      expect(Object.keys(JSON.parse(await readFile(file, "utf8")) as object)).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("runQuestion", () => {
  const question: EvalQuestion = {
    id: "q001",
    framework: "nextjs",
    question: "How do I revalidate every 60 seconds?",
    expectedSourcePaths: ["nextjs/caching.mdx"],
    mustMention: ["revalidate: 60", "revalidateTag"],
    answerable: true,
  };
  const results = [
    makeResult({ sourcePath: "other.mdx", similarity: 0.62 }),
    makeResult({ sourcePath: "caching.mdx", similarity: 0.6 }),
    makeResult({ framework: "jest", sourcePath: "TimerMocks.md", similarity: 0.4 }),
  ];

  function deps(answer: string[], judgeScore = 1): { deps: EvalDeps; judged: string[] } {
    const judged: string[] = [];
    return {
      judged,
      deps: {
        rewriter: {
          rewrite: async ({ question: q }) => ({
            standaloneQuestion: q,
            frameworks: ["nextjs"],
            usage: { inputTokens: 600, outputTokens: 50 },
          }),
        },
        search: async (request) => ({ mode: request.mode, results, topSimilarity: 0.62 }),
        answerModel: {
          async *stream() {
            for (const text of answer) yield { type: "text", text } satisfies AnswerEvent;
            yield {
              type: "done",
              usage: { inputTokens: 2500, outputTokens: 500, cacheReadTokens: 0 },
              stopReason: "end_turn",
              model: "claude-sonnet-5-5",
            };
          },
        },
        judge: {
          judge: async ({ answer: a }) => {
            judged.push(a);
            return {
              score: judgeScore,
              claims: [],
              usage: { inputTokens: 3000, outputTokens: 300 },
              model: "claude-opus-5-5",
            };
          },
        },
        models: { answer: "claude-sonnet-5-5", rewrite: "claude-haiku-5-5" },
      },
    };
  }

  it("records retrieval, the answer, must-mention, faithfulness, timings and cost", async () => {
    const t = deps(["Use `fetch(url, { next: { revalidate: 60 } })` ", "[2]."], 0.9);
    const r = await runQuestion(t.deps, question, {
      mode: "hybrid",
      threshold: 0.4,
      retrievalOnly: false,
    });

    expect(r).toMatchObject({
      id: "q001",
      hitRank: 2,
      topSimilarity: 0.62,
      answered: true,
      outcome: "answered",
      citations: [2],
      mustMentionScore: 0.5,
      faithfulness: 0.9,
      error: false,
      detectedFrameworks: ["nextjs"],
    });
    expect(r.frameworkAccuracy).toBeCloseTo(2 / 3);
    expect(r.retrieved.map((x) => x.source)).toEqual([
      "nextjs/other.mdx",
      "nextjs/caching.mdx",
      "jest/TimerMocks.md",
    ]);
    expect(r.ttftMs).not.toBeNull();
    // Sonnet: 2500 × $2 + 500 × $10; Haiku: 600 × $0.10 + 50 × $0.50 (per million).
    expect(r.costUsd).toBeCloseTo(0.01 + 0.000085);
    expect(r.judgeCostUsd).toBeCloseTo(0.018);
    expect(t.judged).toEqual(["Use `fetch(url, { next: { revalidate: 60 } })` [2]."]);
  });

  it("doesn't judge 'not found' answers", async () => {
    const t = deps([]);
    const r = await runQuestion(t.deps, question, {
      mode: "vector",
      threshold: 0.9,
      retrievalOnly: false,
    });
    expect(r).toMatchObject({ answered: false, outcome: "not_found", faithfulness: null });
    expect(t.judged).toEqual([]);
  });

  it("retrieval-only runs skip the answer and the judge", async () => {
    const t = deps(["unused"]);
    const r = await runQuestion(t.deps, question, {
      mode: "keyword",
      threshold: 0.4,
      retrievalOnly: true,
    });
    expect(r).toMatchObject({
      hitRank: 2,
      answered: null,
      answer: null,
      mustMentionScore: null,
      costUsd: 0.00008500000000000001,
    });
    expect(t.judged).toEqual([]);
  });

  it("records an error instead of throwing", async () => {
    const t = deps([]);
    t.deps.search = async () => {
      throw new Error("db down");
    };
    const r = await runQuestion(t.deps, question, {
      mode: "hybrid",
      threshold: 0.4,
      retrievalOnly: false,
    });
    expect(r).toMatchObject({
      error: true,
      errorMessage: "db down",
    });
  });
});
