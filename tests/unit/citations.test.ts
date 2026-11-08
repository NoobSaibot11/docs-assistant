import { describe, expect, it } from "vitest";

import { buildCitations, citedNumbers, maskCode } from "@/lib/citations/parse";

describe("citedNumbers", () => {
  it("finds single, adjacent and comma-separated markers in order of first use", () => {
    expect(citedNumbers("Use revalidate [2]. Also see [1][3] and [3, 4].", 5)).toEqual([
      2, 1, 3, 4,
    ]);
  });

  it("ignores numbers outside the source range", () => {
    expect(citedNumbers("See [0], [6] and [1, 9].", 5)).toEqual([1]);
  });

  it("ignores brackets that aren't citations", () => {
    expect(citedNumbers("A [link](https://x.dev) and [note] and [1a].", 5)).toEqual([]);
  });

  it("ignores indexes inside inline code and fenced code blocks", () => {
    const text = [
      "Read `items[1]` first [2].",
      "```ts",
      "const first = items[1];",
      "```",
      "Done [3].",
    ].join("\n");
    expect(citedNumbers(text, 5)).toEqual([2, 3]);
  });

  it("treats an unclosed fence (mid-stream) as code to the end", () => {
    expect(citedNumbers("Intro [1].\n```js\nconst a = b[2];", 5)).toEqual([1]);
  });

  it("handles tilde fences", () => {
    expect(citedNumbers("~~~\nx[1]\n~~~\nText [2]", 5)).toEqual([2]);
  });
});

describe("maskCode", () => {
  it("keeps the text length and line breaks", () => {
    const text = "a `b[1]` c\n```\nd[2]\n```\ne";
    const masked = maskCode(text);
    expect(masked).toHaveLength(text.length);
    expect(masked.split("\n")).toHaveLength(text.split("\n").length);
    expect(masked).not.toContain("[");
  });
});

describe("buildCitations", () => {
  const sources = [
    { chunkId: "a", url: "https://x.dev/a" },
    { chunkId: "b", url: "https://x.dev/b#h" },
    { chunkId: "c", url: "https://x.dev/c" },
  ];

  it("maps markers to chunk ids and URLs", () => {
    expect(buildCitations("First [2], then [1][2].", sources)).toEqual([
      { n: 2, chunkId: "b", url: "https://x.dev/b#h" },
      { n: 1, chunkId: "a", url: "https://x.dev/a" },
    ]);
  });

  it("returns nothing when there are no sources or markers", () => {
    expect(buildCitations("No citations here.", sources)).toEqual([]);
    expect(buildCitations("Stray [1].", [])).toEqual([]);
  });
});
