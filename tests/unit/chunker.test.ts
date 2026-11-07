import { describe, expect, it } from "vitest";

import { chunkDocument, documentTitle, overlapFrom, splitOversized } from "@/lib/ingest/chunker";
import { cleanDocument } from "@/lib/ingest/mdx-clean";
import { estimateTokens } from "@/lib/ingest/tokens";

const OPTIONS = { minTokens: 300, maxTokens: 500, overlapTokens: 50 };

function chunks(raw: string, options = OPTIONS) {
  const doc = cleanDocument(raw, { syntax: "mdx" });
  return chunkDocument(doc, documentTitle(doc, "fallback"), options);
}

/** A paragraph of roughly `tokens` tokens made of short sentences. */
const prose = (tokens: number, word = "alpha") =>
  Array.from({ length: Math.ceil((tokens * 4) / 24) }, (_, i) => `The ${word} sentence ${i}.`).join(
    " ",
  );

describe("documentTitle", () => {
  it("prefers frontmatter, then the first h1, then the fallback", () => {
    const title = (raw: string) =>
      documentTitle(cleanDocument(raw, { syntax: "mdx" }), "file-name");
    expect(title("---\ntitle: From frontmatter\n---\n\n# Heading")).toBe("From frontmatter");
    expect(title("# From heading\n\nText.")).toBe("From heading");
    expect(title("Just text.")).toBe("file-name");
  });
});

describe("chunkDocument", () => {
  it("builds heading paths and anchors from h2/h3 headings", () => {
    const result = chunks(
      "---\ntitle: Caching\n---\n\nIntro.\n\n## Data Cache\n\nA.\n\n### Revalidating\n\nB.\n\n## Router Cache\n\nC.",
    );
    expect(result.map((c) => [c.headingPath, c.anchor])).toEqual([
      ["Caching", null],
      // "Revalidating" is small and a child of "Data Cache", so it's merged in with its heading.
      ["Caching > Data Cache", "data-cache"],
      ["Caching > Router Cache", "router-cache"],
    ]);
    expect(result[1]?.content).toBe("A.\n\n### Revalidating\n\nB.");
  });

  it("never merges sibling sections, so anchors always match their content", () => {
    const result = chunks("# Doc\n\n## One\n\nShort.\n\n## Two\n\nAlso short.");
    expect(result.map((c) => c.anchor)).toEqual(["one", "two"]);
  });

  it("keeps a sub-section separate when the parent is already large", () => {
    const result = chunks(`# Doc\n\n## Big\n\n${prose(320)}\n\n### Child\n\nChild text.`);
    expect(result.map((c) => c.headingPath)).toEqual(["Doc > Big", "Doc > Big > Child"]);
  });

  it("skips the page's own h1 and de-duplicates repeated heading anchors", () => {
    const result = chunks("# Mock Functions\n\nIntro.\n\n## Example\n\nOne.\n\n## Example\n\nTwo.");
    expect(result.map((c) => [c.headingPath, c.anchor])).toEqual([
      ["Mock Functions", null],
      ["Mock Functions > Example", "example"],
      ["Mock Functions > Example", "example-1"],
    ]);
  });

  it("uses Docusaurus custom heading ids as anchors", () => {
    const result = chunks("# Doc\n\n## Using a mock function {#using-a-mock}\n\nText.");
    expect(result.at(-1)?.anchor).toBe("using-a-mock");
  });

  it("keeps h4+ headings inside the section's content", () => {
    const result = chunks("# Doc\n\n## Section\n\nText.\n\n#### Detail\n\nMore.");
    expect(result.at(-1)?.content).toContain("#### Detail");
    expect(result.at(-1)?.headingPath).toBe("Doc > Section");
  });

  it("drops headings that have no content of their own", () => {
    const result = chunks("# Doc\n\n## Empty\n\n### Child\n\nText.");
    expect(result.map((c) => c.headingPath)).toEqual(["Doc > Empty > Child"]);
  });

  it("splits long sections into chunks under maxTokens, with an overlap", () => {
    const paragraphs = Array.from({ length: 6 }, (_, i) => prose(150, `p${i}`)).join("\n\n");
    const result = chunks(`# Doc\n\n## Long\n\n${paragraphs}`);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(OPTIONS.maxTokens);
      expect(chunk.tokenCount).toBe(estimateTokens(chunk.content));
      expect(chunk.headingPath).toBe("Doc > Long");
    }
    // The second chunk starts with the tail of the first one.
    expect(result[1]?.content.startsWith("…")).toBe(true);
    expect(result.map((c) => c.ordinal)).toEqual(result.map((_, i) => i));
  });

  it("splits an oversized code block between lines and re-fences every piece", () => {
    const code = Array.from({ length: 200 }, (_, i) => `const value${i} = compute(${i});`).join(
      "\n",
    );
    const result = chunks(`# Doc\n\n## Code\n\n\`\`\`ts\n${code}\n\`\`\``);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.content.startsWith("```ts\n")).toBe(true);
      expect(chunk.content.endsWith("\n```")).toBe(true);
      expect(chunk.tokenCount).toBeLessThanOrEqual(OPTIONS.maxTokens);
    }
    const lines = result.flatMap((c) => c.content.split("\n").filter((l) => l.startsWith("const")));
    expect(lines).toHaveLength(200);
  });
});

describe("overlapFrom", () => {
  it("returns a short block whole", () => {
    expect(overlapFrom("Short block.", 50)).toBe("Short block.");
  });

  it("cuts a long block at a sentence boundary", () => {
    const result = overlapFrom(prose(200), 50) ?? "";
    expect(result.startsWith("…The alpha sentence")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(50 * 4 + 1);
  });

  it("never overlaps from a code block", () => {
    expect(overlapFrom("```js\nconst a = 1\n```", 50)).toBeNull();
  });
});

describe("splitOversized", () => {
  it("leaves blocks under the limit alone", () => {
    expect(splitOversized("Small.", 500)).toEqual(["Small."]);
  });

  it("splits one huge line of prose by sentences", () => {
    const pieces = splitOversized(prose(1200), 500);
    expect(pieces.length).toBeGreaterThan(2);
    for (const piece of pieces) expect(estimateTokens(piece)).toBeLessThanOrEqual(500);
  });
});
