import { describe, expect, it } from "vitest";

import { assertSafeRelativePath } from "@/lib/ingest/fetch-source";
import {
  extractRegion,
  localMarkdownImports,
  resolveIncludes,
  resolveRelative,
  type IncludeReaders,
} from "@/lib/ingest/includes";

function readers(docs: Record<string, string>, repo: Record<string, string> = {}): IncludeReaders {
  const read = (files: Record<string, string>) => async (p: string) => {
    const content = files[p];
    if (content === undefined) throw new Error(`ENOENT ${p}`);
    return content;
  };
  return { readDocFile: read(docs), readRepoFile: read(repo) };
}

describe("extractRegion", () => {
  const code = [
    "// #docplaster",
    "import {a} from 'a';",
    "// #docregion imports, setup",
    "import {b} from 'b';",
    "// #enddocregion imports",
    "const setup = 1;",
    "// #enddocregion setup",
    "class C {",
    "  // #docregion body",
    "  method() {",
    "    return 1;",
    "  }",
    "  // #enddocregion body",
    "  // #docregion body",
    "  other() {}",
    "  // #enddocregion",
    "}",
  ].join("\n");

  it("joins every span of a region, drops markers and dedents", () => {
    expect(extractRegion(code, "body")).toBe("method() {\n  return 1;\n}\nother() {}");
  });

  it("handles regions opened together and closed separately", () => {
    expect(extractRegion(code, "imports")).toBe("import {b} from 'b';");
    expect(extractRegion(code, "setup")).toBe("import {b} from 'b';\nconst setup = 1;");
  });

  it("returns the whole file without markers when there is no region or it isn't found", () => {
    for (const result of [extractRegion(code), extractRegion(code, "missing")]) {
      expect(result).not.toMatch(/docregion|docplaster/);
      expect(result.startsWith("import {a} from 'a';")).toBe(true);
      expect(result.endsWith("}")).toBe(true);
    }
  });

  it("understands HTML and CSS comment markers", () => {
    const html =
      "<!-- #docregion tpl -->\n<p>Hi</p>\n<!-- #enddocregion tpl -->\n<footer></footer>";
    expect(extractRegion(html, "tpl")).toBe("<p>Hi</p>");
    const css = "/* #docregion s */\np { color: red; }\n/* #enddocregion s */";
    expect(extractRegion(css, "s")).toBe("p { color: red; }");
  });
});

describe("localMarkdownImports", () => {
  it("finds .md/.mdx imports outside code blocks and unescapes underscores", () => {
    const text = [
      "import Tabs from '@theme/Tabs';",
      "import Guide from './\\_getting-started.md';",
      "import Note from '../shared/_note.mdx'",
      "",
      "```js",
      "import Fake from './_inside-code.md';",
      "```",
    ].join("\n");
    expect([...localMarkdownImports(text)]).toEqual([
      ["Guide", "./_getting-started.md"],
      ["Note", "../shared/_note.mdx"],
    ]);
  });
});

describe("resolveRelative", () => {
  it("resolves against the importing file's directory", () => {
    expect(resolveRelative("guides/setup.md", "./_a.md")).toBe("guides/_a.md");
    expect(resolveRelative("guides/setup.md", "../arch/_b.mdx")).toBe("arch/_b.mdx");
    expect(resolveRelative("setup.md", "./_c.md")).toBe("_c.md");
  });
});

describe("resolveIncludes", () => {
  it("inlines MDX partials (nested ones too), without their frontmatter and imports", async () => {
    const page = [
      "import Guide from './_guide.md';",
      "",
      "<Tabs>",
      '<TabItem value="ios">',
      "<Guide />",
      "</TabItem>",
      "</Tabs>",
    ].join("\n");
    const { text, stats } = await resolveIncludes(
      "setup.md",
      page,
      readers({
        "_guide.md": "---\ntitle: x\n---\nimport Step from './_step.md';\n\n## Install\n\n<Step/>",
        "_step.md": "Run `npm install`.",
      }),
    );
    expect(text).toContain("## Install\n\n\n\nRun `npm install`.");
    expect(text).not.toContain("<Guide");
    expect(text).not.toContain("title: x");
    expect(text).not.toContain("import Step");
    expect(stats).toEqual({ partials: 2, codeExamples: 0, missing: [] });
  });

  it("keeps the tag and reports a partial that can't be read", async () => {
    const { text, stats } = await resolveIncludes(
      "a.md",
      "import Gone from './_gone.md';\n\n<Gone />",
      readers({}),
    );
    expect(text).toContain("<Gone />");
    expect(stats.missing).toEqual(["_gone.md"]);
  });

  it("inlines <docs-code path> as a fenced block with its header and region", async () => {
    const page = [
      "Intro.",
      "",
      '<docs-code header="app.ts" path="examples/app.ts" region="main"/>',
      "",
      '<docs-code language="ts" path="examples/plain.txt"></docs-code>',
      "",
      '<docs-code-multifile path="examples/app.ts">',
      '  <docs-code path="examples/view.html"/>',
      "</docs-code-multifile>",
      "",
      '<docs-code header="inline.ts">const x = 1;</docs-code>',
    ].join("\n");
    const { text, stats } = await resolveIncludes(
      "guide/x.md",
      page,
      readers(
        {},
        {
          "examples/app.ts": "// #docregion main\nbootstrap();\n// #enddocregion main\nextra();",
          "examples/plain.txt": "hello",
          "examples/view.html": "<p>view</p>",
        },
      ),
    );
    expect(text).toContain("**app.ts**\n\n```ts\nbootstrap();\n```");
    expect(text).not.toContain("extra();");
    expect(text).toContain("**plain.txt**\n\n```ts\nhello\n```");
    expect(text).toContain("**view.html**\n\n```html\n<p>view</p>\n```");
    // The multifile wrapper and inline docs-code (no path) are left for the cleaner.
    expect(text).toContain('<docs-code-multifile path="examples/app.ts">');
    expect(text).toContain('<docs-code header="inline.ts">const x = 1;</docs-code>');
    expect(stats).toEqual({ partials: 0, codeExamples: 3, missing: [] });
  });

  it("never rewrites inside fenced code blocks", async () => {
    const page = [
      "import Guide from './_guide.md';",
      "",
      "````md",
      "<Guide />",
      '<docs-code path="examples/app.ts"/>',
      "```",
      "still code",
      "````",
    ].join("\n");
    const { text, stats } = await resolveIncludes(
      "a.md",
      page,
      readers({ "_guide.md": "GUIDE" }, { "examples/app.ts": "CODE" }),
    );
    expect(text).toBe(page);
    expect(stats.partials + stats.codeExamples).toBe(0);
  });
});

describe("assertSafeRelativePath", () => {
  it.each(["/etc/passwd", "../secrets", "a/../../b"])("rejects %s", (p) => {
    expect(() => assertSafeRelativePath(p)).toThrow("Unsafe include path");
  });

  it("accepts plain relative paths", () => {
    expect(() => assertSafeRelativePath("adev/src/content/examples/a.ts")).not.toThrow();
  });
});
