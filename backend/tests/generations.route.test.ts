import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import request from "supertest";

// ---- Mocks (hoisted so the route's module graph picks them up) ----
// env.ts validates process.env and calls process.exit() at import, so it MUST be
// mocked; the others avoid real DB / Redis / Cloudinary side effects.
const db = vi.hoisted(() => ({
  count: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("../src/env.js", () => ({
  personPipelineReady: true,
  itemPipelineReady: true,
  editPipelineReady: true,
}));
vi.mock("../src/lib/prisma.js", () => ({
  prisma: { generation: { count: db.count, findMany: db.findMany } },
}));
vi.mock("../src/lib/cloudinary.js", () => ({ uploadBase64: vi.fn(), withRetry: vi.fn() }));
vi.mock("../src/services/finalize.js", () => ({ recomputeBatchStatus: vi.fn() }));
vi.mock("../src/queues/index.js", () => ({
  getPersonQueue: () => ({ addBulk: vi.fn() }),
  getItemQueue: () => ({ addBulk: vi.fn() }),
}));

import { generateRouter, periodSince, zipEntryName } from "../src/routes/generate.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  // Stand in for loadUser + requireAuth.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: { sub: string } }).user = { sub: "user1" };
    next();
  });
  app.use("/api", generateRouter);
  return app;
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: "g1",
    brandName: "Nike",
    theme: null,
    description: "a model",
    generatedImageUrl: "https://cdn/1.png",
    actionType: "FULL",
    isEdit: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

beforeEach(() => {
  db.count.mockReset();
  db.findMany.mockReset();
});

/**
 * BE Test 1 — GET /api/generations response contract (TASK §3).
 * Verifies the gallery payload shape, the actionType→contentType derivation that
 * feeds the Result tabs, and the hasMore pagination flag.
 */
describe("GET /api/generations — response shape", () => {
  it("returns {images,total,hasMore} with contentType derived from actionType", async () => {
    db.count.mockResolvedValue(3);
    db.findMany.mockResolvedValue([
      row({ id: "g1", actionType: "CREATE_ITEM" }),
      row({ id: "g2", actionType: "FULL" }),
    ]);

    const res = await request(makeApp()).get("/api/generations");

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    // offset(0) + rows(2) < total(3) → there is another page.
    expect(res.body.hasMore).toBe(true);
    expect(res.body.images[0].contentType).toBe("Item"); // CREATE_ITEM → Item
    expect(res.body.images[1].contentType).toBe("Person"); // FULL → Person
  });

  it("reports hasMore=false once the last page is reached", async () => {
    db.count.mockResolvedValue(2);
    db.findMany.mockResolvedValue([row({ id: "g1" }), row({ id: "g2" })]);

    const res = await request(makeApp()).get("/api/generations?offset=0&limit=50");
    expect(res.body.hasMore).toBe(false); // 0 + 2 < 2 is false
  });
});

/**
 * BE Test 2 — tab filtering (TASK §3 / Phase 2).
 * Asserts the Prisma where-clause the route builds per tab: Background matches
 * nothing (no pipeline yet), Edited shows only edited rows, Person maps to the
 * Person action types and excludes edits.
 */
describe("GET /api/generations — tab filters", () => {
  beforeEach(() => {
    db.count.mockResolvedValue(0);
    db.findMany.mockResolvedValue([]);
  });

  function lastWhere() {
    return db.findMany.mock.calls.at(-1)![0].where;
  }

  it("background → impossible filter (returns nothing)", async () => {
    await request(makeApp()).get("/api/generations?tab=background");
    expect(lastWhere().actionType).toEqual({ in: [] });
  });

  it("edited → only isEdit rows", async () => {
    await request(makeApp()).get("/api/generations?tab=edited");
    expect(lastWhere().isEdit).toBe(true);
  });

  it("person → Person action types, excluding edits, scoped to the user", async () => {
    await request(makeApp()).get("/api/generations?tab=person");
    const where = lastWhere();
    expect(where.isEdit).toBe(false);
    expect(where.actionType).toEqual({ in: ["FULL", "NANO_REF"] });
    expect(where.userId).toBe("user1");
    expect(where.status).toBe("DONE");
  });

  it("tournament → only TOURNAMENT rows (Archive's Tournament Pack tab)", async () => {
    await request(makeApp()).get("/api/generations?tab=tournament");
    const where = lastWhere();
    expect(where.actionType).toBe("TOURNAMENT");
    expect(where.userId).toBe("user1");
    expect(where.status).toBe("DONE");
    // The standard Archive filters still apply on this tab.
    expect(where.createdAt?.gte).toBeInstanceOf(Date);
  });

  it("generated (default) still EXCLUDES tournament rows", async () => {
    await request(makeApp()).get("/api/generations");
    expect(lastWhere().actionType).toEqual({ not: "TOURNAMENT" });
  });

  it("tournament rows map to contentType 'Tournament' and expose tourFileName", async () => {
    db.count.mockResolvedValue(1);
    db.findMany.mockResolvedValue([
      row({ id: "g9", actionType: "TOURNAMENT", tourFileName: "Bonuskong_Tournament_1_2" }),
    ]);
    const res = await request(makeApp()).get("/api/generations?tab=tournament");
    expect(res.body.images[0].contentType).toBe("Tournament");
    expect(res.body.images[0].tourFileName).toBe("Bonuskong_Tournament_1_2");
  });

  it("rejects an unknown tab with 400", async () => {
    const res = await request(makeApp()).get("/api/generations?tab=bogus");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query");
  });

  it("every tab EXCLUDES unsaved brand-test runs (isTest=false, TASK super-designer)", async () => {
    for (const tab of ["", "?tab=person", "?tab=edited", "?tab=tournament"]) {
      await request(makeApp()).get(`/api/generations${tab}`);
      expect(lastWhere().isTest).toBe(false);
    }
  });
});

/**
 * BE Test 3 — Archive filters (TASK §2): period window + partial brand search.
 */
describe("GET /api/generations — Archive filters", () => {
  beforeEach(() => {
    db.count.mockResolvedValue(0);
    db.findMany.mockResolvedValue([]);
  });
  function lastWhere() {
    return db.findMany.mock.calls.at(-1)![0].where;
  }

  it("defaults to a 3-month window (createdAt lower bound is set)", async () => {
    await request(makeApp()).get("/api/generations");
    expect(lastWhere().createdAt?.gte).toBeInstanceOf(Date);
  });

  it("search → case-insensitive partial brand match", async () => {
    await request(makeApp()).get("/api/generations?search=slot");
    expect(lastWhere().brandName).toEqual({ contains: "slot", mode: "insensitive" });
  });

  it("rejects an unknown period with 400", async () => {
    const res = await request(makeApp()).get("/api/generations?period=year");
    expect(res.status).toBe(400);
  });
});

/**
 * BE Test 4 — periodSince lower-bound math (pure).
 */
describe("periodSince", () => {
  const now = new Date("2026-06-04T15:30:00Z");
  it("today → start of the current day", () => {
    const d = periodSince("today", now);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getDate()).toBe(now.getDate());
  });
  it("week → 7 days earlier", () => {
    expect(periodSince("week", now).getTime()).toBe(now.getTime() - 7 * 24 * 3600 * 1000);
  });
  it("3months → 3 calendar months earlier", () => {
    expect(periodSince("3months", now).getMonth()).toBe(2); // June(5) - 3 = March(2)
  });
});

