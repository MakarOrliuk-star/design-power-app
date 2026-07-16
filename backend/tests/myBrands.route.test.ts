import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import request from "supertest";

// ---- Mocks (hoisted so the route's module graph picks them up) ----
const db = vi.hoisted(() => ({
  brandFindUnique: vi.fn(),
  brandFindMany: vi.fn(),
  categoryFindMany: vi.fn(),
  genFindUnique: vi.fn(),
  genFindMany: vi.fn(),
  genUpdate: vi.fn(),
  userFindUnique: vi.fn(),
}));
const services = vi.hoisted(() => ({
  createBrand: vi.fn(),
  updateBrand: vi.fn(),
  deleteBrand: vi.fn(),
  createBrandTestBatch: vi.fn(),
}));

vi.mock("../src/env.js", () => ({
  JWT_SECRET: "test-secret-key",
  cloudinaryConfigured: true,
  personPipelineReady: true,
}));
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    brand: { findUnique: db.brandFindUnique, findMany: db.brandFindMany },
    brandCategory: { findMany: db.categoryFindMany },
    generation: { findUnique: db.genFindUnique, findMany: db.genFindMany, update: db.genUpdate },
    user: { findUnique: db.userFindUnique },
  },
}));
vi.mock("../src/lib/cloudinary.js", () => ({ uploadBase64: vi.fn(), withRetry: vi.fn() }));
vi.mock("../src/services/brand.service.js", () => ({
  createBrand: services.createBrand,
  updateBrand: services.updateBrand,
  deleteBrand: services.deleteBrand,
}));
vi.mock("../src/services/generation.service.js", () => ({
  createBrandTestBatch: services.createBrandTestBatch,
}));

import { myBrandsRouter } from "../src/routes/myBrands.js";
import { requireSuperDesigner, requireZone } from "../src/middleware/auth.js";

const ME = "user1";

function makeApp() {
  const app = express();
  app.use(express.json());
  // Stand in for loadUser + requireAuth + requireSuperDesigner.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: { sub: string } }).user = { sub: ME };
    next();
  });
  app.use("/api/my-brands", myBrandsRouter);
  return app;
}

/** DB row for loadOwnBrand. */
function ownBrand(createdById: string | null = ME) {
  return { id: "b1", name: "TestBrand", createdById };
}

beforeEach(() => {
  for (const fn of [...Object.values(db), ...Object.values(services)]) fn.mockReset();
});

/**
 * BE Test — ownership wall (TASK super-designer: редактирование чужих/старых
 * брендов запрещено НА СЕРВЕРЕ). Foreign and legacy (ownerless) brands are 403
 * on every mutating verb, including test runs.
 */
describe("ownership: only the creator may touch a brand", () => {
  const verbs = [
    ["patch", "/api/my-brands/b1"],
    ["delete", "/api/my-brands/b1"],
    ["post", "/api/my-brands/b1/test"],
    ["get", "/api/my-brands/b1/tests"],
  ] as const;

  it("403s a FOREIGN brand on every route", async () => {
    for (const [verb, url] of verbs) {
      db.brandFindUnique.mockResolvedValue(ownBrand("someone-else"));
      const res = await request(makeApp())[verb](url).send({ prompt: "x" });
      expect(res.status, `${verb} ${url}`).toBe(403);
    }
    expect(services.updateBrand).not.toHaveBeenCalled();
    expect(services.deleteBrand).not.toHaveBeenCalled();
    expect(services.createBrandTestBatch).not.toHaveBeenCalled();
  });

  it("403s a LEGACY brand (createdById=null) — old brands are nobody's", async () => {
    db.brandFindUnique.mockResolvedValue(ownBrand(null));
    const res = await request(makeApp()).patch("/api/my-brands/b1").send({ name: "X" });
    expect(res.status).toBe(403);
  });

  it("404s a missing brand", async () => {
    db.brandFindUnique.mockResolvedValue(null);
    const res = await request(makeApp()).delete("/api/my-brands/b1");
    expect(res.status).toBe(404);
  });

  it("lets the owner through (PATCH → updateBrand)", async () => {
    db.brandFindUnique.mockResolvedValue(ownBrand());
    services.updateBrand.mockResolvedValue({ ok: true, brand: { id: "b1", name: "X" } });
    const res = await request(makeApp()).patch("/api/my-brands/b1").send({ name: "X" });
    expect(res.status).toBe(200);
    expect(services.updateBrand).toHaveBeenCalledWith("b1", { name: "X" });
  });
});

/**
 * BE Test — create stamps the caller as owner and surfaces name clashes.
 */
describe("POST /api/my-brands", () => {
  it("passes createdById = the caller to the shared service", async () => {
    services.createBrand.mockResolvedValue({ ok: true, brand: { id: "b9", name: "New" } });
    const res = await request(makeApp())
      .post("/api/my-brands")
      .send({ name: "New", personPrompt: "p" });
    expect(res.status).toBe(201);
    expect(services.createBrand).toHaveBeenCalledWith(
      expect.objectContaining({ name: "New", createdById: ME }),
    );
  });

  it("409s a duplicate name", async () => {
    services.createBrand.mockResolvedValue({ ok: false, error: "already_exists" });
    const res = await request(makeApp()).post("/api/my-brands").send({ name: "Dup" });
    expect(res.status).toBe(409);
  });

  it("400s a blank name", async () => {
    const res = await request(makeApp()).post("/api/my-brands").send({ name: "   " });
    expect(res.status).toBe(400);
    expect(services.createBrand).not.toHaveBeenCalled();
  });
});

