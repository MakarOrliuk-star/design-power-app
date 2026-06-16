import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

// env.ts validates process.env and calls process.exit() at import — mock it so
// jwt.js (which reads JWT_SECRET) can be imported in isolation. The literal is
// inlined in the factory because vi.mock is hoisted above top-level consts.
vi.mock("../src/env.js", () => ({ JWT_SECRET: "test-secret-key" }));
const TEST_SECRET = "test-secret-key";

import { requireZone } from "../src/middleware/auth.js";
import { signSession, verifySession } from "../src/lib/jwt.js";

type Role = "ADMIN" | "DESIGNER" | "CRM";

/** Drive requireZone with a fake req/res and report whether next() ran. */
function invoke(role: Role | null, zones: Role[]) {
  const req = { user: role ? { sub: "u1", email: "e@x", role } : undefined } as unknown as Request;
  let code = 200;
  let body: unknown = null;
  const res = {
    status(c: number) { code = c; return this; },
    json(b: unknown) { body = b; return this; },
  } as unknown as Response;
  let passed = false;
  const next: NextFunction = () => { passed = true; };
  requireZone(...zones)(req, res, next);
  return { passed, code, body };
}

/**
 * BE Test — zone wall (TASK: role-based Design/CRM separation). ADMIN reaches
 * every zone; the others are 403'd outside their own.
 */
describe("requireZone middleware", () => {
  it("ADMIN passes every zone", () => {
    expect(invoke("ADMIN", ["DESIGNER"]).passed).toBe(true);
    expect(invoke("ADMIN", ["CRM"]).passed).toBe(true);
  });

  it("DESIGNER reaches the Design zone but is 403'd from CRM", () => {
    expect(invoke("DESIGNER", ["DESIGNER"]).passed).toBe(true);
    const crm = invoke("DESIGNER", ["CRM"]);
    expect(crm.passed).toBe(false);
    expect(crm.code).toBe(403);
    expect(crm.body).toEqual({ error: "forbidden" });
  });

  it("CRM reaches the CRM zone but is 403'd from Design", () => {
    expect(invoke("CRM", ["CRM"]).passed).toBe(true);
    const design = invoke("CRM", ["DESIGNER"]);
    expect(design.passed).toBe(false);
    expect(design.code).toBe(403);
  });

  it("an unauthenticated request is 401", () => {
    const r = invoke(null, ["CRM"]);
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
