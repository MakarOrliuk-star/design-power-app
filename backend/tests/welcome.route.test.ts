import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import request from "supertest";
import yauzl from "yauzl";

// ---- Mocks (hoisted so the route's module graph picks them up) ----
const db = vi.hoisted(() => ({
  categoryFindMany: vi.fn(),
  overrideFindMany: vi.fn(),
  overrideUpsert: vi.fn(),
  overrideDeleteMany: vi.fn(),
  overrideUpdateMany: vi.fn(),
  promptFindUnique: vi.fn(),
  batchCount: vi.fn(),
  batchFindMany: vi.fn(),
  generationFindMany: vi.fn(),
  zipExportCreate: vi.fn(),
  desCounterCreateMany: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock("../src/env.js", () => ({
  personPipelineReady: true,
  itemPipelineReady: true,
  editPipelineReady: true,
}));
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    welcomeCategory: { findMany: db.categoryFindMany },
    userWelcomePromptOverride: {
      findMany: db.overrideFindMany,
      upsert: db.overrideUpsert,
      deleteMany: db.overrideDeleteMany,
      updateMany: db.overrideUpdateMany,
    },
    welcomePrompt: { findUnique: db.promptFindUnique },
    batch: { count: db.batchCount, findMany: db.batchFindMany },
    generation: { findMany: db.generationFindMany },
    zipExport: { create: db.zipExportCreate },
    desCounter: { createMany: db.desCounterCreateMany },
    $queryRaw: db.queryRaw,
  },
}));
vi.mock("../src/queues/index.js", () => ({
  getPersonQueue: () => ({ addBulk: vi.fn() }),
  getItemQueue: () => ({ addBulk: vi.fn() }),
}));

import { welcomeRouter } from "../src/routes/welcome.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  // Stand in for loadUser + requireAuth + requireZone.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: { sub: string } }).user = { sub: "user1" };
    next();
  });
  app.use("/api/welcome", welcomeRouter);
  return app;
}

beforeEach(() => {
  for (const fn of Object.values(db)) fn.mockReset();
});

// ---- GET /config ----

describe("GET /api/welcome/config", () => {
  it("merges the default prompt with the user's override and flags a stale one", async () => {
    db.categoryFindMany.mockResolvedValue([
      {
        id: "c1",
        key: "welcome_series",
        name: "Welcome Series",
        usesOwnReferences: false,
        order: 0,
        elements: [
          {
            id: "e1",
            name: "Welcome_1",
            order: 0,
            referenceImages: [],
            prompt: { content: "default", updatedAt: new Date("2026-08-02") },
          },
          {
            id: "e2",
            name: "Welcome_2",
            order: 1,
            referenceImages: [],
            prompt: { content: "default 2", updatedAt: new Date("2026-08-01") },
          },
        ],
      },
    ]);
    db.overrideFindMany.mockResolvedValue([
      // The default (08-02) moved AFTER this override's snapshot (08-01) -> stale.
      { elementId: "e1", content: "mine", baseUpdatedAt: new Date("2026-08-01") },
      { elementId: "e2", content: "mine 2", baseUpdatedAt: new Date("2026-08-01") },
    ]);

    const res = await request(makeApp()).get("/api/welcome/config");

    expect(res.status).toBe(200);
    expect(res.body.categories[0].usesOwnReferences).toBe(false);
    const [e1, e2] = res.body.categories[0].elements;
    expect(e1.prompt.content).toBe("default");
    expect(e1.override).toEqual({ content: "mine", defaultChanged: true });
    expect(e2.override).toEqual({ content: "mine 2", defaultChanged: false });
    // No Base/VIP anywhere in the Welcome DTO.
    expect(e1.prompts).toBeUndefined();
    expect(e1.nameVip).toBeUndefined();
  });

  it("reports an element whose prompt was never written as prompt: null", async () => {
    db.categoryFindMany.mockResolvedValue([
      {
        id: "c1",
        key: "welcome_series",
        name: "Welcome Series",
        usesOwnReferences: true,
        order: 0,
        elements: [{ id: "e1", name: "Welcome_1", order: 0, referenceImages: [], prompt: null }],
      },
    ]);
    db.overrideFindMany.mockResolvedValue([]);

    const res = await request(makeApp()).get("/api/welcome/config");
    expect(res.status).toBe(200);
    expect(res.body.categories[0].elements[0].prompt).toBeNull();
    expect(res.body.categories[0].elements[0].override).toBeNull();
  });

  it("returns an empty list on a fresh install (nothing is seeded by design)", async () => {
    db.categoryFindMany.mockResolvedValue([]);
    db.overrideFindMany.mockResolvedValue([]);
    const res = await request(makeApp()).get("/api/welcome/config");
    expect(res.status).toBe(200);
    expect(res.body.categories).toEqual([]);
  });
});

// ---- Overrides CRUD ----

