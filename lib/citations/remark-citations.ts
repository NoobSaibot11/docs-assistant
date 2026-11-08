import type { Data, Node, Parent, PhrasingContent, Root, Text } from "mdast";

import { CITATION_MARKER } from "@/lib/citations/parse";

/** A citation marker in the Markdown tree; rendered as <sup data-citation="n">. */
export interface CitationNode extends Node {
  type: "citation";
  n: number;
  data: Data & { hName: "sup"; hProperties: { dataCitation: number } };
}

declare module "mdast" {
  interface PhrasingContentMap {
    citation: CitationNode;
  }
  interface RootContentMap {
    citation: CitationNode;
  }
}

/** Nodes whose text must stay literal: code, and link text (a marker inside a link can't be a button). */
const SKIP = new Set(["code", "inlineCode", "link", "linkReference", "html"]);

function citation(n: number): CitationNode {
  return { type: "citation", n, data: { hName: "sup", hProperties: { dataCitation: n } } };
}

/** Splits one text node into text + citation nodes. Groups with no valid number stay as text. */
export function splitCitations(value: string, maxN: number): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  let last = 0;
  const pushText = (text: string) => {
    if (text === "") return;
    const prev = out.at(-1);
    if (prev?.type === "text") prev.value += text;
    else out.push({ type: "text", value: text } satisfies Text);
  };

  for (const match of value.matchAll(CITATION_MARKER)) {
    const numbers = (match[1] ?? "")
      .split(",")
      .map((part) => Number(part.trim()))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= maxN);
    if (numbers.length === 0) continue;
    pushText(value.slice(last, match.index));
    for (const n of numbers) out.push(citation(n));
    last = match.index + match[0].length;
  }
  pushText(value.slice(last));
  return out;
}

function hasChildren(node: Node): node is Parent {
  return Array.isArray((node as Partial<Parent>).children);
}

function transform(parent: Parent, maxN: number): void {
  const children: Node[] = [];
  for (const child of parent.children) {
    if (child.type === "text") {
      children.push(...splitCitations((child as Text).value, maxN));
    } else {
      if (!SKIP.has(child.type) && hasChildren(child)) transform(child, maxN);
      children.push(child);
    }
  }
  parent.children = children as Parent["children"];
}

/**
 * remark plugin: turns [n], [n][m] and [n, m] in prose into citation nodes, for 1 ≤ n ≤ sourceCount.
 * Code, inline code and link text are left alone, matching `citedNumbers` in parse.ts.
 */
export function remarkCitations(options: { sourceCount: number }) {
  return (tree: Root) => {
    if (options.sourceCount > 0) transform(tree, options.sourceCount);
  };
}
