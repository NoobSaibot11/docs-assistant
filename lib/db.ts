import "server-only";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";
import { getEnv } from "@/lib/env";

// One client per process. In dev, hot reload re-runs this module, so the
// instance is kept on globalThis to avoid opening a new pool on every edit.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: getEnv().DATABASE_URL });
  return new PrismaClient({ adapter });
}

/** Lazily created Prisma client (so importing this module never needs DATABASE_URL). */
export function getDb(): PrismaClient {
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = createClient();
  }
  return globalForPrisma.prisma;
}

/** Cheap connectivity check for the health route. */
export async function pingDb(): Promise<void> {
  await getDb().$queryRaw`SELECT 1`;
}
