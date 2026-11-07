import type { Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { describe, expect, it } from "vitest";

import { cleanDocument } from "@/lib/ingest/mdx-clean";

const toMd = (root: Root) => unified().use(remarkGfm).use(remarkStringify).stringify(root).trim();
const clean = (raw: string, syntax: "mdx" | "md" = "mdx") => {
  const doc = cleanDocument(raw, { syntax });
  return { ...doc, md: toMd(doc.root) };
};

describe("cleanDocument", () => {
  it("moves frontmatter into an object and removes it from the content", () => {
    const { frontmatter, md } = clean("---\ntitle: Caching\nid: caching\n---\n\nBody text.");
    expect(frontmatter).toEqual({ title: "Caching", id: "caching" });
    expect(md).toBe("Body text.");
  });

  it("removes MDX imports but keeps import lines inside code blocks", () => {
    const { md } = clean(
      "import Tabs from '@theme/Tabs';\n\nIntro.\n\n```js\nimport {forEach} from './forEach';\n```",
    );
    expect(md).not.toContain("@theme/Tabs");
    expect(md).toContain("import {forEach} from './forEach';");
  });

  it("removes {expressions} such as MDX comments", () => {
    const { md } = clean("{/* internal note */}\n\nVisible text.");
    expect(md).toBe("Visible text.");
  });

  it("unwraps JSX components, keeps their text, and counts them", () => {
    const { md, stats } = clean(
      "<AppOnly>\n\nApp Router only.\n\n</AppOnly>\n\nSee <Kbd>Ctrl</Kbd>.",
    );
    expect(md).toContain("App Router only.");
    expect(md).toContain("See Ctrl.");
    expect(md).not.toMatch(/<\/?(AppOnly|Kbd)/);
    expect(stats.jsx).toEqual({ AppOnly: 1, Kbd: 1 });
  });

  it("turns ✓/✗ icon components in tables into Yes/No", () => {
    const { md } = clean(
      "| Feature | Supported |\n| --- | --- |\n| Streaming | <Check size={18} /> |\n| Export | <Cross size={18} /> |",
    );
    expect(md).toContain("| Streaming | Yes ");
    expect(md).toContain("| Export    | No ");
  });

  it("drops PagesOnly content entirely", () => {
    const { md } = clean("Shared.\n\n<PagesOnly>\n\nPages Router only.\n\n</PagesOnly>");
    expect(md).toBe("Shared.");
  });

  it("keeps the TS sample of a switcher pair and drops the JS twin", () => {
    const { md } = clean(
      '```tsx filename="app/page.tsx" switcher\nconst a: number = 1\n```\n\n```jsx filename="app/page.js" switcher\nconst a = 1\n```',
    );
    expect(md).toContain('```tsx filename="app/page.tsx"\nconst a: number = 1');
    expect(md).not.toContain("app/page.js");
    expect(md).not.toContain("switcher");
  });

  it("keeps a JS block that isn't part of a switcher pair", () => {
    const { md } = clean("```js\nconst a = 1\n```");
    expect(md).toContain("const a = 1");
  });

  it("strips Docusaurus admonition markers but keeps the text", () => {
    const { md } = clean(":::tip\n\nUse fake timers.\n\n:::");
    expect(md).toBe("Use fake timers.");
  });

  it("records custom heading ids by line and removes them from the heading", () => {
    const doc = clean("Intro.\n\n## Using a mock {#using-a-mock}\n\nText.");
    expect(doc.customIds.get(3)).toBe("using-a-mock");
    expect(doc.md).toContain("## Using a mock\n");
  });

  it("ignores {#id} inside code blocks", () => {
    const doc = clean("```md\n## Heading {#keep-me}\n```");
    expect(doc.customIds.size).toBe(0);
    expect(doc.md).toContain("{#keep-me}");
  });

  it("falls back to plain Markdown when an .md page isn't valid MDX", () => {
    const { stats, md } = clean("<!-- a comment -->\n\nText after the comment.");
    expect(stats.parsedAs).toBe("md");
    expect(md).toBe("Text after the comment.");
  });

  describe("HTML (Angular docs)", () => {
    it("takes the page title from <docs-decorative-header>", () => {
      const { frontmatter, md } = clean(
        '<docs-decorative-header title="Angular Signals" imgSrc="x.svg"> <!-- lint -->\nSignals track state.\n</docs-decorative-header>',
        "md",
      );
      expect(frontmatter["title"]).toBe("Angular Signals");
      expect(md).toBe("Signals track state.");
    });

    it("keeps a callout's title as bold text and strips its tags", () => {
      const { md } = clean(
        '<docs-callout important title="Signals are synchronous">\nNo subscription needed.\n</docs-callout>',
        "md",
      );
      expect(md).toBe("**Signals are synchronous**\n\nNo subscription needed.");
    });

    it("counts <docs-code path> embeds it can't inline", () => {
      const { stats } = clean('<docs-code path="adev/src/content/examples/a.ts" />', "md");
      expect(stats.docsCodeRefs).toBe(1);
    });
  });

  it("removes images", () => {
    const { md } = clean("Before ![diagram](/img.png) after.");
    expect(md).toBe("Before  after.");
  });
});
