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
    tournamentCategory: {
      findUnique: db.categoryFindUnique,
      findMany: db.categoryFindMany,
      findFirst: db.categoryFindFirst,
      create: db.categoryCreate,
      update: db.categoryUpdate,
      delete: db.categoryDelete,
    },
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

describe("POST /api/tournament-admin/categories", () => {
  it("creates with a slugified key (ZIP folder) appended after the last order", async () => {
    db.categoryFindUnique.mockResolvedValue(null); // key is free
    db.categoryFindFirst.mockResolvedValue({ order: 3 });
    db.categoryCreate.mockResolvedValue({
      id: "c9",
      key: "provider_2",
      name: "Provider 2",
      hasModes: false,
      fixedMode: "BASE",
      order: 4,
    });

    const res = await request(makeApp())
      .post("/api/tournament-admin/categories")
      .send({ name: "Provider 2", hasModes: false, fixedMode: "BASE" });

    expect(res.status).toBe(201);
    const data = db.categoryCreate.mock.calls[0]![0].data;
    expect(data.key).toBe("provider_2"); // "Provider 2" -> slug
    expect(data.order).toBe(4); // after the existing 0..3
    expect(data.fixedMode).toBe("BASE");
  });

  it("suffixes the key on a collision (rename-safe ZIP folders)", async () => {
    db.categoryFindUnique
      .mockResolvedValueOnce({ id: "existing" }) // "tournament" taken
      .mockResolvedValueOnce(null); // "tournament_2" free
    db.categoryFindFirst.mockResolvedValue({ order: 3 });
    db.categoryCreate.mockResolvedValue({ id: "c9" });

    const res = await request(makeApp())
      .post("/api/tournament-admin/categories")
      .send({ name: "Tournament", hasModes: true, fixedMode: null });

    expect(res.status).toBe(201);
    expect(db.categoryCreate.mock.calls[0]![0].data.key).toBe("tournament_2");
  });

  it("nulls fixedMode for a Base+VIP category even if the client sends one", async () => {
    db.categoryFindUnique.mockResolvedValue(null);
    db.categoryFindFirst.mockResolvedValue(null); // first category ever
    db.categoryCreate.mockResolvedValue({ id: "c1" });

    const res = await request(makeApp())
      .post("/api/tournament-admin/categories")
      .send({ name: "Promo", hasModes: true, fixedMode: "VIP" });

    expect(res.status).toBe(201);
    const data = db.categoryCreate.mock.calls[0]![0].data;
    expect(data.fixedMode).toBeNull();
    expect(data.order).toBe(0);
  });

  it("400s a single-mode category without fixedMode", async () => {
    const res = await request(makeApp())
      .post("/api/tournament-admin/categories")
      .send({ name: "Promo", hasModes: false, fixedMode: null });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_mode_config");
    expect(db.categoryCreate).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/tournament-admin/categories/:id", () => {
  it("renames without touching the key", async () => {
    db.categoryUpdate.mockResolvedValue({ id: "c1", key: "tournament", name: "Tournament NEW" });
    const res = await request(makeApp())
      .patch("/api/tournament-admin/categories/c1")
      .send({ name: "Tournament NEW" });
    expect(res.status).toBe(200);
    expect(db.categoryUpdate.mock.calls[0]![0].data).toEqual({ name: "Tournament NEW" });
  });
});

describe("DELETE /api/tournament-admin/categories/:id", () => {
  it("hard-deletes the category (cascade takes elements/prompts/overrides)", async () => {
    db.categoryDelete.mockResolvedValue({});
    const res = await request(makeApp()).delete("/api/tournament-admin/categories/c1");
    expect(res.status).toBe(200);
    expect(db.categoryDelete.mock.calls[0]![0]).toEqual({ where: { id: "c1" } });
  });

  it("404s an unknown id", async () => {
    db.categoryDelete.mockRejectedValue(new Error("P2025"));
    const res = await request(makeApp()).delete("/api/tournament-admin/categories/nope");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/tournament-admin/elements", () => {
  it("creates the element with placeholder prompts for every category mode", async () => {
    db.categoryFindUnique.mockResolvedValue({ id: "c1", hasModes: true, fixedMode: null });
    db.elementFindUnique.mockResolvedValue(null); // no name clash
    db.elementFindFirst
      .mockResolvedValueOnce(null) // no VIP-name clash
      .mockResolvedValueOnce({ order: 6 }); // order lookup
    db.elementCreate.mockResolvedValue({
      id: "e9",
      name: "Tournament_4_BASE",
      nameVip: "Tournament_4_VIP",
      order: 7,
      isActive: true,
      referenceImages: [],
    });

    const res = await request(makeApp())
      .post("/api/tournament-admin/elements")
      .send({ categoryId: "c1", name: "Tournament_4_BASE", nameVip: "Tournament_4_VIP" });

    expect(res.status).toBe(201);
    const data = db.elementCreate.mock.calls[0]![0].data;
    expect(data.order).toBe(7); // appended after the last element
    expect(data.nameVip).toBe("Tournament_4_VIP");
    // hasModes category -> BASE + VIP placeholder prompts are born with it.
    expect(data.prompts.create.map((p: { mode: string }) => p.mode)).toEqual(["BASE", "VIP"]);
  });

  it("400s a hasModes category without a VIP name (both names are required)", async () => {
    db.categoryFindUnique.mockResolvedValue({ id: "c1", hasModes: true, fixedMode: null });

    const res = await request(makeApp())
      .post("/api/tournament-admin/elements")
      .send({ categoryId: "c1", name: "Tournament_4" });
    expect(res.status).toBe(400);
    expect(db.elementCreate).not.toHaveBeenCalled();
  });

  it("a fixed-mode category never stores nameVip, even if the client sends one", async () => {
    db.categoryFindUnique.mockResolvedValue({ id: "c2", hasModes: false, fixedMode: "BASE" });
    db.elementFindUnique.mockResolvedValue(null);
    db.elementFindFirst.mockResolvedValue({ order: 0 });
    db.elementCreate.mockResolvedValue({ id: "e9" });

    const res = await request(makeApp())
      .post("/api/tournament-admin/elements")
      .send({ categoryId: "c2", name: "Playson", nameVip: "Playson_VIP" });
    expect(res.status).toBe(201);
    expect(db.elementCreate.mock.calls[0]![0].data.nameVip).toBeNull();
  });

  it("409s on a duplicate name within the category", async () => {
    db.categoryFindUnique.mockResolvedValue({ id: "c1", hasModes: true, fixedMode: null });
    db.elementFindUnique.mockResolvedValue({ id: "existing" });

    const res = await request(makeApp())
      .post("/api/tournament-admin/elements")
      .send({ categoryId: "c1", name: "Tournament_1", nameVip: "Tournament_1_VIP" });
    expect(res.status).toBe(409);
    expect(db.elementCreate).not.toHaveBeenCalled();
  });

  it("409s on a duplicate VIP name within the category", async () => {
    db.categoryFindUnique.mockResolvedValue({ id: "c1", hasModes: true, fixedMode: null });
    db.elementFindUnique.mockResolvedValue(null); // base name free
    db.elementFindFirst.mockResolvedValueOnce({ id: "other" }); // VIP name taken

    const res = await request(makeApp())
      .post("/api/tournament-admin/elements")
      .send({ categoryId: "c1", name: "Tournament_9", nameVip: "Tournament_1_VIP" });
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

  it("saves nameVip on a hasModes element", async () => {
    db.elementFindUnique.mockResolvedValue({
      categoryId: "c1",
      category: { hasModes: true },
    });
    db.elementFindFirst.mockResolvedValue(null); // no VIP clash
    db.elementUpdate.mockResolvedValue({ id: "e1", name: "Tournament_1", nameVip: "Tournament_1_VIP" });

    const res = await request(makeApp())
      .patch("/api/tournament-admin/elements/e1")
      .send({ nameVip: "Tournament_1_VIP" });
    expect(res.status).toBe(200);
    expect(db.elementUpdate.mock.calls[0]![0].data).toEqual({ nameVip: "Tournament_1_VIP" });
  });

  it("400s nameVip on a fixed-mode element and 409s a VIP-name collision", async () => {
    // fixed-mode category -> nameVip is not applicable
    db.elementFindUnique.mockResolvedValue({
      categoryId: "c2",
      category: { hasModes: false },
    });
    let res = await request(makeApp())
      .patch("/api/tournament-admin/elements/e2")
      .send({ nameVip: "Nope_VIP" });
    expect(res.status).toBe(400);

    // hasModes, but another element already uses that VIP name
    db.elementFindUnique.mockResolvedValue({
      categoryId: "c1",
      category: { hasModes: true },
    });
    db.elementFindFirst.mockResolvedValue({ id: "other" });
    res = await request(makeApp())
      .patch("/api/tournament-admin/elements/e1")
      .send({ nameVip: "Tournament_2_VIP" });
    expect(res.status).toBe(409);
    expect(db.elementUpdate).not.toHaveBeenCalled();
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
