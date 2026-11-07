import "dotenv/config";

import { execFileSync } from "node:child_process";

import pg from "pg";

/**
 * Creates the integration-test database if it doesn't exist, then applies all migrations to it.
 * Runs once per `vitest` run, before any integration test file.
 */
export default async function setup(): Promise<void> {
  const url = process.env["TEST_DATABASE_URL"];
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Add it to .env (see .env.example) to run integration tests.",
    );
  }

  const target = new URL(url);
  const dbName = decodeURIComponent(target.pathname.slice(1));
  if (!/^[\w-]+$/.test(dbName)) throw new Error(`Unexpected test database name: ${dbName}`);
  if (!/test/.test(dbName)) {
    throw new Error(`Refusing to use "${dbName}" for tests: its name must contain "test"`);
  }

  // Connect to the server's default database to create the test one.
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    // Identifiers can't be parameters; dbName is validated against [\w-]+ above.
    if (exists.rowCount === 0) await client.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await client.end();
  }

  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
}
