import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import request from "supertest";

// ---- Mocks (hoisted so the route's module graph picks them up) ----
const db = vi.hoisted(() => ({
  categoryFindUnique: vi.fn(),
  categoryFindMany: vi.fn(),
  categoryFindFirst: vi.fn(),
  categoryCreate: vi.fn(),
  categoryUpdate: vi.fn(),
  categoryDelete: vi.fn(),
  elementFindUnique: vi.fn(),
  elementFindMany: vi.fn(),
  elementFindFirst: vi.fn(),
  elementCreate: vi.fn(),
  elementUpdate: vi.fn(),
  promptUpsert: vi.fn(),
  promptTemplateFindUnique: vi.fn(),
  promptTemplateUpsert: vi.fn(),
  logCreate: vi.fn(),
  logFindFirst: vi.fn(),
  transaction: vi.fn(),
  userFindUnique: vi.fn(),
}));

vi.mock("../src/env.js", () => ({
  cloudinaryConfigured: false,
  personPipelineReady: true,
  itemPipelineReady: true,
  editPipelineReady: true,
}));
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    welcomeCategory: {
      findUnique: db.categoryFindUnique,
      findMany: db.categoryFindMany,
      findFirst: db.categoryFindFirst,
      create: db.categoryCreate,
      update: db.categoryUpdate,
      delete: db.categoryDelete,
    },
    welcomeElement: {
      findUnique: db.elementFindUnique,
      findMany: db.elementFindMany,
      findFirst: db.elementFindFirst,
      create: db.elementCreate,
      update: db.elementUpdate,
    },
    welcomePrompt: { upsert: db.promptUpsert },
    welcomeChangeLog: { create: db.logCreate, findFirst: db.logFindFirst },
    promptTemplate: { findUnique: db.promptTemplateFindUnique, upsert: db.promptTemplateUpsert },
    user: { findUnique: db.userFindUnique },
    $transaction: db.transaction,
  },
}));
vi.mock("../src/lib/cloudinary.js", () => ({ uploadBase64: vi.fn(), withRetry: vi.fn() }));

import { welcomePackRouter } from "../src/routes/welcomePack.js";
import { requireSuperDesigner } from "../src/middleware/auth.js";

function makeApp(withGuard = false) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: { sub: string; email: string; role: string } }).user = {
      sub: "user1",
      email: "sd@example.com",
      role: "DESIGNER", // guard reads the DB, not this
    };
    next();
  });
  if (withGuard) app.use(requireSuperDesigner);
  app.use("/api/welcome-pack", welcomePackRouter);
  return app;
}

interface SnapRow {
  name: string;
  order: number;
  isActive: boolean;
  referenceImages: string[];
  prompt: { content: string } | null;
}

function snap(over: Partial<SnapRow> = {}): SnapRow {
  return {
    name: "Welcome_1",
    order: 0,
    isActive: true,
    referenceImages: [],
    prompt: { content: "default prompt" },
    ...over,
  };
}

beforeEach(() => {
  for (const fn of Object.values(db)) fn.mockReset();
  db.transaction.mockResolvedValue([]);
  db.logCreate.mockResolvedValue({});
});

// ---- Role guard (the whole point of a separate surface) ----

describe("requireSuperDesigner on /api/welcome-pack", () => {
  it("403s a plain DESIGNER and lets SUPER_DESIGNER / ADMIN / MANAGER through", async () => {
    db.categoryFindMany.mockResolvedValue([]);
    db.promptTemplateFindUnique.mockResolvedValue({ content: "SYS" });

    db.userFindUnique.mockResolvedValue({ role: "DESIGNER", isActive: true });
    expect((await request(makeApp(true)).get("/api/welcome-pack/config")).status).toBe(403);

    for (const role of ["SUPER_DESIGNER", "ADMIN", "MANAGER"]) {
      db.userFindUnique.mockResolvedValue({ role, isActive: true });
      expect((await request(makeApp(true)).get("/api/welcome-pack/config")).status).toBe(200);
    }
  });

  it("401s a deactivated user even if their role would pass", async () => {
    db.userFindUnique.mockResolvedValue({ role: "SUPER_DESIGNER", isActive: false });
    expect((await request(makeApp(true)).get("/api/welcome-pack/config")).status).toBe(401);
  });
});

// ---- Categories ----

