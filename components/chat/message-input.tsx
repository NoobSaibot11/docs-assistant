"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { CHAT } from "@/lib/config";

/** Question box: Enter sends, Shift+Enter adds a line. While an answer streams, Send becomes Stop. */
export function MessageInput({
  busy,
  onSend,
  onStop,
}: {
  busy: boolean;
  onSend: (question: string) => void;
  onStop: () => void;
}) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const tooLong = value.length > CHAT.maxQuestionChars;
  const canSend = !busy && value.trim() !== "" && !tooLong;

  // Focus the box again once an answer finishes.
  useEffect(() => {
    if (!busy) textareaRef.current?.focus();
  }, [busy]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!canSend) return;
    onSend(value);
    setValue("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form
      onSubmit={submit}
      className="flex items-end gap-2 rounded-xl border border-zinc-300 bg-white p-2 shadow-sm focus-within:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:focus-within:border-zinc-500"
    >
      <label htmlFor="question" className="sr-only">
        Ask a question about the docs
      </label>
      <textarea
        id="question"
        ref={textareaRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        rows={1}
        placeholder="Ask about React Native, Next.js, Angular or Jest…"
        aria-invalid={tooLong || undefined}
        aria-describedby={tooLong ? "question-error" : undefined}
        className="[field-sizing:content] max-h-48 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] placeholder:text-zinc-400 focus:outline-none"
      />
      {busy ? (
        <button
          type="button"
          onClick={onStop}
          className="h-9 shrink-0 rounded-lg border border-zinc-300 px-3 text-sm font-medium hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-zinc-600 dark:hover:bg-zinc-800"
        >
          Stop
        </button>
      ) : (
        <button
          type="submit"
          disabled={!canSend}
          className="h-9 shrink-0 rounded-lg bg-zinc-900 px-3 text-sm font-medium text-white hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          Send
        </button>
      )}
      {tooLong && (
        <p id="question-error" className="sr-only">
          Questions can be up to {CHAT.maxQuestionChars} characters.
        </p>
      )}
    </form>
  );
}
