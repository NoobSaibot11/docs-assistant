import { parseEventLine, type ChatEvent } from "@/lib/chat/protocol";
import type { FrameworkId } from "@/lib/frameworks";
import type { SearchResult } from "@/lib/retrieval/types";

/** Reads a whole NDJSON chat stream into validated events. */
export async function readEvents(stream: ReadableStream<Uint8Array>): Promise<ChatEvent[]> {
  const text = await new Response(stream).text();
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map(parseEventLine);
}

/** Reads events one at a time, so a test can act (abort, cancel) mid-stream. */
export function eventReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    reader,
    /** The next event, or null when the stream has ended. */
    async next(): Promise<ChatEvent | null> {
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          return parseEventLine(line);
        }
        const { value, done } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
      }
    },
  };
}

let nextId = 1;

export function makeResult(
  overrides: Partial<SearchResult> & { framework?: FrameworkId } = {},
): SearchResult {
  const id = nextId++;
  return {
    chunkId: `chunk-${id}`,
    documentId: `doc-${id}`,
    framework: "nextjs",
    sourcePath: `docs/page-${id}.mdx`,
    title: `Page ${id}`,
    url: `https://nextjs.org/docs/page-${id}#section`,
    headingPath: `Page ${id} > Section`,
    anchor: "section",
    content: `Content of chunk ${id}.`,
    rank: 1,
    score: 0.8,
    similarity: 0.8,
    ...overrides,
  };
}