describe("POST /api/welcome-pack/categories", () => {
  it("creates with a slugified key (ZIP folder) appended after the last order", async () => {
    db.categoryFindUnique.mockResolvedValue(null); // key is free
    db.categoryFindFirst.mockResolvedValue({ order: 2 });
    db.categoryCreate.mockResolvedValue({
      id: "c9",
      key: "welcome_series",
      name: "Welcome Series",
      usesOwnReferences: false,
      order: 3,
    });

    const res = await request(makeApp())
      .post("/api/welcome-pack/categories")
      .send({ name: "Welcome Series", usesOwnReferences: false });

    expect(res.status).toBe(201);
    expect(db.categoryCreate.mock.calls[0]![0].data).toMatchObject({
      key: "welcome_series",
      name: "Welcome Series",
      usesOwnReferences: false,
      order: 3,
    });
    expect(db.logCreate.mock.calls[0]![0].data).toMatchObject({
      entityType: "CATEGORY",
      action: "CREATE",
      userEmail: "sd@example.com",
    });
  });

  it("de-duplicates a colliding key with a _2 suffix", async () => {
    db.categoryFindUnique.mockResolvedValueOnce({ id: "c1" }).mockResolvedValueOnce(null);
    db.categoryFindFirst.mockResolvedValue(null);
    db.categoryCreate.mockResolvedValue({
      id: "c9",
      key: "welcome_series_2",
      name: "Welcome Series",
      usesOwnReferences: false,
      order: 0,
    });

    const res = await request(makeApp())
      .post("/api/welcome-pack/categories")
      .send({ name: "Welcome Series" });

    expect(res.status).toBe(201);
    expect(db.categoryCreate.mock.calls[0]![0].data.key).toBe("welcome_series_2");
  });

  it("rejects an empty name", async () => {
    const res = await request(makeApp()).post("/api/welcome-pack/categories").send({ name: "  " });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/welcome-pack/categories/:id", () => {
  it("flips usesOwnReferences and logs the change", async () => {
    db.categoryFindUnique.mockResolvedValue({
      name: "Own refs",
      order: 0,
      usesOwnReferences: false,
    });
    db.categoryUpdate.mockResolvedValue({
      id: "c1",
      key: "own_refs",
      name: "Own refs",
      usesOwnReferences: true,
      order: 0,
    });

    const res = await request(makeApp())
      .patch("/api/welcome-pack/categories/c1")
      .send({ usesOwnReferences: true });

    expect(res.status).toBe(200);
    expect(db.categoryUpdate.mock.calls[0]![0].data).toEqual({ usesOwnReferences: true });
    const logged = db.logCreate.mock.calls[0]![0].data;
    expect(logged.before).toMatchObject({ usesOwnReferences: false });
    expect(logged.after).toMatchObject({ usesOwnReferences: true });
  });

  it("never touches the frozen key, even if the client sends one", async () => {
    db.categoryFindUnique.mockResolvedValue({ name: "Old", order: 0, usesOwnReferences: false });
    db.categoryUpdate.mockResolvedValue({
      id: "c1",
      key: "old",
      name: "New",
      usesOwnReferences: false,
      order: 0,
    });

    await request(makeApp())
      .patch("/api/welcome-pack/categories/c1")
      .send({ name: "New", key: "hacked" });

    expect(db.categoryUpdate.mock.calls[0]![0].data).toEqual({ name: "New" });
  });

  it("404s an unknown category", async () => {
    db.categoryFindUnique.mockResolvedValue(null);
    const res = await request(makeApp())
      .patch("/api/welcome-pack/categories/ghost")
      .send({ name: "X" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/welcome-pack/categories/:id", () => {
  it("HARD deletes and keeps the FULL snapshot (elements included) in the log", async () => {
    db.categoryFindUnique.mockResolvedValue({
      key: "welcome_series",
      name: "Welcome Series",
      usesOwnReferences: false,
      order: 0,
      elements: [snap(), snap({ name: "Welcome_2" })],
    });
    db.categoryDelete.mockResolvedValue({});

    const res = await request(makeApp()).delete("/api/welcome-pack/categories/c1");

    expect(res.status).toBe(200);
    expect(db.categoryDelete).toHaveBeenCalledWith({ where: { id: "c1" } });
    const logged = db.logCreate.mock.calls[0]![0].data;
    expect(logged.action).toBe("DELETE");
    expect((logged.before as { elements: unknown[] }).elements).toHaveLength(2);
  });
});

// ---- Elements ----

describe("POST /api/welcome-pack/elements", () => {
  it("creates ONE placeholder prompt (no Base/VIP pair) after the last order", async () => {
    db.categoryFindUnique.mockResolvedValue({ id: "c1" });
    db.elementFindUnique
      .mockResolvedValueOnce(null) // name clash check
      .mockResolvedValueOnce(snap()); // snapshot read
    db.elementFindFirst.mockResolvedValue({ order: 1 });
    db.elementCreate.mockResolvedValue({ id: "e9" });

    const res = await request(makeApp())
      .post("/api/welcome-pack/elements")
      .send({ categoryId: "c1", name: "Welcome_3" });

    expect(res.status).toBe(201);
    const data = db.elementCreate.mock.calls[0]![0].data;
    expect(data.order).toBe(2);
    expect(data.prompt.create.content).toContain("Welcome_3");
  });

  it("409s a duplicate name inside the same category", async () => {
    db.categoryFindUnique.mockResolvedValue({ id: "c1" });
    db.elementFindUnique.mockResolvedValue({ id: "other" });
    const res = await request(makeApp())
      .post("/api/welcome-pack/elements")
      .send({ categoryId: "c1", name: "Welcome_1" });
    expect(res.status).toBe(409);
  });

  it("404s an unknown category", async () => {
    db.categoryFindUnique.mockResolvedValue(null);
    const res = await request(makeApp())
      .post("/api/welcome-pack/elements")
      .send({ categoryId: "ghost", name: "Welcome_1" });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /elements/:id — the single audited save", () => {
  it("writes name, prompt and refs in ONE transaction and ONE log entry", async () => {
    db.elementFindUnique
      .mockResolvedValueOnce({ categoryId: "c1" }) // existence
      .mockResolvedValueOnce(snap()) // before
      .mockResolvedValueOnce(null) // name clash check
      .mockResolvedValueOnce(
        snap({ name: "Welcome_1x", prompt: { content: "new prompt" }, referenceImages: ["u1"] }),
      ); // after

    const res = await request(makeApp())
      .patch("/api/welcome-pack/elements/e1")
      .send({ name: "Welcome_1x", prompt: "new prompt", referenceImages: ["u1"], isActive: true });

    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    // One $transaction with the element update + the prompt upsert.
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.transaction.mock.calls[0]![0]).toHaveLength(2);
    // The prompt is keyed by elementId alone — no mode in this feature.
    expect(db.promptUpsert.mock.calls[0]![0].where).toEqual({ elementId: "e1" });
    expect(db.logCreate).toHaveBeenCalledTimes(1);
  });

  it("a no-op save writes NO log entry (it must not become a rollback target)", async () => {
    db.elementFindUnique
      .mockResolvedValueOnce({ categoryId: "c1" })
      .mockResolvedValueOnce(snap())
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(snap()); // identical after

    const res = await request(makeApp())
      .patch("/api/welcome-pack/elements/e1")
      .send({ name: "Welcome_1" });

    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    expect(db.logCreate).not.toHaveBeenCalled();
  });

  it("409s a name that collides with another element of the category", async () => {
    db.elementFindUnique
      .mockResolvedValueOnce({ categoryId: "c1" })
      .mockResolvedValueOnce(snap())
      .mockResolvedValueOnce({ id: "other" }); // clash

    const res = await request(makeApp())
      .patch("/api/welcome-pack/elements/e1")
      .send({ name: "Welcome_2" });
    expect(res.status).toBe(409);
  });

  it("rejects more than 2 reference images", async () => {
    const res = await request(makeApp())
      .patch("/api/welcome-pack/elements/e1")
      .send({ referenceImages: ["a", "b", "c"] });
    expect(res.status).toBe(400);
  });

  it("404s an unknown element", async () => {
    db.elementFindUnique.mockResolvedValue(null);
    const res = await request(makeApp())
      .patch("/api/welcome-pack/elements/ghost")
      .send({ name: "X" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/welcome-pack/elements/:id", () => {
  it("soft-deletes (isActive=false) so generation history keeps the name", async () => {
    db.elementFindUnique
      .mockResolvedValueOnce(snap())
      .mockResolvedValueOnce(snap({ isActive: false }));
    db.elementUpdate.mockResolvedValue({});

    const res = await request(makeApp()).delete("/api/welcome-pack/elements/e1");

    expect(res.status).toBe(200);
    expect(db.elementUpdate).toHaveBeenCalledWith({
      where: { id: "e1" },
      data: { isActive: false },
    });
    expect(db.logCreate.mock.calls[0]![0].data.action).toBe("DELETE");
  });
});

describe("POST /elements/:id/rollback", () => {
  it("restores the previous snapshot and logs it as ROLLBACK", async () => {
    db.logFindFirst.mockResolvedValue({
      before: { name: "Welcome_1", isActive: true, referenceImages: [], prompt: "old prompt" },
    });
    db.elementFindUnique
      .mockResolvedValueOnce({ categoryId: "c1" })
      .mockResolvedValueOnce(snap({ prompt: { content: "new prompt" } }))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(snap({ prompt: { content: "old prompt" } }));

    const res = await request(makeApp()).post("/api/welcome-pack/elements/e1/rollback");

    expect(res.status).toBe(200);
    expect(db.promptUpsert.mock.calls[0]![0].update).toEqual({ content: "old prompt" });
    expect(db.logCreate.mock.calls[0]![0].data.action).toBe("ROLLBACK");
  });

  it("keeps the current prompt when the previous entry has none (a CREATE)", async () => {
    db.logFindFirst.mockResolvedValue({
      before: { name: "Welcome_1", isActive: true, referenceImages: [], prompt: null },
    });
    db.elementFindUnique
      .mockResolvedValueOnce({ categoryId: "c1" })
      .mockResolvedValueOnce(snap())
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(snap());

    const res = await request(makeApp()).post("/api/welcome-pack/elements/e1/rollback");

    expect(res.status).toBe(200);
    // No prompt write at all — an empty rollback must not wipe the text.
    expect(db.promptUpsert).not.toHaveBeenCalled();
  });

  it("409s when there is nothing to roll back to", async () => {
    db.logFindFirst.mockResolvedValue(null);
    const res = await request(makeApp()).post("/api/welcome-pack/elements/e1/rollback");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("nothing_to_rollback");
  });
});

// ---- Reorder ----

describe("POST /elements/reorder", () => {
  it("applies the new order in ONE transaction and logs the resulting names", async () => {
    db.elementFindMany.mockResolvedValue([
      { id: "e1", name: "Welcome_1" },
      { id: "e2", name: "Welcome_2" },
    ]);

    const res = await request(makeApp())
      .post("/api/welcome-pack/elements/reorder")
      .send({ categoryId: "c1", orderedIds: ["e2", "e1"] });

    expect(res.status).toBe(200);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.logCreate.mock.calls[0]![0].data.after).toEqual({
      order: ["Welcome_2", "Welcome_1"],
    });
  });

  it("400s when the id list doesn't match the category's elements exactly", async () => {
    db.elementFindMany.mockResolvedValue([{ id: "e1", name: "Welcome_1" }]);
    const res = await request(makeApp())
      .post("/api/welcome-pack/elements/reorder")
      .send({ categoryId: "c1", orderedIds: ["e1", "ghost"] });
    expect(res.status).toBe(400);
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

// ---- System wrapper ----

describe("PUT /api/welcome-pack/system-prompt", () => {
  it("upserts the WELCOME wrapper (never the TOURNAMENT one) and logs the diff", async () => {
    db.promptTemplateFindUnique.mockResolvedValue({ content: "old" });
    db.promptTemplateUpsert.mockResolvedValue({ content: "new {{prompt}}" });

    const res = await request(makeApp())
      .put("/api/welcome-pack/system-prompt")
      .send({ content: "new {{prompt}}" });

    expect(res.status).toBe(200);
    expect(db.promptTemplateUpsert.mock.calls[0]![0].where).toEqual({
      type_key: { type: "WELCOME", key: "system" },
    });
    expect(db.logCreate.mock.calls[0]![0].data.entityType).toBe("SYSTEM");
  });
});

// ---- Upload ----

describe("POST /api/welcome-pack/upload", () => {
  it("503s while Cloudinary is not configured", async () => {
    const res = await request(makeApp())
      .post("/api/welcome-pack/upload")
      .send({ dataUrl: "data:image/png;base64,AAA" });
    expect(res.status).toBe(503);
  });
});
