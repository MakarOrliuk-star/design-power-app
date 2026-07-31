import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import sharp from "sharp";
import { renderScene, STRUCTURAL_CHECK_KEYS, type RenderLayer } from "../src/lib/sceneRenderer.js";
import { buildScenePlan, type ScenePlan } from "../src/services/scenePlan.js";
import { clampCreativeBrief, type CreativeBrief } from "../src/lib/creativeBrief.js";
import { measure, checkAgainstSpec, type PatternSpec } from "../src/lib/patternMiner.js";
import { mineCorpus } from "../scripts/mine-pattern.js";

/**
 * Scene Renderer (Фаза 4). Главный тест фазы: кадр, собранный по плану из
 * СИНТЕТИЧЕСКИХ слоёв, обязан попадать в структурные коридоры добытой спеки —
 * те самые, по которым `result-2` падал (декор, глубина, кадрирование,
 * масштабы кластеров). Метрики света и цвета здесь не проверяются: синтетике
 * нечем их честно заработать, их закрывает живой прогон.
 */

const EXAMPLES = path.resolve(__dirname, "../../figma/crm-bundle/examples");
const CANVAS = { w: 1200, h: 600 };

const STRUCTURAL = STRUCTURAL_CHECK_KEYS;

let spec: PatternSpec;

beforeAll(async () => {
  spec = (await mineCorpus(EXAMPLES)).spec;
}, 120_000);

// ---------------------------------------------------------------------------
// Синтетические слои
// ---------------------------------------------------------------------------

async function blob(
  w: number,
  h: number,
  rgb: [number, number, number],
  shape: "rect" | "ellipse" = "rect",
): Promise<RenderLayer> {
  const data = Buffer.alloc(w * h * 4, 0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (shape === "ellipse") {
        const dx = (x - w / 2) / (w / 2);
        const dy = (y - h / 2) / (h / 2);
        if (dx * dx + dy * dy > 1) continue;
      }
      // Детерминированная фактура: у реального арта резкость несёт
      // ВНУТРЕННЯЯ деталь, а не только контур. Плоская заливка занижала бы
      // дисперсию лапласиана резких кусков и вместе с ней разброс V8.
      // Период 12 px: клетка переживает ресайз куска, но гаснет под блюром.
      const tex = (Math.floor(x / 6) + Math.floor(y / 6)) % 2 === 0 ? 50 : 0;
      const i = (y * w + x) * 4;
      data[i] = Math.min(255, rgb[0] + tex);
      data[i + 1] = Math.min(255, rgb[1] + tex);
      data[i + 2] = Math.min(255, rgb[2] + tex);
      data[i + 3] = 255;
    }
  }
  const png = await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
  return { png, width: w, height: h };
}

function brief(over: Partial<CreativeBrief> = {}): CreativeBrief {
  return clampCreativeBrief(
    {
      offer: { kind: "reload", headline: null, amount: null, extras: [], cta: null },
      mood: "celebration",
      season: null,
      decorConcepts: ["coin", "spark", "star"],
      paletteHint: "gold",
      lightMood: "bright warm golden burst",
      captions: [],
      confidence: { offer: 0.9, scene: 0.8 },
      ...over,
    },
    { campaignPrompt: "" },
  );
}

async function layers() {
  return {
    // Поясной персонаж: вытянутый эллипс, аспект ~0.53 — как реальный
    // waist-up кроп; синтетика уже поясная, cropTopFraction не передаётся.
    person: await blob(160, 300, [180, 60, 60], "ellipse"),
    // Item по контракту слоя: портретный 2:3.
    item: await blob(200, 300, [60, 120, 200], "ellipse"),
    light: null,
    decor: [
      await blob(120, 120, [230, 190, 60], "ellipse"),
      await blob(90, 90, [230, 190, 60], "ellipse"),
      await blob(80, 100, [200, 80, 160], "rect"),
      await blob(110, 70, [90, 200, 120], "rect"),
      await blob(100, 100, [240, 240, 240], "ellipse"),
      await blob(70, 90, [250, 150, 60], "rect"),
    ],
  };
}

function plan(seed = "probe-1"): ScenePlan {
  return buildScenePlan({ brief: brief(), patternSpec: spec, seed, canvas: CANVAS });
}

describe("renderScene — кадр попадает в структурные коридоры спеки", () => {
  it("все структурные проверки проходят на синтетических слоях", async () => {
    const rendered = await renderScene(plan(), await layers());
    const { metrics } = await measure(rendered.png);
    const report = checkAgainstSpec(metrics, spec, STRUCTURAL);
    const failed = report.checks.filter((c) => !c.passed).map((c) => `${c.key}: ${c.detail}`);
    expect(failed, failed.join("\n")).toEqual([]);
  }, 60_000);

  it("детерминирован: тот же план и слои → побайтово тот же кадр", async () => {
    const l = await layers();
    const a = await renderScene(plan("seed-d"), l);
    const b = await renderScene(plan("seed-d"), l);
    expect(a.png.equals(b.png)).toBe(true);
  }, 60_000);

  it("другой seed — другая раскладка декора, но каркас на месте", async () => {
    const l = await layers();
    const a = await renderScene(plan("seed-x"), l);
    const b = await renderScene(plan("seed-y"), l);
    expect(a.png.equals(b.png)).toBe(false);
    for (const r of [a, b]) {
      const { metrics } = await measure(r.png);
      // Каркас: item слева на 84+ %, person справа, центр защищён.
      expect(metrics.itemClusterHeightPct).toBeGreaterThan(80);
      expect(metrics.personClusterHeightPct).toBeGreaterThan(75);
      expect(metrics.bandMidThird).toBeLessThan(3);
    }
  }, 60_000);

  it("глубина честная: разброс резкости декора ≥ 10×, как требует V8", async () => {
    const rendered = await renderScene(plan(), await layers());
    const { metrics } = await measure(rendered.png);
    expect(metrics.sharpnessSpread).toBeGreaterThanOrEqual(10);
  }, 60_000);

  it("ровно то, на чём упал result-2: фон-дыра заменена сценой", async () => {
    // Контрольная сверка с диагнозом §3.3: у result-2 декор 2 объекта/0.16 %,
    // разброс 1.33, ноль подрезок верхом. У рендера — коридорные значения.
    const rendered = await renderScene(plan(), await layers());
    const { metrics } = await measure(rendered.png);
    expect(metrics.decorCount).toBeGreaterThanOrEqual(7);
    expect(metrics.decorAreaPct).toBeGreaterThan(4);
    expect(metrics.croppedTop).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
