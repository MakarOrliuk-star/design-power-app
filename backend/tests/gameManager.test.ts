import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

// env.ts validates process.env and calls process.exit() at import — mock it so
// jwt.js (which reads JWT_SECRET) can be imported in isolation. The literal is
// inlined in the factory because vi.mock is hoisted above top-level consts.
vi.mock("../src/env.js", () => ({ JWT_SECRET: "test-secret-key" }));
const TEST_SECRET = "test-secret-key";

// Guards read the fresh role from the DB — mock the user delegate.
const db = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("../src/lib/prisma.js", () => ({ prisma: { user: { findUnique: db.findUnique } } }));

import { requireGameZone, requireZone } from "../src/middleware/auth.js";
import { signSession, verifySession } from "../src/lib/jwt.js";
import { sanitizeNext } from "../src/lib/nextTarget.js";

type Role =
  | "ADMIN"
  | "DESIGNER"
  | "CRM"
  | "MANAGER"
  | "SUPER_DESIGNER"
  | "CRM_SUPER"
  | "GAME_MANAGER";

function fakeReqRes(authenticated: boolean) {
  const req = {
    user: authenticated ? { sub: "u1", email: "e@x", role: "DESIGNER" as Role } : undefined,
  } as unknown as Request;
  let code = 200;
  let body: unknown = null;
  const res = {
    status(c: number) { code = c; return this; },
    json(b: unknown) { body = b; return this; },
  } as unknown as Response;
  return { req, res, get code() { return code; }, get body() { return body; } };
}

/** Drive requireGameZone with the DB reporting `dbRole` and report the outcome. */
async function invokeGuard(
  dbRole: Role | null,
  opts: { authenticated?: boolean; isActive?: boolean } = {},
) {
  const ctx = fakeReqRes(opts.authenticated ?? true);
  db.findUnique.mockResolvedValue(
    dbRole ? { role: dbRole, isActive: opts.isActive ?? true } : null,
  );
  let passed = false;
  const next: NextFunction = () => { passed = true; };
  await requireGameZone(ctx.req, ctx.res, next);
  return { passed, code: ctx.code, body: ctx.body };
}

/** Drive requireZone(...) — used to prove GAME_MANAGER inherits NO other zone. */
async function invokeZone(dbRole: Role, zones: Array<"DESIGNER" | "CRM">) {
  const ctx = fakeReqRes(true);
  db.findUnique.mockResolvedValue({ role: dbRole, isActive: true });
  let passed = false;
  const next: NextFunction = () => { passed = true; };
  await requireZone(...zones)(ctx.req, ctx.res, next);
  return { passed, code: ctx.code };
}

/**
 * BE Test — Game zone guard (TASK game-manager, Q1 variant «б»): GAME_MANAGER,
 * DESIGNER, SUPER_DESIGNER, ADMIN and MANAGER pass; CRM-zone roles are 403'd.
 */
describe("requireGameZone middleware", () => {
  it("GAME_MANAGER, DESIGNER, SUPER_DESIGNER, ADMIN and MANAGER pass", async () => {
    expect((await invokeGuard("GAME_MANAGER")).passed).toBe(true);
    expect((await invokeGuard("DESIGNER")).passed).toBe(true);
    expect((await invokeGuard("SUPER_DESIGNER")).passed).toBe(true);
    expect((await invokeGuard("ADMIN")).passed).toBe(true);
    expect((await invokeGuard("MANAGER")).passed).toBe(true);
  });

  it("CRM and CRM_SUPER are 403'd", async () => {
    const r = await invokeGuard("CRM");
    expect(r.passed).toBe(false);
    expect(r.code).toBe(403);
    expect(r.body).toEqual({ error: "forbidden" });
    expect((await invokeGuard("CRM_SUPER")).code).toBe(403);
  });

  it("uses the fresh DB role, not the JWT role", async () => {
    // JWT says DESIGNER (fakeReqRes), DB says GAME_MANAGER → passes anyway,
    // so an admin's promotion takes effect without the user re-logging in.
    expect((await invokeGuard("GAME_MANAGER")).passed).toBe(true);
  });

  it("401s when unauthenticated, row missing, or deactivated", async () => {
    expect((await invokeGuard("GAME_MANAGER", { authenticated: false })).code).toBe(401);
    expect((await invokeGuard(null)).code).toBe(401);
    expect((await invokeGuard("GAME_MANAGER", { isActive: false })).code).toBe(401);
  });
});

/**
 * BE Test — the Q2 wall: GAME_MANAGER belongs to the Game zone ALONE. It must
 * be 403'd by every requireZone list, which is what closes CRM off to it.
 */
describe("GAME_MANAGER reaches no other zone", () => {
  it("is 403'd from the Design zone", async () => {
    const r = await invokeZone("GAME_MANAGER", ["DESIGNER"]);
    expect(r.passed).toBe(false);
    expect(r.code).toBe(403);
  });

  it("is 403'd from the CRM zone", async () => {
    const r = await invokeZone("GAME_MANAGER", ["CRM"]);
    expect(r.passed).toBe(false);
    expect(r.code).toBe(403);
  });

  it("is 403'd even when both zones are listed", async () => {
    expect((await invokeZone("GAME_MANAGER", ["DESIGNER", "CRM"])).code).toBe(403);
  });
});

/** BE Test — session round-trip for the new role (mirrors the CRM_SUPER test). */
describe("verifySession accepts the GAME_MANAGER role", () => {
  it("round-trips a GAME_MANAGER session", () => {
    const token = signSession({ sub: "u1", email: "g@x", role: "GAME_MANAGER" });
    expect(verifySession(token)?.role).toBe("GAME_MANAGER");
  });

  it("still rejects unknown roles", () => {
    const bad = jwt.sign({ sub: "u1", email: "x@x", role: "GAME_ADMIN" }, TEST_SECRET);
    expect(verifySession(bad)).toBeNull();
  });
});

/**
 * BE Test — the OAuth return target. Without "/game" in ALLOWED_NEXT the portal
 * sends ?next=/game, sanitizeNext collapses it to "/" and a Game manager lands
 * in the Design zone (→ /forbidden). Mirrors routes/auth.ts.
 */
describe("sanitizeNext accepts the Game zone", () => {
  it("keeps the existing zones", () => {
    expect(sanitizeNext("/")).toBe("/");
    expect(sanitizeNext("/crm")).toBe("/crm");
  });

  it("keeps /game", () => {
    expect(sanitizeNext("/game")).toBe("/game");
  });

  it("still rejects anything unlisted", () => {
    expect(sanitizeNext("/admin")).toBe("/");
    expect(sanitizeNext("https://evil.example")).toBe("/");
    expect(sanitizeNext(undefined)).toBe("/");
  });
});
