import { runChat, type ChatDeps } from "@/lib/chat/pipeline";
import { ChatRequestSchema, NDJSON_CONTENT_TYPE } from "@/lib/chat/protocol";
import { createQueryLogger } from "@/lib/chat/query-log";
import { getDb } from "@/lib/db";
import { getEnv, requireKey } from "@/lib/env";
import { createClaudeAnswerModel } from "@/lib/llm/answer";
import { getAnthropic } from "@/lib/llm/client";
import { createClaudeQueryRewriter } from "@/lib/llm/rewrite-query";
import { createVoyageQueryEmbedder } from "@/lib/retrieval/query-embedder";
import { search } from "@/lib/retrieval/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let deps: ChatDeps | undefined;

/** Real clients, built once per server process. Throws if an API key is missing. */
function getDeps(): ChatDeps {
  if (deps) return deps;
  const env = getEnv();
  const anthropic = getAnthropic();
  const db = getDb();
  const queryEmbedder = createVoyageQueryEmbedder({
    apiKey: requireKey("VOYAGE_API_KEY"),
    model: env.VOYAGE_MODEL,
  });
  const onError = (error: unknown) => console.error("[api/chat]", error);
  deps = {
    rewriter: createClaudeQueryRewriter({
      client: anthropic,
      model: env.CLAUDE_FAST_MODEL,
      onError,
    }),
    search: (request) =>
      search(
        { db, embedder: queryEmbedder },
        { ...request, keywordWeight: env.HYBRID_KEYWORD_WEIGHT },
      ),
    answerModel: createClaudeAnswerModel({
      client: anthropic,
      model: env.CLAUDE_MODEL,
      effort: env.ANSWER_EFFORT,
    }),
    logQuery: createQueryLogger(db),
    mode: env.RETRIEVAL_MODE,
    notFoundThreshold: env.NOT_FOUND_THRESHOLD,
    onError,
  };
  return deps;
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be JSON" }, { status: 400 });
  }

  const parsed = ChatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      {
        error: "Invalid request",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
      { status: 400 },
    );
  }

  let chatDeps: ChatDeps;
  try {
    chatDeps = getDeps();
  } catch (error) {
    console.error("[api/chat]", error);
    return Response.json(
      { error: "The chat service isn't configured (missing API key)." },
      { status: 503 },
    );
  }

  return new Response(runChat(chatDeps, parsed.data, request.signal), {
    headers: {
      "Content-Type": NDJSON_CONTENT_TYPE,
      "Cache-Control": "no-cache, no-transform",
      // Stop proxies (e.g. nginx) from buffering the stream.
      "X-Accel-Buffering": "no",
    },
  });
}
