import { pingDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    await pingDb();
    return Response.json({ status: "ok", db: "ok" });
  } catch (error) {
    console.error("[health] database check failed:", error);
    return Response.json({ status: "error", db: "unreachable" }, { status: 503 });
  }
}
