"use client";

import type { Element, ElementContent } from "hast";
import { useEffect, useState, type ReactNode } from "react";

/** Plain text of a hast subtree (the highlighted <code> is split into many spans). */
export function hastText(node: ElementContent | Element): string {
  if (node.type === "text") return node.value;
  if ("children" in node) return node.children.map(hastText).join("");
  return "";
}

/** The fence's language, from the `language-xxx` class remark-rehype puts on <code>. */
export function codeLanguage(pre: Element | undefined): string | null {
  const code = pre?.children.find(
    (child): child is Element => child.type === "element" && child.tagName === "code",
  );
  const classes = code?.properties.className;
  const list = Array.isArray(classes) ? classes.map(String) : [];
  const lang = list.find((c) => c.startsWith("language-"));
  return lang ? lang.slice("language-".length) : null;
}

/** A fenced code block: language label, copy button, horizontally scrollable body. */
export function CodeBlock({ node, children }: { node?: Element; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const language = codeLanguage(node);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    if (!node) return;
    try {
      await navigator.clipboard.writeText(hastText(node).replace(/\n$/, ""));
      setCopied(true);
    } catch {
      // Clipboard access denied (e.g. insecure context): nothing useful to show.
    }
  };

  return (
    <div className="code-block group relative my-3 overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
      <div className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-3 py-1 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
        <span className="font-mono">{language ?? "code"}</span>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={copied ? "Copied" : "Copy code"}
          className="rounded px-1.5 py-0.5 font-medium hover:bg-zinc-200 hover:text-zinc-800 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto bg-white p-3 text-[13px] leading-relaxed dark:bg-zinc-950">
        {children}
      </pre>
    </div>
  );
}
