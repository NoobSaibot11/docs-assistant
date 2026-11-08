import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StreamingMarkdown } from "@/components/chat/streaming-markdown";
import type { Source } from "@/lib/chat/protocol";

const sources: Source[] = [1, 2, 3].map((n) => ({
  n,
  chunkId: `c${n}`,
  framework: "nextjs",
  title: `Page ${n}`,
  headingPath: `Page ${n} > Section`,
  url: `https://nextjs.org/docs/p${n}#s`,
  excerpt: `Excerpt ${n}`,
}));

const render = (text: string, srcs: Source[] = sources) =>
  renderToStaticMarkup(<StreamingMarkdown text={text} sources={srcs} />);

/** Every prefix of `text`, as the UI sees it while streaming. */
const prefixes = (text: string) =>
  Array.from({ length: text.length + 1 }, (_, i) => text.slice(0, i));

const ANSWER = [
  "Set **`revalidate`** on the fetch [1][2]:",
  "",
  "```ts",
  "const res = await fetch(url, { next: { revalidate: 60 } })",
  "const first = items[1]",
  "```",
  "",
  "| Option | Value |",
  "| --- | --- |",
  "| `revalidate` | `60` [3] |",
  "",
  "See [the docs](https://nextjs.org/docs) [1, 3].",
].join("\n");

describe("StreamingMarkdown", () => {
  it("turns citation markers into buttons and leaves code alone", () => {
    const html = render(ANSWER);
    expect(html.match(/data-citation="\d"/g)).toEqual([
      'data-citation="1"',
      'data-citation="2"',
      'data-citation="3"',
      'data-citation="1"',
      'data-citation="3"',
    ]);
    expect(html).toContain('aria-label="Source 1: Page 1"');
    // items[1] inside the code block is not a citation.
    expect(html).toContain('items[<span class="hljs-number">1</span>]');
  });

  it("highlights labelled code blocks and adds a copy button with the language", () => {
    const html = render(ANSWER);
    expect(html).toContain('class="hljs language-ts"');
    expect(html).toContain("hljs-keyword");
    expect(html).toContain('<span class="font-mono">ts</span>');
    expect(html).toContain('aria-label="Copy code"');
  });

  it("renders GFM tables in a scroll container and links in a new tab", () => {
    const html = render(ANSWER);
    expect(html).toMatch(/<div class="my-3 overflow-x-auto"><table>/);
    expect(html).toContain('<a href="https://nextjs.org/docs" target="_blank" rel="noreferrer">');
  });

  it("renders every partial prefix of an answer without throwing", () => {
    for (const prefix of prefixes(ANSWER)) expect(() => render(prefix)).not.toThrow();
  });

  it("keeps an unclosed code fence as a code block while it streams", () => {
    const partial = "Use this:\n\n```ts\nconst a = 1;\nconst b = [1, 2";
    const html = render(partial);
    expect(html).toContain("<pre");
    expect(html).toContain("const");
    expect(html).not.toContain("data-citation"); // [1, 2 inside the open fence is code
    // Text after the fence is still inside the block, not loose paragraphs.
    expect(html.indexOf("Use this:")).toBeLessThan(html.indexOf("<pre"));
  });

  it("shows a half-written marker as text until it closes", () => {
    expect(render("Use revalidate [")).toContain("Use revalidate [");
    expect(render("Use revalidate [1")).not.toContain("data-citation");
    expect(render("Use revalidate [1]")).toContain('data-citation="1"');
  });

  it("keeps markers that point past the sources as plain text", () => {
    const html = render("Claim [4] and [2].", sources.slice(0, 2));
    expect(html).toContain("Claim [4]");
    expect(html.match(/data-citation/g)).toHaveLength(1);
  });

  it("keeps only absolute web links clickable", () => {
    const html = render(
      "See [manual mocks](ManualMocks.md), [anchor](#x), [js](javascript:alert(1)) and [site](https://jestjs.io/docs).",
    );
    expect(html).toContain("<span>manual mocks</span>");
    expect(html).toContain("<span>anchor</span>");
    expect(html).not.toContain("javascript:");
    expect(html).toContain(
      '<a href="https://jestjs.io/docs" target="_blank" rel="noreferrer">site</a>',
    );
  });

  it("drops raw HTML from the model instead of rendering it", () => {
    const html = render('Hi <script>alert(1)</script><img src=x onerror="alert(1)"> there [1]');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("there");
  });
});
