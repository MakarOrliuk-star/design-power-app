import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import sharp from "sharp";

// Роут библиотеки декора (Задание 2, Фаза 2; DV-C1/DV-C2). prisma и Cloudinary
// замоканы, приёмка файла (альфа, нормализация, дедуп) работает по-настоящему —
// именно она решает, попадёт ли на баннер прямоугольная плашка вместо вырезки.
const db = vi.hoisted(() => ({
  bundleType: {
    findMany: vi.fn(),
    update: vi.fn(),
  },
}));
const cloud = vi.hoisted(() => ({
  uploadBuffer: vi.fn(),
  withRetry: vi.fn(),
}));
vi.mock("../src/env.js", () => ({
  JWT_SECRET: "test-secret-key",
  cloudinaryConfigured: true,
  personPipelineReady: true,
}));
vi.mock("../src/lib/prisma.js", () => ({ prisma: db }));
vi.mock("../src/lib/cloudinary.js", () => cloud);

import { decorRouter, MAX_DECOR_PER_SLOT } from "../src/routes/decor.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/decor", decorRouter);
  return app;
}

/** PNG w×h с непрозрачным прямоугольником и прозрачными полями. */
async function cutout(w = 60, h = 40, opaque = true): Promise<Buffer> {
  const data = Buffer.alloc(w * h * 4, 0);
  for (let y = 8; y < h - 8; y++) {
    for (let x = 8; x < w - 8; x++) {
      const i = (y * w + x) * 4;
      data[i] = 220;
      data[i + 1] = 180;
      data[i + 2] = 60;
      data[i + 3] = 255;
    }
  }
  if (opaque) {
    // Заливаем всё — альфа-канал есть, но ничего не вырезает.
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
  }
  return sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

const slots = () => [
  {
    id: "bt1",
    key: "simple_sendout",
    assets: [
      { key: "email", label: "Email", width: 1200, height: 600 },
      { key: "push", label: "Push", width: 1024, height: 512, decorUrls: ["https://cdn/x.png"] },
    ],
  },
];

beforeEach(() => {
  db.bundleType.findMany.mockReset();
  db.bundleType.update.mockReset();
  cloud.uploadBuffer.mockReset();
  cloud.withRetry.mockReset();
  db.bundleType.findMany.mockResolvedValue(slots());
  db.bundleType.update.mockResolvedValue({});
  cloud.withRetry.mockImplementation((fn: () => unknown) => fn());
  cloud.uploadBuffer.mockResolvedValue({
    success: true,
    secure_url: "https://cdn/decor/abc.png",
    public_id: "abc",
  });
});

describe("GET /api/admin/decor", () => {
  it("lists every asset slot with its current decor", async () => {
    const res = await request(makeApp()).get("/api/admin/decor");
    expect(res.status).toBe(200);
    expect(res.body.slots).toHaveLength(2);
    expect(res.body.slots[0]).toMatchObject({ assetKey: "email", decorUrls: [] });
    expect(res.body.slots[1]).toMatchObject({ assetKey: "push", decorUrls: ["https://cdn/x.png"] });
    expect(res.body.limits.perSlot).toBe(MAX_DECOR_PER_SLOT);
  });
});

describe("POST /api/admin/decor", () => {
  it("accepts a transparent cutout and attaches it to the chosen slot", async () => {
    const res = await request(makeApp())
      .post("/api/admin/decor")
      .field("assetKeys", JSON.stringify(["email"]))
      .attach("files", await cutout(60, 40, false), "coin.png");

    expect(res.status).toBe(201);
    expect(res.body.results[0]).toMatchObject({ name: "coin.png", ok: true });
    expect(res.body.results[0].url).toBe("https://cdn/decor/abc.png");
    // Нормализация обрезала прозрачные поля: 60×40 с полями по 8 → 44×24.
    expect(res.body.results[0].width).toBe(44);
    expect(res.body.results[0].height).toBe(24);
    expect(db.bundleType.update).toHaveBeenCalledOnce();
  });

  it("rejects a file without real transparency and says what to do", async () => {
    const res = await request(makeApp())
      .post("/api/admin/decor")
      .field("assetKeys", JSON.stringify(["email"]))
      .attach("files", await cutout(60, 40, true), "flat.png");

    expect(res.status).toBe(201); // пофайловый отчёт, а не 4xx на всю пачку
    expect(res.body.results[0].ok).toBe(false);
    expect(res.body.results[0].reason).toContain("прозрачн");
    expect(cloud.uploadBuffer).not.toHaveBeenCalled();
    expect(db.bundleType.update).not.toHaveBeenCalled();
  });

  it("reports per-file so one bad asset does not sink the batch", async () => {
    const res = await request(makeApp())
      .post("/api/admin/decor")
      .field("assetKeys", JSON.stringify(["email"]))
      .attach("files", await cutout(60, 40, false), "good.png")
      .attach("files", await cutout(50, 50, true), "bad.png");

    expect(res.status).toBe(201);
    expect(res.body.results.filter((r: { ok: boolean }) => r.ok)).toHaveLength(1);
    expect(res.body.results.filter((r: { ok: boolean }) => !r.ok)).toHaveLength(1);
  });

  it("derives the public id from the normalized bytes — same file, same asset", async () => {
    const app = makeApp();
    const png = await cutout(60, 40, false);
    await request(app)
      .post("/api/admin/decor")
      .field("assetKeys", JSON.stringify(["email"]))
      .attach("files", png, "a.png");
    await request(app)
      .post("/api/admin/decor")
      .field("assetKeys", JSON.stringify(["email"]))
      .attach("files", png, "renamed.png");

    const firstId = cloud.uploadBuffer.mock.calls[0]![1];
    const secondId = cloud.uploadBuffer.mock.calls[1]![1];
    expect(firstId).toBe(secondId); // переименование не плодит дубль
  });

  it("does not append the same url twice", async () => {
    db.bundleType.findMany.mockResolvedValue([
      {
        id: "bt1",
        key: "simple_sendout",
        assets: [{ key: "email", label: "Email", decorUrls: ["https://cdn/decor/abc.png"] }],
      },
    ]);
    const res = await request(makeApp())
      .post("/api/admin/decor")
      .field("assetKeys", JSON.stringify(["email"]))
      .attach("files", await cutout(60, 40, false), "again.png");

    expect(res.status).toBe(201);
    const written = db.bundleType.update.mock.calls[0]![0].data.assets;
    expect(written[0].decorUrls).toEqual(["https://cdn/decor/abc.png"]);
  });

  it("rejects a malformed assetKeys field with a usable hint", async () => {
    const res = await request(makeApp())
      .post("/api/admin/decor")
      .field("assetKeys", "email")
      .attach("files", await cutout(60, 40, false), "coin.png");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_asset_keys");
    expect(res.body.hint).toContain("JSON");
  });

  it("400s when no file survived the mime filter", async () => {
    const res = await request(makeApp())
      .post("/api/admin/decor")
      .field("assetKeys", JSON.stringify(["email"]));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("no_files");
  });
});

describe("DELETE /api/admin/decor", () => {
  it("detaches a url from the given slot only", async () => {
    const res = await request(makeApp())
      .delete("/api/admin/decor")
      .send({ assetKey: "push", url: "https://cdn/x.png" });

    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(1);
    const written = db.bundleType.update.mock.calls[0]![0].data.assets;
    expect(written.find((a: { key: string }) => a.key === "push").decorUrls).toEqual([]);
  });

  it("is a no-op for a url that is not attached", async () => {
    const res = await request(makeApp())
      .delete("/api/admin/decor")
      .send({ assetKey: "push", url: "https://cdn/nope.png" });
    expect(res.body.removed).toBe(0);
    expect(db.bundleType.update).not.toHaveBeenCalled();
  });
});
