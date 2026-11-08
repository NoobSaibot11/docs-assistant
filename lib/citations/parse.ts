/**
 * Citation markers in an answer: [1], [2][3] or [1, 2]. Pure functions, shared by the API (to
 * build the final citations event) and the UI (to turn markers into links).
 */

/** Matches one bracket group of comma-separated numbers: "[1]" or "[1, 2]". */
export const CITATION_MARKER = /\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g;

/**
 * Code is not prose: `arr[1]` inside a code span or fenced block is an index, not a citation.
 * Replaces fenced blocks (closed or still open while streaming) and inline code spans with
 * spaces, keeping offsets intact.
 */
export function maskCode(text: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return text
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm, blank)
    .replace(/`[^`\n]+`/g, blank);
}

/** Marker numbers cited in the text, in order of first appearance, limited to 1..sourceCount. */
export function citedNumbers(text: string, sourceCount: number): number[] {
  const seen = new Set<number>();
  for (const match of maskCode(text).matchAll(CITATION_MARKER)) {
    for (const part of (match[1] ?? "").split(",")) {
      const n = Number(part.trim());
      if (Number.isInteger(n) && n >= 1 && n <= sourceCount) seen.add(n);
    }
  }
  return [...seen];
}

export interface Citation {
  /** The marker number, 1-based: [n] refers to sources[n - 1]. */
  n: number;
  chunkId: string;
  url: string;
}

/** Maps the markers used in an answer to the chunks they point at. */
export function buildCitations(
  text: string,
  sources: readonly { chunkId: string; url: string }[],
): Citation[] {
  return citedNumbers(text, sources.length).map((n) => {
    const source = sources[n - 1]!;
    return { n, chunkId: source.chunkId, url: source.url };
  });
}
