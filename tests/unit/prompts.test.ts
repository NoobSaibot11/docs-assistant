import { describe, expect, it } from "vitest";

import { ChatRequestSchema } from "@/lib/chat/protocol";
import { CHAT } from "@/lib/config";
import {
  ANSWER_SYSTEM_PROMPT,
  buildAnswerUserMessage,
  formatContext,
  isNotFoundAnswer,
  NOT_FOUND_ANSWER,
} from "@/lib/llm/prompts";
import { formatRewriteInput } from "@/lib/llm/rewrite-query";
import { makeResult } from "@/tests/helpers/chat";

describe("answer prompt", () => {
  it("tells the model to use only the context, cite [n], and use the exact not-found sentence", () => {
    expect(ANSWER_SYSTEM_PROMPT).toContain("Answer only from the numbered context");
    expect(ANSWER_SYSTEM_PROMPT).toContain("[1]");
    expect(ANSWER_SYSTEM_PROMPT).toContain(NOT_FOUND_ANSWER);
  });

  it("numbers each chunk with its framework, heading path and URL", () => {
    const results = [
      makeResult({ headingPath: "Caching > Revalidating", content: "Use revalidate." }),
      makeResult({
        framework: "jest",
        headingPath: "Timer Mocks",
        url: "https://jestjs.io/docs/timer-mocks",
        content: "Call jest.useFakeTimers().",
      }),
    ];
    const context = formatContext(results);
    expect(context).toContain("[1] Next.js: Caching > Revalidating\nSource: https://nextjs.org");
    expect(context).toContain(
      "[2] Jest: Timer Mocks\nSource: https://jestjs.io/docs/timer-mocks\n\nCall jest.useFakeTimers().",
    );

    const message = buildAnswerUserMessage("How do I revalidate?", results);
    expect(message.startsWith("<context>\n[1]")).toBe(true);
    expect(message.endsWith("</context>\n\nQuestion: How do I revalidate?")).toBe(true);
  });

  it("detects the not-found sentence only at the start of the answer", () => {
    expect(isNotFoundAnswer(`  ${NOT_FOUND_ANSWER}\n`)).toBe(true);
    expect(isNotFoundAnswer("Use revalidate [1].")).toBe(false);
    expect(isNotFoundAnswer(`Some text. ${NOT_FOUND_ANSWER}`)).toBe(false);
  });
});

describe("formatRewriteInput", () => {
  it("includes the conversation before the latest question", () => {
    const input = formatRewriteInput("What about on-demand?", [
      { role: "user", content: "How do I revalidate data?" },
      { role: "assistant", content: "Use revalidate [1]." },
    ]);
    expect(input).toBe(
      "<conversation>\nUser: How do I revalidate data?\n\nAssistant: Use revalidate [1].\n</conversation>\n\n" +
        "<latest_question>\nWhat about on-demand?\n</latest_question>",
    );
  });

  it("omits the conversation block without history and shortens long turns", () => {
    expect(formatRewriteInput("Q?", [])).toBe("<latest_question>\nQ?\n</latest_question>");
    const long = "x".repeat(CHAT.maxHistoryMessageChars + 50);
    const input = formatRewriteInput("Q?", [{ role: "assistant", content: long }]);
    expect(input).toContain(`${"x".repeat(CHAT.maxHistoryMessageChars)}…`);
    expect(input).not.toContain("x".repeat(CHAT.maxHistoryMessageChars + 1));
  });
});

describe("ChatRequestSchema", () => {
  it("trims the question and applies defaults", () => {
    expect(ChatRequestSchema.parse({ question: "  How?  " })).toEqual({
      question: "How?",
      history: [],
      frameworks: [],
    });
  });

  it("keeps only the most recent history turns and de-duplicates frameworks", () => {
    const history = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `turn ${i}`,
    }));
    const parsed = ChatRequestSchema.parse({
      question: "Q",
      history,
      frameworks: ["jest", "jest"],
    });
    expect(parsed.history).toHaveLength(CHAT.historyMessages);
    expect(parsed.history.at(-1)?.content).toBe("turn 9");
    expect(parsed.frameworks).toEqual(["jest"]);
  });

  it.each([
    [{ question: "" }],
    [{ question: "   " }],
    [{ question: "x".repeat(CHAT.maxQuestionChars + 1) }],
    [{ question: "Q", frameworks: ["remix"] }],
    [{ question: "Q", history: [{ role: "system", content: "hi" }] }],
    [{}],
  ])("rejects invalid input %#", (input) => {
    expect(ChatRequestSchema.safeParse(input).success).toBe(false);
  });
});
