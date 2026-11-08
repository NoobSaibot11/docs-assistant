import "server-only";

import { z } from "zod";

import { FRAMEWORK_IDS, RETRIEVAL_MODES, type FrameworkId } from "@/lib/frameworks";

/** Treat `KEY=` (empty string in .env) the same as an unset variable. */
const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);

const optionalString = z.preprocess(emptyToUndefined, z.string().min(1).optional());

const ingestFrameworks = z
  .string()
  .default("all")
  .transform((value, ctx): FrameworkId[] => {
    const trimmed = value.trim();
    if (trimmed === "all") return [...FRAMEWORK_IDS];
    const ids = trimmed.split(",").map((id) => id.trim());
    const unknown = ids.filter((id) => !(FRAMEWORK_IDS as readonly string[]).includes(id));
    if (unknown.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `Unknown framework(s): ${unknown.join(", ")}. Use "all" or a comma list of: ${FRAMEWORK_IDS.join(", ")}`,
      });
      return z.NEVER;
    }
    return ids as FrameworkId[];
  });

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),

  // API keys are optional at startup so the app, health check and CI run without them.
  // Code that calls Claude or Voyage reads them through requireKey(), which fails loudly.
  ANTHROPIC_API_KEY: optionalString,
  VOYAGE_API_KEY: optionalString,

  CLAUDE_MODEL: z.string().min(1).default("claude-sonnet-5-5"),
  CLAUDE_FAST_MODEL: z.string().min(1).default("claude-haiku-5-5"),
  VOYAGE_MODEL: z.string().min(1).default("voyage-4"),
  // Voyage reranker: retrieve RETRIEVAL.candidates, rerank, keep topK. Lifted hit@5 from 93% to
  // 98% in the eval. "none" turns it off.
  RERANK_MODEL: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .min(1)
      .default("rerank-3")
      .transform((v) => (v === "none" ? undefined : v)),
  ),
  // Thinking depth for the answer model. Sonnet 5.5 can't turn thinking off; "low" keeps
  // time-to-first-token short for docs Q&A. Tune with the eval set. (Not CLAUDE_EFFORT: Claude
  // Code sets that in its own environment, and dotenv never overrides a variable already set.)
  ANSWER_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
  // Grades faithfulness in `pnpm eval`; should be at least as capable as CLAUDE_MODEL.
  CLAUDE_JUDGE_MODEL: z.string().min(1).default("claude-opus-5-5"),

  // Optional client-side throttle for Voyage. Without a payment method on file, Voyage allows
  // 3 requests and 10K tokens per minute; set VOYAGE_RPM=3 and VOYAGE_TPM=10000 to stay under it.
  VOYAGE_RPM: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  VOYAGE_TPM: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),

  // Optional: raises the GitHub API limit (60/hour unauthenticated) used to list docs files.
  GITHUB_TOKEN: optionalString,
  // Separate database for integration tests (they truncate tables).
  TEST_DATABASE_URL: z.preprocess(
    emptyToUndefined,
    z.url({ protocol: /^postgres(ql)?$/ }).optional(),
  ),

  INGEST_FRAMEWORKS: ingestFrameworks,

  // Public-demo limits (0 = off): questions per visitor per hour, and per day overall.
  RATE_LIMIT_PER_HOUR: z.coerce.number().int().min(0).default(20),
  DAILY_QUESTION_LIMIT: z.coerce.number().int().min(0).default(300),
  // Salt for hashing visitor IPs; set a random value in production.
  RATE_LIMIT_SALT: z.preprocess(emptyToUndefined, z.string().min(1).default("docs-assistant")),
  // Vector beat hybrid on the eval set (see README "Evaluation"); hybrid stays available.
  RETRIEVAL_MODE: z.enum(RETRIEVAL_MODES).default("vector"),
  // Weight of keyword results in hybrid fusion (vector results weigh 1). Tuned with the eval.
  HYBRID_KEYWORD_WEIGHT: z.coerce.number().min(0).max(1).default(0.1),
  // A cheap pre-filter before the answer call; set just below the lowest answerable question's
  // similarity in the eval sweep. The model's own "not found" reply handles the rest.
  NOT_FOUND_THRESHOLD: z.coerce.number().min(0).max(1).default(0.4),
});

export type Env = z.infer<typeof envSchema>;

/** Validates a raw env object. Throws one readable error listing every bad variable. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment variables:\n${details}`);
  }
  return result.data;
}

let cached: Env | undefined;

/**
 * Validated env, parsed on first use. Lazy so `next build` doesn't need runtime
 * variables like DATABASE_URL; the first request (or the health check) validates them.
 */
export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Returns an API key, or throws a clear error naming the missing variable. */
export function requireKey(name: "ANTHROPIC_API_KEY" | "VOYAGE_API_KEY"): string {
  const value = getEnv()[name];
  if (!value) throw new Error(`${name} is not set. Add it to your .env file.`);
  return value;
}
