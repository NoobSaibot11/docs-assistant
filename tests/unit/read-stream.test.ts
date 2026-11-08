import { describe, expect, it } from "vitest";

import { citedSources, historyFrom, type Turn } from "@/components/chat/use-chat";
import { encodeEvent, type ChatEvent } from "@/lib/chat/protocol";
import { readChatEvents } from "@/lib/chat/read-stream";
import { CHAT } from "@/lib/config";

/** A body that delivers `text` in the given byte-sized pieces, like a slow network. */
function bodyOf(text: string, pieceSize: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += pieceSize) {
        controller.enqueue(bytes.slice(i, i + pieceSize));
      }
      controller.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of readChatEvents(body)) events.push(event);
  return events;
}

const EVENTS: ChatEvent[] = [
  { type: "text", text: "Ünïcödé ✓ and emoji 🚀 split across chunks " },
  { type: "text", text: "[1]" },
  { type: "error", message: "boom" },
];

describe("readChatEvents", () => {
  it.each([1, 3, 7, 1000])("reassembles events split into %i-byte pieces", async (size) => {
    const text = EVENTS.map(encodeEvent).join("");
    expect(await collect(bodyOf(text, size))).toEqual(EVENTS);
  });

  it("accepts a final line without a trailing newline and skips blank lines", async () => {
    const text = `\n${encodeEvent(EVENTS[0]!)}\n${JSON.stringify(EVENTS[1])}`;
    expect(await collect(bodyOf(text, 5))).toEqual(EVENTS.slice(0, 2));
  });

  it("throws on a malformed line instead of skipping it", async () => {
    await expect(collect(bodyOf('{"type":"text"}\n', 100))).rejects.toThrow();
    await expect(collect(bodyOf("not json\n", 100))).rejects.toThrow();
  });
});

function turn(overrides: Partial<Turn>): Turn {
  return {
    id: "t",
    question: "Q",
    filter: "all",
    history: [],
    status: "done",
    text: "A",
    ...overrides,
  };
}

describe("historyFrom", () => {
  it("sends completed turns only, as user/assistant pairs, capped to the history limit", () => {
    const turns = [
      turn({ question: "q1", text: "a1" }),
      turn({ question: "q2", text: "partial", status: "stopped" }),
      turn({ question: "q3", text: "", status: "error" }),
      ...Array.from({ length: 5 }, (_, i) => turn({ question: `q${i + 4}`, text: `a${i + 4}` })),
    ];
    const history = historyFrom(turns);
    expect(history).toHaveLength(CHAT.historyMessages);
    expect(history.at(-1)).toEqual({ role: "assistant", content: "a8" });
    expect(history.some((h) => h.content === "partial" || h.content === "q3")).toBe(false);
  });
});

describe("citedSources", () => {
  const source = (n: number) => ({
    n,
    chunkId: `c${n}`,
    framework: "jest" as const,
    title: "T",
    headingPath: "H",
    url: `https://jestjs.io/docs/${n}`,
    excerpt: "E",
  });
  const meta: Extract<ChatEvent, { type: "meta" }> = {
    type: "meta",
    question: "Q",
    frameworks: [],
    frameworksSource: "all",
    sources: [source(1), source(2), source(3)],
  };
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    rewriteInputTokens: 0,
    rewriteOutputTokens: 0,
  };

  it("lists cited sources in citation order once the answer is done", () => {
    const done: Extract<ChatEvent, { type: "done" }> = {
      type: "done",
      answered: true,
      outcome: "answered",
      citations: [
        { n: 3, chunkId: "c3", url: "u" },
        { n: 1, chunkId: "c1", url: "u" },
      ],
      usage,
      topSimilarity: 0.6,
      queryId: null,
    };
    expect(citedSources(turn({ meta, done })).map((s) => s.n)).toEqual([3, 1]);
  });

  it("is empty while streaming", () => {
    expect(citedSources(turn({ meta, status: "streaming" }))).toEqual([]);
  });
});
