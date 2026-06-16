import type { Request, Response, NextFunction } from "express";
import { SESSION_COOKIE, verifySession } from "../lib/jwt.js";
import type { SessionPayload } from "../lib/jwt.js";

/** Attach req.user from the session cookie if present/valid. Never blocks. */
export function loadUser(req: Request, _res: Response, next: NextFunction): void {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token === "string") {
    const session = verifySession(token);
    if (session) req.user = session;
  }
  next();
}

/** 401 unless an authenticated user is present. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

/** 403 unless the authenticated user is an admin. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (req.user.role !== "ADMIN") {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  next();
}

/**
 * 403 unless the authenticated user's role is in `roles`. ADMIN always passes
 * (full access across zones). Used to wall off the Design zone from CRM-only
 * users and vice-versa. Assumes loadUser + requireAuth ran earlier.
 */
export function requireZone(...roles: SessionPayload["role"][]) {
  return function (req: Request, res: Response, next: NextFunction): void {
    if (!req.user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (req.user.role !== "ADMIN" && !roles.includes(req.user.role)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    next();
  };
}
