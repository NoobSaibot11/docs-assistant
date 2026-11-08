import { FRAMEWORK_IDS, type FrameworkId } from "@/lib/frameworks";
import type { SearchResult } from "@/lib/retrieval/types";

/**
 * The exact sentence used when the docs don't cover a question: sent as-is on the "not found"
 * path, and the answer model is told to reply with it, so both cases can be detected.
 */
export const NOT_FOUND_ANSWER = "I couldn't find this in the docs.";

export const FRAMEWORK_NAMES: Record<FrameworkId, string> = {
  "react-native": "React Native",
  nextjs: "Next.js",
  angular: "Angular",
  jest: "Jest",
};

/**
 * Answer prompt. Kept free of per-request values so it can be cached later (Phase 6); the
 * numbered context and the question go in the user message.
 */
export const ANSWER_SYSTEM_PROMPT = `You answer developer questions about the official React Native, Next.js, Angular and Jest documentation.

Rules:
- Answer only from the numbered context in the user's message. Don't use outside knowledge, even if you know the answer.
- Cite the context passages you used with their numbers in square brackets, like [1] or [2][3], placed right after the sentence or code block they support. Cite only numbers that appear in the context.
- If the context doesn't contain the answer, reply with exactly this sentence and nothing else: "${NOT_FOUND_ANSWER}"
- If the context answers only part of the question, answer that part and say plainly what the docs provided don't cover.
- Keep frameworks apart: don't apply one framework's APIs to another unless the context says they work together.
- Write in Markdown. Put code in fenced code blocks with a language tag. Be direct and concise; skip preambles like "Based on the context".`;

/** One context passage, numbered as the model will cite it. */
export function formatContext(results: readonly SearchResult[]): string {
  return results
    .map((r, i) =>
      [
        `[${i + 1}] ${FRAMEWORK_NAMES[r.framework]}: ${r.headingPath}`,
        `Source: ${r.url}`,
        "",
        r.content,
      ].join("\n"),
    )
    .join("\n\n---\n\n");
}

export function buildAnswerUserMessage(question: string, results: readonly SearchResult[]): string {
  return `<context>\n${formatContext(results)}\n</context>\n\nQuestion: ${question}`;
}

/** True when the model said the context doesn't cover the question. */
export function isNotFoundAnswer(text: string): boolean {
  return text.trim().startsWith(NOT_FOUND_ANSWER);
}

export const REWRITE_SYSTEM_PROMPT = `You prepare search queries for a documentation assistant that covers these frameworks: ${FRAMEWORK_IDS.map((id) => `"${id}" (${FRAMEWORK_NAMES[id]})`).join(", ")}.

Given the latest user question and any earlier conversation:
1. standaloneQuestion: rewrite the latest question so it can be understood without the conversation (resolve "it", "that", "the second one", and carry over the framework or API being discussed). If it already stands alone, return it unchanged. Don't answer it and don't add facts.
2. frameworks: the ids of the frameworks the question is about. Use the conversation when the question itself doesn't say. Return several ids when the question spans frameworks (e.g. testing a Next.js component with Jest), and an empty list when it isn't about any of them or you can't tell.`;
