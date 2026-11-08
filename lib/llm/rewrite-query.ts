import "server-only";

import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import { CHAT } from "@/lib/config";
import { FRAMEWORK_IDS, type FrameworkId } from "@/lib/frameworks";
import { REWRITE_SYSTEM_PROMPT } from "@/lib/llm/prompts";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface RewriteResult {
  standaloneQuestion: string;
  /** Detected frameworks; empty means "not sure", so search all. */
  frameworks: FrameworkId[];
  usage: TokenUsage;
}

/** Rewrites a follow-up into a standalone question and tags its frameworks. */
export interface QueryRewriter {
  rewrite(
    input: { question: string; history: readonly ChatTurn[] },
    signal?: AbortSignal,
  ): Promise<RewriteResult>;
}

const RewriteOutput = z.object({
  standaloneQuestion: z.string(),
  frameworks: z.array(z.enum(FRAMEWORK_IDS)),
});

/** The conversation as one block of text, newest last, with long turns shortened. */
export function formatRewriteInput(question: string, history: readonly ChatTurn[]): string {
  const turns = history.map((turn) => {
    const text =
      turn.content.length > CHAT.maxHistoryMessageChars
        ? `${turn.content.slice(0, CHAT.maxHistoryMessageChars)}…`
        : turn.content;
    return `${turn.role === "user" ? "User" : "Assistant"}: ${text}`;
  });
  const conversation =
    turns.length > 0 ? `<conversation>\n${turns.join("\n\n")}\n</conversation>\n\n` : "";
  return `${conversation}<latest_question>\n${question}\n</latest_question>`;
}

/**
 * Claude (CLAUDE_FAST_MODEL) with structured output, so the reply is validated JSON. Any
 * failure (API error, refusal, unparseable output) falls back to the original question and all
 * frameworks: a weaker search is better than failing the whole request.
 */
export function createClaudeQueryRewriter(options: {
  client: Anthropic;
  model: string;
  onError?: (error: unknown) => void;
}): QueryRewriter {
  return {
    async rewrite({ question, history }, signal) {
      const fallback = (
        usage: TokenUsage = { inputTokens: 0, outputTokens: 0 },
      ): RewriteResult => ({
        standaloneQuestion: question,
        frameworks: [],
        usage,
      });
      try {
        const response = await options.client.messages.parse(
          {
            model: options.model,
            max_tokens: CHAT.rewriteMaxTokens,
            system: REWRITE_SYSTEM_PROMPT,
            messages: [{ role: "user", content: formatRewriteInput(question, history) }],
            output_config: { effort: "low", format: zodOutputFormat(RewriteOutput) },
          },
          { signal },
        );
        const usage = {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        };
        const parsed = response.parsed_output;
        if (
          response.stop_reason === "refusal" ||
          !parsed ||
          parsed.standaloneQuestion.trim() === ""
        ) {
          return fallback(usage);
        }
        return {
          standaloneQuestion: parsed.standaloneQuestion.trim(),
          frameworks: [...new Set(parsed.frameworks)],
          usage,
        };
      } catch (error) {
        if (signal?.aborted) throw error;
        options.onError?.(error);
        return fallback();
      }
    },
  };
}