/**
 * BE Test 5 — ZIP export (TASK §2): explicit selection wins over filters, and an
 * empty result is a clean 404. Entry naming is collision-free + extension-aware.
 */
describe("GET /api/generations/export.zip", () => {
  beforeEach(() => {
    db.findMany.mockReset();
    db.findMany.mockResolvedValue([]); // no rows → 404 (skips fetch/archiver)
  });
  function lastWhere() {
    return db.findMany.mock.calls.at(-1)![0].where;
  }

  it("ids → scopes to id:{in} (selection wins over filters)", async () => {
    const res = await request(makeApp()).get("/api/generations/export.zip?ids=g1,g2&tab=person");
    expect(res.status).toBe(404); // empty mock
    expect(lastWhere().id).toEqual({ in: ["g1", "g2"] });
    expect(lastWhere().status).toBe("DONE");
  });

  it("no ids → falls back to the filtered gallery where-clause", async () => {
    await request(makeApp()).get("/api/generations/export.zip?search=slot");
    expect(lastWhere().brandName).toEqual({ contains: "slot", mode: "insensitive" });
    expect(lastWhere().createdAt?.gte).toBeInstanceOf(Date);
  });

  it("zipEntryName → zero-padded index, sanitized brand, url extension", () => {
    expect(zipEntryName(0, "Teddy Slot!", "https://cdn/x/a.jpg?v=2")).toBe("0001_Teddy_Slot_.jpg");
    expect(zipEntryName(11, "Nike", "https://cdn/y.png")).toBe("0012_Nike.png");
    expect(zipEntryName(0, "", "https://cdn/noext")).toBe("0001_image.png");
  });

  it("prefix=result → result-*.zip filename (Result page export)", async () => {
    db.findMany.mockResolvedValue([row()]);
    // Skip the image download inside the zip loop — headers are what we assert.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    try {
      const res = await request(makeApp()).get("/api/generations/export.zip?ids=g1&prefix=result");
      expect(res.status).toBe(200);
      expect(res.headers["content-disposition"]).toMatch(/filename="result-\d{4}-\d{2}-\d{2}\.zip"/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("no prefix → keeps the legacy archive-*.zip filename", async () => {
    db.findMany.mockResolvedValue([row()]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    try {
      const res = await request(makeApp()).get("/api/generations/export.zip?ids=g1");
      expect(res.headers["content-disposition"]).toMatch(/filename="archive-\d{4}-\d{2}-\d{2}\.zip"/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("garbage prefix → 400 invalid_query", async () => {
    const res = await request(makeApp()).get(
      "/api/generations/export.zip?ids=g1&prefix=%22evil%22",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query");
  });
});
