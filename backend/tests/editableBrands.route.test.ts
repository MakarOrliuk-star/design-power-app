import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import request from "supertest";

// ---- Mocks (hoisted so the route's module graph picks them up) ----
const db = vi.hoisted(() => ({
  brandFindUnique: vi.fn(),
  brandFindMany: vi.fn(),
  categoryFindMany: vi.fn(),
  changeLogCount: vi.fn(),
}));
const services = vi.hoisted(() => ({
  createBrand: vi.fn(),
  updateBrand: vi.fn(),
  deleteBrand: vi.fn(),
  getBrandSnapshot: vi.fn(),
  updateBrandAudited: vi.fn(),
  rollbackBrand: vi.fn(),
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
    brandChangeLog: { count: db.changeLogCount },
  },
}));
vi.mock("../src/lib/cloudinary.js", () => ({ uploadBase64: vi.fn(), withRetry: vi.fn() }));
vi.mock("../src/lib/falModels.js", () => ({
  MODEL_KEYS: ["fal-ai/nano-banana-2", "xai/test-model"],
  MODEL_OPTIONS: [{ key: "xai/test-model", label: "Test Model" }],
}));
vi.mock("../src/services/brand.service.js", () => ({
  createBrand: services.createBrand,
  updateBrand: services.updateBrand,
  deleteBrand: services.deleteBrand,
  getBrandSnapshot: services.getBrandSnapshot,
  updateBrandAudited: services.updateBrandAudited,
  rollbackBrand: services.rollbackBrand,
}));
vi.mock("../src/services/generation.service.js", () => ({
  createBrandTestBatch: services.createBrandTestBatch,
}));

import { myBrandsRouter } from "../src/routes/myBrands.js";

const ME = "user1";
const MY_EMAIL = "me@test.dev";
const ACTOR = { userId: ME, userEmail: MY_EMAIL };

function makeApp() {
  const app = express();
  app.use(express.json());
  // Stand in for loadUser + requireAuth + requireSuperDesigner.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: { sub: string; email: string } }).user = {
      sub: ME,
      email: MY_EMAIL,
    };
    next();
  });
  app.use("/api/my-brands", myBrandsRouter);
  return app;
}

function snapshot(over: Record<string, unknown> = {}) {
  return {
    name: "Legacy",
    categoryIds: ["c1"],
    personPrompt: "base",
    stylePrompt: "style",
    referenceImages: ["https://cdn/r1.png"],
    forcedAspectRatio: null,
    imageModel: null,
    isActive: true,
    ...over,
  };
}

beforeEach(() => {
  for (const fn of [...Object.values(db), ...Object.values(services)]) fn.mockReset();
});

/**
 * BE Test — «Edit current style» (TASK download-and-edit-style §2): the
 * editable surface deliberately has NO ownership wall — legacy/admin brands
 * (createdById=null) are editable too, with every change audited.
 */
describe("GET /api/my-brands/editable", () => {
  it("lists ALL brands (no ownership filter) plus categories and models", async () => {
    db.brandFindMany.mockResolvedValue([
      { id: "b1", name: "Foreign", isActive: true },
      { id: "b2", name: "Legacy", isActive: false },
    ]);
    db.categoryFindMany.mockResolvedValue([{ id: "c1", name: "Sport" }]);

    const res = await request(makeApp()).get("/api/my-brands/editable");

    expect(res.status).toBe(200);
    expect(res.body.brands).toHaveLength(2);
    expect(res.body.models).toEqual([{ key: "xai/test-model", label: "Test Model" }]);
    // No createdById in the where clause — every brand is listed.
    expect(db.brandFindMany.mock.calls[0]![0].where).toBeUndefined();
  });
});

