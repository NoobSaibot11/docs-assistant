import path from "node:path";

import { parseEnv } from "@/lib/env";
import type { FrameworkId } from "@/lib/frameworks";
import { getSource } from "@/sources.config";

/** Hand-written fixture corpus: two small docs per framework, laid out like each docs repo. */
export const FIXTURES = path.resolve("tests/fixtures");
const FIXTURE_ORDER: readonly FrameworkId[] = ["nextjs", "jest", "angular", "react-native"];
export const FIXTURE_SOURCES = FIXTURE_ORDER.map((id) => getSource(id));

/** The integration-test database URL, validated like the rest of the env. */
export function testDatabaseUrl(): string {
  const url = parseEnv({
    ...process.env,
    DATABASE_URL: process.env["DATABASE_URL"] ?? "postgresql://unused/db",
  }).TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set");
  return url;
}
