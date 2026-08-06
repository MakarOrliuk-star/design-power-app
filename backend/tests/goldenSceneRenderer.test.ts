import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { renderScene, type RenderLayer } from "../src/lib/sceneRenderer.js";
import { buildScenePlan } from "../src/services/scenePlan.js";
import { clampCreativeBrief, type CreativeBrief } from "../src/lib/creativeBrief.js";
import { ssim } from "../src/lib/assetValidator.js";
import { mineCorpus } from "../scripts/mine-pattern.js";
import type { PatternSpec } from "../src/lib/patternMiner.js";

/**
 * Фаза 7 (Задание 3) — golden-регресс scene-рендерера (TASK §6 «Golden-набор
 * в репозитории + регресс на структурное совпадение»). Детерминированный
 * рендер по scene-plan на фиксированных синтетических слоях сверяется с
 * закоммиченным golden-композитом по SSIM.
 *
 * Ловит дрейф, который юнит-тесты на коридоры не видят: раскладка внутри
 * коридора, блюр глубины, виньетка углов, перекраска П8 — после правок
 * рендерера или бампа sharp/libvips (риск R4). Порог 0.995 — структурное
 * равенство с допуском на монтаж библиотеки.
 *
 * Обновить эталон осознанно:
 *   UPDATE_GOLDEN=1 npx vitest run tests/goldenSceneRenderer.test.ts
 */

const GOLDEN_DIR = path.resolve(__dirname, "golden");
const GOLDEN_FILE = path.join(GOLDEN_DIR, "scene-renderer-v1.golden.png");
const EXAMPLES = path.resolve(__dirname, "../../figma/crm-bundle/examples");

let spec: PatternSpec;

beforeAll(async () => {
  spec = (await mineCorpus(EXAMPLES)).spec;
}, 120_000);

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

function goldenBrief(): CreativeBrief {
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
    },
    { campaignPrompt: "" },
  );
}

async function renderGoldenScene(): Promise<Buffer> {
  const plan = buildScenePlan({
    brief: goldenBrief(),
    patternSpec: spec,
    seed: "golden-scene-v1",
    canvas: { w: 1200, h: 600 },
  });
  const rendered = await renderScene(plan, {
    person: await blob(160, 300, [190, 90, 60], "ellipse"),
    item: await blob(200, 300, [210, 150, 60], "ellipse"),
    light: null, // слой света — генерация, в golden не входит (машинонезависимость)
    decor: [
      await blob(120, 120, [230, 190, 60], "ellipse"),
      await blob(90, 90, [230, 190, 60], "ellipse"),
      await blob(80, 100, [200, 80, 160], "rect"),
      await blob(110, 70, [90, 200, 120], "rect"),
      await blob(100, 100, [240, 240, 240], "ellipse"),
      await blob(70, 90, [250, 150, 60], "rect"),
    ],
  });
  return rendered.png;
}

describe("golden-регресс scene-рендерера (Задание 3)", () => {
  it("рендер структурно совпадает с закоммиченным golden (SSIM ≥ 0.995)", async () => {
    const current = await renderGoldenScene();

    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(GOLDEN_FILE)) {
      mkdirSync(GOLDEN_DIR, { recursive: true });
      writeFileSync(GOLDEN_FILE, current);
      console.warn(`🟡 golden записан: ${GOLDEN_FILE} — закоммить его в репозиторий`);
      return;
    }

    const golden = readFileSync(GOLDEN_FILE);
    const [gm, cm] = await Promise.all([sharp(golden).metadata(), sharp(current).metadata()]);
    expect(`${cm.width}×${cm.height}`).toBe(`${gm.width}×${gm.height}`);

    const value = await ssim(current, golden);
    expect(
      value,
      `SSIM ${value.toFixed(4)} < 0.995 — раскладка/глубина/виньетка сцены уехали. ` +
        `Если изменение НАМЕРЕННОЕ (правка рендерера/спеки) — перегенерируй эталон: ` +
        `UPDATE_GOLDEN=1 npx vitest run tests/goldenSceneRenderer.test.ts и закоммить файл.`,
    ).toBeGreaterThanOrEqual(0.995);
  }, 60_000);
});
