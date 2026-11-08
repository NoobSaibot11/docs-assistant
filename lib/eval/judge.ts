import "server-only";

import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import type { TokenCounts } from "@/lib/eval/metrics";
import { formatContext } from "@/lib/llm/prompts";
import type { SearchResult } from "@/lib/retrieval/types";

/**
 * The fixed faithfulness rubric. The judge lists the answer's claims and marks each as supported
 * or not; the score is computed from that list (supported / total), not asked for directly, so
 * it's reproducible and every point can be inspected in the results file.
 */
export const JUDGE_SYSTEM_PROMPT = `You check whether an answer is supported by the documentation passages it was written from.

Steps:
1. Split the answer into atomic factual claims: one API, option, behavior, default, step or recommendation per claim. Each line of code that shows an API or option counts as a claim about that API.
2. Skip text that makes no factual claim: greetings, transitions, restating the question, and sentences saying the docs don't cover something.
3. For each claim, set supported to true only if the numbered passages state it or directly imply it. Background knowledge doesn't count, even when the claim is true. A claim that misstates a name, value or behavior from the passages is not supported.
4. List the passage numbers that support each supported claim (empty for unsupported ones).

Be strict and literal. Don't grade style, completeness or citation formatting.`;

const JudgeOutput = z.object({
  claims: z.array(
    z.object({
      claim: z.string(),
      supported: z.boolean(),
      sources: z.array(z.number().int()),
    }),
  ),
});

export type JudgedClaim = z.infer<typeof JudgeOutput>["claims"][number];

export interface Judgement {
  /** supported / total claims; null when the answer makes no claims or the judge failed. */
  score: number | null;
  claims: JudgedClaim[];
  usage: TokenCounts;
  model: string;
}

export interface FaithfulnessJudge {
  judge(input: {
    question: string;
    answer: string;
    sources: readonly SearchResult[];
  }): Promise<Judgement>;
}

export function buildJudgeMessage(
  question: string,
  answer: string,
  sources: readonly SearchResult[],
): string {
  return [
    `<passages>\n${formatContext(sources)}\n</passages>`,
    `<question>\n${question}\n</question>`,
    `<answer>\n${answer}\n</answer>`,
  ].join("\n\n");
}

export function scoreClaims(claims: readonly JudgedClaim[]): number | null {
  if (claims.length === 0) return null;
  return claims.filter((c) => c.supported).length / claims.length;
}

export function createClaudeJudge(options: {
  client: Anthropic;
  model: string;
}): FaithfulnessJudge {
  return {
    async judge({ question, answer, sources }) {
      const response = await options.client.messages.parse({
        model: options.model,
        max_tokens: 16_000,
        system: JUDGE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildJudgeMessage(question, answer, sources) }],
        output_config: { effort: "medium", format: zodOutputFormat(JudgeOutput) },
      });
      const usage = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      };
      const claims =
        response.stop_reason === "refusal" ? [] : (response.parsed_output?.claims ?? []);
      return { score: scoreClaims(claims), claims, usage, model: response.model };
    },
  };
}
