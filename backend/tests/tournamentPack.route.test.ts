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
    tournamentChangeLog: { create: db.logCreate, findFirst: db.logFindFirst },
    promptTemplate: { findUnique: db.promptTemplateFindUnique, upsert: db.promptTemplateUpsert },
    user: { findUnique: db.userFindUnique },
    $transaction: db.transaction,
  },
}));
vi.mock("../src/lib/cloudinary.js", () => ({ uploadBase64: vi.fn(), withRetry: vi.fn() }));

import { tournamentPackRouter } from "../src/routes/tournamentPack.js";
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
  app.use("/api/tournament-pack", tournamentPackRouter);
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
 * The service hits tournamentElement.findUnique three ways — the element+category
 * lookup, the before/after snapshots (select carries `prompts`) and the base-name
 * clash check (`where.categoryId_name`). Route by the args instead of chaining
 * mockResolvedValueOnce, which would break the moment a call order changes.
 */
function setupElement(opts: {
  category?: { hasModes: boolean; fixedMode: string | null };
  snapshots?: SnapRow[];
  nameClash?: { id: string } | null;
  vipClash?: { id: string } | null;
} = {}) {
  const category = opts.category ?? { hasModes: true, fixedMode: null };
  const queue = [...(opts.snapshots ?? [snap(), snap()])];
  db.elementFindUnique.mockImplementation((args: { where?: Record<string, unknown>; select?: Record<string, unknown> }) => {
    if (args.where?.categoryId_name) return Promise.resolve(opts.nameClash ?? null);
    if (args.select?.prompts) return Promise.resolve(queue.length > 1 ? queue.shift() : queue[0]);
    return Promise.resolve({ categoryId: "c1", category });
  });
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
 * The window is the super-designer's, but ADMIN/MANAGER reach it too (answer C2)
 * — mirrors auth.canCreateStyles on the frontend. Plain DESIGNER never does.
 */
describe("requireSuperDesigner on /api/tournament-pack", () => {
  it.each([
    ["SUPER_DESIGNER", 200],
    ["ADMIN", 200],
    ["MANAGER", 200],
    ["DESIGNER", 403],
    ["CRM", 403],
    ["CRM_SUPER", 403],
  ])("role %s -> %i", async (role, expected) => {
    db.userFindUnique.mockResolvedValue({ role, isActive: true });
    db.categoryFindMany.mockResolvedValue([]);
    db.promptTemplateFindUnique.mockResolvedValue(null);

    const res = await request(makeApp(true)).get("/api/tournament-pack/config");
    expect(res.status).toBe(expected);
  });

  it("401s a deactivated user even with a valid session", async () => {
    db.userFindUnique.mockResolvedValue({ role: "SUPER_DESIGNER", isActive: false });
    const res = await request(makeApp(true)).get("/api/tournament-pack/config");
    expect(res.status).toBe(401);
  });
});

describe("PATCH /elements/:id — the single audited save", () => {
  it("writes names, both prompts and refs in ONE transaction and ONE log entry", async () => {
    setupElement({
      snapshots: [snap(), snap({ name: "Tournament_1_NEW", prompts: [
        { mode: "BASE", content: "new base" },
        { mode: "VIP", content: "new vip" },
      ] })],
    });

    const res = await request(makeApp())
      .patch("/api/tournament-pack/elements/e1")
      .send({
        name: "Tournament_1_NEW",
        nameVip: "Tournament_1_VIP",
        isActive: true,
        prompts: [
          { mode: "BASE", content: "new base" },
          { mode: "VIP", content: "new vip" },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    // one transaction carrying the element update + both prompt upserts
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.transaction.mock.calls[0]![0]).toHaveLength(3);
    expect(db.promptUpsert).toHaveBeenCalledTimes(2);
    // exactly one audit entry, with before/after snapshots of the whole element
    expect(db.logCreate).toHaveBeenCalledTimes(1);
    const logged = db.logCreate.mock.calls[0]![0].data;
    expect(logged.entityType).toBe("ELEMENT");
    expect(logged.action).toBe("UPDATE");
    expect(logged.userEmail).toBe("sd@example.com");
    expect(logged.before.name).toBe("Tournament_1");
    expect(logged.after.name).toBe("Tournament_1_NEW");
    expect(logged.after.prompts).toHaveLength(2);
  });

  it("a no-op save writes NO log entry (it must not become a rollback target)", async () => {
    setupElement({ snapshots: [snap(), snap()] });

    const res = await request(makeApp())
      .patch("/api/tournament-pack/elements/e1")
      .send({ name: "Tournament_1" });

    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    expect(db.logCreate).not.toHaveBeenCalled();
  });

  it("409s a rename that collides with another element of the category", async () => {
    setupElement({ nameClash: { id: "other" } });

    const res = await request(makeApp())
      .patch("/api/tournament-pack/elements/e1")
      .send({ name: "Tournament_2" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_exists");
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("409s a VIP-name collision", async () => {
    setupElement({ vipClash: { id: "other" } });

    const res = await request(makeApp())
      .patch("/api/tournament-pack/elements/e1")
      .send({ nameVip: "Tournament_2_VIP" });

    expect(res.status).toBe(409);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("400s a nameVip on a fixed-mode element", async () => {
    setupElement({ category: { hasModes: false, fixedMode: "BASE" } });

    const res = await request(makeApp())
      .patch("/api/tournament-pack/elements/e1")
      .send({ nameVip: "Nope_VIP" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("vip_not_applicable");
  });

  it("400s a prompt mode the element's category does not carry", async () => {
    // calendar_vip: fixedMode VIP -> a BASE prompt must be refused
    setupElement({ category: { hasModes: false, fixedMode: "VIP" } });

    const res = await request(makeApp())
      .patch("/api/tournament-pack/elements/e1")
      .send({ prompts: [{ mode: "BASE", content: "nope" }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_mode");
    expect(db.promptUpsert).not.toHaveBeenCalled();
  });

  it("caps provider referenceImages at 2", async () => {
    setupElement();
    const res = await request(makeApp())
      .patch("/api/tournament-pack/elements/e1")
      .send({ referenceImages: ["a", "b", "c"] });
    expect(res.status).toBe(400);
  });

  it("404s an unknown element", async () => {
    db.elementFindUnique.mockResolvedValue(null);
    const res = await request(makeApp())
      .patch("/api/tournament-pack/elements/nope")
      .send({ name: "X" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /elements/:id", () => {
  it("soft-deletes (isActive=false) and logs a DELETE with the full snapshot", async () => {
    setupElement({ snapshots: [snap(), snap({ isActive: false })] });

    const res = await request(makeApp()).delete("/api/tournament-pack/elements/e1");

    expect(res.status).toBe(200);
    expect(db.elementUpdate.mock.calls[0]![0]).toMatchObject({
      where: { id: "e1" },
      data: { isActive: false },
    });
    const logged = db.logCreate.mock.calls[0]![0].data;
    expect(logged.action).toBe("DELETE");
    expect(logged.before.isActive).toBe(true);
    expect(logged.before.prompts).toHaveLength(2);
  });
});

describe("POST /elements/:id/rollback", () => {
  it("409s when the element has no history", async () => {
    db.logFindFirst.mockResolvedValue(null);
    const res = await request(makeApp()).post("/api/tournament-pack/elements/e1/rollback");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("nothing_to_rollback");
  });

  it("restores the previous snapshot, logs a ROLLBACK, and never touches order", async () => {
    db.logFindFirst.mockResolvedValue({
      before: snap({ name: "Tournament_OLD", order: 5, prompts: [
        { mode: "BASE", content: "old base" },
        { mode: "VIP", content: "old vip" },
      ] }),
    });
    setupElement({ snapshots: [snap(), snap({ name: "Tournament_OLD" })] });

    const res = await request(makeApp()).post("/api/tournament-pack/elements/e1/rollback");

    expect(res.status).toBe(200);
    const data = db.elementUpdate.mock.calls[0]![0].data;
    expect(data.name).toBe("Tournament_OLD");
    // position is owned by reorder — resurrecting an old index would scramble the list
    expect(data).not.toHaveProperty("order");
    expect(db.promptUpsert).toHaveBeenCalledTimes(2);
    expect(db.logCreate.mock.calls[0]![0].data.action).toBe("ROLLBACK");
  });
});

describe("POST /elements/reorder", () => {
  it("400s when the ids do not match the category's elements exactly", async () => {
    db.elementFindMany.mockResolvedValue([{ id: "e1", name: "A" }, { id: "e2", name: "B" }]);
    const res = await request(makeApp())
      .post("/api/tournament-pack/elements/reorder")
      .send({ categoryId: "c1", orderedIds: ["e1"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_ids");
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("renumbers 0..n in one transaction and logs the resulting name order", async () => {
    db.elementFindMany.mockResolvedValue([{ id: "e1", name: "A" }, { id: "e2", name: "B" }]);
    db.elementUpdate.mockResolvedValue({});

    const res = await request(makeApp())
      .post("/api/tournament-pack/elements/reorder")
      .send({ categoryId: "c1", orderedIds: ["e2", "e1"] });

    expect(res.status).toBe(200);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.elementUpdate.mock.calls.map((c) => c[0])).toEqual([
      { where: { id: "e2" }, data: { order: 0 } },
      { where: { id: "e1" }, data: { order: 1 } },
    ]);
    expect(db.logCreate.mock.calls[0]![0].data.after).toEqual({ order: ["B", "A"] });
  });
});

describe("POST /elements", () => {
  it("creates with placeholder prompts per mode and logs a CREATE", async () => {
    db.categoryFindUnique.mockResolvedValue({ id: "c1", hasModes: true, fixedMode: null });
    db.elementFindUnique
      .mockResolvedValueOnce(null) // base-name clash check
      .mockResolvedValueOnce(snap()); // post-create snapshot
    db.elementFindFirst
      .mockResolvedValueOnce(null) // VIP-name clash check
      .mockResolvedValueOnce({ order: 6 }); // order lookup
    db.elementCreate.mockResolvedValue({ id: "e9" });

    const res = await request(makeApp())
      .post("/api/tournament-pack/elements")
      .send({ categoryId: "c1", name: "Tournament_4", nameVip: "Tournament_4_VIP" });

    expect(res.status).toBe(201);
    const data = db.elementCreate.mock.calls[0]![0].data;
    expect(data.order).toBe(7);
    expect(data.prompts.create.map((p: { mode: string }) => p.mode)).toEqual(["BASE", "VIP"]);
    expect(db.logCreate.mock.calls[0]![0].data.action).toBe("CREATE");
  });

  it("400s a Base+VIP category without a VIP name", async () => {
    db.categoryFindUnique.mockResolvedValue({ id: "c1", hasModes: true, fixedMode: null });
    const res = await request(makeApp())
      .post("/api/tournament-pack/elements")
      .send({ categoryId: "c1", name: "Tournament_4" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("vip_name_required");
    expect(db.elementCreate).not.toHaveBeenCalled();
  });

  it("404s an unknown category", async () => {
    db.categoryFindUnique.mockResolvedValue(null);
    const res = await request(makeApp())
      .post("/api/tournament-pack/elements")
      .send({ categoryId: "nope", name: "X" });
    expect(res.status).toBe(404);
  });
});

describe("categories", () => {
  it("creates with a slugified, collision-suffixed key (the ZIP folder)", async () => {
    db.categoryFindUnique
      .mockResolvedValueOnce({ id: "existing" }) // "tournament" taken
      .mockResolvedValueOnce(null); // "tournament_2" free
    db.categoryFindFirst.mockResolvedValue({ order: 3 });
    db.categoryCreate.mockResolvedValue({ id: "c9", key: "tournament_2", name: "Tournament" });

    const res = await request(makeApp())
      .post("/api/tournament-pack/categories")
      .send({ name: "Tournament", hasModes: true, fixedMode: null });

    expect(res.status).toBe(201);
    const data = db.categoryCreate.mock.calls[0]![0].data;
    expect(data.key).toBe("tournament_2");
    expect(data.order).toBe(4);
    expect(data.fixedMode).toBeNull();
  });

  it("400s a single-mode category without fixedMode", async () => {
    const res = await request(makeApp())
      .post("/api/tournament-pack/categories")
      .send({ name: "Promo", hasModes: false, fixedMode: null });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_mode_config");
    expect(db.categoryCreate).not.toHaveBeenCalled();
  });

  it("renames without touching the frozen key", async () => {
    db.categoryFindUnique.mockResolvedValue({ name: "Old", order: 0 });
    db.categoryUpdate.mockResolvedValue({ id: "c1", name: "New", order: 0 });

    const res = await request(makeApp())
      .patch("/api/tournament-pack/categories/c1")
      .send({ name: "New" });

    expect(res.status).toBe(200);
    expect(db.categoryUpdate.mock.calls[0]![0].data).toEqual({ name: "New" });
    expect(db.logCreate).toHaveBeenCalledTimes(1);
  });

  it("hard-deletes and keeps the FULL snapshot (elements + prompts) in the log", async () => {
    db.categoryFindUnique.mockResolvedValue({
      key: "tournament",
      name: "Tournament",
      hasModes: true,
      fixedMode: null,
      order: 0,
      elements: [snap(), snap({ name: "Tournament_2" })],
    });
    db.categoryDelete.mockResolvedValue({});

    const res = await request(makeApp()).delete("/api/tournament-pack/categories/c1");

    expect(res.status).toBe(200);
    const logged = db.logCreate.mock.calls[0]![0].data;
    expect(logged.action).toBe("DELETE");
    expect(logged.before.elements).toHaveLength(2);
    expect(logged.before.elements[0].prompts).toHaveLength(2);
  });

  it("404s deleting an unknown category (and never calls delete)", async () => {
    db.categoryFindUnique.mockResolvedValue(null);
    const res = await request(makeApp()).delete("/api/tournament-pack/categories/nope");
    expect(res.status).toBe(404);
    expect(db.categoryDelete).not.toHaveBeenCalled();
  });
});

describe("PUT /system-prompt", () => {
  it("upserts the TOURNAMENT/system wrapper and logs the change", async () => {
    db.promptTemplateFindUnique.mockResolvedValue({ content: "OLD" });
    db.promptTemplateUpsert.mockResolvedValue({ content: "SYS {{prompt}}" });

    const res = await request(makeApp())
      .put("/api/tournament-pack/system-prompt")
      .send({ content: "SYS {{prompt}}" });

    expect(res.status).toBe(200);
    expect(db.promptTemplateUpsert.mock.calls[0]![0].where).toEqual({
      type_key: { type: "TOURNAMENT", key: "system" },
    });
    expect(db.logCreate.mock.calls[0]![0].data.entityType).toBe("SYSTEM");
  });

  it("logs nothing when the wrapper text is unchanged", async () => {
    db.promptTemplateFindUnique.mockResolvedValue({ content: "SAME" });
    db.promptTemplateUpsert.mockResolvedValue({ content: "SAME" });

    const res = await request(makeApp())
      .put("/api/tournament-pack/system-prompt")
      .send({ content: "SAME" });

    expect(res.status).toBe(200);
    expect(db.logCreate).not.toHaveBeenCalled();
  });
});

describe("POST /upload", () => {
  it("503s when Cloudinary is not configured", async () => {
    const res = await request(makeApp())
      .post("/api/tournament-pack/upload")
      .send({ dataUrl: "data:image/png;base64,AAAA" });
    expect(res.status).toBe(503);
  });
});
