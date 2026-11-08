import "server-only";

import { createHash } from "node:crypto";

import type { PrismaClient } from "@/generated/prisma/client";

/**
 * Limits for the public demo, counted from QueryLog rows (no extra store needed):
 * questions per visitor per hour, and questions per day overall. A visitor is a salted hash of
 * their IP, so raw IPs are never stored. Requests still in flight aren't counted yet, so a burst
 * of parallel requests can overshoot by a few; the per-day cap bounds the worst case.
 */
export interface RateLimits {
  perClientPerHour: number;
  perDay: number;
}

export type RateLimitResult =
  { ok: true } | { ok: false; message: string; retryAfterSeconds: number };

/** The client's IP from proxy headers (Vercel sets x-forwarded-for), or "unknown". */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers.get("x-real-ip")?.trim() || "unknown";
}

export function hashClient(ip: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export async function checkRateLimit(
  db: PrismaClient,
  clientHash: string,
  limits: RateLimits,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  if (limits.perDay > 0) {
    const today = await db.queryLog.count({
      where: { createdAt: { gte: new Date(now.getTime() - DAY_MS) } },
    });
    if (today >= limits.perDay) {
      return {
        ok: false,
        message: "This demo has reached its daily question limit. Please try again tomorrow.",
        retryAfterSeconds: 60 * 60,
      };
    }
  }
  if (limits.perClientPerHour > 0) {
    const recent = await db.queryLog.findMany({
      where: { clientHash, createdAt: { gte: new Date(now.getTime() - HOUR_MS) } },
      select: { createdAt: true },
      orderBy: { createdAt: "asc" },
      take: limits.perClientPerHour,
    });
    if (recent.length >= limits.perClientPerHour) {
      const oldest = recent[0]!.createdAt.getTime();
      return {
        ok: false,
        message: `You've asked ${limits.perClientPerHour} questions in the last hour, the limit for this demo. Please try again a little later.`,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + HOUR_MS - now.getTime()) / 1000)),
      };
    }
  }
  return { ok: true };
}
