import "server-only";

import type { PrismaClient } from "@/generated/prisma/client";
import type { Outcome } from "@/lib/chat/protocol";
import type { FrameworkId, RetrievalMode } from "@/lib/frameworks";

export interface QueryLogEntry {
  question: string;
  retrievalMode: RetrievalMode;
  frameworks: FrameworkId[];
  topChunkIds: string[];
  topScore: number;
  outcome: Outcome;
  ttftMs: number | null;
  totalMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  rewriteInputTokens: number;
  rewriteOutputTokens: number;
}

export type QueryLogger = (entry: QueryLogEntry) => Promise<void>;

export function createQueryLogger(db: PrismaClient): QueryLogger {
  return async (entry) => {
    await db.queryLog.create({
      data: { ...entry, answered: entry.outcome === "answered" },
    });
  };
}
