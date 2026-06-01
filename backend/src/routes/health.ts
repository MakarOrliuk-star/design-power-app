import { Router } from "express";
import type { Request, Response } from "express";
import { prisma } from "../lib/prisma.js";
import { ensureRedis, redis } from "../lib/redis.js";

export const healthRouter: Router = Router();

/**
 * Liveness/readiness probe. Reports DB + Redis connectivity independently so a
 * single failing dependency is visible (and doesn't 500 the whole endpoint
 * unless something is actually down).
 */
healthRouter.get("/", async (_req: Request, res: Response) => {
  const checks: Record<string, "ok" | "down"> = {
    database: "down",
    redis: "down",
  };

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = "ok";
  } catch {
    /* leave as "down" */
  }

  try {
    await ensureRedis();
    const pong = await redis.ping();
    if (pong === "PONG") checks.redis = "ok";
  } catch {
    /* leave as "down" */
  }

  const healthy = Object.values(checks).every((c) => c === "ok");
  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    checks,
    timestamp: new Date().toISOString(),
  });
});
