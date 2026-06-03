import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import request from "supertest";

// Mutable env state so we can flip the edit-pipeline readiness per test. The env
// module is also mocked to avoid its import-time process.exit() validation.
const cfg = vi.hoisted(() => ({ edit: true }));
const db = vi.hoisted(() => ({
  findMany: vi.fn(), // generation lookup
  batchCreate: vi.fn(),
  generationCreate: vi.fn(),
}));
const queue = vi.hoisted(() => ({ addBulk: vi.fn() }));

vi.mock("../src/env.js", () => ({
  personPipelineReady: true,
  itemPipelineReady: true,
  get editPipelineReady() {
    return cfg.edit;
  },
}));
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    generation: { findMany: db.findMany, create: db.generationCreate },
    batch: { create: db.batchCreate },
  },
}));
vi.mock("../src/lib/cloudinary.js", () => ({ uploadBase64: vi.fn(), withRetry: vi.fn() }));
vi.mock("../src/services/finalize.js", () => ({ recomputeBatchStatus: vi.fn() }));
vi.mock("../src/queues/index.js", () => ({
  getPersonQueue: () => ({ addBulk: queue.addBulk }),
  getItemQueue: () => ({ addBulk: queue.addBulk }),
}));

import { generateRouter } from "../src/routes/generate.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: { sub: string } }).user = { sub: "user1" };
    next();
  });
  app.use("/api", generateRouter);
  return app;
}

beforeEach(() => {
  cfg.edit = true;
  db.findMany.mockReset();
  db.batchCreate.mockReset();
  db.generationCreate.mockReset();
  queue.addBulk.mockReset();
});

/**
 * BE Test 3 — POST /api/generate/edit guard rails (TASK §5).
 * The endpoint must reject malformed input (zod) and refuse to run when the edit
 * pipeline (fal + Cloudinary keys) isn't configured.
 */
describe("POST /api/generate/edit — validation", () => {
  it("rejects an empty generationIds array with 400 invalid_body", async () => {
    const res = await request(makeApp())
      .post("/api/generate/edit")
      .send({ generationIds: [], prompt: "x" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(db.findMany).not.toHaveBeenCalled();
  });

  it("returns 503 when the edit pipeline is not configured", async () => {
    cfg.edit = false;
    const res = await request(makeApp())
      .post("/api/generate/edit")
      .send({ generationIds: ["g1"], prompt: "make it darker" });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("edit_pipeline_not_configured");
    expect(db.findMany).not.toHaveBeenCalled();
  });
});

/**
 * BE Test 4 — edit source resolution (TASK §5).
 * Edits only apply to the user's own DONE images, and every source needs a prompt.
 */
describe("POST /api/generate/edit — source resolution", () => {
  it("returns 404 when none of the ids resolve to editable images", async () => {
    db.findMany.mockResolvedValue([]); // nothing matched (wrong user / not DONE)

    const res = await request(makeApp())
      .post("/api/generate/edit")
      .send({ generationIds: ["g1"], prompt: "make it darker" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_editable_images");
    expect(db.batchCreate).not.toHaveBeenCalled();
  });

  it("returns 400 empty_prompt when a resolved source has no instruction", async () => {
    db.findMany.mockResolvedValue([
      {
        id: "g1",
        brandName: "Nike",
        theme: null,
        actionType: "FULL",
        generatedImageUrl: "https://cdn/1.png",
      },
    ]);

    // No shared prompt and no perPrompts → the source resolves to an empty string.
    const res = await request(makeApp())
      .post("/api/generate/edit")
      .send({ generationIds: ["g1"] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("empty_prompt");
    expect(db.batchCreate).not.toHaveBeenCalled();
  });
});
