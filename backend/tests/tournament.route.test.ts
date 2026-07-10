import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import request from "supertest";

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
  queryRaw: vi.fn(),
}));

vi.mock("../src/env.js", () => ({
  personPipelineReady: true,
  itemPipelineReady: true,
  editPipelineReady: true,
}));
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    tournamentCategory: { findMany: db.categoryFindMany },
    userTournamentPromptOverride: {
      findMany: db.overrideFindMany,
      upsert: db.overrideUpsert,
      deleteMany: db.overrideDeleteMany,
      updateMany: db.overrideUpdateMany,
    },
    tournamentPrompt: { findUnique: db.promptFindUnique },
    batch: { count: db.batchCount, findMany: db.batchFindMany },
    generation: { findMany: db.generationFindMany },
    zipExport: { create: db.zipExportCreate },
    $queryRaw: db.queryRaw,
  },
}));
vi.mock("../src/queues/index.js", () => ({
  getPersonQueue: () => ({ addBulk: vi.fn() }),
  getItemQueue: () => ({ addBulk: vi.fn() }),
}));

import {
  tournamentRouter,
  toPngUrl,
  packFolderOf,
  uniqueEntryPath,
} from "../src/routes/tournament.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  // Stand in for loadUser + requireAuth + requireZone.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: { sub: string } }).user = { sub: "user1" };
    next();
  });
  app.use("/api/tournament", tournamentRouter);
  return app;
}

beforeEach(() => {
  for (const fn of Object.values(db)) fn.mockReset();
});

// ---- ZIP helpers (pure) ----

describe("toPngUrl", () => {
  it("keeps .png URLs and injects f_png into non-png Cloudinary URLs", () => {
    expect(toPngUrl("https://res.cloudinary.com/d/image/upload/v1/a/b.png")).toBe(
      "https://res.cloudinary.com/d/image/upload/v1/a/b.png",
    );
    expect(toPngUrl("https://res.cloudinary.com/d/image/upload/v1/a/b.jpg")).toBe(
      "https://res.cloudinary.com/d/image/upload/f_png/v1/a/b.jpg",
    );
  });
});

describe("packFolderOf / uniqueEntryPath", () => {
  it("derives the pack folder by stripping the trailing image index", () => {
    expect(packFolderOf("Bonuskong_Tournament_1_2")).toBe("Bonuskong_Tournament_1");
    expect(packFolderOf("Bonuskong_Playson_&_Booongo_1")).toBe("Bonuskong_Playson_&_Booongo");
  });

  it("de-duplicates identical archive paths with -2/-3 suffixes", () => {
    const used = new Set<string>();
    expect(uniqueEntryPath(used, "t/a/x.png")).toBe("t/a/x.png");
    expect(uniqueEntryPath(used, "t/a/x.png")).toBe("t/a/x-2.png");
    expect(uniqueEntryPath(used, "t/a/x.png")).toBe("t/a/x-3.png");
  });
});

// ---- GET /config ----

describe("GET /api/tournament/config", () => {
  it("merges default prompts with the user's overrides and flags stale ones", async () => {
    db.categoryFindMany.mockResolvedValue([
      {
        id: "c1",
        key: "tournament",
        name: "Tournament (Bs)",
        hasModes: true,
        fixedMode: null,
        order: 0,
        elements: [
          {
            id: "e1",
            name: "Tournament_1",
            order: 0,
            referenceImages: [],
            prompts: [
              { mode: "BASE", content: "default base", updatedAt: new Date("2026-07-02") },
              { mode: "VIP", content: "default vip", updatedAt: new Date("2026-07-01") },
            ],
          },
        ],
      },
    ]);
    db.overrideFindMany.mockResolvedValue([
      // Admin edited the BASE default (07-02) AFTER this override's snapshot
      // (07-01) -> defaultChanged. The VIP override snapshot is current.
      { elementId: "e1", mode: "BASE", content: "mine base", baseUpdatedAt: new Date("2026-07-01") },
      { elementId: "e1", mode: "VIP", content: "mine vip", baseUpdatedAt: new Date("2026-07-01") },
    ]);

    const res = await request(makeApp()).get("/api/tournament/config");

    expect(res.status).toBe(200);
    const el = res.body.categories[0].elements[0];
    expect(el.prompts.BASE.content).toBe("default base");
    expect(el.overrides.BASE).toEqual({ content: "mine base", defaultChanged: true });
    expect(el.overrides.VIP).toEqual({ content: "mine vip", defaultChanged: false });
  });
});

