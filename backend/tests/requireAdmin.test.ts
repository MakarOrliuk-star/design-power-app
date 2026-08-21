import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";

// env.ts validates process.env and calls process.exit() at import — mock it so
// jwt.js (which reads JWT_SECRET) can be imported in isolation. The literal is
// inlined in the factory because vi.mock is hoisted above top-level consts.
vi.mock("../src/env.js", () => ({ JWT_SECRET: "test-secret-key" }));

// requireAdmin reads the fresh role from the DB — mock the user delegate.
const db = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("../src/lib/prisma.js", () => ({ prisma: { user: { findUnique: db.findUnique } } }));

import { requireAdmin } from "../src/middleware/auth.js";

type Role = "ADMIN" | "DESIGNER" | "CRM" | "MANAGER" | "SUPER_DESIGNER" | "CRM_SUPER";

/**
 * Drive requireAdmin with a fake req/res.
 *
 * `dbRole` is the role currently stored in the DB — what the guard must check.
 * The JWT deliberately carries ADMIN so every "DB wins" case is a real proof:
 * if the guard ever falls back to the token, these tests go green-to-red.
 * `dbRole = null` simulates a session whose user row is gone.
 */
async function invoke(
  dbRole: Role | null,
  opts: { authenticated?: boolean; isActive?: boolean; dbThrows?: boolean } = {},
) {
  const req = {
    user: (opts.authenticated ?? true)
      ? { sub: "u1", email: "e@x", role: "ADMIN" as Role }
      : undefined,
  } as unknown as Request;

  let code = 200;
  let body: unknown = null;
  const res = {
    status(c: number) { code = c; return this; },
    json(b: unknown) { body = b; return this; },
  } as unknown as Response;

  if (opts.dbThrows) db.findUnique.mockRejectedValue(new Error("db down"));
  else db.findUnique.mockResolvedValue(dbRole ? { role: dbRole, isActive: opts.isActive ?? true } : null);

  let passed = false;
  const next: NextFunction = () => { passed = true; };
  await requireAdmin(req, res, next);
  return { passed, code, body, req };
}

/**
 * BE Test — /api/admin guard. requireAdmin used to trust the role baked into
 * the 7-day session cookie, which made demotion and deactivation take up to a
 * week to bite on the one surface that hands out roles. It now mirrors the
 * other guards and reads role + isActive fresh from the DB.
 */
describe("requireAdmin middleware", () => {
  it("lets a current ADMIN through", async () => {
    expect((await invoke("ADMIN")).passed).toBe(true);
  });

  it("403s a demoted admin whose JWT still says ADMIN", async () => {
    // The revocation case: token minted while the user was ADMIN, DB now says
    // DESIGNER. Trusting the token here would keep /api/admin open for 7 days.
    const r = await invoke("DESIGNER");
    expect(r.passed).toBe(false);
    expect(r.code).toBe(403);
    expect(r.body).toEqual({ error: "forbidden" });
  });

  it("403s every non-admin role, including MANAGER", async () => {
    // MANAGER passes every requireZone by construction — it must NOT pass here.
    for (const role of ["CRM", "MANAGER", "SUPER_DESIGNER", "CRM_SUPER"] as const) {
      expect((await invoke(role)).code).toBe(403);
    }
  });

  it("401s a deactivated admin", async () => {
    const r = await invoke("ADMIN", { isActive: false });
    expect(r.passed).toBe(false);
    expect(r.code).toBe(401);
  });

  it("401s when unauthenticated or the user row is gone", async () => {
    expect((await invoke("ADMIN", { authenticated: false })).code).toBe(401);
    expect((await invoke(null)).code).toBe(401);
  });

  it("syncs req.user.role from the DB for downstream handlers", async () => {
    // admin.ts writes req.user!.email / req.user!.sub into audit fields; the
    // role must not stay stale behind them.
    const r = await invoke("ADMIN");
    expect(r.req.user!.role).toBe("ADMIN");
  });

  it("fails closed with 500 when the DB lookup throws", async () => {
    const r = await invoke("ADMIN", { dbThrows: true });
    expect(r.passed).toBe(false);
    expect(r.code).toBe(500);
  });
});
