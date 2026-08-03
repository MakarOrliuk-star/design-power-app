import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import path from "node:path";
import { readFileSync } from "node:fs";

/**
 * Админ-роут pattern-спек (Задание 3): майнер по загруженному корпусу →
 * публикация в БД. prisma замокан; сам майнер НАСТОЯЩИЙ и работает на
 * реальных эталонах — тест проверяет, что из админки добываются те же
 * коридоры, что из CLI, а не что ручки дёргаются.
 */

const db = vi.hoisted(() => ({
  patternSpec: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
}));
vi.mock("../src/lib/prisma.js", () => ({ prisma: db }));

import { patternSpecAdminRouter, MIN_CORPUS_FILES } from "../src/routes/patternSpecAdmin.js";

const EXAMPLES = path.resolve(__dirname, "../../figma/crm-bundle/examples");
const REFS = ["1.jfif", "2.jfif", "3.jfif", "4.jfif", "5.jfif"];

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/pattern-specs", patternSpecAdminRouter);
  return app;
}

beforeEach(() => {
  for (const fn of Object.values(db.patternSpec)) fn.mockReset();
  db.patternSpec.findMany.mockResolvedValue([]);
  db.patternSpec.findFirst.mockResolvedValue(null); // дедуп по corpusHash: пусто
  db.patternSpec.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "ps1",
    createdAt: new Date("2026-07-31"),
    isActive: true,
    createdBy: null,
    ...data,
  }));
});

describe("POST /api/admin/pattern-specs/mine", () => {
  it("корпус эталонов → добытая спека публикуется активной, коридоры в ответе", async () => {
    const req = request(makeApp()).post("/api/admin/pattern-specs/mine").field("key", "pattern.email");
    // .jfif не мапится в image/* автоматически — тип задаётся явно, как это
    // делает браузер при загрузке из админки.
    for (const name of REFS)
      req.attach("files", readFileSync(path.join(EXAMPLES, name)), {
        filename: name,
        contentType: "image/jpeg",
      });
    const res = await req;

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.spec.key).toBe("pattern.email");
    expect(res.body.spec.version).toBe(1);
    expect(res.body.spec.corpus).toEqual(REFS);
    // Спека в БД — та же, что у CLI: версия методики и полный набор коридоров.
    const written = db.patternSpec.create.mock.calls[0]![0].data;
    expect(written.spec.specVersion).toBe("pattern.email.v1");
    expect(Object.keys(written.spec.corridors).length).toBeGreaterThan(15);
    // Контрольная сверка добычи: высота item-кластера — floor от ~80 (§3.2).
    const item = res.body.corridors.find((c: { key: string }) => c.key === "itemClusterHeightPct");
    expect(item.direction).toBe("floor");
    expect(item.lo).toBeGreaterThan(75);
    expect(item.hi).toBeNull();
  }, 120_000);

  it("тот же корпус не плодит версии — возвращается существующая (200)", async () => {
    db.patternSpec.findFirst.mockResolvedValue({
      id: "ps1",
      key: "pattern.email",
      version: 3,
      spec: { corpus: REFS, corridors: {} },
      corpusHash: "same",
      isActive: true,
      createdAt: new Date("2026-07-30"),
      createdBy: null,
    });
    const req = request(makeApp()).post("/api/admin/pattern-specs/mine");
    for (const name of REFS)
      req.attach("files", readFileSync(path.join(EXAMPLES, name)), {
        filename: name,
        contentType: "image/jpeg",
      });
    const res = await req;
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.created).toBe(false);
    expect(res.body.spec.version).toBe(3);
    expect(db.patternSpec.create).not.toHaveBeenCalled();
  }, 120_000);

  it("корпус меньше минимума отклоняется с подсказкой", async () => {
    const res = await request(makeApp())
      .post("/api/admin/pattern-specs/mine")
      .attach("files", readFileSync(path.join(EXAMPLES, "1.jfif")), "1.jfif");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("corpus_too_small");
    expect(res.body.hint).toContain(String(MIN_CORPUS_FILES));
  }, 60_000);

  it("неизвестный ключ отклоняется", async () => {
    const req = request(makeApp()).post("/api/admin/pattern-specs/mine").field("key", "pattern.banner");
    for (const name of REFS.slice(0, 2)) req.attach("files", readFileSync(path.join(EXAMPLES, name)), name);
    const res = await req;
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_key");
  }, 60_000);
});

describe("GET / и PATCH /:id", () => {
  it("список версий — со сводкой, без тела коридоров", async () => {
    db.patternSpec.findMany.mockResolvedValue([
      {
        id: "ps1",
        key: "pattern.email",
        version: 1,
        spec: { corpus: REFS, corridors: { a: {}, b: {} } },
        corpusHash: "abcdef0123456789deadbeef",
        isActive: true,
        createdAt: new Date("2026-07-31"),
        createdBy: "admin@x",
      },
    ]);
    const res = await request(makeApp()).get("/api/admin/pattern-specs");
    expect(res.status).toBe(200);
    expect(res.body.specs[0]).toMatchObject({
      key: "pattern.email",
      version: 1,
      corpus: REFS,
      corridorCount: 2,
      corpusHash: "abcdef0123456789",
      isActive: true,
    });
    expect(res.body.specs[0].spec).toBeUndefined();
  });

  it("PATCH переключает isActive", async () => {
    db.patternSpec.findUnique.mockResolvedValue({ id: "ps1", key: "pattern.email", version: 1 });
    db.patternSpec.update.mockResolvedValue({});
    const res = await request(makeApp())
      .patch("/api/admin/pattern-specs/ps1")
      .send({ isActive: false });
    expect(res.status).toBe(200);
    expect(db.patternSpec.update).toHaveBeenCalledWith({
      where: { id: "ps1" },
      data: { isActive: false },
    });
  });
});
