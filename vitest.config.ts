import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Resolve the `@/*` alias from tsconfig.json, so paths are defined in one place.
    tsconfigPaths: true,
    alias: {
      // `server-only` throws outside a React Server Components bundle; tests run in plain Node.
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["tests/unit/**/*.test.{ts,tsx}"] },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          // Creates the test database (if needed) and applies migrations once per run.
          globalSetup: ["tests/integration/global-setup.ts"],
          // Tests share one database; run files one at a time.
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
