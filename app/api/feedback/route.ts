import { z } from "zod";

import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FeedbackSchema = z.object({
  queryId: z.uuid(),
  rating: z.enum(["up", "down"]),
});

/** Thumbs up/down on an answer. One per query: a second click changes the rating. */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be JSON" }, { status: 400 });
  }
  const parsed = FeedbackSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid feedback" }, { status: 400 });

  const { queryId, rating } = parsed.data;
  const db = getDb();
  const query = await db.queryLog.findUnique({ where: { id: queryId }, select: { id: true } });
  if (!query) return Response.json({ error: "Unknown answer" }, { status: 404 });

  const value = rating === "up" ? 1 : -1;
  await db.feedback.upsert({
    where: { queryLogId: queryId },
    create: { queryLogId: queryId, rating: value },
    update: { rating: value },
  });
  return Response.json({ ok: true });
}
