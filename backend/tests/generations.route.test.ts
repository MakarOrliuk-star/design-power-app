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

import { generateRouter } from "../src/routes/generate.js";

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

  it("rejects an unknown tab with 400", async () => {
    const res = await request(makeApp()).get("/api/generations?tab=bogus");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query");
  });
});
