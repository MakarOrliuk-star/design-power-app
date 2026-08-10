import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import request from "supertest";

// CRM-админка (TASK ai-reference, DI-R12): пресеты + референсы за
// requireCrmSuper (сам гейт покрыт crmSuper.test.ts — тут он застаблен).
// Multipart-загрузка (formidable + sharp + Cloudinary) в юнитах не гоняется —
// её контракт держат интеграционные прогоны; здесь — list/reorder/delete.
const db = vi.hoisted(() => ({
  neuralPromptPreset: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  variationReference: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    groupBy: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  brand: { findMany: vi.fn() },
  bundleType: { findMany: vi.fn() },
  $transaction: vi.fn(),
}));
const cloud = vi.hoisted(() => ({
  uploadBuffer: vi.fn(),
  deleteAsset: vi.fn(),
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock("../src/lib/prisma.js", () => ({ prisma: db }));
vi.mock("../src/lib/cloudinary.js", () => cloud);

import { crmAdminRouter } from "../src/routes/crmAdmin.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: { sub: string } }).user = { sub: "crm1" };
    next();
  });
  app.use("/api/crm-admin", crmAdminRouter);
  return app;
}

beforeEach(() => {
  for (const delegate of Object.values(db)) {
    if (typeof delegate === "function") (delegate as ReturnType<typeof vi.fn>).mockReset();
    else for (const fn of Object.values(delegate)) (fn as ReturnType<typeof vi.fn>).mockReset();
  }
  cloud.uploadBuffer.mockReset();
  cloud.deleteAsset.mockReset();
  // Форматы референсов (TASK multiformat-promo) берутся из активных типов
  // бандлов: ai_reference включён на email (якорь) и push.
  db.bundleType.findMany.mockResolvedValue([
    {
      assets: [
        { key: "email", label: "Email", width: 1200, height: 600, composeMode: "ai_reference" },
        { key: "push", label: "Push", width: 1024, height: 512, composeMode: "ai_reference" },
        { key: "popup", label: "Pop-up", width: 800, height: 600, composeMode: "layered" },
      ],
    },
  ]);
});

function refRow(i: number) {
  return {
    id: `r${i}`,
    presetId: "p1",
    brandName: "Betnella",
    assetKey: "email",
    imageUrl: `https://cdn/r${i}.png`,
    publicId: `pid${i}`,
    width: 1200,
    height: 600,
    sortOrder: i,
    createdAt: new Date("2026-08-04T10:00:00Z"),
  };
}

describe("prompt-presets (зеркало админки для CRM_SUPER)", () => {
  it("GET отдаёт пресеты в порядке order", async () => {
    db.neuralPromptPreset.findMany.mockResolvedValue([{ id: "p1", title: "VIP" }]);
    const res = await request(makeApp()).get("/api/crm-admin/prompt-presets");
    expect(res.status).toBe(200);
    expect(res.body.presets).toHaveLength(1);
  });

  it("POST валидирует тело и создаёт", async () => {
    const bad = await request(makeApp()).post("/api/crm-admin/prompt-presets").send({ title: "" });
    expect(bad.status).toBe(400);

    db.neuralPromptPreset.create.mockResolvedValue({ id: "p2", title: "VIP", text: "t" });
    const ok = await request(makeApp())
      .post("/api/crm-admin/prompt-presets")
      .send({ title: "VIP", text: "t" });
    expect(ok.status).toBe(201);
    expect(ok.body.preset.id).toBe("p2");
  });

  it("DELETE: 404 на несуществующем", async () => {
    db.neuralPromptPreset.delete.mockRejectedValue(new Error("not found"));
    const res = await request(makeApp()).delete("/api/crm-admin/prompt-presets/ghost");
    expect(res.status).toBe(404);
  });
});

