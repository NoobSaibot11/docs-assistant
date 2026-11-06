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
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
  },
});
