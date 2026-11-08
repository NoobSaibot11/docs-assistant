"use client";

import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import shell from "highlight.js/lib/languages/shell";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { memo, useMemo } from "react";
import Markdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import type { PluggableList } from "unified";

import { CodeBlock } from "@/components/chat/code-block";
import { CitationMarker } from "@/components/citations/citation-marker";
import { SourcesContext } from "@/components/citations/sources-context";
import type { Source } from "@/lib/chat/protocol";
import { remarkCitations } from "@/lib/citations/remark-citations";

/** Only the languages these docs use, so highlight.js stays small. Aliases (ts, tsx, js, jsx, sh, html…) come with them. */
const LANGUAGES = { bash, css, diff, javascript, json, shell, typescript, xml, yaml };

const HIGHLIGHT_OPTIONS = {
  languages: LANGUAGES,
  // Unlabelled blocks stay plain: guessing the language is slow and often wrong on partial code.
  detect: false,
  plainText: ["text", "txt", "plain"],
};

const REHYPE_PLUGINS: PluggableList = [[rehypeHighlight, HIGHLIGHT_OPTIONS]];

const components: Components = {
  pre: ({ node, children }) => <CodeBlock node={node}>{children}</CodeBlock>,
  // Docs chunks contain repo-relative links (e.g. "ManualMocks.md") that the model sometimes
  // copies; they'd 404 here, so only absolute web links stay clickable.
  a: ({ node: _node, children, href, ...props }) =>
    href && /^https?:\/\//i.test(href) ? (
      <a {...props} href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  sup: ({ node: _node, children, ...props }) => {
    const n = Number((props as Record<string, unknown>)["data-citation"]);
    return Number.isInteger(n) && n > 0 ? (
      <CitationMarker n={n} />
    ) : (
      <sup {...props}>{children}</sup>
    );
  },
  table: ({ node: _node, children, ...props }) => (
    <div className="my-3 overflow-x-auto">
      <table {...props}>{children}</table>
    </div>
  ),
};

/**
 * Renders an answer's Markdown, including while it streams in.
 *
 * Partial input is safe by construction: CommonMark treats an unclosed ``` fence as a code block
 * that runs to the end of the text, so half-streamed code renders as code instead of breaking the
 * layout; a half-written `[1` or `**bold` shows as plain text until it completes. Raw HTML in the
 * model's output is dropped (`skipHtml`), never rendered.
 */
export const StreamingMarkdown = memo(function StreamingMarkdown({
  text,
  sources,
  streaming = false,
}: {
  text: string;
  sources: readonly Source[];
  streaming?: boolean;
}) {
  const remarkPlugins = useMemo<PluggableList>(
    () => [remarkGfm, [remarkCitations, { sourceCount: sources.length }]],
    [sources.length],
  );

  return (
    <SourcesContext.Provider value={sources}>
      <div className="markdown" data-streaming={streaming || undefined}>
        <Markdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={REHYPE_PLUGINS}
          components={components}
          skipHtml
        >
          {text}
        </Markdown>
      </div>
    </SourcesContext.Provider>
  );
});
