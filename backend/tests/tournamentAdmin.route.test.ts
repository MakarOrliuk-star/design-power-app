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
      findMany: db.elementFindMany,
      findFirst: db.elementFindFirst,
      create: db.elementCreate,
      update: db.elementUpdate,
    },
    tournamentPrompt: { upsert: db.promptUpsert },
    tournamentChangeLog: {
      create: db.logCreate,
      findFirst: db.logFindFirst,
      findMany: db.logFindMany,
    },
    promptTemplate: { findUnique: db.promptTemplateFindUnique, upsert: db.promptTemplateUpsert },
    user: { findUnique: db.userFindUnique },
    $transaction: db.transaction,
  },
}));
vi.mock("../src/lib/cloudinary.js", () => ({ uploadBase64: vi.fn(), withRetry: vi.fn() }));

import { tournamentAdminRouter } from "../src/routes/tournamentAdmin.js";
import { requireAdminOrManager } from "../src/middleware/auth.js";

function makeApp(withGuard = false) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: { sub: string; email: string; role: string } }).user = {
      sub: "user1",
      email: "admin@example.com",
      role: "DESIGNER", // guard reads the DB, not this
    };
    next();
  });
  if (withGuard) app.use(requireAdminOrManager);
  app.use("/api/tournament-admin", tournamentAdminRouter);
  return app;
}

interface SnapRow {
  name: string;
  nameVip: string | null;
  order: number;
  isActive: boolean;
  referenceImages: string[];
  prompts: { mode: string; content: string }[];
}

function snap(over: Partial<SnapRow> = {}): SnapRow {
  return {
    name: "Tournament_1",
    nameVip: "Tournament_1_VIP",
    order: 0,
    isActive: true,
    referenceImages: [],
    prompts: [
      { mode: "BASE", content: "base prompt" },
      { mode: "VIP", content: "vip prompt" },
    ],
    ...over,
  };
}

/**
 * Since the panel delegates to tournamentPack.service, element mutations hit
 * tournamentElement.findUnique three ways — the element+category lookup, the
 * before/after snapshots (select carries `prompts`) and the base-name clash
 * check (`where.categoryId_name`). Route by the args rather than by call order.
 */
function setupElement(
  opts: {
    category?: { hasModes: boolean; fixedMode: string | null };
    snapshots?: SnapRow[];
    nameClash?: { id: string } | null;
    vipClash?: { id: string } | null;
  } = {},
) {
  const category = opts.category ?? { hasModes: true, fixedMode: null };
  const queue = [...(opts.snapshots ?? [snap(), snap()])];
  db.elementFindUnique.mockImplementation(
    (args: { where?: Record<string, unknown>; select?: Record<string, unknown> }) => {
      if (args.where?.categoryId_name) return Promise.resolve(opts.nameClash ?? null);
      if (args.select?.prompts) return Promise.resolve(queue.length > 1 ? queue.shift() : queue[0]);
      return Promise.resolve({ categoryId: "c1", category });
    },
  );
  db.elementFindFirst.mockResolvedValue(opts.vipClash ?? null);
  db.elementUpdate.mockResolvedValue({ id: "e1" });
  db.promptUpsert.mockResolvedValue({});
}

beforeEach(() => {
  for (const fn of Object.values(db)) fn.mockReset();
  db.transaction.mockImplementation((ops: unknown[]) => Promise.all(ops));
  db.logCreate.mockResolvedValue({ id: "log1" });
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
    db.categoryCreate.mockResolvedValue({ id: "c9", name: "Tournament" });

    const res = await request(makeApp())
      .post("/api/tournament-admin/categories")
      .send({ name: "Tournament", hasModes: true, fixedMode: null });

    expect(res.status).toBe(201);
    expect(db.categoryCreate.mock.calls[0]![0].data.key).toBe("tournament_2");
  });

  it("nulls fixedMode for a Base+VIP category even if the client sends one", async () => {
    db.categoryFindUnique.mockResolvedValue(null);
    db.categoryFindFirst.mockResolvedValue(null); // first category ever
    db.categoryCreate.mockResolvedValue({ id: "c1", name: "Promo" });

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
    db.categoryFindUnique.mockResolvedValue({ name: "Tournament", order: 0 });
    db.categoryUpdate.mockResolvedValue({
      id: "c1",
      key: "tournament",
      name: "Tournament NEW",
      order: 0,
    });

    const res = await request(makeApp())
      .patch("/api/tournament-admin/categories/c1")
      .send({ name: "Tournament NEW" });

    expect(res.status).toBe(200);
    expect(db.categoryUpdate.mock.calls[0]![0].data).toEqual({ name: "Tournament NEW" });
  });

  it("404s an unknown id", async () => {
    db.categoryFindUnique.mockResolvedValue(null);
    const res = await request(makeApp())
      .patch("/api/tournament-admin/categories/nope")
      .send({ name: "X" });
    expect(res.status).toBe(404);
    expect(db.categoryUpdate).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/tournament-admin/categories/:id", () => {
  it("hard-deletes the category (cascade takes elements/prompts/overrides)", async () => {
    db.categoryFindUnique.mockResolvedValue({
      key: "tournament",
      name: "Tournament",
      hasModes: true,
      fixedMode: null,
      order: 0,
      elements: [snap()],
    });
    db.categoryDelete.mockResolvedValue({});

    const res = await request(makeApp()).delete("/api/tournament-admin/categories/c1");

    expect(res.status).toBe(200);
    expect(db.categoryDelete.mock.calls[0]![0]).toEqual({ where: { id: "c1" } });
    // the only trace left of a hard delete
    expect(db.logCreate.mock.calls[0]![0].data.before.elements).toHaveLength(1);
  });

  it("404s an unknown id", async () => {
    db.categoryFindUnique.mockResolvedValue(null);
    const res = await request(makeApp()).delete("/api/tournament-admin/categories/nope");
    expect(res.status).toBe(404);
    expect(db.categoryDelete).not.toHaveBeenCalled();
  });
});

