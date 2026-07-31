import { describe, it, expect } from "vitest";
import sharp from "sharp";
import {
  buildDecorSheetPrompt,
  cutDecorSheet,
  DECOR_SHEET_CONTRACT,
  MIN_SHEET_PIECES,
  SHEET_MAX_PIECES,
} from "../src/lib/decorSheet.js";

/**
 * Лист декора (Фаза 3, D-N7' шаг 3). Провайдер офлайн недоступен, поэтому
 * проверяется то, что детерминировано: промпт-контракт и нарезка. Живой
 * прогон с генерацией — `scripts/try-decor-sheet.ts`.
 */

/** Прозрачный холст с непрозрачными прямоугольниками — синтетический «лист». */
async function sheetWith(
  w: number,
  h: number,
  rects: Array<{ x: number; y: number; w: number; h: number }>,
): Promise<Buffer> {
  const data = Buffer.alloc(w * h * 4);
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
  return sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

describe("buildDecorSheetPrompt — промпт-контракт листа", () => {
  it("несёт концепты брифа и требования контракта", () => {
    const p = buildDecorSheetPrompt(["coin", "chip", "spark"]);
    expect(p).toContain("coin, chip, spark");
    expect(p).toContain(DECOR_SHEET_CONTRACT);
  });

  it("подчёркивания концептов становятся пробелами: gift_box → gift box", () => {
    expect(buildDecorSheetPrompt(["gift_box"])).toContain("gift box");
  });

  it("детерминирован: те же концепты → тот же промпт", () => {
    expect(buildDecorSheetPrompt(["coin", "star"])).toBe(buildDecorSheetPrompt(["coin", "star"]));
  });

  it("контракт запрещает то, что ломает нарезку и кадр: касания, текст, героя", () => {
    for (const req of ["never touch", "No text", "no characters", "no single dominant hero"]) {
      expect(DECOR_SHEET_CONTRACT).toContain(req);
    }
  });
});

describe("cutDecorSheet — нарезка листа существующей механикой", () => {
  // 8 раздельных объектов разного размера — удачный лист по MIN_SHEET_PIECES.
  const RECTS = [
    { x: 20, y: 20, w: 90, h: 90 },
    { x: 160, y: 30, w: 70, h: 70 },
    { x: 290, y: 20, w: 80, h: 60 },
    { x: 430, y: 40, w: 60, h: 80 },
    { x: 30, y: 220, w: 75, h: 65 },
    { x: 180, y: 230, w: 65, h: 75 },
    { x: 320, y: 220, w: 85, h: 55 },
    { x: 460, y: 240, w: 55, h: 55 },
  ];

  it("раздельные объекты становятся отдельными нормализованными кусками", async () => {
    const pieces = await cutDecorSheet(await sheetWith(600, 340, RECTS));
    expect(pieces.length).toBe(RECTS.length);
    expect(pieces.length).toBeGreaterThanOrEqual(MIN_SHEET_PIECES);
    // Каждый кусок обрезан по своему bbox: размеры совпадают с прямоугольником.
    const sizes = pieces.map((p) => `${p.width}x${p.height}`).sort();
    const expected = RECTS.map((r) => `${r.w}x${r.h}`).sort();
    expect(sizes).toEqual(expected);
    // Крупные первыми — порядок сплиттера сохранён.
    for (let i = 1; i < pieces.length; i++) {
      expect(pieces[i - 1]!.area).toBeGreaterThanOrEqual(pieces[i]!.area);
    }
  });

  it("детерминирована: те же байты листа → те же байты кусков", async () => {
    const sheet = await sheetWith(600, 340, RECTS);
    const a = await cutDecorSheet(sheet);
    const b = await cutDecorSheet(sheet);
    expect(a.map((p) => p.png.toString("base64"))).toEqual(b.map((p) => p.png.toString("base64")));
  });

  it("потолок SHEET_MAX_PIECES соблюдается", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      x: 30 + (i % 5) * 110,
      y: 30 + Math.floor(i / 5) * 110,
      w: 60,
      h: 60,
    }));
    const pieces = await cutDecorSheet(await sheetWith(600, 480, many));
    expect(pieces.length).toBeLessThanOrEqual(SHEET_MAX_PIECES);
    const capped = await cutDecorSheet(await sheetWith(600, 480, many), { maxPieces: 4 });
    expect(capped.length).toBe(4);
  });

  it("лист-обманка с одним крупным объектом даёт меньше MIN_SHEET_PIECES", async () => {
    // Модель проигнорировала контракт и нарисовала «героя» — вызывающий обязан
    // это увидеть по числу кусков и перегенерировать лист.
    const pieces = await cutDecorSheet(await sheetWith(600, 340, [{ x: 50, y: 40, w: 400, h: 250 }]));
    expect(pieces.length).toBeLessThan(MIN_SHEET_PIECES);
  });
});
