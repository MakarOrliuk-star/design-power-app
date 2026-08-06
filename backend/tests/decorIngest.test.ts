import { describe, it, expect, beforeEach, vi } from "vitest";
import sharp from "sharp";

/**
 * Приём и добыча декора (Фаза 3, D-N8'). prisma, Cloudinary и fal замоканы;
 * настоящие — нормализация, sha256-дедуп, нарезка листа и слияние тегов.
 *
 * Главная проверяемая гарантия: библиотека — КЭШ. Первая нарезка листа
 * наполняет библиотеку бренда тегированными записями через тот же приёмник,
 * что и ручная заливка, и повторная заливка того же файла не плодит записей.
 */

const db = vi.hoisted(() => ({
  brand: { findUnique: vi.fn(), update: vi.fn() },
}));
const cloud = vi.hoisted(() => ({
  uploadBuffer: vi.fn(),
  withRetry: vi.fn(),
}));
const fal = vi.hoisted(() => ({
  runPersonFal: vi.fn(),
  runBriaRemoveBg: vi.fn(),
}));
const cache = vi.hoisted(() => ({
  fetchBuffer: vi.fn(),
}));
vi.mock("../src/lib/prisma.js", () => ({ prisma: db }));
vi.mock("../src/lib/cloudinary.js", () => cloud);
vi.mock("../src/lib/fal.js", () => fal);
vi.mock("../src/services/layerCache.js", () => cache);

import {
  ingestDecorBuffer,
  attachEntriesToBrand,
  saveSheetPiecesToBrandLibrary,
  generateDecorSheetPieces,
  SHEET_ATTEMPTS,
} from "../src/services/decorIngest.js";
import { cutDecorSheet, MIN_SHEET_PIECES } from "../src/lib/decorSheet.js";

/** Прозрачный холст с непрозрачными прямоугольниками. */
async function canvasWith(
  w: number,
  h: number,
  rects: Array<{ x: number; y: number; w: number; h: number }>,
  opaqueAll = false,
): Promise<Buffer> {
  const data = Buffer.alloc(w * h * 4, 0);
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const o = (y * w + x) * 4;
        data[o] = 200;
        data[o + 1] = 160;
        data[o + 2] = 40;
        data[o + 3] = 255;
      }
    }
  }
  if (opaqueAll) for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

/** Лист на 8 раздельных объектов — проходит порог MIN_SHEET_PIECES. */
const GOOD_SHEET_RECTS = [
  { x: 20, y: 20, w: 90, h: 90 },
  { x: 160, y: 30, w: 70, h: 70 },
  { x: 290, y: 20, w: 80, h: 60 },
  { x: 430, y: 40, w: 60, h: 80 },
  { x: 30, y: 220, w: 75, h: 65 },
  { x: 180, y: 230, w: 65, h: 75 },
  { x: 320, y: 220, w: 85, h: 55 },
  { x: 460, y: 240, w: 55, h: 55 },
];

beforeEach(() => {
  db.brand.findUnique.mockReset();
  db.brand.update.mockReset();
  cloud.uploadBuffer.mockReset();
  cloud.withRetry.mockReset();
  fal.runPersonFal.mockReset();
  fal.runBriaRemoveBg.mockReset();
  cache.fetchBuffer.mockReset();
  db.brand.findUnique.mockResolvedValue({ id: "br1", decorUrls: null });
  db.brand.update.mockResolvedValue({});
  cloud.withRetry.mockImplementation((fn: () => unknown) => fn());
  let n = 0;
  cloud.uploadBuffer.mockImplementation(async (_buf: Buffer, id: string) => ({
    success: true,
    secure_url: `https://cdn/decor/${id}.png`,
    public_id: id,
  }));
  void n;
});

