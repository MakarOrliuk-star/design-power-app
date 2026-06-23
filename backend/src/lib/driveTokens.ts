import { redis, ensureRedis } from "./redis.js";

/**
 * Per-user Google Drive access tokens, kept in Redis with a TTL matching the
 * token's own lifetime. We use online (short-lived) access only — no refresh
 * tokens are stored. When a token expires the user re-connects Drive via the
 * incremental-consent flow (a quick, silent redirect once already consented).
 *
 * Keyed by the app's userId (the session `sub`), so a token is reused across
 * the interactive navigation calls and handed to the generation job at enqueue.
 */

const PREFIX = "smartico:drive:token:";
// Drop the token a little before Google does, so we never hand out one that
// expires mid-request.
const EXPIRY_SKEW_SEC = 60;

export async function storeDriveToken(
  userId: string,
  accessToken: string,
  expiresIn: number,
): Promise<void> {
  await ensureRedis();
  const ttl = Math.max(1, Math.floor(expiresIn) - EXPIRY_SKEW_SEC);
  await redis.set(PREFIX + userId, accessToken, "EX", ttl);
}

/** Current user's Drive access token, or null if not connected / expired. */
export async function getDriveToken(userId: string): Promise<string | null> {
  await ensureRedis();
  return redis.get(PREFIX + userId);
}

export async function clearDriveToken(userId: string): Promise<void> {
  await ensureRedis();
  await redis.del(PREFIX + userId);
}
