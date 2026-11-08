import type { FrameworkId } from "@/lib/frameworks";
import angularRoutes from "@/sources/angular-routes.json";

/** A file path relative to the source's rootPath, plus its parsed frontmatter. */
export interface SourceFile {
  path: string;
  frontmatter: Record<string, unknown>;
}

export interface SourceConfig {
  framework: FrameworkId;
  /** Display name (UI filter, citations, attribution footer). */
  name: string;
  /** GitHub "owner/name". */
  repo: string;
  /** Pinned tag or commit SHA. Content at this ref never changes, so it's safe to cache. */
  ref: string;
  /** Human-readable docs version stored on each Document row. */
  docsVersion: string;
  /** Docs folder inside the repo. */
  rootPath: string;
  /** Sub-folders (relative to rootPath) to ingest. */
  include: string[];
  /** Parse as MDX (JSX + ESM) or plain Markdown (+ raw HTML). */
  syntax: "mdx" | "md";
  license: { name: string; url: string };
  siteUrl: string;
  /** Public docs URL for a file (no anchor). */
  toUrl: (file: SourceFile) => string;
}

const MARKDOWN_EXT = /\.mdx?$/;

/** Docusaurus page id: frontmatter `slug` or `id`, else the file name. */
export function docusaurusId(file: SourceFile): string {
  const { slug, id } = file.frontmatter;
  // Pages in sub-folders keep the folder: the-new-architecture/pure-cxx-modules.md →
  // /docs/the-new-architecture/pure-cxx-modules. An absolute slug ("/x") replaces the path.
  const parts = file.path.split("/");
  const folder = parts.slice(0, -1).join("/");
  const inFolder = (name: string) => (folder ? `${folder}/${name}` : name);
  if (typeof slug === "string") return slug.startsWith("/") ? slug.slice(1) : inFolder(slug);
  if (typeof id === "string") return inFolder(id);
  return inFolder((parts.at(-1) ?? file.path).replace(MARKDOWN_EXT, ""));
}

const ANGULAR_ROUTES: Record<string, string> = angularRoutes;

/**
 * angular.dev route for a content path: from the navigation map, else error and diagnostic pages
 * (generated from their folders, not listed in the navigation), else the path itself.
 */
export function angularRoute(contentPath: string): string {
  const mapped = ANGULAR_ROUTES[contentPath];
  if (mapped !== undefined) return mapped;
  for (const folder of ["errors", "extended-diagnostics"]) {
    if (contentPath.startsWith(`reference/${folder}/`)) {
      return contentPath.slice("reference/".length);
    }
  }
  return contentPath;
}

export const SOURCES: readonly SourceConfig[] = [
  {
    framework: "nextjs",
    name: "Next.js",
    repo: "vercel/next.js",
    ref: "v16.4.5",
    docsVersion: "16.4.5",
    rootPath: "docs",
    // App Router + architecture pages. The legacy Pages Router (02-pages) would contradict App
    // Router answers, and 04-community is a contributor guide.
    include: ["01-app", "03-architecture"],
    syntax: "mdx",
    license: { name: "MIT", url: "https://github.com/vercel/next.js/blob/canary/license.md" },
    siteUrl: "https://nextjs.org",
    // docs/01-app/02-guides/03-caching.mdx -> https://nextjs.org/docs/app/guides/caching
    toUrl: (file) => {
      const route = file.path
        .replace(MARKDOWN_EXT, "")
        .split("/")
        .map((segment) => segment.replace(/^\d+-/, ""))
        .filter((segment) => segment !== "index")
        .join("/");
      return `https://nextjs.org/docs/${route}`;
    },
  },
  {
    framework: "jest",
    name: "Jest",
    repo: "jestjs/jest",
    ref: "v30.5.2",
    docsVersion: "30.5",
    rootPath: "website/versioned_docs/version-30.5",
    include: [""],
    // Docusaurus 3 parses .md files as MDX too.
    syntax: "mdx",
    license: { name: "MIT", url: "https://github.com/jestjs/jest/blob/main/LICENSE" },
    siteUrl: "https://jestjs.io",
    // 30.5 is the current stable version, so pages live at /docs/<id> (no version prefix).
    toUrl: (file) => `https://jestjs.io/docs/${docusaurusId(file)}`,
  },
  {
    framework: "react-native",
    name: "React Native",
    repo: "react/react-native-website",
    // The website repo has no tags; pin a commit on main.
    ref: "9f6c98978a2dd0a58dbcbca83259928c816ff644",
    docsVersion: "0.88",
    rootPath: "website/versioned_docs/version-0.88",
    include: [""],
    syntax: "mdx",
    license: {
      name: "CC BY 4.0",
      url: "https://github.com/react/react-native-website/blob/main/LICENSE-docs",
    },
    siteUrl: "https://reactnative.dev",
    toUrl: (file) => `https://reactnative.dev/docs/${docusaurusId(file)}`,
  },
  {
    framework: "angular",
    name: "Angular",
    repo: "angular/angular",
    ref: "v22.2.5",
    docsVersion: "22.2.5",
    rootPath: "adev/src/content",
    include: ["introduction", "guide", "best-practices", "tools", "ecosystem", "reference"],
    // Plain Markdown with custom <docs-*> HTML elements.
    syntax: "md",
    license: { name: "MIT", url: "https://github.com/angular/angular/blob/main/LICENSE" },
    siteUrl: "https://angular.dev",
    // Content paths aren't URLs: the site's navigation maps them to routes
    // (introduction/what-is-angular -> /overview). See scripts/sync-angular-routes.ts.
    toUrl: (file) => `https://angular.dev/${angularRoute(file.path.replace(MARKDOWN_EXT, ""))}`,
  },
];

export function getSource(framework: FrameworkId): SourceConfig {
  const source = SOURCES.find((s) => s.framework === framework);
  if (!source) throw new Error(`No source configured for framework "${framework}"`);
  return source;
}
