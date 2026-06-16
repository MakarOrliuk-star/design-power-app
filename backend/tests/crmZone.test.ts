import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

// env.ts validates process.env and calls process.exit() at import — mock it so
// jwt.js (which reads JWT_SECRET) can be imported in isolation. The literal is
// inlined in the factory because vi.mock is hoisted above top-level consts.
vi.mock("../src/env.js", () => ({ JWT_SECRET: "test-secret-key" }));
const TEST_SECRET = "test-secret-key";

// requireZone reads the fresh role from the DB — mock the user delegate.
const db = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("../src/lib/prisma.js", () => ({ prisma: { user: { findUnique: db.findUnique } } }));

import { requireZone } from "../src/middleware/auth.js";
import { signSession, verifySession } from "../src/lib/jwt.js";

type Role = "ADMIN" | "DESIGNER" | "CRM";

/**
 * Drive requireZone with a fake req/res and report whether next() ran.
 * `dbRole` is the CURRENT role stored in the DB (what the guard actually checks);
 * the JWT carries a deliberately different role to prove the DB value wins.
 * `dbRole = null` simulates an authenticated session whose user row is gone
 * (or deactivated); `req.user = undefined` is covered separately.
 */
async function invoke(
  dbRole: Role | null,
  zones: Role[],
  opts: { authenticated?: boolean; isActive?: boolean } = {},
) {
  const authenticated = opts.authenticated ?? true;
  const req = {
    user: authenticated ? { sub: "u1", email: "e@x", role: "DESIGNER" as Role } : undefined,
  } as unknown as Request;
  db.findUnique.mockResolvedValue(
    dbRole ? { role: dbRole, isActive: opts.isActive ?? true } : null,
  );
  let code = 200;
  let body: unknown = null;
  const res = {
    status(c: number) { code = c; return this; },
    json(b: unknown) { body = b; return this; },
  } as unknown as Response;
  let passed = false;
  const next: NextFunction = () => { passed = true; };
  await requireZone(...zones)(req, res, next);
  return { passed, code, body };
}

/**
 * BE Test — zone wall (TASK: role-based Design/CRM separation). ADMIN reaches
 * every zone; the others are 403'd outside their own. The role is read fresh
 * from the DB, so a just-promoted user is let in without re-login.
 */
describe("requireZone middleware", () => {
  it("ADMIN passes every zone", async () => {
    expect((await invoke("ADMIN", ["DESIGNER"])).passed).toBe(true);
    expect((await invoke("ADMIN", ["CRM"])).passed).toBe(true);
  });

  it("DESIGNER reaches the Design zone but is 403'd from CRM", async () => {
    expect((await invoke("DESIGNER", ["DESIGNER"])).passed).toBe(true);
    const crm = await invoke("DESIGNER", ["CRM"]);
    expect(crm.passed).toBe(false);
    expect(crm.code).toBe(403);
    expect(crm.body).toEqual({ error: "forbidden" });
  });

  it("CRM reaches the CRM zone but is 403'd from Design", async () => {
    expect((await invoke("CRM", ["CRM"])).passed).toBe(true);
    const design = await invoke("CRM", ["DESIGNER"]);
    expect(design.passed).toBe(false);
    expect(design.code).toBe(403);
  });

  it("uses the fresh DB role, not the (stale) JWT role", async () => {
    // JWT says DESIGNER (set in invoke), DB says CRM → a freshly-promoted user
    // reaches the CRM zone immediately, without re-logging in.
    const r = await invoke("CRM", ["CRM"]);
    expect(r.passed).toBe(true);
  });

  it("401s when the user row is missing or deactivated", async () => {
    expect((await invoke(null, ["CRM"])).code).toBe(401); // missing
    expect((await invoke("CRM", ["CRM"], { isActive: false })).code).toBe(401); // deactivated
  });

  it("an unauthenticated request is 401", async () => {
    const r = await invoke("CRM", ["CRM"], { authenticated: false });
    expect(r.passed).toBe(false);
    expect(r.code).toBe(401);
    expect(r.body).toEqual({ error: "unauthorized" });
  });
});

/**
 * BE Test — session must accept the new CRM role. Before the fix verifySession
 * rejected anything but ADMIN/DESIGNER, which would lock CRM users out entirely.
 */
describe("verifySession accepts the CRM role", () => {
  it("round-trips a CRM session", () => {
    const token = signSession({ sub: "u1", email: "c@x", role: "CRM" });
    expect(verifySession(token)?.role).toBe("CRM");
  });

  it("still round-trips DESIGNER and ADMIN", () => {
    expect(verifySession(signSession({ sub: "u", email: "d", role: "DESIGNER" }))?.role).toBe("DESIGNER");
    expect(verifySession(signSession({ sub: "u", email: "a", role: "ADMIN" }))?.role).toBe("ADMIN");
  });

  it("rejects a token carrying an unknown role", () => {
    const bad = jwt.sign({ sub: "u1", email: "x@x", role: "SUPERUSER" }, TEST_SECRET);
    expect(verifySession(bad)).toBeNull();
  });
});
