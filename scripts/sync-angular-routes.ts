/**
 * pnpm sync:angular-routes
 *
 * angular.dev doesn't serve pages at their content path (adev/src/content/<path>.md): the site's
 * navigation maps each content file to a route, e.g. introduction/what-is-angular → /overview.
 * This reads that mapping from the repo at the pinned ref and writes sources/angular-routes.json,
 * which sources.config.ts uses to build citation URLs. Re-run it when the Angular ref changes.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { parseNavigationRoutes } from "@/lib/ingest/angular-routes";
import { createGitHubProvider } from "@/lib/ingest/fetch-source";
import { getSource } from "@/sources.config";

const NAVIGATION_FILE = "adev/src/app/routing/navigation-entries/index.ts";
const OUTPUT = path.resolve("sources/angular-routes.json");

async function main(): Promise<void> {
  const source = getSource("angular");
  const provider = createGitHubProvider({ cacheDir: path.resolve(".cache", "docs") });
  const routes = parseNavigationRoutes(await provider.readRepoFile(source, NAVIGATION_FILE));
  const sorted = Object.fromEntries(Object.entries(routes).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(OUTPUT, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`Wrote ${Object.keys(sorted).length} routes for angular@${source.ref} to ${OUTPUT}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
