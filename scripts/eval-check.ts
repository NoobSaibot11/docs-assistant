/**
 * pnpm eval:check [--file eval/questions.json]
 *
 * Validates the eval questions before spending money on a run:
 * - the file matches the schema (ids, fields, answerable/unanswerable rules, valid regexes);
 * - every expected source exists in the database (so it's ingested and the path is right);
 * - every must-mention fact appears in at least one expected source (warning: the docs may
 *   phrase it differently, but usually it means a typo);
 * - coverage against the spec's targets (15 answerable per framework, 10 unanswerable).
 *
 * Exits with code 1 on errors; warnings don't fail it.
 */
import "dotenv/config";

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { EVAL } from "@/lib/config";
import { getDb } from "@/lib/db";
import { mentions } from "@/lib/eval/metrics";
import { parseEvalFile, questionFrameworks } from "@/lib/eval/schema";
import { FRAMEWORK_IDS } from "@/lib/frameworks";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { file: { type: "string", default: EVAL.questionsFile } },
  });
  const questions = parseEvalFile(JSON.parse(await readFile(values.file, "utf8")));
  console.log(`${values.file}: ${questions.length} questions, schema OK`);

  const db = getDb();
  const errors: string[] = [];
  const warnings: string[] = [];
  try {
    const wanted = [...new Set(questions.flatMap((q) => q.expectedSourcePaths))];
    const docs = await db.document.findMany({
      where: {
        OR: wanted.map((key) => {
          const [framework, ...rest] = key.split("/");
          return { framework: framework!, sourcePath: rest.join("/") };
        }),
      },
      select: { framework: true, sourcePath: true, chunks: { select: { content: true } } },
    });
    const textByKey = new Map(
      docs.map((d) => [
        `${d.framework}/${d.sourcePath}`,
        d.chunks.map((c) => c.content).join("\n"),
      ]),
    );

    for (const q of questions) {
      for (const key of q.expectedSourcePaths) {
        if (!textByKey.has(key))
          errors.push(`${q.id}: expected source not in the database: ${key}`);
      }
      const docsText = q.expectedSourcePaths.map((k) => textByKey.get(k) ?? "").join("\n");
      for (const pattern of q.mustMention) {
        if (docsText !== "" && !mentions(docsText, pattern)) {
          warnings.push(`${q.id}: must-mention "${pattern}" isn't in its expected sources`);
        }
      }
      const frameworks = questionFrameworks(q);
      for (const key of q.expectedSourcePaths) {
        const framework = key.split("/")[0];
        if (!frameworks.some((f) => f === framework)) {
          warnings.push(`${q.id}: source ${key} is outside the question's framework(s)`);
        }
      }
    }

    const seen = new Map<string, string>();
    for (const q of questions) {
      const normalized = q.question.toLowerCase().replace(/\W+/g, " ").trim();
      const other = seen.get(normalized);
      if (other) warnings.push(`${q.id}: same question as ${other}`);
      seen.set(normalized, q.id);
    }
  } finally {
    await db.$disconnect();
  }

  console.log(
    "\nCoverage (target: %d answerable per framework, %d unanswerable)",
    EVAL.answerablePerFramework,
    EVAL.unanswerable,
  );
  console.table(
    Object.fromEntries(
      FRAMEWORK_IDS.map((f) => {
        const about = questions.filter((q) => q.answerable && questionFrameworks(q).includes(f));
        return [
          f,
          {
            answerable: about.length,
            "cross-framework": about.filter((q) => questionFrameworks(q).length > 1).length,
          },
        ];
      }),
    ),
  );
  console.log(`unanswerable: ${questions.filter((q) => !q.answerable).length}`);

  for (const w of warnings) console.warn(`warning: ${w}`);
  for (const e of errors) console.error(`error: ${e}`);
  console.log(`\n${errors.length} error(s), ${warnings.length} warning(s)`);
  if (errors.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