describe("GET /bundle-refs", () => {
  it("400 без presetId/brandName", async () => {
    const res = await request(makeApp()).get("/api/crm-admin/bundle-refs");
    expect(res.status).toBe(400);
  });

  it("отдаёт референсы тройки + вложенные счётчики + лимиты", async () => {
    db.variationReference.findMany.mockResolvedValue([refRow(0), refRow(1)]);
    db.variationReference.groupBy.mockResolvedValue([
      { brandName: "Betnella", assetKey: "email", _count: { _all: 2 } },
      { brandName: "Betnella", assetKey: "push", _count: { _all: 6 } },
    ]);
    const res = await request(makeApp())
      .get("/api/crm-admin/bundle-refs")
      .query({ presetId: "p1", brandName: "Betnella", assetKey: "email" });
    expect(res.status).toBe(200);
    expect(res.body.refs).toHaveLength(2);
    // Выборка идёт по формату (DI2-1): пулы email/push/pop-up раздельные.
    expect(db.variationReference.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { presetId: "p1", brandName: "Betnella", assetKey: "email" } }),
    );
    expect(res.body.counts).toEqual({ Betnella: { email: 2, push: 6 } });
    expect(res.body.limits).toEqual({ min: 5, max: 15 });
  });

  it("без assetKey работает как email — совместимость со старыми клиентами", async () => {
    db.variationReference.findMany.mockResolvedValue([refRow(0)]);
    db.variationReference.groupBy.mockResolvedValue([]);
    await request(makeApp())
      .get("/api/crm-admin/bundle-refs")
      .query({ presetId: "p1", brandName: "Betnella" });
    expect(db.variationReference.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { presetId: "p1", brandName: "Betnella", assetKey: "email" } }),
    );
  });
});

describe("GET /ref-formats (TASK multiformat-promo, DI2-1)", () => {
  it("отдаёт только ai_reference-форматы активных типов и помечает якорь", async () => {
    const res = await request(makeApp()).get("/api/crm-admin/ref-formats");
    expect(res.status).toBe(200);
    expect(res.body.formats).toEqual([
      { key: "email", label: "Email", width: 1200, height: 600, isAnchor: true },
      { key: "push", label: "Push", width: 1024, height: 512, isAnchor: false },
    ]);
    expect(res.body.limits).toEqual({ min: 5, max: 15 });
  });
});

describe("POST /bundle-refs/reorder (порядок = приоритет, DI-R5)", () => {
  it("переставляет sortOrder по индексу и отдаёт свежий список", async () => {
    db.variationReference.findMany
      .mockResolvedValueOnce([refRow(0), refRow(1)]) // проверка полноты списка
      .mockResolvedValueOnce([refRow(1), refRow(0)]); // ответ после транзакции
    db.$transaction.mockResolvedValue([]);
    db.variationReference.update.mockReturnValue({});

    const res = await request(makeApp())
      .post("/api/crm-admin/bundle-refs/reorder")
      .send({ presetId: "p1", brandName: "Betnella", assetKey: "email", ids: ["r1", "r0"] });
    expect(res.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledOnce();
  });

  it("400 при неполном/чужом списке id", async () => {
    db.variationReference.findMany.mockResolvedValue([refRow(0), refRow(1)]);
    const res = await request(makeApp())
      .post("/api/crm-admin/bundle-refs/reorder")
      .send({ presetId: "p1", brandName: "Betnella", assetKey: "email", ids: ["r0"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("ids_mismatch");
  });
});

describe("DELETE /bundle-refs/:id", () => {
  it("удаляет строку БД, затем best-effort чистит Cloudinary", async () => {
    db.variationReference.findUnique.mockResolvedValue(refRow(0));
    db.variationReference.delete.mockResolvedValue({});
    db.variationReference.groupBy.mockResolvedValue([]);
    cloud.deleteAsset.mockResolvedValue({ success: true });

    const res = await request(makeApp()).delete("/api/crm-admin/bundle-refs/r0");
    expect(res.status).toBe(200);
    expect(db.variationReference.delete).toHaveBeenCalledWith({ where: { id: "r0" } });
    expect(cloud.deleteAsset).toHaveBeenCalledWith("pid0");
  });

  it("сбой Cloudinary не ломает ответ (строка БД уже удалена)", async () => {
    db.variationReference.findUnique.mockResolvedValue(refRow(0));
    db.variationReference.delete.mockResolvedValue({});
    db.variationReference.groupBy.mockResolvedValue([]);
    cloud.deleteAsset.mockResolvedValue({ success: false, error: "HTTP 500" });

    const res = await request(makeApp()).delete("/api/crm-admin/bundle-refs/r0");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("404 на несуществующем id", async () => {
    db.variationReference.findUnique.mockResolvedValue(null);
    const res = await request(makeApp()).delete("/api/crm-admin/bundle-refs/ghost");
    expect(res.status).toBe(404);
  });
});