describe("POST /api/tournament-admin/elements", () => {
  it("creates the element with placeholder prompts for every category mode", async () => {
    db.categoryFindUnique.mockResolvedValue({ id: "c1", hasModes: true, fixedMode: null });
    db.elementFindUnique
      .mockResolvedValueOnce(null) // base-name clash check
      .mockResolvedValueOnce(snap()); // post-create snapshot
    db.elementFindFirst
      .mockResolvedValueOnce(null) // no VIP-name clash
      .mockResolvedValueOnce({ order: 6 }); // order lookup
    db.elementCreate.mockResolvedValue({ id: "e9" });

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
    db.elementFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(snap());
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
    setupElement({ nameClash: { id: "other" } });

    const res = await request(makeApp())
      .patch("/api/tournament-admin/elements/e1")
      .send({ name: "Tournament_2" });
    expect(res.status).toBe(409);
    expect(db.elementUpdate).not.toHaveBeenCalled();
  });

  it("caps provider referenceImages at 2", async () => {
    setupElement();
    const res = await request(makeApp())
      .patch("/api/tournament-admin/elements/e1")
      .send({ referenceImages: ["a", "b", "c"] });
    expect(res.status).toBe(400);
  });

  it("saves nameVip on a hasModes element", async () => {
    setupElement({ snapshots: [snap(), snap({ nameVip: "Tournament_1_VIP_NEW" })] });

    const res = await request(makeApp())
      .patch("/api/tournament-admin/elements/e1")
      .send({ nameVip: "Tournament_1_VIP_NEW" });
    expect(res.status).toBe(200);
    expect(db.elementUpdate.mock.calls[0]![0].data).toEqual({ nameVip: "Tournament_1_VIP_NEW" });
  });

  it("400s nameVip on a fixed-mode element and 409s a VIP-name collision", async () => {
    // fixed-mode category -> nameVip is not applicable
    setupElement({ category: { hasModes: false, fixedMode: "BASE" } });
    let res = await request(makeApp())
      .patch("/api/tournament-admin/elements/e2")
      .send({ nameVip: "Nope_VIP" });
    expect(res.status).toBe(400);

    // hasModes, but another element already uses that VIP name
    setupElement({ vipClash: { id: "other" } });
    res = await request(makeApp())
      .patch("/api/tournament-admin/elements/e1")
      .send({ nameVip: "Tournament_2_VIP" });
    expect(res.status).toBe(409);
    expect(db.elementUpdate).not.toHaveBeenCalled();
  });

  it("still accepts `order` — the panel's contract predates the pack window", async () => {
    setupElement({ snapshots: [snap(), snap({ order: 3 })] });

    const res = await request(makeApp())
      .patch("/api/tournament-admin/elements/e1")
      .send({ order: 3 });
    expect(res.status).toBe(200);
    expect(db.elementUpdate.mock.calls[0]![0].data).toEqual({ order: 3 });
  });
});

