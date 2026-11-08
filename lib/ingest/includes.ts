/**
 * Inlines content that docs pages pull in from other files, before cleaning and chunking:
 *
 * - MDX partials (React Native, Jest): `import Guide from './_guide.md'` + `<Guide />` renders the
 *   partial's content in place. Without inlining, whole setup guides are lost.
 * - Angular code examples: `<docs-code path="adev/src/content/examples/…" region="x"/>` shows a
 *   file (or one marked region of it) from elsewhere in the repo.
 *
 * Works on raw text, line by line, and never touches fenced code blocks (Jest pages have
 * `import … from './x'` lines inside code samples).
 */

export interface IncludeReaders {
  /** A file relative to the source's rootPath (partials live next to the pages). */
  readDocFile(path: string): Promise<string>;
  /** A file relative to the repository root (Angular example code). */
  readRepoFile(path: string): Promise<string>;
}

export interface IncludeStats {
  partials: number;
  codeExamples: number;
  /** Includes that couldn't be read; the original tag is kept (and later dropped by the cleaner). */
  missing: string[];
}

const MAX_PARTIAL_DEPTH = 3;
/** An opening fence: 3+ backticks or tildes (captured), optionally followed by an info string. */
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

interface Segment {
  prose: boolean;
  text: string;
}

/** Splits text into alternating prose and fenced-code segments (rejoined with newlines). */
function segments(text: string): Segment[] {
  const out: { prose: boolean; lines: string[] }[] = [];
  let fence: string | null = null;
  const push = (prose: boolean, line: string) => {
    const last = out.at(-1);
    if (last?.prose === prose) last.lines.push(line);
    else out.push({ prose, lines: [line] });
  };
  for (const line of text.split("\n")) {
    const marker = FENCE.exec(line)?.[1];
    if (fence === null && marker) {
      fence = marker;
      push(false, line);
    } else if (fence !== null) {
      push(false, line);
      // Closing fence: same character, at least as long, nothing else on the line.
      const trimmed = line.trim();
      if (trimmed.length >= fence.length && trimmed === fence[0]!.repeat(trimmed.length)) {
        fence = null;
      }
    } else {
      push(true, line);
    }
  }
  return out.map((s) => ({ prose: s.prose, text: s.lines.join("\n") }));
}

/** Applies `fn` to the text outside fenced code blocks, leaving code blocks untouched. */
function outsideFences(text: string, fn: (prose: string) => string): string {
  return segments(text)
    .map((s) => (s.prose ? fn(s.text) : s.text))
    .join("\n");
}

async function outsideFencesAsync(
  text: string,
  fn: (prose: string) => Promise<string>,
): Promise<string> {
  const parts = await Promise.all(
    segments(text).map((s) => (s.prose ? fn(s.text) : Promise.resolve(s.text))),
  );
  return parts.join("\n");
}

/** Like String.replace with an async replacer (all replacements run concurrently). */
async function asyncReplace(
  text: string,
  pattern: RegExp,
  replace: (match: RegExpExecArray) => Promise<string>,
): Promise<string> {
  const matches = [...text.matchAll(pattern)];
  const replacements = await Promise.all(matches.map((m) => replace(m)));
  let result = "";
  let last = 0;
  matches.forEach((m, i) => {
    result += text.slice(last, m.index) + replacements[i];
    last = m.index + m[0].length;
  });
  return result + text.slice(last);
}

// ---------------------------------------------------------------------------------------------
// MDX partials

/** `import Name from './_file.md'` lines outside code blocks → { Name: './_file.md' }. */
export function localMarkdownImports(text: string): Map<string, string> {
  const imports = new Map<string, string>();
  outsideFences(text, (prose) => {
    for (const m of prose.matchAll(
      /^import\s+([A-Z]\w*)\s+from\s+['"](\.{1,2}\/[^'"]+\.mdx?)['"];?\s*$/gm,
    )) {
      // Prettier escapes underscores in MDX import paths: './\_guide.md'.
      imports.set(m[1]!, m[2]!.replace(/\\_/g, "_"));
    }
    return prose;
  });
  return imports;
}

