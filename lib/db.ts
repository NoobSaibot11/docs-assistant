import "server-only";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";
import { getEnv } from "@/lib/env";

// One client per process. In dev, hot reload re-runs this module, so the
// instance is kept on globalThis to avoid opening a new pool on every edit.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/** A new client for a specific database (scripts and integration tests). */
export function createDbClient(connectionString: string): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
    // Prisma gives a transaction 2 s to get a connection by default. Opening one can take longer
    // on a cold pool (Docker Desktop on Windows, a serverless Postgres waking up), and vector
    // search runs in a transaction for its SET LOCAL settings.
    transactionOptions: { maxWait: 10_000, timeout: 15_000 },
  });
}

/** Lazily created Prisma client (so importing this module never needs DATABASE_URL). */
export function getDb(): PrismaClient {
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = createDbClient(getEnv().DATABASE_URL);
  }
  return globalForPrisma.prisma;
}

/** Cheap connectivity check for the health route. */
export async function pingDb(): Promise<void> {
  await getDb().$queryRaw`SELECT 1`;
}
