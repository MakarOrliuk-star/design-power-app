import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.js";
import { env, isProd } from "../env.js";

/**
 * Single shared PrismaClient. Prisma 7 uses a driver adapter (node-postgres) so
 * the same client works against any standard Postgres URL (Railway in prod, a
 * local Postgres / Prisma Postgres in dev). In dev we stash it on globalThis so
 * `tsx watch` hot-reloads don't open a new pool on every change.
 */
const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: isProd ? ["error"] : ["query", "warn", "error"],
  });

if (!isProd) globalForPrisma.prisma = prisma;
