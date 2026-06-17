import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import request from "supertest";

// crm.ts only touches prisma — mock the CrmServiceFavorite delegate.
const db = vi.hoisted(() => ({
  findMany: vi.fn(),
  upsert: vi.fn(),
  deleteMany: vi.fn(),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    crmServiceFavorite: { findMany: db.findMany, upsert: db.upsert, deleteMany: db.deleteMany },
  },
}));

import { crmRouter } from "../src/routes/crm.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  // Stand in for loadUser + requireAuth + requireZone("CRM").
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: { sub: string } }).user = { sub: "user1" };
    next();
  });
  app.use("/api/crm", crmRouter);
  return app;
}

beforeEach(() => {
  db.findMany.mockReset();
  db.upsert.mockReset();
  db.deleteMany.mockReset();
});

describe("GET /api/crm/favorites", () => {
  it("returns the user's favorite service keys", async () => {
    db.findMany.mockResolvedValue([{ serviceKey: "calculator" }, { serviceKey: "auditor" }]);
    const res = await request(makeApp()).get("/api/crm/favorites");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ favorites: ["calculator", "auditor"] });
    expect(db.findMany).toHaveBeenCalledWith({ where: { userId: "user1" }, select: { serviceKey: true } });
  });
});

describe("POST /api/crm/favorites/:serviceKey", () => {
  it("upserts a favorite for a valid service key", async () => {
    db.upsert.mockResolvedValue({});
    const res = await request(makeApp()).post("/api/crm/favorites/bonuscalc");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(db.upsert).toHaveBeenCalledOnce();
  });

  // The allowlist guards against junk keys AND against favoriting a "soon" tile
  // (e.g. rebrandly), which has no real logic yet.
  it("rejects an unknown / soon service key with 400", async () => {
    const res = await request(makeApp()).post("/api/crm/favorites/rebrandly");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_service_key" });
    expect(db.upsert).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/crm/favorites/:serviceKey", () => {
  it("removes a favorite (idempotent)", async () => {
    db.deleteMany.mockResolvedValue({ count: 1 });
    const res = await request(makeApp()).delete("/api/crm/favorites/calculator");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(db.deleteMany).toHaveBeenCalledWith({ where: { userId: "user1", serviceKey: "calculator" } });
  });
});