describe("PUT /api/welcome/overrides", () => {
  it("upserts the override snapshotting the CURRENT default updatedAt", async () => {
    const defUpdated = new Date("2026-08-05T10:00:00Z");
    db.promptFindUnique.mockResolvedValue({
      updatedAt: defUpdated,
      content: "default",
      element: { isActive: true },
    });
    db.overrideUpsert.mockResolvedValue({ elementId: "e1", content: "mine" });

    const res = await request(makeApp())
      .put("/api/welcome/overrides")
      .send({ elementId: "e1", content: "mine" });

    expect(res.status).toBe(200);
    const call = db.overrideUpsert.mock.calls[0]![0];
    expect(call.create.baseUpdatedAt).toEqual(defUpdated);
    expect(call.update.baseUpdatedAt).toEqual(defUpdated);
    // Scoped to the requesting user — override isolation.
    expect(call.where.userId_elementId.userId).toBe("user1");
  });

  it("404s when the element has no default prompt, or was soft-deleted", async () => {
    db.promptFindUnique.mockResolvedValue(null);
    const missing = await request(makeApp())
      .put("/api/welcome/overrides")
      .send({ elementId: "e1", content: "mine" });
    expect(missing.status).toBe(404);

    db.promptFindUnique.mockResolvedValue({
      updatedAt: new Date(),
      content: "default",
      element: { isActive: false },
    });
    const inactive = await request(makeApp())
      .put("/api/welcome/overrides")
      .send({ elementId: "e1", content: "mine" });
    expect(inactive.status).toBe(404);
  });

  it("rejects an empty content (reset goes through DELETE, not a blank PUT)", async () => {
    const res = await request(makeApp())
      .put("/api/welcome/overrides")
      .send({ elementId: "e1", content: "   " });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/welcome/overrides", () => {
  it("deletes only the requesting user's override", async () => {
    db.overrideDeleteMany.mockResolvedValue({ count: 1 });
    const res = await request(makeApp()).delete("/api/welcome/overrides?elementId=e1");
    expect(res.status).toBe(200);
    expect(db.overrideDeleteMany.mock.calls[0]![0].where).toEqual({
      userId: "user1",
      elementId: "e1",
    });
  });
});

describe("POST /api/welcome/overrides/ack", () => {
  it("re-snapshots baseUpdatedAt to the current default (keep mine)", async () => {
    const defUpdated = new Date("2026-08-06T00:00:00Z");
    db.promptFindUnique.mockResolvedValue({
      updatedAt: defUpdated,
      content: "default",
      element: { isActive: true },
    });
    db.overrideUpdateMany.mockResolvedValue({ count: 1 });

    const res = await request(makeApp())
      .post("/api/welcome/overrides/ack")
      .send({ elementId: "e1" });

    expect(res.status).toBe(200);
    expect(db.overrideUpdateMany.mock.calls[0]![0].data.baseUpdatedAt).toEqual(defUpdated);
  });

  it("404s when the user has no override to acknowledge", async () => {
    db.promptFindUnique.mockResolvedValue({
      updatedAt: new Date(),
      content: "default",
      element: { isActive: true },
    });
    db.overrideUpdateMany.mockResolvedValue({ count: 0 });
    const res = await request(makeApp())
      .post("/api/welcome/overrides/ack")
      .send({ elementId: "e1" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("override_not_found");
  });
});

// ---- POST /generate validation (API-level caps) ----

describe("POST /api/welcome/generate", () => {
  it("rejects more than 4 brands at the API boundary", async () => {
    const res = await request(makeApp())
      .post("/api/welcome/generate")
      .send({ brandIds: ["1", "2", "3", "4", "5"], count: 1, selections: [{ elementId: "e1" }] });
    expect(res.status).toBe(400);
  });

  it("rejects an aspect outside 1:1 / 9:16", async () => {
    const res = await request(makeApp())
      .post("/api/welcome/generate")
      .send({ brandIds: ["1"], count: 1, aspect: "16:9", selections: [{ elementId: "e1" }] });
    expect(res.status).toBe(400);
  });

  it("rejects a count above 4 and an empty selection", async () => {
    const tooMany = await request(makeApp())
      .post("/api/welcome/generate")
      .send({ brandIds: ["1"], count: 5, selections: [{ elementId: "e1" }] });
    expect(tooMany.status).toBe(400);

    const empty = await request(makeApp())
      .post("/api/welcome/generate")
      .send({ brandIds: ["1"], count: 1, selections: [] });
    expect(empty.status).toBe(400);
  });
});

// ---- Packs (Result tab) ----

describe("GET /api/welcome/packs", () => {
  it("lists only this user's WELCOME batches, newest first", async () => {
    db.batchCount.mockResolvedValue(1);
    db.batchFindMany.mockResolvedValue([{ id: "b1", status: "COMPLETED", generations: [] }]);

    const res = await request(makeApp()).get("/api/welcome/packs?limit=10&offset=0");

    expect(res.status).toBe(200);
    expect(res.body.hasMore).toBe(false);
    const args = db.batchFindMany.mock.calls[0]![0];
    expect(args.where).toEqual({ userId: "user1", actionType: "WELCOME" });
    expect(args.orderBy).toEqual({ createdAt: "desc" });
  });
});

// ---- Export ----

/** supertest binary parser — collect the raw ZIP bytes. */
function binaryParser(res: NodeJS.ReadableStream, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
}

/** Open a ZIP buffer and list its entry paths (real unzip, not string checks). */
function zipEntries(buf: Buffer): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const names: string[] = [];
      zip.on("entry", (e: { fileName: string }) => {
        names.push(e.fileName);
        zip.readEntry();
      });
      zip.on("end", () => resolve(names));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

function welRow(over: Record<string, unknown> = {}) {
  return {
    id: "g1",
    generatedImageUrl: "https://res.cloudinary.com/d/image/upload/v1/x/a.png",
    brandName: "Bonuskong",
    welElementName: "Welcome_1",
    welFileName: "Bonuskong_Welcome_1_1",
    ...over,
  };
}

// A minimal payload — the export just streams the fetched bytes.
const FAKE_IMG = Buffer.from("fake-png-bytes");

describe("GET /api/welcome/export.zip — real archive structure", () => {
  it("streams DES-<n>.zip: flat {Brand}/{Element}_N[_gender].png, Men/Women share a folder", async () => {
    db.generationFindMany.mockResolvedValue([
      welRow(),
      welRow({ id: "g2", welFileName: "Bonuskong_Welcome_1_2" }),
      welRow({
        id: "g3",
        brandName: "Spinogambino(Men)",
        welElementName: "Welcome_2",
        welFileName: "SpinogambinoMen_Welcome_2_1",
      }),
      welRow({
        id: "g4",
        brandName: "Spinogambino (Women)",
        welElementName: "Welcome_2",
        welFileName: "SpinogambinoWomen_Welcome_2_1",
      }),
      welRow({
        id: "g5",
        welElementName: "Deposit & Bonus",
        welFileName: "Bonuskong_Deposit_&_Bonus_1",
      }),
    ]);
    db.queryRaw.mockResolvedValue([{ value: 100010 }]);
    db.zipExportCreate.mockResolvedValue({});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => FAKE_IMG })),
    );

    const res = await request(makeApp())
      .get("/api/welcome/export.zip?batchId=b1")
      .buffer(true)
      .parse(binaryParser);

    expect(res.status).toBe(200);
    // The DES sequence is shared with the tournament export (заказчик: one numbering).
    expect(res.headers["content-disposition"]).toBe('attachment; filename="DES-100010.zip"');

    const entries = await zipEntries(res.body as Buffer);
    expect(entries.sort()).toEqual(
      [
        "Bonuskong/Welcome_1_1.png",
        "Bonuskong/Welcome_1_2.png",
        // (Men)/(Women) merge into ONE folder; gender -> file-name suffix.
        "Spinogambino/Welcome_2_1_men.png",
        "Spinogambino/Welcome_2_1_women.png",
        "Bonuskong/Deposit_&_Bonus_1.png",
      ].sort(),
    );

    // Only WELCOME rows are eligible for this archive.
    expect(db.generationFindMany.mock.calls[0]![0].where.actionType).toBe("WELCOME");
    // The download is journaled with its contents.
    expect(db.zipExportCreate.mock.calls[0]![0].data).toMatchObject({
      desNumber: 100010,
      userId: "user1",
      batchId: "b1",
      imageIds: ["g1", "g2", "g3", "g4", "g5"],
    });
    vi.unstubAllGlobals();
  });

  it("issues a NEW DES number on every repeat download of the same batch", async () => {
    db.generationFindMany.mockResolvedValue([welRow()]);
    db.zipExportCreate.mockResolvedValue({});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => FAKE_IMG })),
    );

    db.queryRaw.mockResolvedValueOnce([{ value: 100011 }]);
    const first = await request(makeApp())
      .get("/api/welcome/export.zip?batchId=b1")
      .buffer(true)
      .parse(binaryParser);
    db.queryRaw.mockResolvedValueOnce([{ value: 100012 }]);
    const second = await request(makeApp())
      .get("/api/welcome/export.zip?batchId=b1")
      .buffer(true)
      .parse(binaryParser);

    expect(first.headers["content-disposition"]).toContain("DES-100011.zip");
    expect(second.headers["content-disposition"]).toContain("DES-100012.zip");
    vi.unstubAllGlobals();
  });

  it("requires a target (batchId or ids)", async () => {
    const res = await request(makeApp()).get("/api/welcome/export.zip");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("no_target");
  });

  it("404s (and does NOT burn a DES number) when nothing matches", async () => {
    db.generationFindMany.mockResolvedValue([]);
    const res = await request(makeApp()).get("/api/welcome/export.zip?batchId=b1");
    expect(res.status).toBe(404);
    expect(db.queryRaw).not.toHaveBeenCalled();
    expect(db.zipExportCreate).not.toHaveBeenCalled();
  });
});