/**
 * BE Test — «Протестировать бренд» + «Сохранить» flow. A test run may only
 * target the caller's own brand; save flips isTest → false ONLY for a DONE
 * generation that belongs to both the brand and the caller.
 */
describe("brand test flow", () => {
  it("runs a test on an own brand with the given prompt/aspect", async () => {
    db.brandFindUnique.mockResolvedValue(ownBrand());
    services.createBrandTestBatch.mockResolvedValue({ batchId: "bt1", generationId: "g1" });
    const res = await request(makeApp())
      .post("/api/my-brands/b1/test")
      .send({ prompt: "bulldog on a cloud", aspectRatio: "9:16" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ batchId: "bt1", generationId: "g1" });
    expect(services.createBrandTestBatch).toHaveBeenCalledWith({
      userId: ME,
      brandId: "b1",
      prompt: "bulldog on a cloud",
      aspectRatio: "9:16",
    });
  });

  it("400s an empty prompt", async () => {
    db.brandFindUnique.mockResolvedValue(ownBrand());
    const res = await request(makeApp()).post("/api/my-brands/b1/test").send({ prompt: "  " });
    expect(res.status).toBe(400);
    expect(services.createBrandTestBatch).not.toHaveBeenCalled();
  });

  it("save flips isTest → false for the owner's DONE generation", async () => {
    db.brandFindUnique.mockResolvedValue(ownBrand());
    db.genFindUnique.mockResolvedValue({
      id: "g1", userId: ME, brandId: "b1", isTest: true, status: "DONE",
    });
    const res = await request(makeApp()).post("/api/my-brands/b1/test/g1/save");
    expect(res.status).toBe(200);
    expect(db.genUpdate).toHaveBeenCalledWith({ where: { id: "g1" }, data: { isTest: false } });
  });

  it("404s saving someone else's generation", async () => {
    db.brandFindUnique.mockResolvedValue(ownBrand());
    db.genFindUnique.mockResolvedValue({
      id: "g1", userId: "intruder", brandId: "b1", isTest: true, status: "DONE",
    });
    const res = await request(makeApp()).post("/api/my-brands/b1/test/g1/save");
    expect(res.status).toBe(404);
    expect(db.genUpdate).not.toHaveBeenCalled();
  });

  it("409s saving an unfinished generation", async () => {
    db.brandFindUnique.mockResolvedValue(ownBrand());
    db.genFindUnique.mockResolvedValue({
      id: "g1", userId: ME, brandId: "b1", isTest: true, status: "PROCESSING",
    });
    const res = await request(makeApp()).post("/api/my-brands/b1/test/g1/save");
    expect(res.status).toBe(409);
  });
});

/**
 * BE Test — the Library list is scoped to the caller's own brands only.
 */
describe("GET /api/my-brands", () => {
  it("queries only createdById = caller", async () => {
    db.brandFindMany.mockResolvedValue([]);
    db.categoryFindMany.mockResolvedValue([]);
    const res = await request(makeApp()).get("/api/my-brands");
    expect(res.status).toBe(200);
    expect(db.brandFindMany.mock.calls[0]![0].where).toEqual({ createdById: ME });
  });
});

/**
 * BE Test — guards. requireSuperDesigner admits SUPER_DESIGNER/ADMIN/MANAGER
 * (fresh DB role); requireZone lets SUPER_DESIGNER into the Design zone but
 * keeps the CRM wall up.
 */
describe("SUPER_DESIGNER guards", () => {
  function fakeReqRes(dbRole: string | null) {
    db.userFindUnique.mockResolvedValue(dbRole ? { role: dbRole, isActive: true } : null);
    const req = { user: { sub: "u1", email: "e@x", role: "DESIGNER" } } as unknown as Request;
    let code = 200;
    const res = {
      status(c: number) { code = c; return this; },
      json() { return this; },
    } as unknown as Response;
    let passed = false;
    const next: NextFunction = () => { passed = true; };
    return { req, res, next, code: () => code, passed: () => passed };
  }

  it("requireSuperDesigner admits SUPER_DESIGNER, ADMIN, MANAGER; 403s the rest", async () => {
    for (const role of ["SUPER_DESIGNER", "ADMIN", "MANAGER"]) {
      const f = fakeReqRes(role);
      await requireSuperDesigner(f.req, f.res, f.next);
      expect(f.passed(), role).toBe(true);
    }
    for (const role of ["DESIGNER", "CRM"]) {
      const f = fakeReqRes(role);
      await requireSuperDesigner(f.req, f.res, f.next);
      expect(f.passed(), role).toBe(false);
      expect(f.code(), role).toBe(403);
    }
  });

  it("requireZone: SUPER_DESIGNER reaches the Design zone but not CRM", async () => {
    const design = fakeReqRes("SUPER_DESIGNER");
    await requireZone("DESIGNER")(design.req, design.res, design.next);
    expect(design.passed()).toBe(true);

    const crm = fakeReqRes("SUPER_DESIGNER");
    await requireZone("CRM")(crm.req, crm.res, crm.next);
    expect(crm.passed()).toBe(false);
    expect(crm.code()).toBe(403);
  });
});
