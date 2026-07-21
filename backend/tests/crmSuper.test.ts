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

import { requireCrmSuper, requireZone } from "../src/middleware/auth.js";
import { signSession, verifySession } from "../src/lib/jwt.js";

type Role = "ADMIN" | "DESIGNER" | "CRM" | "MANAGER" | "SUPER_DESIGNER" | "CRM_SUPER";

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

/** Drive requireCrmSuper with the DB reporting `dbRole` and report the outcome. */
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
  await requireCrmSuper(ctx.req, ctx.res, next);
  return { passed, code: ctx.code, body: ctx.body };
}

/** Drive requireZone(...) — used to prove CRM_SUPER inherits the CRM zone. */
async function invokeZone(dbRole: Role, zones: Array<"DESIGNER" | "CRM">) {
  const ctx = fakeReqRes(true);
  db.findUnique.mockResolvedValue({ role: dbRole, isActive: true });
  let passed = false;
  const next: NextFunction = () => { passed = true; };
  await requireZone(...zones)(ctx.req, ctx.res, next);
  return { passed, code: ctx.code };
}

/**
 * BE Test — Image Bundles guard (TASK crm-bundle, D4): CRM_SUPER, ADMIN and
 * MANAGER pass; plain CRM and Design-zone roles are 403'd; the DB role wins
 * over the (stale) JWT role.
 */
describe("requireCrmSuper middleware", () => {
  it("CRM_SUPER, ADMIN and MANAGER pass", async () => {
    expect((await invokeGuard("CRM_SUPER")).passed).toBe(true);
    expect((await invokeGuard("ADMIN")).passed).toBe(true);
    expect((await invokeGuard("MANAGER")).passed).toBe(true);
  });

  it("plain CRM is 403'd (negative test from Phase 1 DoD)", async () => {
    const r = await invokeGuard("CRM");
    expect(r.passed).toBe(false);
    expect(r.code).toBe(403);
    expect(r.body).toEqual({ error: "forbidden" });
  });

  it("DESIGNER and SUPER_DESIGNER are 403'd", async () => {
    expect((await invokeGuard("DESIGNER")).code).toBe(403);
    expect((await invokeGuard("SUPER_DESIGNER")).code).toBe(403);
  });

  it("uses the fresh DB role, not the JWT role", async () => {
    // JWT says DESIGNER (fakeReqRes), DB says CRM_SUPER → passes immediately.
    expect((await invokeGuard("CRM_SUPER")).passed).toBe(true);
  });

  it("401s when unauthenticated, row missing, or deactivated", async () => {
    expect((await invokeGuard("CRM_SUPER", { authenticated: false })).code).toBe(401);
    expect((await invokeGuard(null)).code).toBe(401);
    expect((await invokeGuard("CRM_SUPER", { isActive: false })).code).toBe(401);
  });
});

/**
 * BE Test — CRM_SUPER is a CRM-zone role: reaches every CRM-zone service
 * (calculator/auditor/smartico/crm) but never the Design zone.
 */
describe("requireZone with CRM_SUPER", () => {
  it("CRM_SUPER reaches the CRM zone", async () => {
    expect((await invokeZone("CRM_SUPER", ["CRM"])).passed).toBe(true);
  });

  it("CRM_SUPER is 403'd from the Design zone", async () => {
    const r = await invokeZone("CRM_SUPER", ["DESIGNER"]);
    expect(r.passed).toBe(false);
    expect(r.code).toBe(403);
  });
});

/** BE Test — session round-trip for the new role (mirrors the CRM-role test). */
describe("verifySession accepts the CRM_SUPER role", () => {
  it("round-trips a CRM_SUPER session", () => {
    const token = signSession({ sub: "u1", email: "s@x", role: "CRM_SUPER" });
    expect(verifySession(token)?.role).toBe("CRM_SUPER");
  });

  it("still rejects unknown roles", () => {
    const bad = jwt.sign({ sub: "u1", email: "x@x", role: "CRM_ULTRA" }, TEST_SECRET);
    expect(verifySession(bad)).toBeNull();
  });
});
