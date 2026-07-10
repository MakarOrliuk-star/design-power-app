import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import request from "supertest";

// ---- Mocks (hoisted so the route's module graph picks them up) ----
const db = vi.hoisted(() => ({
  categoryFindUnique: vi.fn(),
  categoryFindMany: vi.fn(),
  elementFindUnique: vi.fn(),
  elementFindFirst: vi.fn(),
  elementCreate: vi.fn(),
  elementUpdate: vi.fn(),
  promptUpsert: vi.fn(),
  promptTemplateFindUnique: vi.fn(),
  promptTemplateUpsert: vi.fn(),
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
    tournamentCategory: { findUnique: db.categoryFindUnique, findMany: db.categoryFindMany },
    tournamentElement: {
      findUnique: db.elementFindUnique,
      findFirst: db.elementFindFirst,
      create: db.elementCreate,
      update: db.elementUpdate,
    },
    tournamentPrompt: { upsert: db.promptUpsert },
    promptTemplate: { findUnique: db.promptTemplateFindUnique, upsert: db.promptTemplateUpsert },
    user: { findUnique: db.userFindUnique },
  },
}));
vi.mock("../src/lib/cloudinary.js", () => ({ uploadBase64: vi.fn(), withRetry: vi.fn() }));

import { tournamentAdminRouter } from "../src/routes/tournamentAdmin.js";
import { requireAdminOrManager } from "../src/middleware/auth.js";

function makeApp(withGuard = false) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: { sub: string; role: string } }).user = {
      sub: "user1",
      role: "DESIGNER", // guard reads the DB, not this
    };
    next();
  });
  if (withGuard) app.use(requireAdminOrManager);
  app.use("/api/tournament-admin", tournamentAdminRouter);
  return app;
}

beforeEach(() => {
  for (const fn of Object.values(db)) fn.mockReset();
});

/**
 * Phase 0 decision: tournament admin is editable by ADMIN **and** MANAGER —
 * and nobody else. The role comes fresh from the DB (promotion without re-login).
 */
describe("requireAdminOrManager", () => {
  it.each([
    ["ADMIN", 200],
    ["MANAGER", 200],
    ["DESIGNER", 403],
    ["CRM", 403],
  ])("role %s -> %i", async (role, expected) => {
    db.userFindUnique.mockResolvedValue({ role, isActive: true });
    db.categoryFindMany.mockResolvedValue([]);
    db.promptTemplateFindUnique.mockResolvedValue(null);

    const res = await request(makeApp(true)).get("/api/tournament-admin/config");
    expect(res.status).toBe(expected);
  });

  it("401s a deactivated user even with a valid session", async () => {
    db.userFindUnique.mockResolvedValue({ role: "ADMIN", isActive: false });
    const res = await request(makeApp(true)).get("/api/tournament-admin/config");
    expect(res.status).toBe(401);
  });
});

describe("POST /api/tournament-admin/elements", () => {
  it("creates the element with placeholder prompts for every category mode", async () => {
    db.categoryFindUnique.mockResolvedValue({ id: "c1", hasModes: true, fixedMode: null });
    db.elementFindUnique.mockResolvedValue(null); // no name clash
    db.elementFindFirst.mockResolvedValue({ order: 6 });
    db.elementCreate.mockResolvedValue({
      id: "e9",
      name: "Tournament_4",
      order: 7,
      isActive: true,
      referenceImages: [],
    });

    const res = await request(makeApp())
      .post("/api/tournament-admin/elements")
      .send({ categoryId: "c1", name: "Tournament_4" });

    expect(res.status).toBe(201);
    const data = db.elementCreate.mock.calls[0]![0].data;
    expect(data.order).toBe(7); // appended after the last element
    // hasModes category -> BASE + VIP placeholder prompts are born with it.
    expect(data.prompts.create.map((p: { mode: string }) => p.mode)).toEqual(["BASE", "VIP"]);
  });

  it("409s on a duplicate name within the category", async () => {
    db.categoryFindUnique.mockResolvedValue({ id: "c1", hasModes: true, fixedMode: null });
    db.elementFindUnique.mockResolvedValue({ id: "existing" });

    const res = await request(makeApp())
      .post("/api/tournament-admin/elements")
      .send({ categoryId: "c1", name: "Tournament_1" });
    expect(res.status).toBe(409);
    expect(db.elementCreate).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/tournament-admin/elements/:id", () => {
  it("rejects a rename that collides with another element", async () => {
    db.elementFindUnique
      .mockResolvedValueOnce({ categoryId: "c1" }) // the element being patched
      .mockResolvedValueOnce({ id: "other" }); // clash lookup

    const res = await request(makeApp())
      .patch("/api/tournament-admin/elements/e1")
      .send({ name: "Tournament_2" });
    expect(res.status).toBe(409);
    expect(db.elementUpdate).not.toHaveBeenCalled();
  });

  it("caps provider referenceImages at 2", async () => {
    db.elementFindUnique.mockResolvedValue({ categoryId: "c1" });
    const res = await request(makeApp())
      .patch("/api/tournament-admin/elements/e1")
      .send({ referenceImages: ["a", "b", "c"] });
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/tournament-admin/prompts", () => {
  it("rejects a mode the element's category does not carry", async () => {
    // calendar_vip: fixedMode VIP -> BASE must be refused.
    db.elementFindUnique.mockResolvedValue({
      category: { hasModes: false, fixedMode: "VIP" },
    });
    const res = await request(makeApp())
      .put("/api/tournament-admin/prompts")
      .send({ elementId: "e1", mode: "BASE", content: "new default" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_mode");
  });

  it("upserts a valid default prompt", async () => {
    db.elementFindUnique.mockResolvedValue({
      category: { hasModes: true, fixedMode: null },
    });
    db.promptUpsert.mockResolvedValue({
      elementId: "e1",
      mode: "VIP",
      content: "new default",
      updatedAt: new Date(),
    });
    const res = await request(makeApp())
      .put("/api/tournament-admin/prompts")
      .send({ elementId: "e1", mode: "VIP", content: "new default" });
    expect(res.status).toBe(200);
    expect(db.promptUpsert).toHaveBeenCalledTimes(1);
  });
});

describe("DELETE /api/tournament-admin/elements/:id", () => {
  it("soft-deletes (isActive=false), never removes the row", async () => {
    db.elementUpdate.mockResolvedValue({});
    const res = await request(makeApp()).delete("/api/tournament-admin/elements/e1");
    expect(res.status).toBe(200);
    expect(db.elementUpdate.mock.calls[0]![0]).toMatchObject({
      where: { id: "e1" },
      data: { isActive: false },
    });
  });
});

describe("PUT /api/tournament-admin/system-prompt", () => {
  it("upserts the TOURNAMENT/system wrapper", async () => {
    db.promptTemplateUpsert.mockResolvedValue({ content: "SYS {{prompt}}" });
    const res = await request(makeApp())
      .put("/api/tournament-admin/system-prompt")
      .send({ content: "SYS {{prompt}}" });
    expect(res.status).toBe(200);
    expect(db.promptTemplateUpsert.mock.calls[0]![0].where).toEqual({
      type_key: { type: "TOURNAMENT", key: "system" },
    });
  });
});
