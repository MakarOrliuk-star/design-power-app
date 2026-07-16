import type { Request, Response, NextFunction } from "express";
import { SESSION_COOKIE, verifySession } from "../lib/jwt.js";
import type { SessionPayload } from "../lib/jwt.js";
import { prisma } from "../lib/prisma.js";

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
 * 403 unless the user is ADMIN or MANAGER (tournament admin, Phase 0 decision:
 * MANAGER also edits defaults/references). Like requireZone, the role is read
 * FRESH from the DB so a promotion takes effect without re-login.
 */
export async function requireAdminOrManager(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.sub },
      select: { role: true, isActive: true },
    });
    if (!user || !user.isActive) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (user.role !== "ADMIN" && user.role !== "MANAGER") {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    req.user.role = user.role;
    next();
  } catch (err) {
    console.error("requireAdminOrManager DB lookup failed:", err);
    res.status(500).json({ error: "server_error" });
  }
}

/**
 * 403 unless the user is SUPER_DESIGNER, ADMIN or MANAGER (TASK super-designer:
 * the Create a New Style / Library surface is visible to all three). Role is
 * read FRESH from the DB, mirroring requireAdminOrManager.
 */
export async function requireSuperDesigner(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.sub },
      select: { role: true, isActive: true },
    });
    if (!user || !user.isActive) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (user.role !== "SUPER_DESIGNER" && user.role !== "ADMIN" && user.role !== "MANAGER") {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    req.user.role = user.role;
    next();
  } catch (err) {
    console.error("requireSuperDesigner DB lookup failed:", err);
    res.status(500).json({ error: "server_error" });
  }
}

/**
 * 403 unless the authenticated user's role is in `roles`. ADMIN always passes
 * (full access across zones). Used to wall off the Design zone from CRM-only
 * users and vice-versa. Assumes loadUser + requireAuth ran earlier.
 *
 * The role is read FRESH from the DB (not from the JWT), so an admin promoting a
 * user to CRM takes effect immediately — without the user re-logging in. The
 * session cookie lives 7 days and caches the role at login time, which would
 * otherwise keep a just-promoted user 403'd until their token expires.
 */
export function requireZone(...roles: SessionPayload["role"][]) {
  return async function (req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!req.user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user.sub },
        select: { role: true, isActive: true },
      });
      if (!user || !user.isActive) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      // ADMIN and MANAGER pass every zone (MANAGER = Design + CRM). Admin routes
      // are guarded separately by requireAdmin, so MANAGER never reaches them.
      // SUPER_DESIGNER is a DESIGNER-zone role (Design only, never CRM).
      const effectiveRole = user.role === "SUPER_DESIGNER" ? "DESIGNER" : user.role;
      if (user.role !== "ADMIN" && user.role !== "MANAGER" && !roles.includes(effectiveRole)) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      // Keep the request's role in sync with the DB for downstream handlers.
      req.user.role = user.role;
      next();
    } catch (err) {
      console.error("requireZone DB lookup failed:", err);
      res.status(500).json({ error: "server_error" });
    }
  };
}
