/** { contentPath: route } from the navigation entries' object literals. */
export function parseNavigationRoutes(source: string): Record<string, string> {
  const routes: Record<string, string> = {};
  // Each entry is an object literal; its own `path` and `contentPath` come before any children.
  for (const block of source.split("{")) {
    const contentPath = /\bcontentPath:\s*['"`]([^'"`]+)['"`]/.exec(block)?.[1];
    const route = /(?<![\w.])path:\s*['"`]([^'"`]*)['"`]/.exec(block)?.[1];
    if (contentPath && route !== undefined) routes[contentPath] = route;
  }
  return routes;
}