describe("PUT /api/tournament-admin/prompts", () => {
  it("rejects a mode the element's category does not carry", async () => {
    // calendar_vip: fixedMode VIP -> BASE must be refused.
    setupElement({ category: { hasModes: false, fixedMode: "VIP" } });
    const res = await request(makeApp())
      .put("/api/tournament-admin/prompts")
      .send({ elementId: "e1", mode: "BASE", content: "new default" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_mode");
    expect(db.promptUpsert).not.toHaveBeenCalled();
  });

  it("upserts a valid default prompt", async () => {
    setupElement({
      snapshots: [
        snap(),
        snap({ prompts: [{ mode: "BASE", content: "base prompt" }, { mode: "VIP", content: "new default" }] }),
      ],
    });
    const res = await request(makeApp())
      .put("/api/tournament-admin/prompts")
      .send({ elementId: "e1", mode: "VIP", content: "new default" });
    expect(res.status).toBe(200);
    expect(db.promptUpsert).toHaveBeenCalledTimes(1);
    expect(db.logCreate).toHaveBeenCalledTimes(1); // panel edits are audited too now
  });

  it("404s an unknown element", async () => {
    db.elementFindUnique.mockResolvedValue(null);
    const res = await request(makeApp())
      .put("/api/tournament-admin/prompts")
      .send({ elementId: "nope", mode: "BASE", content: "x" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("element_not_found");
  });
});

describe("DELETE /api/tournament-admin/elements/:id", () => {
  it("soft-deletes (isActive=false), never removes the row", async () => {
    setupElement({ snapshots: [snap(), snap({ isActive: false })] });
    const res = await request(makeApp()).delete("/api/tournament-admin/elements/e1");
    expect(res.status).toBe(200);
    expect(db.elementUpdate.mock.calls[0]![0]).toMatchObject({
      where: { id: "e1" },
      data: { isActive: false },
    });
  });

  it("404s an unknown element", async () => {
    db.elementFindUnique.mockResolvedValue(null);
    const res = await request(makeApp()).delete("/api/tournament-admin/elements/nope");
    expect(res.status).toBe(404);
    expect(db.elementUpdate).not.toHaveBeenCalled();
  });
});

describe("PUT /api/tournament-admin/system-prompt", () => {
  it("upserts the TOURNAMENT/system wrapper", async () => {
    db.promptTemplateFindUnique.mockResolvedValue({ content: "OLD" });
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

/**
 * The journal the panel shows: every tournament edit, from the admin panel AND
 * from the super-designer's «Edit Tournament pack», with a per-field diff.
 */
describe("GET /api/tournament-admin/change-log", () => {
  it("returns newest-first entries with a field-level diff", async () => {
    db.logFindMany.mockResolvedValue([
      {
        id: "l1",
        entityType: "ELEMENT",
        entityName: "Tournament_1",
        userEmail: "super@example.com",
        action: "UPDATE",
        createdAt: new Date("2026-08-04T10:00:00Z"),
        before: snap(),
        after: snap({
          name: "Tournament_1_NEW",
          prompts: [
            { mode: "BASE", content: "base prompt" },
            { mode: "VIP", content: "rewritten vip" },
          ],
        }),
      },
    ]);

    const res = await request(makeApp()).get("/api/tournament-admin/change-log");

    expect(res.status).toBe(200);
    expect(db.logFindMany.mock.calls[0]![0]).toMatchObject({ orderBy: { createdAt: "desc" } });
    const entry = res.body.entries[0];
    expect(entry.userEmail).toBe("super@example.com");
    // only what actually differs — untouched BASE prompt is not listed
    expect(entry.changes.map((c: { field: string }) => c.field)).toEqual([
      "Название",
      "Промпт VIP",
    ]);
    expect(entry.changes[0]).toEqual({
      field: "Название",
      before: "Tournament_1",
      after: "Tournament_1_NEW",
    });
  });

  it("clamps the limit to a sane window", async () => {
    db.logFindMany.mockResolvedValue([]);
    await request(makeApp()).get("/api/tournament-admin/change-log?limit=9999");
    expect(db.logFindMany.mock.calls[0]![0].take).toBe(200);
  });

  it("reports a hard-deleted category by its size, not a dump of every element", async () => {
    db.logFindMany.mockResolvedValue([
      {
        id: "l2",
        entityType: "CATEGORY",
        entityName: "Lotterie",
        userEmail: "super@example.com",
        action: "DELETE",
        createdAt: new Date("2026-08-04T11:00:00Z"),
        before: { key: "lotterie", name: "Lotterie", order: 1, elements: [snap(), snap()] },
        after: {},
      },
    ]);

    const res = await request(makeApp()).get("/api/tournament-admin/change-log");
    const fields = res.body.entries[0].changes.map((c: { field: string }) => c.field);
    expect(fields).toContain("Элементов");
    expect(res.body.entries[0].changes.find((c: { field: string }) => c.field === "Элементов"))
      .toEqual({ field: "Элементов", before: "2", after: "—" });
  });
});
