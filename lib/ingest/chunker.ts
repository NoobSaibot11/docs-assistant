import GithubSlugger from "github-slugger";
import type { Heading, Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { unified } from "unified";

import { CHUNKING } from "@/lib/config";
import { nodeText, type CleanedDoc } from "@/lib/ingest/mdx-clean";
import { estimateTokens, tokensToChars } from "@/lib/ingest/tokens";

export interface DocChunk {
  ordinal: number;
  /** "Doc title > Section > Subsection" */
  headingPath: string;
  /** Slug of the closest section heading, for deep links (null for the intro). */
  anchor: string | null;
  content: string;
  tokenCount: number;
}

export interface ChunkingOptions {
  minTokens: number;
  maxTokens: number;
  overlapTokens: number;
}

interface Section {
  path: string[];
  anchor: string | null;
  depth: number;
  /** Markdown of each block in the section, in order. */
  blocks: string[];
}

/** Headings at or above this depth start a new section; deeper ones stay inside the content. */
const SECTION_MAX_DEPTH = 3;
const PATH_SEPARATOR = " > ";

const stringifier = unified()
  .use(remarkGfm)
  .use(remarkStringify, { bullet: "-", fence: "`", fences: true, rule: "-", emphasis: "_" })
  .freeze();

function toMarkdown(node: RootContent): string {
  const root: Root = { type: "root", children: [node] };
  return stringifier.stringify(root).trim();
}

/** Page title: frontmatter `title`, else the first h1, else the fallback (file name). */
export function documentTitle(doc: CleanedDoc, fallback: string): string {
  const fromFrontmatter = doc.frontmatter["title"];
  if (typeof fromFrontmatter === "string" && fromFrontmatter.trim()) return fromFrontmatter.trim();
  const h1 = doc.root.children.find(
    (node): node is Heading => node.type === "heading" && node.depth === 1,
  );
  return h1 ? nodeText(h1).trim() : fallback;
}

export function chunkDocument(
  doc: CleanedDoc,
  title: string,
  options: ChunkingOptions = CHUNKING,
): DocChunk[] {
  const sections = mergeSmallSections(splitSections(doc, title), options);
  const chunks: DocChunk[] = [];
  for (const section of sections) {
    for (const content of packSection(section.blocks, options)) {
      chunks.push({
        ordinal: chunks.length,
        headingPath: section.path.join(PATH_SEPARATOR),
        anchor: section.anchor,
        content,
        tokenCount: estimateTokens(content),
      });
    }
  }
  return chunks;
}

/** Splits the page into sections at h1–h3 headings, tracking the heading path and anchor. */
function splitSections(doc: CleanedDoc, title: string): Section[] {
  // Slug every heading in page order (like the docs sites do) so duplicate titles get -1, -2...
  const slugger = new GithubSlugger();
  const stack: { depth: number; text: string }[] = [];
  const sections: Section[] = [{ path: [title], anchor: null, depth: 0, blocks: [] }];
  let titleHeadingSeen = false;

  for (const node of doc.root.children) {
    if (node.type !== "heading") {
      sections.at(-1)?.blocks.push(toMarkdown(node));
      continue;
    }

    const text = nodeText(node).trim();
    const line = node.position?.start.line;
    const anchor = (line !== undefined && doc.customIds.get(line)) || slugger.slug(text);

    // The page's own h1 repeats the title; it isn't a section.
    if (node.depth === 1 && !titleHeadingSeen && text === title) {
      titleHeadingSeen = true;
      continue;
    }
    if (node.depth > SECTION_MAX_DEPTH) {
      sections.at(-1)?.blocks.push(toMarkdown(node));
      continue;
    }

    while (stack.length > 0 && (stack.at(-1)?.depth ?? 0) >= node.depth) stack.pop();
    stack.push({ depth: node.depth, text });
    sections.push({
      path: [title, ...stack.map((s) => s.text)],
      anchor,
      depth: node.depth,
      blocks: [],
    });
  }

  // A heading followed straight by a sub-heading has no content of its own.
  return sections.filter((section) => section.blocks.length > 0);
}

/**
 * Small sections make weak retrieval units, so a section under minTokens absorbs its following
 * sub-sections (with their headings inline) while it stays under maxTokens. Siblings are never
 * merged: the chunk's anchor must point at the heading that actually contains its content.
 */
function mergeSmallSections(sections: Section[], options: ChunkingOptions): Section[] {
  const merged: Section[] = [];
  for (const section of sections) {
    const current = merged.at(-1);
    if (current && canAbsorb(current, section, options)) {
      current.blocks.push(
        `${"#".repeat(section.depth)} ${section.path.at(-1) ?? ""}`,
        ...section.blocks,
      );
    } else {
      merged.push({ ...section, blocks: [...section.blocks] });
    }
  }
  return merged;
}

function canAbsorb(current: Section, next: Section, options: ChunkingOptions): boolean {
  // `next` must be a descendant of `current`: its path extends current's path.
  if (current.depth === 0 || next.path.length <= current.path.length) return false;
  if (!current.path.every((part, i) => next.path[i] === part)) return false;
  const size = estimateTokens(current.blocks.join("\n\n"));
  if (size >= options.minTokens) return false;
  return size + estimateTokens(next.blocks.join("\n\n")) <= options.maxTokens;
}

/** Greedily packs blocks into chunks of at most maxTokens, with a short prose overlap. */
function packSection(blocks: string[], options: ChunkingOptions): string[] {
  const pieces = blocks.flatMap((block) => splitOversized(block, options.maxTokens));
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;

  for (const piece of pieces) {
    const pieceSize = estimateTokens(piece);
    if (current.length > 0 && size + pieceSize > options.maxTokens) {
      chunks.push(current.join("\n\n"));
      const overlap = overlapFrom(current.at(-1) ?? "", options.overlapTokens);
      current =
        overlap && estimateTokens(overlap) + pieceSize <= options.maxTokens ? [overlap] : [];
      size = estimateTokens(current.join("\n\n"));
    }
    current.push(piece);
    size += pieceSize;
  }
  if (current.length > 0) chunks.push(current.join("\n\n"));
  return chunks;
}

/**
 * The tail of the previous chunk's last block, cut at a sentence or word boundary. Code blocks
 * aren't used for overlap: cutting one would leave an unbalanced fence.
 */
export function overlapFrom(block: string, overlapTokens: number): string | null {
  if (overlapTokens <= 0 || isCodeBlock(block)) return null;
  const maxChars = tokensToChars(overlapTokens);
  if (block.length <= maxChars) return block;
  const tail = block.slice(-maxChars);
  const sentenceStart = tail.search(/(?<=[.!?])\s+\S/);
  const wordStart = tail.indexOf(" ");
  const start = sentenceStart >= 0 ? sentenceStart : wordStart;
  return `…${tail.slice(start >= 0 ? start : 0).trim()}`;
}

function isCodeBlock(markdown: string): boolean {
  return /^(```|~~~)/.test(markdown);
}

/** Splits a block over maxTokens: code by lines (re-fenced), prose by lines then sentences. */
export function splitOversized(block: string, maxTokens: number): string[] {
  if (estimateTokens(block) <= maxTokens) return [block];

  if (isCodeBlock(block)) {
    const lines = block.split("\n");
    const open = lines[0] ?? "```";
    const close =
      lines.at(-1)?.trim() === open.match(/^(`+|~+)/)?.[0] ? (lines.at(-1) ?? "```") : "```";
    const body = lines.slice(1, -1);
    const budget = maxTokens - estimateTokens(`${open}\n${close}`) - 1;
    return groupUnits(body, budget, "\n").map((group) => `${open}\n${group}\n${close}`);
  }

  const units = block
    .split("\n")
    .flatMap((line) => (estimateTokens(line) <= maxTokens ? [line] : line.split(/(?<=[.!?])\s+/)))
    .flatMap((unit) => (estimateTokens(unit) <= maxTokens ? [unit] : hardSplit(unit, maxTokens)));
  return groupUnits(units, maxTokens, "\n");
}

function groupUnits(units: string[], maxTokens: number, joiner: string): string[] {
  const groups: string[] = [];
  let current: string[] = [];
  for (const unit of units.flatMap((u) =>
    estimateTokens(u) <= maxTokens ? [u] : hardSplit(u, maxTokens),
  )) {
    const candidate = [...current, unit].join(joiner);
    if (current.length > 0 && estimateTokens(candidate) > maxTokens) {
      groups.push(current.join(joiner));
      current = [unit];
    } else {
      current.push(unit);
    }
  }
  if (current.length > 0) groups.push(current.join(joiner));
  return groups;
}

function hardSplit(text: string, maxTokens: number): string[] {
  const size = tokensToChars(maxTokens);
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts;
}
