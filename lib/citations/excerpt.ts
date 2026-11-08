/**
 * A short plain-text preview of a chunk for the citation popover. Chunks are Markdown, and
 * `[Next.js Commerce](https://…)` or ``` fences read badly as raw text, so the common syntax is
 * stripped. Deliberately light: it only needs to look right in a 5-line preview.
 */
export function markdownExcerpt(markdown: string, maxChars: number): string {
  const text = markdown
    .replace(/^\s*(```|~~~).*$/gm, "") // fence lines (code inside is kept)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images → alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → link text
    .replace(/`([^`\n]+)`/g, "$1") // inline code
    .replace(/(\*\*|__)(.+?)\1/g, "$2") // bold
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") // heading markers
    .replace(/^\s{0,3}>\s?/gm, "") // blockquote markers
    .replace(/^…/, "") // overlap marker the chunker adds
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();

  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
