import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../env.js";

export interface SessionPayload {
  sub: string; // userId
  email: string;
  role: "ADMIN" | "DESIGNER" | "CRM" | "MANAGER" | "SUPER_DESIGNER" | "CRM_SUPER" | "GAME_MANAGER";
}

/**
 * Session lifetime (TASK security, §3.4).
 *
 * Was 7 days. There is no revocation list — a stolen cookie is valid until it
 * expires, so this number IS the exposure window for a session lifted off an
 * unlocked laptop. Seven days of that is a lot for a tool holding brand assets;
 * 24 hours keeps the same shape of risk at a seventh of the duration.
 *
 * What it costs: Google's consent URL uses prompt=select_account, so the daily
 * re-login shows the account picker rather than bouncing through silently —
 * one extra click each morning. If that proves too coarse, this constant and
 * SESSION_MAX_AGE_MS below are the only two places to change (keep them equal:
 * a cookie outliving its token gives a confusing 401 instead of a clean login).
 */
const EXPIRES_IN = "24h";

/** The cookie's own max-age, in milliseconds. Must match EXPIRES_IN. */
export const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const SESSION_COOKIE = "session";

export function signSession(payload: SessionPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: EXPIRES_IN });
}

export function verifySession(token: string): SessionPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (typeof decoded === "string") return null;
    const { sub, email, role } = decoded as Record<string, unknown>;
    if (typeof sub !== "string" || typeof email !== "string") return null;
    if (
      role !== "ADMIN" &&
      role !== "DESIGNER" &&
      role !== "CRM" &&
      role !== "MANAGER" &&
      role !== "SUPER_DESIGNER" &&
      role !== "CRM_SUPER" &&
      role !== "GAME_MANAGER"
    )
      return null;
    return { sub, email, role };
  } catch {
    return null;
  }
}
