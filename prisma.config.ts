import "dotenv/config";
import { defineConfig } from "prisma/config";

// Used by the Prisma CLI (generate, migrate). The app itself connects via lib/db.ts.
// `prisma generate` doesn't need a database, so DATABASE_URL may be unset at install/build time.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"] ?? "",
  },
});
