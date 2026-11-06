import { describe, expect, it } from "vitest";

import { parseEnv } from "@/lib/env";
import { FRAMEWORK_IDS } from "@/lib/frameworks";

const base = { DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/docs_assistant" };

describe("parseEnv", () => {
  it("applies defaults when only DATABASE_URL is set", () => {
    const env = parseEnv(base);
    expect(env.CLAUDE_MODEL).toBe("claude-sonnet-5-5");
    expect(env.RETRIEVAL_MODE).toBe("hybrid");
    expect(env.NOT_FOUND_THRESHOLD).toBe(0.35);
    expect(env.INGEST_FRAMEWORKS).toEqual([...FRAMEWORK_IDS]);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("treats empty API keys as unset", () => {
    const env = parseEnv({ ...base, ANTHROPIC_API_KEY: "", VOYAGE_API_KEY: "" });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.VOYAGE_API_KEY).toBeUndefined();
  });

  it("parses a comma list of frameworks", () => {
    expect(parseEnv({ ...base, INGEST_FRAMEWORKS: "nextjs, jest" }).INGEST_FRAMEWORKS).toEqual([
      "nextjs",
      "jest",
    ]);
  });

  it("coerces the threshold to a number", () => {
    expect(parseEnv({ ...base, NOT_FOUND_THRESHOLD: "0.5" }).NOT_FOUND_THRESHOLD).toBe(0.5);
  });

  it.each([
    [{}, "DATABASE_URL"],
    [{ DATABASE_URL: "mysql://localhost/db" }, "DATABASE_URL"],
    [{ ...base, INGEST_FRAMEWORKS: "nextjs,remix" }, "INGEST_FRAMEWORKS"],
    [{ ...base, RETRIEVAL_MODE: "semantic" }, "RETRIEVAL_MODE"],
    [{ ...base, NOT_FOUND_THRESHOLD: "1.5" }, "NOT_FOUND_THRESHOLD"],
  ])("rejects invalid input %#", (source, badKey) => {
    expect(() => parseEnv(source)).toThrow(badKey);
  });
});
