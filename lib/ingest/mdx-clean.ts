import type { Code, Html, Nodes, Paragraph, PhrasingContent, Root, RootContent } from "mdast";
import type {} from "mdast-util-mdx";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { parse as parseYaml } from "yaml";

/**
 * Turns a raw Markdown/MDX docs page into a clean mdast tree: frontmatter, imports/exports,
 * {expressions} and JSX/HTML tags removed (their text kept), Docusaurus admonition markers and
 * duplicate JS code samples dropped. Everything is done on the syntax tree, never with regexes on
 * the raw file, so code blocks are never touched.
 */

export interface CleanStats {
  parsedAs: "mdx" | "md";
  /** JSX element names that were unwrapped or dropped, with counts (for the dry-run report). */
  jsx: Record<string, number>;
  /** Angular `<docs-code path="...">` embeds whose example file isn't inlined (yet). */
  docsCodeRefs: number;
}

export interface CleanedDoc {
  root: Root;
  frontmatter: Record<string, unknown>;
  /** Docusaurus-style custom heading ids (`## Title {#my-id}`), keyed by the heading's line. */
  customIds: Map<number, string>;
  stats: CleanStats;
}

/** JSX components whose content is dropped entirely rather than unwrapped. */
const DROP_JSX = new Set([
  // Next.js: shared pages show this content only on the Pages Router version.
  "PagesOnly",
]);

/** Icon components that carry meaning (Next.js support tables use ✓/✗ icons) become words. */
const REPLACE_JSX = new Map([
  ["Check", "Yes"],
  ["Cross", "No"],
]);

