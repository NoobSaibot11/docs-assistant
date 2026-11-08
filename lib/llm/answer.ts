import "server-only";

import type Anthropic from "@anthropic-ai/sdk";

import { CHAT } from "@/lib/config";

export interface AnswerUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export type AnswerEvent =
  | { type: "text"; text: string }
  | {
      type: "done";
      usage: AnswerUsage;
      /** e.g. "end_turn", "max_tokens", "refusal". */
      stopReason: string | null;
      /** Model that produced the reply (differs from the request when a fallback served it). */
      model: string;
    };

/** Streams an answer: text deltas, then one "done" event. An interface so tests can fake it. */
export interface AnswerModel {
  stream(input: { system: string; user: string }, signal?: AbortSignal): AsyncIterable<AnswerEvent>;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Claude (CLAUDE_MODEL), streamed. Thinking is adaptive (Sonnet 5.5 can't disable it) and
 * `effort` bounds how much it thinks; thinking blocks aren't shown, only text deltas are
 * forwarded. `fallbacks: "default"` lets the API re-run the request on another model if a
 * safety classifier declines it, inside the same call (beta, Claude API only).
 *
 * Aborting `signal` cancels the HTTP request, so a stopped answer stops being generated and billed.
 */
export function createClaudeAnswerModel(options: {
  client: Anthropic;
  model: string;
  effort: Effort;
}): AnswerModel {
  return {
    async *stream({ system, user }, signal) {
      const stream = options.client.beta.messages.stream(
        {
          model: options.model,
          max_tokens: CHAT.answerMaxTokens,
          system,
          messages: [{ role: "user", content: user }],
          output_config: { effort: options.effort },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        { signal },
      );

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { type: "text", text: event.delta.text };
        }
      }

      const message = await stream.finalMessage();
      yield {
        type: "done",
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        },
        stopReason: message.stop_reason,
        model: message.model,
      };
    },
  };
}
