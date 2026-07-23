import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import request from "supertest";

// Route-level tests: prisma + queue mocked; the guard chain is stubbed the way
// crmFavorites.route.test.ts does (requireCrmSuper itself is covered in
// crmSuper.test.ts).
const db = vi.hoisted(() => ({
  brand: { findMany: vi.fn() },
  bundle: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    count: vi.fn(),
    groupBy: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  bundleType: { findFirst: vi.fn(), findMany: vi.fn() },
  bundleAsset: { findMany: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  neuralPromptPreset: { findMany: vi.fn() },
}));
const sendMock = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/prisma.js", () => ({ prisma: db }));
vi.mock("../src/queues/index.js", () => ({ getBundleQueue: () => ({ add: vi.fn(), addBulk: vi.fn() }) }));
vi.mock("../src/services/bundleSmartico.service.js", () => ({ sendBundleToSmartico: sendMock }));

import { bundlesRouter } from "../src/routes/bundles.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: { sub: string } }).user = { sub: "user1" };
    next();
  });
  app.use("/api/bundles", bundlesRouter);
  return app;
}

beforeEach(() => {
  for (const delegate of Object.values(db)) {
    for (const fn of Object.values(delegate)) (fn as ReturnType<typeof vi.fn>).mockReset();
  }
});

describe("GET /api/bundles (list)", () => {
  it("returns page items, totals and per-status tab counts", async () => {
    db.bundle.findMany.mockResolvedValue([
      {
        id: "bun1",
        name: "Weekend Reload – Betnella",
        status: "COMPLETED",
        plannedSendAt: null,
        createdAt: new Date("2026-07-01T10:00:00Z"),
        brandNames: ["Betnella"],
        variants: [{ displayName: "Betnella (Men)" }, { displayName: "Betnella (Women)" }],
      },
      {
        id: "bun2",
        name: "Draft one",
        status: "DRAFT",
        plannedSendAt: null,
        createdAt: new Date("2026-07-02T10:00:00Z"),
        brandNames: ["Corgi"],
        variants: [],
      },
    ]);
    db.bundle.count.mockResolvedValue(2);
    db.bundle.groupBy.mockResolvedValue([
      { status: "COMPLETED", _count: { _all: 1 } },
      { status: "DRAFT", _count: { _all: 1 } },
    ]);

    const res = await request(makeApp()).get("/api/bundles");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.counts).toEqual({ all: 2, draft: 1, generating: 0, completed: 1, failed: 0 });
    // Subtitle: expanded variants once generated, base names for drafts.
    expect(res.body.bundles[0].brandLabels).toEqual(["Betnella (Men)", "Betnella (Women)"]);
    expect(res.body.bundles[1].brandLabels).toEqual(["Corgi"]);
    expect(res.body.bundles[0].status).toBe("completed");
  });

  it("filters by status tab and search", async () => {
    db.bundle.findMany.mockResolvedValue([]);
    db.bundle.count.mockResolvedValue(0);
    db.bundle.groupBy.mockResolvedValue([]);

    const res = await request(makeApp()).get("/api/bundles?status=failed&search=betnella&page=2");
    expect(res.status).toBe(200);
    const args = db.bundle.findMany.mock.calls[0]![0];
    expect(args.where).toEqual({
      status: "FAILED",
      name: { contains: "betnella", mode: "insensitive" },
    });
    expect(args.skip).toBe(8); // page 2, pageSize 8 ("1–8 of 24")
  });
});

describe("POST /api/bundles (create draft)", () => {
  it("creates a DRAFT with the default active bundle type", async () => {
    db.bundleType.findFirst.mockResolvedValue({ id: "bt1", key: "simple_sendout" });
    db.bundle.create.mockResolvedValue({ id: "bun1", name: "Test", status: "DRAFT" });

    const res = await request(makeApp())
      .post("/api/bundles")
      .send({ name: "Test", brandNames: ["Betnella"] });
    expect(res.status).toBe(201);
    expect(res.body.bundle).toEqual({ id: "bun1", name: "Test", status: "draft" });
    expect(db.bundle.create.mock.calls[0]![0].data.createdById).toBe("user1");
  });

  it("rejects a missing name and an over-limit prompt", async () => {
    expect((await request(makeApp()).post("/api/bundles").send({})).status).toBe(400);
    const res = await request(makeApp())
      .post("/api/bundles")
      .send({ name: "x", neuralPrompt: "a".repeat(1501) }); // counter is 0 / 1500
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/bundles/:id", () => {
  it("locks brand changes after the first launch (409 brands_locked)", async () => {
    db.bundle.findUnique.mockResolvedValue({ id: "bun1", status: "COMPLETED" });
    const res = await request(makeApp())
      .patch("/api/bundles/bun1")
      .send({ brandNames: ["Corgi"] });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "brands_locked" });
  });

  it("edits name/date/prompt on a completed bundle (Result header Edit, D9)", async () => {
    db.bundle.findUnique.mockResolvedValue({ id: "bun1", status: "COMPLETED" });
    db.bundle.update.mockResolvedValue({
      id: "bun1",
      name: "Renamed",
      status: "COMPLETED",
      plannedSendAt: null,
      neuralPrompt: "p",
      brandNames: ["Betnella"],
    });
    const res = await request(makeApp()).patch("/api/bundles/bun1").send({ name: "Renamed" });
    expect(res.status).toBe(200);
    expect(res.body.bundle.name).toBe("Renamed");
  });
});