const CUSTOM_ID = /^(#{1,6}\s.*?)\s*\{#([\w-]+)\}\s*$/;
const FENCE = /^\s*(```|~~~)/;
const ADMONITION_LINE = /^:::[^\n]*(\n|$)/gm;

const PHRASING_TYPES = new Set([
  "text",
  "emphasis",
  "strong",
  "delete",
  "inlineCode",
  "link",
  "linkReference",
  "image",
  "imageReference",
  "break",
  "footnoteReference",
  "mdxJsxTextElement",
  "mdxTextExpression",
]);

/** Parents whose children are block content (so stray inline content must be wrapped). */
const BLOCK_PARENTS = new Set(["root", "blockquote", "listItem", "footnoteDefinition"]);

type ParentNode = Extract<Nodes, { children: unknown }>;

const baseProcessor = () =>
  unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]).use(remarkGfm);
const mdParser = baseProcessor().freeze();
const mdxParser = baseProcessor().use(remarkMdx).freeze();

export function cleanDocument(raw: string, options: { syntax: "mdx" | "md" }): CleanedDoc {
  const { text, customIds } = extractCustomIds(raw.replace(/\r\n?/g, "\n"));

  let root: Root;
  let parsedAs: "mdx" | "md" = options.syntax;
  if (options.syntax === "mdx") {
    try {
      root = mdxParser.parse(text);
    } catch {
      // Some .md pages in MDX sites aren't valid MDX (e.g. HTML comments); read them as Markdown.
      root = mdParser.parse(text);
      parsedAs = "md";
    }
  } else {
    root = mdParser.parse(text);
  }

  const state: CleanState = { frontmatter: {}, stats: { parsedAs, jsx: {}, docsCodeRefs: 0 } };
  cleanParent(root, state);
  return { root, frontmatter: state.frontmatter, customIds, stats: state.stats };
}

interface CleanState {
  frontmatter: Record<string, unknown>;
  stats: CleanStats;
}

/** Strips `{#id}` from heading lines (outside code fences) and remembers it by line number. */
function extractCustomIds(text: string): { text: string; customIds: Map<number, string> } {
  const customIds = new Map<number, string>();
  let inFence = false;
  const lines = text.split("\n").map((line, index) => {
    if (FENCE.test(line)) inFence = !inFence;
    if (inFence) return line;
    const match = CUSTOM_ID.exec(line);
    if (!match?.[1] || !match[2]) return line;
    customIds.set(index + 1, match[2]);
    return match[1];
  });
  return { text: lines.join("\n"), customIds };
}

function cleanParent(parent: ParentNode, state: CleanState): void {
  const blockLevel = BLOCK_PARENTS.has(parent.type);
  const next: Nodes[] = [];

  for (const child of parent.children as Nodes[]) {
    switch (child.type) {
      case "yaml": {
        const data: unknown = parseYaml(child.value);
        if (data && typeof data === "object") state.frontmatter = data as Record<string, unknown>;
        break;
      }
      case "mdxjsEsm":
      case "mdxFlowExpression":
      case "mdxTextExpression":
      case "image":
      case "imageReference":
        break;
      case "mdxJsxFlowElement":
      case "mdxJsxTextElement": {
        const name = child.name ?? "<>";
        state.stats.jsx[name] = (state.stats.jsx[name] ?? 0) + 1;
        if (DROP_JSX.has(name)) break;
        const replacement = REPLACE_JSX.get(name);
        if (replacement) {
          next.push({ type: "text", value: replacement });
          break;
        }
        cleanParent(child, state);
        next.push(...(child.children as Nodes[]));
        break;
      }
      case "html":
        next.push(...cleanHtml(child, blockLevel, state));
        break;
      case "code": {
        if (isDuplicateJsSample(child, next.at(-1))) break;
        if (child.meta) child.meta = child.meta.replace(/\bswitcher\b/, "").trim() || null;
        next.push(child);
        break;
      }
      case "text": {
        const value = child.value.replace(ADMONITION_LINE, "");
        if (value.trim() !== "" || value === child.value) next.push({ ...child, value });
        break;
      }
      default:
        if ("children" in child) cleanParent(child, state);
        if (child.type === "paragraph" || child.type === "heading") normalizeInline(child.children);
        if (!isEmptyParagraph(child)) next.push(child);
    }
  }

  parent.children = (blockLevel ? wrapStrayPhrasing(next) : next) as typeof parent.children;
}

/** Next.js shows each sample twice (TS + JS) behind a `switcher`; keep only the TS one. */
function isDuplicateJsSample(code: Code, previous: Nodes | undefined): boolean {
  if (!code.meta?.includes("switcher") || !["js", "jsx"].includes(code.lang ?? "")) return false;
  // The TS twin was already kept (and its `switcher` flag stripped), so match on its language.
  return previous?.type === "code" && ["ts", "tsx"].includes(previous.lang ?? "");
}

/** Removes HTML tags but keeps their text; a `title="..."` attribute becomes a bold line. */
function cleanHtml(node: Html, blockLevel: boolean, state: CleanState): Nodes[] {
  if (/<docs-code\b[^>]*\bpath=/.test(node.value)) state.stats.docsCodeRefs++;
  const title = /\btitle="([^"]+)"/.exec(node.value)?.[1];

  // Angular pages put their title on <docs-decorative-header title="..."> instead of frontmatter.
  const isPageHeader = /<docs-decorative-header\b/.test(node.value);
  if (isPageHeader && title && typeof state.frontmatter["title"] !== "string") {
    state.frontmatter["title"] = title;
  }

  const text = node.value
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .trim();
  if (!blockLevel) return text ? [{ type: "text", value: text }] : [];

  const out: Paragraph[] = [];
  if (title && !isPageHeader) {
    out.push({
      type: "paragraph",
      children: [{ type: "strong", children: [{ type: "text", value: title }] }],
    });
  }
  if (text) out.push({ type: "paragraph", children: [{ type: "text", value: text }] });
  return out;
}

/** Unwrapped JSX can leave inline nodes directly in a block container; wrap them in paragraphs. */
function wrapStrayPhrasing(nodes: Nodes[]): Nodes[] {
  const out: Nodes[] = [];
  let run: PhrasingContent[] = [];
  const flush = () => {
    if (run.some((n) => n.type !== "text" || n.value.trim() !== "")) {
      out.push({ type: "paragraph", children: run });
    }
    run = [];
  };
  for (const node of nodes) {
    if (PHRASING_TYPES.has(node.type)) {
      run.push(node as PhrasingContent);
    } else {
      flush();
      out.push(node);
    }
  }
  flush();
  return out;
}

/**
 * After tags are stripped, a paragraph can start or end with whitespace-only text (which would be
 * serialized as `&#x20;`). Merge adjacent text nodes and trim the paragraph's outer edges.
 */
function normalizeInline(children: PhrasingContent[]): void {
  for (let i = children.length - 1; i > 0; i--) {
    const current = children[i];
    const previous = children[i - 1];
    if (current?.type === "text" && previous?.type === "text") {
      previous.value += current.value;
      children.splice(i, 1);
    }
  }
  const first = children[0];
  if (first?.type === "text") first.value = first.value.trimStart();
  const last = children.at(-1);
  if (last?.type === "text") last.value = last.value.trimEnd();
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (child?.type === "text" && child.value === "") children.splice(i, 1);
  }
}

function isEmptyParagraph(node: Nodes): boolean {
  return (
    node.type === "paragraph" &&
    node.children.every((child) => child.type === "text" && child.value.trim() === "")
  );
}

/** Plain text of a node (used for heading text). */
export function nodeText(node: Nodes | RootContent): string {
  if ("value" in node && (node.type === "text" || node.type === "inlineCode")) return node.value;
  if ("children" in node) return (node.children as Nodes[]).map(nodeText).join("");
  return "";
}