describe("ingestDecorBuffer — один приёмник на оба пути", () => {
  it("нормализует и грузит с public_id = sha256 нормализованных байтов", async () => {
    const res = await ingestDecorBuffer(await canvasWith(60, 40, [{ x: 8, y: 8, w: 44, h: 24 }]), "a");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.width).toBe(44);
      expect(res.height).toBe(24);
    }
    const [, publicId] = cloud.uploadBuffer.mock.calls[0]!;
    expect(publicId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("альфа-гейт включён по умолчанию: непрозрачный файл отклоняется с причиной", async () => {
    const res = await ingestDecorBuffer(await canvasWith(60, 40, [{ x: 8, y: 8, w: 44, h: 24 }], true), "flat");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("прозрачн");
    expect(cloud.uploadBuffer).not.toHaveBeenCalled();
  });

  it("alphaGate: false — путь кусков листа: плотный кусок без 5 % прозрачности принимается", async () => {
    // Кусок, обрезанный по bbox прямоугольного объекта, прозрачности не имеет.
    const res = await ingestDecorBuffer(await canvasWith(44, 24, [{ x: 0, y: 0, w: 44, h: 24 }], true), "piece", {
      alphaGate: false,
    });
    expect(res.ok).toBe(true);
  });
});

describe("attachEntriesToBrand — слияние тегов, дедуп, потолок", () => {
  it("к строковой библиотеке дописываются тегированные записи, строки не мутируют", async () => {
    db.brand.findUnique.mockResolvedValue({ id: "br1", decorUrls: ["https://cdn/manual.png"] });
    const out = await attachEntriesToBrand("br1", [
      { url: "https://cdn/decor/aa.png", concepts: ["coin"], season: null },
    ]);
    expect(out).toEqual({ brandId: "br1", total: 2, skipped: 0 });
    expect(db.brand.update.mock.calls[0]![0].data.decorUrls).toEqual([
      "https://cdn/manual.png",
      { url: "https://cdn/decor/aa.png", concepts: ["coin"] },
    ]);
  });

  it("повторный URL дополняет теги существующей записи, а не плодит её", async () => {
    db.brand.findUnique.mockResolvedValue({
      id: "br1",
      decorUrls: [{ url: "https://cdn/decor/aa.png", concepts: ["coin"] }],
    });
    const out = await attachEntriesToBrand("br1", [
      { url: "https://cdn/decor/aa.png", concepts: ["spark"], season: null },
    ]);
    expect(out.total).toBe(1);
    expect(db.brand.update.mock.calls[0]![0].data.decorUrls).toEqual([
      { url: "https://cdn/decor/aa.png", concepts: ["coin", "spark"] },
    ]);
  });
});

describe("saveSheetPiecesToBrandLibrary — библиотека как кэш (D-N8')", () => {
  it("куски листа сохраняются с тегами из концептов брифа", async () => {
    const pieces = await cutDecorSheet(await canvasWith(600, 340, GOOD_SHEET_RECTS));
    const out = await saveSheetPiecesToBrandLibrary({
      brandId: "br1",
      pieces,
      concepts: ["coin", "spark"],
      season: "winter",
    });
    expect(out.failed).toBe(0);
    expect(out.saved.length).toBe(pieces.length);
    for (const e of out.saved) {
      expect(e.concepts).toEqual(["coin", "spark"]);
      expect(e.season).toBe("winter");
    }
    const written = db.brand.update.mock.calls[0]![0].data.decorUrls;
    expect(written.length).toBe(pieces.length);
    expect(written[0]).toMatchObject({ concepts: ["coin", "spark"], season: "winter" });
  });
});

describe("generateDecorSheetPieces — шаг [3] цепочки D-N7'", () => {
  it("генерация → BR-фолбэк → нарезка; куски проходят порог MIN_SHEET_PIECES", async () => {
    // Провайдер вернул лист БЕЗ альфы (nano-banana всегда так) → BR вырезал.
    const opaqueSheet = await canvasWith(600, 340, GOOD_SHEET_RECTS, true);
    const alphaSheet = await canvasWith(600, 340, GOOD_SHEET_RECTS);
    fal.runPersonFal.mockResolvedValue({ success: true, imageUrl: "https://fal/sheet.png" });
    fal.runBriaRemoveBg.mockResolvedValue({ success: true, imageUrl: "https://fal/sheet-cut.png" });
    cache.fetchBuffer.mockImplementation(async (url: string) =>
      url === "https://fal/sheet.png" ? opaqueSheet : alphaSheet,
    );

    const res = await generateDecorSheetPieces(["coin", "chip"], "test");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.pieces.length).toBeGreaterThanOrEqual(MIN_SHEET_PIECES);
    expect(fal.runBriaRemoveBg).toHaveBeenCalledWith("https://fal/sheet.png");
    // Промпт листа собран из концептов и контракта.
    const prompt = fal.runPersonFal.mock.calls[0]![0] as string;
    expect(prompt).toContain("coin, chip");
    expect(prompt).toContain("SEPARATE");
  });

  it("лист-обманка (один крупный объект) перегенерируется, а не идёт в кадр", async () => {
    const heroSheet = await canvasWith(600, 340, [{ x: 50, y: 40, w: 400, h: 250 }]);
    const goodSheet = await canvasWith(600, 340, GOOD_SHEET_RECTS);
    fal.runPersonFal.mockResolvedValue({ success: true, imageUrl: "https://fal/sheet.png" });
    cache.fetchBuffer
      .mockResolvedValueOnce(heroSheet) // попытка 1: контракт нарушен
      .mockResolvedValueOnce(goodSheet); // попытка 2: норма

    const res = await generateDecorSheetPieces(["coin"], "test");
    expect(res.ok).toBe(true);
    expect(fal.runPersonFal).toHaveBeenCalledTimes(SHEET_ATTEMPTS);
  });

  it("исчерпание попыток → внятная причина, не исключение", async () => {
    fal.runPersonFal.mockResolvedValue({ success: false, error: "quota" });
    const res = await generateDecorSheetPieces(["coin"], "test");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("quota");
  });

  it("лист без концептов не генерируется — прайм «нарисуй что-нибудь» запрещён", async () => {
    const res = await generateDecorSheetPieces([], "test");
    expect(res.ok).toBe(false);
    expect(fal.runPersonFal).not.toHaveBeenCalled();
  });
});
