import { z } from "zod";

import { FRAMEWORK_IDS, type FrameworkId } from "@/lib/frameworks";

/**
 * One eval question (eval/questions.json is an array of these). Written by hand; see
 * eval/README.md for how to choose questions and fill in each field.
 */
export const EvalQuestionSchema = z
  .object({
    id: z.string().regex(/^q\d{3}$/, 'Use ids like "q001"'),
    /** The framework the question is about, several for cross-framework questions, or null. */
    framework: z.union([z.enum(FRAMEWORK_IDS), z.array(z.enum(FRAMEWORK_IDS)).min(1), z.null()]),
    question: z.string().trim().min(5),
    /**
     * Documents that answer it, as "<framework>/<path in the docs folder>", e.g.
     * "nextjs/01-app/02-guides/caching.mdx" (`pnpm run search` prints this for each result).
     */
    expectedSourcePaths: z.array(z.string().regex(/^[a-z-]+\/\S+\.mdx?$/)).default([]),
    /** Key facts the answer must contain: case-insensitive text, or a /regex/flags. */
    mustMention: z.array(z.string().min(1)).default([]),
    answerable: z.boolean(),
    /** Optional: why the question is here, what makes it hard. */
    notes: z.string().optional(),
  })
  .superRefine((q, ctx) => {
    if (q.answerable) {
      if (q.framework === null) {
        ctx.addIssue({
          code: "custom",
          path: ["framework"],
          message: "Answerable questions need a framework",
        });
      }
      if (q.expectedSourcePaths.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["expectedSourcePaths"],
          message: "Answerable questions need at least one expected source",
        });
      }
    } else if (q.expectedSourcePaths.length > 0 || q.mustMention.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["answerable"],
        message: "Unanswerable questions have no expected sources or must-mention facts",
      });
    }
    for (const [i, source] of q.expectedSourcePaths.entries()) {
      const framework = source.split("/")[0] as FrameworkId;
      if (!(FRAMEWORK_IDS as readonly string[]).includes(framework)) {
        ctx.addIssue({
          code: "custom",
          path: ["expectedSourcePaths", i],
          message: `Unknown framework prefix "${framework}"`,
        });
      }
    }
    for (const [i, pattern] of q.mustMention.entries()) {
      if (isRegexPattern(pattern)) {
        try {
          toRegex(pattern);
        } catch (error) {
          ctx.addIssue({
            code: "custom",
            path: ["mustMention", i],
            message: `Invalid regex: ${(error as Error).message}`,
          });
        }
      }
    }
  });

export const EvalFileSchema = z.array(EvalQuestionSchema).superRefine((questions, ctx) => {
  const seen = new Set<string>();
  for (const [i, q] of questions.entries()) {
    if (seen.has(q.id))
      ctx.addIssue({ code: "custom", path: [i, "id"], message: `Duplicate id ${q.id}` });
    seen.add(q.id);
  }
});

export type EvalQuestion = z.infer<typeof EvalQuestionSchema>;

/** The question's frameworks as a list (empty for off-topic questions). */
export function questionFrameworks(q: Pick<EvalQuestion, "framework">): FrameworkId[] {
  if (q.framework === null) return [];
  return Array.isArray(q.framework) ? q.framework : [q.framework];
}

/** "/pattern/flags" strings are regexes; anything else is plain text. */
export function isRegexPattern(pattern: string): boolean {
  return /^\/.+\/[dgimsuvy]*$/s.test(pattern);
}

export function toRegex(pattern: string): RegExp {
  const end = pattern.lastIndexOf("/");
  return new RegExp(pattern.slice(1, end), pattern.slice(end + 1));
}

/** Parses and validates a question file; throws a readable error listing every problem. */
export function parseEvalFile(json: unknown): EvalQuestion[] {
  const result = EvalFileSchema.safeParse(json);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - [${issue.path.join(".")}] ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid eval questions:\n${details}`);
  }
  return result.data;
}