describe("GET /api/my-brands/editable/:id", () => {
  it("returns the full snapshot with a canRollback flag", async () => {
    services.getBrandSnapshot.mockResolvedValue(snapshot());
    db.changeLogCount.mockResolvedValue(2);

    const res = await request(makeApp()).get("/api/my-brands/editable/b1");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "b1", name: "Legacy", canRollback: true });
  });

  it("404s a missing brand", async () => {
    services.getBrandSnapshot.mockResolvedValue(null);
    const res = await request(makeApp()).get("/api/my-brands/editable/nope");
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/my-brands/editable/:id", () => {
  it("updates any brand through updateBrandAudited with the actor identity", async () => {
    services.updateBrandAudited.mockResolvedValue({
      ok: true,
      brand: { id: "b1", name: "Renamed" },
      changed: true,
    });
    services.getBrandSnapshot.mockResolvedValue(snapshot({ name: "Renamed" }));

    const res = await request(makeApp())
      .patch("/api/my-brands/editable/b1")
      .send({ name: "Renamed", imageModel: "xai/test-model", isActive: false });

    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(services.updateBrandAudited).toHaveBeenCalledWith(
      "b1",
      { name: "Renamed", imageModel: "xai/test-model", isActive: false },
      ACTOR,
    );
  });

  it("409s a name clash and 404s a missing brand", async () => {
    services.updateBrandAudited.mockResolvedValue({ ok: false, error: "already_exists" });
    const clash = await request(makeApp()).patch("/api/my-brands/editable/b1").send({ name: "X" });
    expect(clash.status).toBe(409);

    services.updateBrandAudited.mockResolvedValue({ ok: false, error: "brand_not_found" });
    const missing = await request(makeApp()).patch("/api/my-brands/editable/b1").send({ name: "X" });
    expect(missing.status).toBe(404);
  });

  it("400s an unknown imageModel key", async () => {
    const res = await request(makeApp())
      .patch("/api/my-brands/editable/b1")
      .send({ imageModel: "not-a-model" });
    expect(res.status).toBe(400);
    expect(services.updateBrandAudited).not.toHaveBeenCalled();
  });
});

describe("POST /api/my-brands/editable/:id/rollback", () => {
  it("restores the previous version via rollbackBrand", async () => {
    services.rollbackBrand.mockResolvedValue({
      ok: true,
      brand: { id: "b1", name: "Legacy" },
      restored: snapshot(),
    });
    const res = await request(makeApp()).post("/api/my-brands/editable/b1/rollback");
    expect(res.status).toBe(200);
    expect(services.rollbackBrand).toHaveBeenCalledWith("b1", ACTOR);
    expect(res.body.snapshot.name).toBe("Legacy");
  });

  it("409s when there is nothing to roll back", async () => {
    services.rollbackBrand.mockResolvedValue({ ok: false, error: "nothing_to_rollback" });
    const res = await request(makeApp()).post("/api/my-brands/editable/b1/rollback");
    expect(res.status).toBe(409);
  });
});

describe("POST /api/my-brands/editable/:id/test — draft test", () => {
  it("passes the DRAFT values as overrides without touching the brand", async () => {
    db.brandFindUnique.mockResolvedValue({ id: "b1" });
    services.createBrandTestBatch.mockResolvedValue({ batchId: "bt1", generationId: "g1" });

    const res = await request(makeApp())
      .post("/api/my-brands/editable/b1/test")
      .send({
        prompt: "a dog on a cloud",
        aspectRatio: "9:16",
        personPrompt: "draft system prompt",
        referenceImages: ["https://cdn/new-ref.png"],
        imageModel: "xai/test-model",
      });

    expect(res.status).toBe(200);
    expect(services.createBrandTestBatch).toHaveBeenCalledWith({
      userId: ME,
      brandId: "b1",
      prompt: "a dog on a cloud",
      aspectRatio: "9:16",
      overrides: {
        personPrompt: "draft system prompt",
        referenceImages: ["https://cdn/new-ref.png"],
        imageModel: "xai/test-model",
      },
    });
    expect(services.updateBrand).not.toHaveBeenCalled();
    expect(services.updateBrandAudited).not.toHaveBeenCalled();
  });

  it("omits overrides entirely when none are sent (plain saved-state test)", async () => {
    db.brandFindUnique.mockResolvedValue({ id: "b1" });
    services.createBrandTestBatch.mockResolvedValue({ batchId: "bt1", generationId: "g1" });

    const res = await request(makeApp())
      .post("/api/my-brands/editable/b1/test")
      .send({ prompt: "x" });

    expect(res.status).toBe(200);
    expect(services.createBrandTestBatch).toHaveBeenCalledWith({
      userId: ME,
      brandId: "b1",
      prompt: "x",
      aspectRatio: "9:16",
    });
  });

  it("404s an unknown brand", async () => {
    db.brandFindUnique.mockResolvedValue(null);
    const res = await request(makeApp())
      .post("/api/my-brands/editable/nope/test")
      .send({ prompt: "x" });
    expect(res.status).toBe(404);
  });
});
