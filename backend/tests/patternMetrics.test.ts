import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  bandCoveragePct,
  bandObjectCount,
  centerAlpha,
  connectedComponents,
  cornerAlphaMax,
  croppedByEdgeCount,
  dominantHueCount,
  loadRaster,
} from "../src/lib/patternMetrics.js";
import { EMAIL_HERO_V3 } from "../src/services/layoutSpec.js";

/**
 * ГЛАВНЫЙ ПРИЁМОЧНЫЙ ТЕСТ ФАЗЫ 4 (TASK §6): пороги паттерна обязаны
 * пропускать ВСЕ ПЯТЬ работ дизайнеров без ложных срабатываний и браковать
 * текущий автогенерат `result.png`.
 *
 * Тест ходит в `figma/crm-bundle/examples`. Если каталога нет (чужая машина,
 * урезанный чекаут) — проверки пропускаются, а не падают: эталоны лежат в
 * репозитории, но их отсутствие не должно ломать чужую сборку.
 */
const EXAMPLES = path.resolve(__dirname, "../../figma/crm-bundle/examples");
const REFS = ["1.jfif", "2.jfif", "3.jfif", "4.jfif", "5.jfif"];
const haveExamples = existsSync(path.join(EXAMPLES, REFS[0]!));

const scatter = EMAIL_HERO_V3.scatter!;
const core = EMAIL_HERO_V3.safe!.levels!.core;
const validation = EMAIL_HERO_V3.validation!;

async function metricsOf(file: string) {
  const raster = await loadRaster(readFileSync(path.join(EXAMPLES, file)));
  const comps = connectedComponents(raster);
  return {
    coverage: bandCoveragePct(raster, scatter.band.x, scatter.band.w),
    objects: bandObjectCount(comps, raster, scatter.band.x, scatter.band.w),
    core: bandCoveragePct(raster, core.x, core.w),
    cropped: croppedByEdgeCount(comps),
    hues: dominantHueCount(raster),
  };
}

describe.skipIf(!haveExamples)("пороги паттерна пропускают эталоны дизайнеров", () => {
  it.each(REFS)("%s проходит все коридоры спеки", async (file) => {
    const m = await metricsOf(file);
    // V4 — покрытие декором полосы 25–72%.
    expect(m.coverage).toBeGreaterThanOrEqual(scatter.targetCoveragePct[0]);
    expect(m.coverage).toBeLessThanOrEqual(scatter.targetCoveragePct[1]);
    // V5 — число объектов в той же полосе.
    expect(m.objects).toBeGreaterThanOrEqual(scatter.targetObjectCount[0]);
    expect(m.objects).toBeLessThanOrEqual(scatter.targetObjectCount[1]);
    // V6 — ядро 40–60% почти пусто.
    expect(m.core).toBeLessThanOrEqual(core.maxCoverage * 100);
    // V7 — bleed.
    expect(m.cropped).toBeGreaterThanOrEqual(validation.minCroppedByEdge!);
    // V12 — цветовой ключ.
    expect(m.hues).toBeLessThanOrEqual(validation.maxHues!);
  });
});

// result.png — исторический автогенерат Фазы 0. Файлы в figma/ вне git и
// принадлежат заказчику: эталоны на месте, а result.png может быть заменён
// свежими прогонами (result-2.png и далее) — скипаемся, а не падаем.
const haveResult = existsSync(path.join(EXAMPLES, "result.png"));

describe.skipIf(!haveExamples || !haveResult)("те же пороги бракуют текущий автогенерат", () => {
  it("result.png проваливает V4, V5 и V7 — ровно те дефекты, что описаны в TASK §2.3", async () => {
    const m = await metricsOf("result.png");
    expect(m.coverage).toBeLessThan(scatter.targetCoveragePct[0]); // декора нет
    expect(m.objects).toBeLessThan(scatter.targetObjectCount[0]);
    expect(m.cropped).toBeLessThan(validation.minCroppedByEdge!); // ничего не подрезано
  });
});

describe("dominantHueCount (V12, приём П8)", () => {
  async function swatch(colors: Array<[number, number, number]>): Promise<Buffer> {
    const w = 60 * colors.length;
    const data = Buffer.alloc(w * 60 * 4);
    colors.forEach((c, i) => {
      for (let y = 0; y < 60; y++) {
        for (let x = i * 60; x < (i + 1) * 60; x++) {
          const o = (y * w + x) * 4;
          data[o] = c[0];
          data[o + 1] = c[1];
          data[o + 2] = c[2];
          data[o + 3] = 255;
        }
      }
    });
    return sharp(data, { raw: { width: w, height: 60, channels: 4 } }).png().toBuffer();
  }

  it("считает один оттенок для монохромного кадра", async () => {
    const r = await loadRaster(await swatch([[220, 170, 40]]));
    expect(dominantHueCount(r)).toBe(1);
  });

  it("различает три далёких оттенка", async () => {
    const r = await loadRaster(
      await swatch([
        [220, 40, 40],
        [40, 220, 40],
        [40, 40, 220],
      ]),
    );
    expect(dominantHueCount(r)).toBe(3);
  });

  it("не считает оттенком тени и блики", async () => {
    // Градиент одного золота от тёмного к светлому — это ОДИН цвет, а не три.
    const r = await loadRaster(
      await swatch([
        [90, 70, 16],
        [200, 155, 36],
        [255, 225, 140],
      ]),
    );
    expect(dominantHueCount(r)).toBeLessThanOrEqual(2);
  });
});

describe("метрики плашки (V2′)", () => {
  it("отличают плашку с прозрачными углами от залитого фона", async () => {
    const plate = await loadRaster(
      await sharp({
        create: { width: 100, height: 100, channels: 4, background: { r: 255, g: 200, b: 160, alpha: 0 } },
      })
        .png()
        .toBuffer(),
    );
    expect(cornerAlphaMax(plate)).toBe(0);
    expect(centerAlpha(plate, 0.15)).toBe(0);

    const filled = await loadRaster(
      await sharp({
        create: { width: 100, height: 100, channels: 4, background: { r: 20, g: 20, b: 20, alpha: 1 } },
      })
        .png()
        .toBuffer(),
    );
    // Непрозрачный фон — это то, что D-E5 запрещает: углы залиты.
    expect(cornerAlphaMax(filled)).toBe(255);
  });
});
