"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ChatEvent, ChatRequestInput, Source } from "@/lib/chat/protocol";
import { readChatEvents } from "@/lib/chat/read-stream";
import { CHAT } from "@/lib/config";
import type { FrameworkId } from "@/lib/frameworks";

export type FrameworkFilter = "all" | FrameworkId;

type MetaEvent = Extract<ChatEvent, { type: "meta" }>;
type DoneEvent = Extract<ChatEvent, { type: "done" }>;

export type AnswerStatus = "searching" | "streaming" | "done" | "error" | "stopped";

export interface Turn {
  id: string;
  question: string;
  filter: FrameworkFilter;
  /** History sent with this question (kept so Retry sends exactly the same request). */
  history: NonNullable<ChatRequestInput["history"]>;
  status: AnswerStatus;
  text: string;
  meta?: MetaEvent;
  done?: DoneEvent;
  error?: string;
  /** The user's thumbs up/down, once sent. */
  feedback?: "up" | "down";
}

const NETWORK_ERROR = "Couldn't reach the server. Check your connection and try again.";

/** Sources the answer cited, in citation order (empty until the answer is done). */
export function citedSources(turn: Turn): Source[] {
  if (!turn.done || !turn.meta) return [];
  const byN = new Map(turn.meta.sources.map((s) => [s.n, s]));
  return turn.done.citations.flatMap((c) => byN.get(c.n) ?? []);
}

/** History for the next question: completed turns only, as user/assistant pairs. */
export function historyFrom(turns: readonly Turn[]): Turn["history"] {
  return turns
    .filter((t) => t.status === "done")
    .flatMap((t) => [
      { role: "user" as const, content: t.question },
      { role: "assistant" as const, content: t.text },
    ])
    .slice(-CHAT.historyMessages);
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // not JSON
  }
  return `The server returned an error (${response.status}).`;
}

/**
 * Chat state: a list of question/answer turns, streamed from /api/chat.
 *
 * Text deltas are buffered and applied once per animation frame, so a fast stream re-renders
 * the Markdown at most ~60 times a second instead of once per token.
 */
export function useChat() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const turnsRef = useRef(turns);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

  // Abort any in-flight request when the page unmounts.
  useEffect(() => () => controllerRef.current?.abort(), []);

  const update = useCallback((id: string, patch: (turn: Turn) => Partial<Turn>) => {
    setTurns((all) => all.map((t) => (t.id === id ? { ...t, ...patch(t) } : t)));
  }, []);

  const run = useCallback(
    async (turn: Turn) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      let pending = "";
      let frame: number | null = null;
      const flush = () => {
        frame = null;
        if (pending === "") return;
        const chunk = pending;
        pending = "";
        update(turn.id, (t) => ({ text: t.text + chunk, status: "streaming" }));
      };
      const schedule = () => {
        frame ??= requestAnimationFrame(flush);
      };
      const finish = (patch: Partial<Turn>) => {
        if (frame !== null) cancelAnimationFrame(frame);
        flush();
        update(turn.id, () => patch);
      };

      const body: ChatRequestInput = {
        question: turn.question,
        history: turn.history,
        frameworks: turn.filter === "all" ? [] : [turn.filter],
      };

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          finish({ status: "error", error: await errorMessage(response) });
          return;
        }

        let ended = false;
        for await (const event of readChatEvents(response.body)) {
          if (event.type === "meta") {
            update(turn.id, () => ({ meta: event }));
          } else if (event.type === "text") {
            pending += event.text;
            schedule();
          } else if (event.type === "done") {
            finish({ status: "done", done: event });
            ended = true;
          } else {
            finish({ status: "error", error: event.message });
            ended = true;
          }
        }
        if (!ended) finish({ status: "error", error: "The answer was cut off. Please try again." });
      } catch (error) {
        if (controller.signal.aborted) finish({ status: "stopped" });
        else {
          console.error(error);
          finish({ status: "error", error: NETWORK_ERROR });
        }
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
      }
    },
    [update],
  );

  const ask = useCallback(
    (question: string, filter: FrameworkFilter) => {
      const trimmed = question.trim();
      if (trimmed === "" || controllerRef.current) return;
      const turn: Turn = {
        id: crypto.randomUUID(),
        question: trimmed,
        filter,
        history: historyFrom(turnsRef.current),
        status: "searching",
        text: "",
      };
      setTurns((all) => [...all, turn]);
      void run(turn);
    },
    [run],
  );

  /** Re-sends the last question with the same history and filter. */
  const retry = useCallback(() => {
    const last = turnsRef.current.at(-1);
    if (!last || controllerRef.current) return;
    const reset: Turn = {
      ...last,
      status: "searching",
      text: "",
      meta: undefined,
      done: undefined,
      error: undefined,
    };
    setTurns((all) => [...all.slice(0, -1), reset]);
    void run(reset);
  }, [run]);

  const stop = useCallback(() => controllerRef.current?.abort(), []);

  /** Sends thumbs up/down for an answer; the UI updates immediately and reverts on failure. */
  const rate = useCallback(
    async (id: string, rating: "up" | "down") => {
      const turn = turnsRef.current.find((t) => t.id === id);
      const queryId = turn?.done?.queryId;
      if (!turn || !queryId) return;
      const previous = turn.feedback;
      update(id, () => ({ feedback: rating }));
      try {
        const response = await fetch("/api/feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ queryId, rating }),
        });
        if (!response.ok) throw new Error(`feedback failed: ${response.status}`);
      } catch (error) {
        console.error(error);
        update(id, () => ({ feedback: previous }));
      }
    },
    [update],
  );

  const clear = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setTurns([]);
  }, []);

  const last = turns.at(-1);
  const busy = last?.status === "searching" || last?.status === "streaming";

  return { turns, busy, ask, retry, stop, clear, rate };
}