describe("POST /api/bundles/:id/assets/approve", () => {
  it("approves only DONE assets and reports skipped ones", async () => {
    db.bundleAsset.findMany.mockResolvedValue([
      { id: "a1", status: "DONE" },
      { id: "a2", status: "FAILED" },
      { id: "a3", status: "DONE" },
    ]);
    db.bundleAsset.updateMany.mockResolvedValue({ count: 2 });

    const res = await request(makeApp())
      .post("/api/bundles/bun1/assets/approve")
      .send({ assetIds: ["a1", "a2", "a3"] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, updated: 2, skipped: 1 });
    expect(db.bundleAsset.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["a1", "a3"] } },
      data: { approved: true },
    });
  });

  it("supports batch unapprove via approved:false", async () => {
    db.bundleAsset.findMany.mockResolvedValue([{ id: "a1", status: "DONE" }]);
    db.bundleAsset.updateMany.mockResolvedValue({ count: 1 });
    const res = await request(makeApp())
      .post("/api/bundles/bun1/assets/approve")
      .send({ assetIds: ["a1"], approved: false });
    expect(res.status).toBe(200);
    expect(db.bundleAsset.updateMany.mock.calls[0]![0].data).toEqual({ approved: false });
  });
});

describe("GET /api/bundles/meta", () => {
  it("returns bundle types, presets and grouped brands", async () => {
    db.bundleType.findMany.mockResolvedValue([
      { id: "bt1", key: "simple_sendout", title: "Simple sendout", description: null, assets: [] },
    ]);
    db.neuralPromptPreset.findMany.mockResolvedValue([{ id: "p1", title: "T", text: "x" }]);
    db.brand.findMany.mockResolvedValue([{ name: "Betnella(Men)" }, { name: "Betnella(Women)" }]);

    const res = await request(makeApp()).get("/api/bundles/meta");
    expect(res.status).toBe(200);
    expect(res.body.bundleTypes).toHaveLength(1);
    expect(res.body.presets).toHaveLength(1);
    expect(res.body.brands).toEqual([
      {
        key: "Betnella",
        displayName: "Betnella",
        variants: [
          { name: "Betnella(Men)", displayName: "Betnella (Men)" },
          { name: "Betnella(Women)", displayName: "Betnella (Women)" },
        ],
      },
    ]);
  });
});

describe("POST /api/bundles/:id/assets/:assetId/edit (D9)", () => {
  it("202s a text edit of a finished asset", async () => {
    db.bundleAsset.findFirst.mockResolvedValue({
      id: "a1",
      status: "DONE",
      imageUrl: "https://cdn/email.png",
      variantId: "v1",
    });
    db.bundleAsset.update.mockResolvedValue({});
    db.bundle.update.mockResolvedValue({});

    const res = await request(makeApp())
      .post("/api/bundles/bun1/assets/a1/edit")
      .send({ prompt: "warmer background" });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true });
  });

  it("409s an asset that cannot be edited and 400s an empty prompt", async () => {
    db.bundleAsset.findFirst.mockResolvedValue({
      id: "a1",
      status: "GENERATING",
      imageUrl: null,
      variantId: "v1",
    });
    const conflict = await request(makeApp())
      .post("/api/bundles/bun1/assets/a1/edit")
      .send({ prompt: "x" });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ error: "not_editable" });

    const empty = await request(makeApp()).post("/api/bundles/bun1/assets/a1/edit").send({ prompt: "  " });
    expect(empty.status).toBe(400);
  });
});

describe("POST /api/bundles/:id/send-smartico (Phase 6)", () => {
  it("returns the emitted snippets + stats", async () => {
    sendMock.mockResolvedValue({
      ok: true,
      sendId: "send1",
      outputs: [{ title: "Men — Email — Function", code: "(function(){})();", kind: "function" }],
      stats: { total: 1, uploaded: 1, reused: 0, failed: 0, failedItems: [], suspicious: [], skipped: [] },
    });
    const res = await request(makeApp()).post("/api/bundles/bun1/send-smartico");
    expect(res.status).toBe(200);
    expect(res.body.outputs).toHaveLength(1);
    expect(sendMock).toHaveBeenCalledWith("bun1");
  });

  it("maps service errors to 400/503/404", async () => {
    sendMock.mockResolvedValueOnce({ ok: false, error: "no_approved_assets" });
    expect((await request(makeApp()).post("/api/bundles/bun1/send-smartico")).status).toBe(400);
    sendMock.mockResolvedValueOnce({ ok: false, error: "cloudinary_not_configured" });
    expect((await request(makeApp()).post("/api/bundles/bun1/send-smartico")).status).toBe(503);
    sendMock.mockResolvedValueOnce(null);
    expect((await request(makeApp()).post("/api/bundles/bun1/send-smartico")).status).toBe(404);
  });
});

describe("misc", () => {
  it("404s details of an unknown bundle", async () => {
    db.bundle.findUnique.mockResolvedValue(null);
    expect((await request(makeApp()).get("/api/bundles/nope")).status).toBe(404);
  });
});