/** Resolves `./x` or `../x` against the directory of `fromPath` (both relative to rootPath). */
export function resolveRelative(fromPath: string, relative: string): string {
  const parts = fromPath.split("/").slice(0, -1);
  for (const segment of relative.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

/** A partial's body without frontmatter or top-level import/export lines. */
function partialBody(text: string): string {
  const withoutFrontmatter = text.replace(/^---\n[\s\S]*?\n---\n/, "");
  return outsideFences(withoutFrontmatter, (prose) =>
    prose.replace(/^(import|export)\s.*$/gm, ""),
  ).trim();
}

async function inlinePartials(
  text: string,
  filePath: string,
  readers: IncludeReaders,
  stats: IncludeStats,
  depth: number,
): Promise<string> {
  const imports = localMarkdownImports(text);
  if (imports.size === 0 || depth > MAX_PARTIAL_DEPTH) return text;

  const names = [...imports.keys()].join("|");
  const usage = new RegExp(`<(${names})(\\s[^>]*)?\\s*(?:/>|>\\s*</\\1>)`, "g");
  const cache = new Map<string, Promise<string | null>>();

  const load = (name: string): Promise<string | null> => {
    const partialPath = resolveRelative(filePath, imports.get(name)!);
    if (!cache.has(partialPath)) {
      cache.set(
        partialPath,
        readers
          .readDocFile(partialPath)
          .then((raw) => inlinePartials(raw, partialPath, readers, stats, depth + 1))
          .then(partialBody)
          .catch(() => {
            stats.missing.push(partialPath);
            return null;
          }),
      );
    }
    return cache.get(partialPath)!;
  };

  return outsideFencesAsync(text, (prose) =>
    asyncReplace(prose, usage, async (m) => {
      const body = await load(m[1]!);
      if (body === null) return m[0];
      stats.partials++;
      // Blank lines so MDX parses the inlined text as Markdown even inside a JSX element.
      return `\n\n${body}\n\n`;
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Angular <docs-code path="…">

const REGION_MARKER = /#(end)?docregion\b([^\n]*)/;

function regionNames(rest: string): string[] {
  return rest
    .replace(/(-->|\*\/|\*\}|%>)\s*$/, "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[\w-]+$/.test(s));
}

/**
 * The lines of `code` inside region `name` (all spans of it, in order), or the whole file when
 * no region is given or found. Region marker lines (`#docregion`, `#enddocregion`, `#docplaster`)
 * are always removed, and common indentation is stripped.
 */
export function extractRegion(code: string, name?: string): string {
  const lines = code.replace(/\r\n/g, "\n").split("\n");
  const isMarker = (line: string) => REGION_MARKER.test(line) || line.includes("#docplaster");

  let selected: string[] = [];
  if (name) {
    const open = new Set<string>();
    for (const line of lines) {
      const marker = REGION_MARKER.exec(line);
      if (marker) {
        const names = regionNames(marker[2] ?? "");
        if (marker[1]) {
          if (names.length === 0) open.clear();
          else for (const n of names) open.delete(n);
        } else {
          for (const n of names) open.add(n);
        }
        continue;
      }
      if (line.includes("#docplaster")) continue;
      if (open.has(name)) selected.push(line);
    }
  }
  if (selected.length === 0) selected = lines.filter((line) => !isMarker(line));

  while (selected.length > 0 && selected[0]!.trim() === "") selected.shift();
  while (selected.length > 0 && selected.at(-1)!.trim() === "") selected.pop();
  const indent = Math.min(
    ...selected.filter((l) => l.trim() !== "").map((l) => /^\s*/.exec(l)![0].length),
  );
  return selected.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join("\n");
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "ts",
  js: "js",
  mjs: "js",
  html: "html",
  css: "css",
  scss: "scss",
  json: "json",
  sh: "bash",
  xlf: "xml",
};

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

/** Matches `<docs-code … path="…" />` and `<docs-code … path="…"></docs-code>` (not -multifile). */
const DOCS_CODE_WITH_PATH =
  /<docs-code(?=[\s/>])([^>]*\spath="[^"]+"[^>]*?)\s*(?:\/>|>\s*<\/docs-code>)/g;

async function inlineCodeExamples(
  text: string,
  readers: IncludeReaders,
  stats: IncludeStats,
): Promise<string> {
  return outsideFencesAsync(text, (prose) =>
    asyncReplace(prose, DOCS_CODE_WITH_PATH, async (m) => {
      const tag = m[0];
      const filePath = attribute(tag, "path")!;
      let code: string;
      try {
        code = await readers.readRepoFile(filePath);
      } catch {
        stats.missing.push(filePath);
        return tag;
      }
      stats.codeExamples++;
      const extension = filePath.split(".").pop() ?? "";
      const language = attribute(tag, "language") ?? LANGUAGE_BY_EXTENSION[extension] ?? "";
      const header = attribute(tag, "header") ?? filePath.split("/").pop();
      const body = extractRegion(code, attribute(tag, "region"));
      return `\n\n**${header}**\n\n\`\`\`${language}\n${body}\n\`\`\`\n\n`;
    }),
  );
}

/** Inlines partials and example code into a page. Returns the text and what was inlined. */
export async function resolveIncludes(
  filePath: string,
  raw: string,
  readers: IncludeReaders,
): Promise<{ text: string; stats: IncludeStats }> {
  const stats: IncludeStats = { partials: 0, codeExamples: 0, missing: [] };
  let text = await inlinePartials(raw, filePath, readers, stats, 1);
  text = await inlineCodeExamples(text, readers, stats);
  return { text, stats };
}
