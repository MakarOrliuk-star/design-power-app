import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import request from "supertest";

// Route tests for /api/admin/layout-specs (TASK email-composition, Phase 1).
// prisma is mocked; the layoutSpec service runs for real on top of it, the
// admin guard chain is stubbed (as in editableBrands.route.test.ts).
const db = vi.hoisted(() => ({
  layoutSpec: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
}));
vi.mock("../src/env.js", () => ({
  JWT_SECRET: "test-secret-key",
  cloudinaryConfigured: true,
  personPipelineReady: true,
}));
vi.mock("../src/lib/prisma.js", () => ({ prisma: db }));
vi.mock("../src/lib/cloudinary.js", () => ({ uploadBase64: vi.fn(), withRetry: vi.fn() }));
vi.mock("../src/lib/falModels.js", () => ({
  MODEL_KEYS: ["fal-ai/nano-banana-2"],
  MODEL_OPTIONS: [{ key: "fal-ai/nano-banana-2", label: "Nano" }],
}));
vi.mock("../src/services/brand.service.js", () => ({
  createBrand: vi.fn(),
  updateBrand: vi.fn(),
  deleteBrand: vi.fn(),
  getBrandSnapshot: vi.fn(),
  updateBrandAudited: vi.fn(),
  rollbackBrand: vi.fn(),
}));
vi.mock("../src/services/generation.service.js", () => ({
  createBrandTestBatch: vi.fn(),
}));

import { adminRouter } from "../src/routes/admin.js";
import { EMAIL_HERO_V1, EMAIL_HERO_KEY } from "../src/services/layoutSpec.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: { sub: string; email: string } }).user = {
      sub: "admin1",
      email: "admin@test.dev",
    };
    next();
  });
  app.use("/api/admin", adminRouter);
  return app;
}

beforeEach(() => {
  for (const fn of Object.values(db.layoutSpec)) fn.mockReset();
});

describe("GET /api/admin/layout-specs", () => {
  it("lists all versions, newest first per key", async () => {
    db.layoutSpec.findMany.mockResolvedValue([
      { id: "a", key: EMAIL_HERO_KEY, version: 2, spec: EMAIL_HERO_V1, isActive: true },
      { id: "b", key: EMAIL_HERO_KEY, version: 1, spec: EMAIL_HERO_V1, isActive: true },
    ]);
    const res = await request(makeApp()).get("/api/admin/layout-specs");
    expect(res.status).toBe(200);
    expect(res.body.layoutSpecs).toHaveLength(2);
    expect(db.layoutSpec.findMany).toHaveBeenCalledWith({
      orderBy: [{ key: "asc" }, { version: "desc" }],
    });
  });
});

describe("POST /api/admin/layout-specs", () => {
  it("creates the next version for the key with the admin as author", async () => {
    db.layoutSpec.findFirst.mockResolvedValue({ version: 1 });
    db.layoutSpec.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: "new", isActive: true, ...data }),
    );
    const res = await request(makeApp())
      .post("/api/admin/layout-specs")
      .send({ key: EMAIL_HERO_KEY, spec: EMAIL_HERO_V1 });
    expect(res.status).toBe(201);
    expect(res.body.layoutSpec.version).toBe(2);
    expect(db.layoutSpec.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ version: 2, createdBy: "admin@test.dev" }),
    });
  });

  it("rejects a malformed spec with field-level details (400 invalid_spec)", async () => {
    const bad = structuredClone(EMAIL_HERO_V1) as Record<string, unknown>;
    (bad.subjects as Record<string, Record<string, unknown>>).person.fitHeight = {
      min: 0.9,
      target: 0.5,
      max: 1,
    };
    const res = await request(makeApp())
      .post("/api/admin/layout-specs")
      .send({ key: EMAIL_HERO_KEY, spec: bad });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_spec");
    expect(db.layoutSpec.create).not.toHaveBeenCalled();
  });

  it("rejects a missing key (400 invalid_body)", async () => {
    const res = await request(makeApp())
      .post("/api/admin/layout-specs")
      .send({ spec: EMAIL_HERO_V1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });
});

describe("PATCH /api/admin/layout-specs/:id", () => {
  it("toggles isActive only", async () => {
    db.layoutSpec.update.mockResolvedValue({ id: "a", isActive: false });
    const res = await request(makeApp())
      .patch("/api/admin/layout-specs/a")
      .send({ isActive: false });
    expect(res.status).toBe(200);
    expect(db.layoutSpec.update).toHaveBeenCalledWith({
      where: { id: "a" },
      data: { isActive: false },
    });
  });

  it("rejects attempts to mutate the spec body (immutability)", async () => {
    const res = await request(makeApp())
      .patch("/api/admin/layout-specs/a")
      .send({ spec: EMAIL_HERO_V1 });
    expect(res.status).toBe(400);
    expect(db.layoutSpec.update).not.toHaveBeenCalled();
  });

  it("404 on unknown id", async () => {
    db.layoutSpec.update.mockRejectedValue(new Error("not found"));
    const res = await request(makeApp())
      .patch("/api/admin/layout-specs/zzz")
      .send({ isActive: true });
    expect(res.status).toBe(404);
  });
});
