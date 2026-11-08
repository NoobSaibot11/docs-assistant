import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import { CHAT } from "@/lib/config";
import { createClaudeAnswerModel, type AnswerEvent } from "@/lib/llm/answer";
import { createClaudeQueryRewriter } from "@/lib/llm/rewrite-query";

/** Just enough of the SDK surface for these wrappers; tests never reach the real API. */
function fakeClient(options: {
  parse?: (params: Record<string, unknown>, opts: { signal?: AbortSignal }) => Promise<unknown>;
  streamEvents?: unknown[];
  finalMessage?: unknown;
}) {
  const calls: { method: string; params: Record<string, unknown>; signal?: AbortSignal }[] = [];
  const client = {
    messages: {
      parse(params: Record<string, unknown>, opts: { signal?: AbortSignal }) {
        calls.push({ method: "parse", params, signal: opts.signal });
        return options.parse?.(params, opts) ?? Promise.reject(new Error("no parse"));
      },
    },
    beta: {
      messages: {
        stream(params: Record<string, unknown>, opts: { signal?: AbortSignal }) {
          calls.push({ method: "stream", params, signal: opts.signal });
          const events = options.streamEvents ?? [];
          return {
            async *[Symbol.asyncIterator]() {
              yield* events;
            },
            finalMessage: async () => options.finalMessage,
          };
        },
      },
    },
  };
  return { client: client as unknown as Anthropic, calls };
}

const parsedReply = (output: unknown, stopReason = "end_turn") => ({
  parsed_output: output,
  stop_reason: stopReason,
  usage: { input_tokens: 50, output_tokens: 20 },
});

describe("createClaudeQueryRewriter", () => {
  it("asks the fast model for structured output and returns the parsed result", async () => {
    const { client, calls } = fakeClient({
      parse: async () =>
        parsedReply({
          standaloneQuestion: " How do I mock timers in Jest? ",
          frameworks: ["jest", "jest"],
        }),
    });
    const signal = new AbortController().signal;
    const rewriter = createClaudeQueryRewriter({ client, model: "claude-haiku-5-5" });

    const result = await rewriter.rewrite({ question: "And timers?", history: [] }, signal);

    expect(result).toEqual({
      standaloneQuestion: "How do I mock timers in Jest?",
      frameworks: ["jest"],
      usage: { inputTokens: 50, outputTokens: 20 },
    });
    expect(calls[0]).toMatchObject({
      method: "parse",
      signal,
      params: {
        model: "claude-haiku-5-5",
        max_tokens: CHAT.rewriteMaxTokens,
        output_config: { effort: "low" },
      },
    });
    const params = calls[0]!.params as { output_config: { format: unknown }; system: string };
    expect(params.output_config.format).toBeDefined();
    expect(params.system).toContain('"react-native"');
  });

  it.each([
    ["a refusal", parsedReply(null, "refusal")],
    ["unparseable output", parsedReply(null)],
    ["an empty question", parsedReply({ standaloneQuestion: "  ", frameworks: ["jest"] })],
  ])("falls back to the original question on %s, keeping the usage", async (_name, reply) => {
    const { client } = fakeClient({ parse: async () => reply });
    const result = await createClaudeQueryRewriter({ client, model: "m" }).rewrite({
      question: "Original?",
      history: [],
    });
    expect(result).toEqual({
      standaloneQuestion: "Original?",
      frameworks: [],
      usage: { inputTokens: 50, outputTokens: 20 },
    });
  });

  it("falls back and reports the error when the API call fails", async () => {
    const errors: unknown[] = [];
    const { client } = fakeClient({
      parse: async () => {
        throw new Error("overloaded");
      },
    });
    const result = await createClaudeQueryRewriter({
      client,
      model: "m",
      onError: (e) => errors.push(e),
    }).rewrite({ question: "Original?", history: [] });

    expect(result.standaloneQuestion).toBe("Original?");
    expect(errors).toHaveLength(1);
  });

  it("rethrows when the request was aborted instead of falling back", async () => {
    const controller = new AbortController();
    const { client } = fakeClient({
      parse: async () => {
        controller.abort();
        throw new Error("Request was aborted.");
      },
    });
    await expect(
      createClaudeQueryRewriter({ client, model: "m" }).rewrite(
        { question: "Q?", history: [] },
        controller.signal,
      ),
    ).rejects.toThrow("aborted");
  });
});

describe("createClaudeAnswerModel", () => {
  const finalMessage = {
    model: "claude-sonnet-5-5",
    stop_reason: "end_turn",
    usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 300 },
  };

  it("forwards only text deltas, then usage, with effort, fallbacks and the abort signal", async () => {
    const { client, calls } = fakeClient({
      streamEvents: [
        { type: "message_start" },
        { type: "content_block_start", content_block: { type: "thinking" } },
        { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } },
        { type: "content_block_delta", delta: { type: "text_delta", text: "Use " } },
        { type: "content_block_delta", delta: { type: "text_delta", text: "revalidate [1]." } },
        { type: "message_stop" },
      ],
      finalMessage,
    });
    const signal = new AbortController().signal;
    const model = createClaudeAnswerModel({ client, model: "claude-sonnet-5-5", effort: "low" });

    const events: AnswerEvent[] = [];
    for await (const event of model.stream({ system: "SYS", user: "USER" }, signal)) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text", text: "Use " },
      { type: "text", text: "revalidate [1]." },
      {
        type: "done",
        usage: { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 300 },
        stopReason: "end_turn",
        model: "claude-sonnet-5-5",
      },
    ]);
    expect(calls[0]).toEqual({
      method: "stream",
      signal,
      params: {
        model: "claude-sonnet-5-5",
        max_tokens: CHAT.answerMaxTokens,
        system: "SYS",
        messages: [{ role: "user", content: "USER" }],
        output_config: { effort: "low" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      },
    });
  });

  it("reports zero cache-read tokens when the API omits them", async () => {
    const { client } = fakeClient({
      finalMessage: { ...finalMessage, usage: { input_tokens: 1, output_tokens: 1 } },
    });
    const events: AnswerEvent[] = [];
    for await (const event of createClaudeAnswerModel({ client, model: "m", effort: "low" }).stream(
      {
        system: "",
        user: "",
      },
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      expect.objectContaining({ usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } }),
    ]);
  });
});
