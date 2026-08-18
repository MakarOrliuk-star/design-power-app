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
  logFindMany: vi.fn(),
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
    welcomeChangeLog: { create: db.logCreate, findMany: db.logFindMany },
    promptTemplate: { findUnique: db.promptTemplateFindUnique, upsert: db.promptTemplateUpsert },
    user: { findUnique: db.userFindUnique },
    $transaction: db.transaction,
  },
}));
vi.mock("../src/lib/cloudinary.js", () => ({ uploadBase64: vi.fn(), withRetry: vi.fn() }));

import { welcomeAdminRouter } from "../src/routes/welcomeAdmin.js";
import { requireAdminOrManager } from "../src/middleware/auth.js";

function makeApp(withGuard = false) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: { sub: string; email: string; role: string } }).user = {
      sub: "admin1",
      email: "admin@example.com",
      role: "ADMIN",
    };
    next();
  });
  if (withGuard) app.use(requireAdminOrManager);
  app.use("/api/welcome-admin", welcomeAdminRouter);
  return app;
}

beforeEach(() => {
  for (const fn of Object.values(db)) fn.mockReset();
  db.transaction.mockResolvedValue([]);
  db.logCreate.mockResolvedValue({});
});

// ---- Role guard ----

describe("requireAdminOrManager on /api/welcome-admin", () => {
  it("lets ADMIN and MANAGER in, 403s SUPER_DESIGNER (that role has its own surface)", async () => {
    db.categoryFindMany.mockResolvedValue([]);
    db.promptTemplateFindUnique.mockResolvedValue(null);

    for (const role of ["ADMIN", "MANAGER"]) {
      db.userFindUnique.mockResolvedValue({ role, isActive: true });
      expect((await request(makeApp(true)).get("/api/welcome-admin/config")).status).toBe(200);
    }
    db.userFindUnique.mockResolvedValue({ role: "SUPER_DESIGNER", isActive: true });
    expect((await request(makeApp(true)).get("/api/welcome-admin/config")).status).toBe(403);
  });
});

// ---- Config + change log ----

describe("GET /api/welcome-admin/config", () => {
  it("returns categories with INACTIVE elements included, plus the system wrapper", async () => {
    db.categoryFindMany.mockResolvedValue([{ id: "c1", elements: [] }]);
    db.promptTemplateFindUnique.mockResolvedValue({ content: "SYS[{{prompt}}]" });

    const res = await request(makeApp()).get("/api/welcome-admin/config");

    expect(res.status).toBe(200);
    expect(res.body.systemPrompt).toBe("SYS[{{prompt}}]");
    // No isActive filter — the panel edits hidden elements too.
    expect(db.categoryFindMany.mock.calls[0]![0].select.elements.where).toBeUndefined();
  });

  it("falls back to an empty wrapper when nothing was seeded yet", async () => {
    db.categoryFindMany.mockResolvedValue([]);
    db.promptTemplateFindUnique.mockResolvedValue(null);
    const res = await request(makeApp()).get("/api/welcome-admin/config");
    expect(res.body.systemPrompt).toBe("");
  });
});

describe("GET /api/welcome-admin/change-log", () => {
  it("reads the WELCOME journal (not the tournament one) and diffs the snapshots", async () => {
    db.logFindMany.mockResolvedValue([
      {
        id: "l1",
        entityType: "ELEMENT",
        entityName: "Welcome_1",
        userEmail: "sd@example.com",
        action: "UPDATE",
        createdAt: new Date("2026-08-18"),
        before: { name: "Welcome_1", prompt: "old", isActive: true },
        after: { name: "Welcome_1", prompt: "new", isActive: false },
      },
    ]);

    const res = await request(makeApp()).get("/api/welcome-admin/change-log?limit=10");

    expect(res.status).toBe(200);
    expect(db.logFindMany.mock.calls[0]![0].take).toBe(10);
    const fields = res.body.entries[0].changes.map((c: { field: string }) => c.field);
    // Only what actually differs — the unchanged name is not listed.
    expect(fields.sort()).toEqual(["Активен", "Промпт"]);
  });

  it("clamps an absurd limit instead of dumping the whole table", async () => {
    db.logFindMany.mockResolvedValue([]);
    await request(makeApp()).get("/api/welcome-admin/change-log?limit=99999");
    expect(db.logFindMany.mock.calls[0]![0].take).toBe(200);
  });
});

// ---- Prompts ----

describe("PUT /api/welcome-admin/prompts", () => {
  it("saves the single default prompt, bumping updatedAt for the banner", async () => {
    db.elementFindUnique
      .mockResolvedValueOnce({ categoryId: "c1" })
      .mockResolvedValueOnce({
        name: "Welcome_1",
        order: 0,
        isActive: true,
        referenceImages: [],
        prompt: { content: "old" },
      })
      .mockResolvedValueOnce({
        name: "Welcome_1",
        order: 0,
        isActive: true,
        referenceImages: [],
        prompt: { content: "new text" },
      });

    const res = await request(makeApp())
      .put("/api/welcome-admin/prompts")
      .send({ elementId: "e1", content: "new text" });

    expect(res.status).toBe(200);
    expect(db.promptUpsert.mock.calls[0]![0]).toMatchObject({
      where: { elementId: "e1" },
      update: { content: "new text" },
    });
    // Edits from the panel land in the SAME journal as the super-designer's.
    expect(db.logCreate).toHaveBeenCalledTimes(1);
  });

  it("404s an unknown element and rejects an empty prompt", async () => {
    db.elementFindUnique.mockResolvedValue(null);
    const missing = await request(makeApp())
      .put("/api/welcome-admin/prompts")
      .send({ elementId: "ghost", content: "text" });
    expect(missing.status).toBe(404);

    const empty = await request(makeApp())
      .put("/api/welcome-admin/prompts")
      .send({ elementId: "e1", content: "  " });
    expect(empty.status).toBe(400);
  });
});

// ---- Elements ----

describe("PATCH /api/welcome-admin/elements/:id", () => {
  it("returns the element without the prompt field (the panel edits it separately)", async () => {
    db.elementFindUnique
      .mockResolvedValueOnce({ categoryId: "c1" })
      .mockResolvedValueOnce({
        name: "Welcome_1",
        order: 0,
        isActive: true,
        referenceImages: [],
        prompt: { content: "p" },
      })
      // No `name` in the patch -> no clash lookup; the next read is the after-snapshot.
      .mockResolvedValueOnce({
        name: "Welcome_1",
        order: 0,
        isActive: false,
        referenceImages: [],
        prompt: { content: "p" },
      });

    const res = await request(makeApp())
      .patch("/api/welcome-admin/elements/e1")
      .send({ isActive: false });

    expect(res.status).toBe(200);
    expect(res.body.element).toMatchObject({ id: "e1", isActive: false });
    expect(res.body.element.prompt).toBeUndefined();
  });
});

// ---- System wrapper ----

describe("PUT /api/welcome-admin/system-prompt", () => {
  it("writes the WELCOME row, leaving the TOURNAMENT wrapper alone", async () => {
    db.promptTemplateFindUnique.mockResolvedValue(null);
    db.promptTemplateUpsert.mockResolvedValue({ content: "W[{{prompt}}]" });

    const res = await request(makeApp())
      .put("/api/welcome-admin/system-prompt")
      .send({ content: "W[{{prompt}}]" });

    expect(res.status).toBe(200);
    expect(db.promptTemplateUpsert.mock.calls[0]![0].create).toMatchObject({
      type: "WELCOME",
      key: "system",
    });
  });
});
