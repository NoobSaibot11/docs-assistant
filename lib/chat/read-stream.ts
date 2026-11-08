import { parseEventLine, type ChatEvent } from "@/lib/chat/protocol";

/**
 * Turns a /api/chat response body into validated events. Lines can be split across network
 * chunks, so text is buffered until a newline. A malformed line throws (the caller shows an
 * error) rather than being skipped silently.
 */
export async function* readChatEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ChatEvent, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line !== "") yield parseEventLine(line);
        newline = buffer.indexOf("\n");
      }
      if (done) break;
    }
    if (buffer.trim() !== "") yield parseEventLine(buffer.trim());
  } finally {
    reader.releaseLock();
  }
}
