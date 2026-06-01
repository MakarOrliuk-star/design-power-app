import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../env.js";

export interface SessionPayload {
  sub: string; // userId
  email: string;
  role: "ADMIN" | "DESIGNER";
}

const EXPIRES_IN = "7d";
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
    if (role !== "ADMIN" && role !== "DESIGNER") return null;
    return { sub, email, role };
  } catch {
    return null;
  }
}
