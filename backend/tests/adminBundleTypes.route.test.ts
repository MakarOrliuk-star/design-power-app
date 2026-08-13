import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Валидация настроек формата в /api/admin/bundle-types (TASK
 * glow-fade-density, DI3-14/DI3-15). `BundleType.assets` — колонка Json, и
 * единственный контроль качества этих данных — zod-схема маршрута: ошибка
 * здесь уехала бы в промпт генерации молча.
 */
const db = vi.hoisted(() => ({
  bundleType: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
}));
vi.mock("../src/lib/prisma.js", () => ({ prisma: db }));
vi.mock("../src/lib/cloudinary.js", () => ({
  uploadBase64: vi.fn(),
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));

import { adminRouter } from "../src/routes/admin.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminRouter);
  return app;
}

const ASSET = { key: "popup", label: "Pop-up", width: 800, height: 600 };

beforeEach(() => {
  db.bundleType.update.mockReset();
  db.bundleType.update.mockResolvedValue({ id: "bt1", assets: [] });
});

describe("PATCH /api/admin/bundle-types/:id — эффекты и плотность", () => {
  it("сохраняет галки эффектов и лимит предметов", async () => {
    const assets = [
      {
        ...ASSET,
        composeMode: "ai_reference",
        effects: { glow: true, fade: false },
        maxProps: 12,
      },
    ];
    const res = await request(makeApp()).patch("/api/admin/bundle-types/bt1").send({ assets });
    expect(res.status).toBe(200);
    expect(db.bundleType.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "bt1" }, data: { assets } }),
    );
  });

  it("поля необязательны — прежние записи без них проходят как раньше", async () => {
    const res = await request(makeApp())
      .patch("/api/admin/bundle-types/bt1")
      .send({ assets: [ASSET] });
    expect(res.status).toBe(200);
  });

  it("лимит предметов вне коридора 8–24 отклоняется", async () => {
    for (const maxProps of [0, 7, 25, 10.5]) {
      const res = await request(makeApp())
        .patch("/api/admin/bundle-types/bt1")
        .send({ assets: [{ ...ASSET, maxProps }] });
      expect(res.status, `maxProps=${maxProps}`).toBe(400);
      expect(res.body.error).toBe("invalid_body");
    }
    expect(db.bundleType.update).not.toHaveBeenCalled();
  });

  it("эффекты не-boolean отклоняются", async () => {
    const res = await request(makeApp())
      .patch("/api/admin/bundle-types/bt1")
      .send({ assets: [{ ...ASSET, effects: { glow: "yes" } }] });
    expect(res.status).toBe(400);
  });
});
