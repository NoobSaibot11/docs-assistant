/**
 * The /api/chat wire format, shared by the route and the browser (no server-only imports).
 *
 * Request: JSON body (ChatRequest). Response: NDJSON, one ChatEvent per line, in this order:
 *   meta → text* → done        (normal and "not found" answers)
 *   meta? → text* → error      (a failure; the stream ends after it)
 */
import { z } from "zod";

import { CHAT } from "@/lib/config";
import { FRAMEWORK_IDS } from "@/lib/frameworks";

export const ChatTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(20_000),
});

export const ChatRequestSchema = z.object({
  question: z.string().trim().min(1, "Ask a question").max(CHAT.maxQuestionChars),
  /** Earlier turns, oldest first. Only the last CHAT.historyMessages are used. */
  history: z
    .array(ChatTurnSchema)
    .max(100)
    .default([])
    .transform((turns) => turns.slice(-CHAT.historyMessages)),
  /** The UI filter. Empty or omitted means "All": frameworks are detected from the question. */
  frameworks: z
    .array(z.enum(FRAMEWORK_IDS))
    .max(FRAMEWORK_IDS.length)
    .default([])
    .transform((ids) => [...new Set(ids)]),
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;
export type ChatRequestInput = z.input<typeof ChatRequestSchema>;

export const SourceSchema = z.object({
  /** Marker number: [n] in the answer refers to this source. */
  n: z.number().int().positive(),
  chunkId: z.string(),
  framework: z.enum(FRAMEWORK_IDS),
  title: z.string(),
  headingPath: z.string(),
  url: z.string(),
  /** Start of the chunk's text, for the citation popover. */
  excerpt: z.string(),
});

export const CitationSchema = z.object({
  n: z.number().int().positive(),
  chunkId: z.string(),
  url: z.string(),
});

export const UsageSchema = z.object({
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cacheReadTokens: z.number().int(),
  rewriteInputTokens: z.number().int(),
  rewriteOutputTokens: z.number().int(),
});

export const OUTCOMES = ["answered", "not_found", "aborted", "error"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const ChatEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("meta"),
    /** The question as searched (rewritten when there was history). */
    question: z.string(),
    frameworks: z.array(z.enum(FRAMEWORK_IDS)),
    /** "user": the filter; "detected": tagged from the question; "all": no filter applied. */
    frameworksSource: z.enum(["user", "detected", "all"]),
    sources: z.array(SourceSchema),
  }),
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("done"),
    /** False when the docs didn't cover the question (threshold or the model said so). */
    answered: z.boolean(),
    outcome: z.enum(["answered", "not_found"]),
    /** Only the sources the answer actually cites, in order of first citation. */
    citations: z.array(CitationSchema),
    usage: UsageSchema,
    topSimilarity: z.number(),
    /** For feedback (POST /api/feedback); null if the request couldn't be logged. */
    queryId: z.string().nullable(),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

export type ChatEvent = z.infer<typeof ChatEventSchema>;
export type Source = z.infer<typeof SourceSchema>;

export const NDJSON_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";

export function encodeEvent(event: ChatEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/** Parses one NDJSON line; throws on malformed input. */
export function parseEventLine(line: string): ChatEvent {
  return ChatEventSchema.parse(JSON.parse(line));
}
