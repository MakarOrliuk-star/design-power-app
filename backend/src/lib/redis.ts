import { Redis } from "ioredis";
import { env, isProd } from "../env.js";

/**
 * Shared Redis connection (cache today; BullMQ queues land in Phase 4).
 * `maxRetriesPerRequest: null` is required for BullMQ compatibility later.
 */
const globalForRedis = globalThis as unknown as {
  redis?: Redis;
};

export const redis =
  globalForRedis.redis ??
  new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });

// Avoid an unhandled 'error' event crashing the process if Redis blips.
redis.on("error", (e: Error) => console.error("⚠️ Redis error:", e.message));

if (!isProd) globalForRedis.redis = redis;

let connecting: Promise<void> | null = null;

/** Ensure the lazy connection is established (idempotent). */
export async function ensureRedis(): Promise<void> {
  if (redis.status === "ready") return;
  if (!connecting) {
    connecting = redis.connect().then(
      () => {
        connecting = null;
      },
      (err) => {
        connecting = null;
        throw err;
      },
    );
  }
  await connecting;
}