// ---- Overrides CRUD ----

describe("PUT /api/tournament/overrides", () => {
  it("upserts the override snapshotting the CURRENT default updatedAt", async () => {
    const defUpdated = new Date("2026-07-05T10:00:00Z");
    db.promptFindUnique.mockResolvedValue({
      updatedAt: defUpdated,
      content: "default",
      element: { isActive: true },
    });
    db.overrideUpsert.mockResolvedValue({ elementId: "e1", mode: "BASE", content: "mine" });

    const res = await request(makeApp())
      .put("/api/tournament/overrides")
      .send({ elementId: "e1", mode: "BASE", content: "mine" });

    expect(res.status).toBe(200);
    const call = db.overrideUpsert.mock.calls[0]![0];
    expect(call.create.baseUpdatedAt).toEqual(defUpdated);
    expect(call.update.baseUpdatedAt).toEqual(defUpdated);
    // Scoped to the requesting user — override isolation.
    expect(call.where.userId_elementId_mode.userId).toBe("user1");
  });

  it("404s when there is no default prompt for that element+mode", async () => {
    db.promptFindUnique.mockResolvedValue(null);
    const res = await request(makeApp())
      .put("/api/tournament/overrides")
      .send({ elementId: "e1", mode: "VIP", content: "mine" });
    expect(res.status).toBe(404);
  });

  it("rejects an empty content (reset goes through DELETE, not a blank PUT)", async () => {
    const res = await request(makeApp())
      .put("/api/tournament/overrides")
      .send({ elementId: "e1", mode: "BASE", content: "   " });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/tournament/overrides", () => {
  it("deletes only the requesting user's override", async () => {
    db.overrideDeleteMany.mockResolvedValue({ count: 1 });
    const res = await request(makeApp()).delete(
      "/api/tournament/overrides?elementId=e1&mode=BASE",
    );
    expect(res.status).toBe(200);
    expect(db.overrideDeleteMany.mock.calls[0]![0].where.userId).toBe("user1");
  });
});

describe("POST /api/tournament/overrides/ack", () => {
  it("re-snapshots baseUpdatedAt to the current default (keep mine)", async () => {
    const defUpdated = new Date("2026-07-06T00:00:00Z");
    db.promptFindUnique.mockResolvedValue({
      updatedAt: defUpdated,
      content: "default",
      element: { isActive: true },
    });
    db.overrideUpdateMany.mockResolvedValue({ count: 1 });

    const res = await request(makeApp())
      .post("/api/tournament/overrides/ack")
      .send({ elementId: "e1", mode: "BASE" });

    expect(res.status).toBe(200);
    expect(db.overrideUpdateMany.mock.calls[0]![0].data.baseUpdatedAt).toEqual(defUpdated);
  });
});

// ---- POST /generate validation (QA risk #1: API-level brand cap) ----

describe("POST /api/tournament/generate", () => {
  it("rejects more than 4 brands at the API boundary", async () => {
    const res = await request(makeApp())
      .post("/api/tournament/generate")
      .send({
        brandIds: ["1", "2", "3", "4", "5"],
        count: 1,
        selections: [{ elementId: "e1", mode: "BASE" }],
      });
    expect(res.status).toBe(400);
  });

  it("rejects a count above 4 and an empty selection", async () => {
    const tooMany = await request(makeApp())
      .post("/api/tournament/generate")
      .send({ brandIds: ["1"], count: 5, selections: [{ elementId: "e1" }] });
    expect(tooMany.status).toBe(400);

    const empty = await request(makeApp())
      .post("/api/tournament/generate")
      .send({ brandIds: ["1"], count: 1, selections: [] });
    expect(empty.status).toBe(400);
  });
});

// ---- Export ----

import yauzl from "yauzl";

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

function tourRow(over: Record<string, unknown> = {}) {
  return {
    id: "g1",
    generatedImageUrl: "https://res.cloudinary.com/d/image/upload/v1/x/a.png",
    brandName: "Bonuskong",
    tourCategoryKey: "tournament",
    tourElementName: "Tournament_1",
    tourFileName: "Bonuskong_Tournament_1_1",
    ...over,
  };
}

// A minimal valid PNG-ish payload — the export just streams the fetched bytes.
const FAKE_IMG = Buffer.from("fake-png-bytes");

describe("GET /api/tournament/export.zip — real archive structure (QA)", () => {
  it("streams DES-<n>.zip: flat {Brand}/{Element}_N[_gender].png, Men/Women share a folder", async () => {
    db.generationFindMany.mockResolvedValue([
      tourRow(),
      tourRow({ id: "g2", tourFileName: "Bonuskong_Tournament_1_2" }),
      tourRow({
        id: "g3",
        brandName: "Spinogambino(Men)",
        tourCategoryKey: "lotterie",
        tourElementName: "Lottery_2",
        tourFileName: "SpinogambinoMen_Lottery_2_1",
      }),
      tourRow({
        id: "g5",
        brandName: "Spinogambino (Women)",
        tourElementName: "Lottery_2",
        tourCategoryKey: "lotterie",
        tourFileName: "SpinogambinoWomen_Lottery_2_1",
      }),
      tourRow({
        id: "g4",
        tourCategoryKey: "provider",
        tourElementName: "Playson & Booongo",
        tourFileName: "Bonuskong_Playson_&_Booongo_1",
      }),
    ]);
    db.queryRaw.mockResolvedValue([{ value: 100001 }]);
    db.zipExportCreate.mockResolvedValue({});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => FAKE_IMG })),
    );

    const res = await request(makeApp())
      .get("/api/tournament/export.zip?batchId=b1")
      .buffer(true)
      .parse(binaryParser);

    expect(res.status).toBe(200);
    // File name = the freshly issued DES number (spec: DES-1XXXXX.zip).
    expect(res.headers["content-disposition"]).toBe('attachment; filename="DES-100001.zip"');

    const entries = await zipEntries(res.body as Buffer);
    expect(entries.sort()).toEqual(
      [
        "Bonuskong/Tournament_1_1.png",
        "Bonuskong/Tournament_1_2.png",
        // (Men)/(Women) merge into ONE folder; gender -> file-name suffix.
        "Spinogambino/Lottery_2_1_men.png",
        "Spinogambino/Lottery_2_1_women.png",
        "Bonuskong/Playson_&_Booongo_1.png", // provider element, same brand folder
      ].sort(),
    );

    // The download is journaled with its contents.
    expect(db.zipExportCreate.mock.calls[0]![0].data).toMatchObject({
      desNumber: 100001,
      userId: "user1",
      batchId: "b1",
      imageIds: ["g1", "g2", "g3", "g5", "g4"],
    });
    vi.unstubAllGlobals();
  });

  it("issues a NEW DES number on every repeat download of the same batch", async () => {
    db.generationFindMany.mockResolvedValue([tourRow()]);
    db.zipExportCreate.mockResolvedValue({});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => FAKE_IMG })),
    );

    db.queryRaw.mockResolvedValueOnce([{ value: 100001 }]);
    const first = await request(makeApp())
      .get("/api/tournament/export.zip?batchId=b1")
      .buffer(true)
      .parse(binaryParser);
    db.queryRaw.mockResolvedValueOnce([{ value: 100002 }]);
    const second = await request(makeApp())
      .get("/api/tournament/export.zip?batchId=b1")
      .buffer(true)
      .parse(binaryParser);

    expect(first.headers["content-disposition"]).toContain("DES-100001.zip");
    expect(second.headers["content-disposition"]).toContain("DES-100002.zip");
    vi.unstubAllGlobals();
  });
});

describe("GET /api/tournament/export.zip", () => {
  it("requires a target (batchId or ids)", async () => {
    const res = await request(makeApp()).get("/api/tournament/export.zip");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("no_target");
  });

  it("404s (and does NOT burn a DES number) when nothing matches", async () => {
    db.generationFindMany.mockResolvedValue([]);
    const res = await request(makeApp()).get("/api/tournament/export.zip?batchId=b1");
    expect(res.status).toBe(404);
    expect(db.queryRaw).not.toHaveBeenCalled();
    expect(db.zipExportCreate).not.toHaveBeenCalled();
  });
});
