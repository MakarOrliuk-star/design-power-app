import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { validateComposedAsset, personLayerSanity, ssim } from "../src/lib/assetValidator.js";
import type { ValidateInputs } from "../src/lib/assetValidator.js";
import type { AssetMetadata, EngineLayer } from "../src/lib/composeEngine.js";
import { composeAsset } from "../src/lib/composeEngine.js";
import { EMAIL_HERO_V1, EMAIL_HERO_V3, PUSH_HERO_V1 } from "../src/services/layoutSpec.js";

/** Непрозрачный слой заданного размера — заменитель вырезки. */
async function solidLayer(
  w: number,
  h: number,
  rgba: [number, number, number, number],
): Promise<EngineLayer> {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = rgba[0];
    data[i * 4 + 1] = rgba[1];
    data[i * 4 + 2] = rgba[2];
    data[i * 4 + 3] = rgba[3];
  }
  const png = await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
  return { data: png, width: w, height: h };
}

/**
 * Phase 4 DoD: every defect class from the Phase 0 «как есть» artifacts must
 * be caught, and the reference-grade assembly must NOT trigger false alarms.
 * Defect sources: bad_result_email.jfif (small floating dog, vertically
 * centered item, пёстрый gold background), как сейчас генерирует.PNG
 * (1206×606 canvas, cluster crossing into the protected center).
 */

const spec = EMAIL_HERO_V1;
const W = 1200;
const H = 600;

interface Paint {
  x: number;
  y: number;
  w: number;
  h: number;
}
async function makeMask(paints: Paint[]): Promise<Buffer> {
  const data = Buffer.alloc(W * H * 4, 0);
  for (const p of paints) {
    for (let y = p.y; y < Math.min(H, p.y + p.h); y++)
      for (let x = p.x; x < Math.min(W, p.x + p.w); x++) {
        const i = (y * W + x) * 4;
        data[i] = 200;
        data[i + 3] = 255;
      }
  }
  return sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
}

async function grayPng(w: number, h: number, l = 230): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: l, g: l, b: l } } })
    .png()
    .toBuffer();
}

// Reference-grade fixture: person 240×480 bottom-right on the baseline,
// item 240×372 centered in the left quarter, both feet at 0.92·H = 552.
const goodPerson = { x: 940, y: 72, w: 240, h: 480 };
const goodItem = { x: 30, y: 180, w: 240, h: 372 };
function goodMetadata(): AssetMetadata {
  return {
    specKey: "email.hero",
    specVersion: 1,
    seed: "s",
    canvas: { w: W, h: H },
    safeZonePct: { x: 25, y: 4, w: 50, h: 92 },
    luminance: 0.784,
    luminanceStd: 0.03,
    textContrast: { white: 1.26, dark: 15 },
    recommendedTextColor: "#111111",
    layers: { person: goodPerson, item: goodItem, decorPlaced: 0, decorSkipped: 0 },
  };
}

async function goodInputs(): Promise<ValidateInputs> {
  return {
    scales: [
      { scale: 1, width: W, height: H, png: await grayPng(W, H) },
      { scale: 2, width: W * 2, height: H * 2, png: await grayPng(W * 2, H * 2) },
    ],
    metadata: goodMetadata(),
    overlayMask: await makeMask([goodPerson, goodItem]),
  };
}

describe("validateComposedAsset — эталонная сборка", () => {
  it("passes with zero false alarms (DoD)", async () => {
    const report = await validateComposedAsset(spec, await goodInputs());
    expect(report.failedKeys).toEqual([]);
    expect(report.passed).toBe(true);
    // All six check families ran.
    const keys = report.checks.map((c) => c.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "size@1x",
        "size@2x",
        "safe-core-clean",
        "safe-coverage",
        "person-position",
        "person-scale",
        "item-position",
        "item-scale",
        "readability",
      ]),
    );
  });
});

describe("validateComposedAsset — дефекты Фазы 0", () => {
  it("catches the wrong canvas (current_gen: 1206×606)", async () => {
    const inputs = await goodInputs();
    inputs.scales[0] = { scale: 1, width: 1206, height: 606, png: await grayPng(1206, 606) };
    const report = await validateComposedAsset(spec, inputs);
    expect(report.failedKeys).toContain("size@1x");
  });

  it("catches graphics inside the text envelopes (current_gen: cluster crossing 25%)", async () => {
    const inputs = await goodInputs();
    // Item cluster bleeding into the offer envelope (x ≥ 312).
    inputs.overlayMask = await makeMask([goodPerson, { ...goodItem, w: 440 }]);
    const report = await validateComposedAsset(spec, inputs);
    expect(report.failedKeys).toContain("safe-core-clean");
  });

  it("catches over-coverage of the safe zone even outside the envelopes", async () => {
    const inputs = await goodInputs();
    // Two solid strips in the top decor band AROUND the "UP TO" envelope
    // (x 480–720): ≈15% of the safe zone covered — over the 10% budget.
    inputs.overlayMask = await makeMask([
      goodPerson,
      goodItem,
      { x: 300, y: 0, w: 170, h: 144 },
      { x: 730, y: 0, w: 170, h: 144 },
    ]);
    const report = await validateComposedAsset(spec, inputs);
    expect(report.failedKeys).toContain("safe-coverage");
    expect(report.failedKeys).not.toContain("safe-core-clean");
  });

  it("catches the undersized person (bad_result: пёс 53% высоты)", async () => {
    const inputs = await goodInputs();
    inputs.metadata.layers.person = { x: 940, y: 234, w: 160, h: 318 }; // 53% H, on baseline
    const report = await validateComposedAsset(spec, inputs);
    expect(report.failedKeys).toContain("person-scale");
    expect(report.failedKeys).not.toContain("person-position");
  });

  it("catches the floating item (bad_result: вертикальный центр вместо линии)", async () => {
    const inputs = await goodInputs();
    inputs.metadata.layers.item = { x: 30, y: 114, w: 240, h: 372 }; // bottom at 486 ≠ 552
    const report = await validateComposedAsset(spec, inputs);
    expect(report.failedKeys).toContain("item-position");
  });

  it("catches a subject crossing into the protected center", async () => {
    const inputs = await goodInputs();
    inputs.metadata.layers.item = { x: 200, y: 180, w: 240, h: 372 }; // ends at 440 > 300
    const report = await validateComposedAsset(spec, inputs);
    expect(report.failedKeys).toContain("item-position");
  });

  it("catches the пёстрый background under the text (bad_result: gold waves)", async () => {
    const inputs = await goodInputs();
    inputs.metadata.textContrast = { white: 2.5, dark: 3.9 }; // best 3.9 < 4.5
    inputs.metadata.luminanceStd = 0.31; // heavy variance
    const report = await validateComposedAsset(spec, inputs);
    expect(report.failedKeys).toContain("readability");
  });

  it("golden SSIM: identical composite passes, alien structure fails", async () => {
    const inputs = await goodInputs();
    inputs.golden = inputs.scales[0]!.png as Buffer;
    let report = await validateComposedAsset(spec, inputs);
    const goldenCheck = report.checks.find((c) => c.key === "golden-ssim")!;
    expect(goldenCheck.passed).toBe(true);

    // Alien structure: hard black/white split instead of the flat banner.
    const alien = await sharp({
      create: { width: W, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite([
        {
          input: await sharp({
            create: { width: W / 2, height: H, channels: 3, background: { r: 0, g: 0, b: 0 } },
          })
            .png()
            .toBuffer(),
          left: 0,
          top: 0,
        },
      ])
      .png()
      .toBuffer();
    inputs.golden = alien;
    report = await validateComposedAsset(spec, inputs);
    expect(report.failedKeys).toContain("golden-ssim");
  });
});

describe("ssim", () => {
  it("identical images → 1", async () => {
    const img = await grayPng(200, 100);
    expect(await ssim(img, img)).toBeCloseTo(1, 5);
  });
});

describe("personLayerSanity (stage A auto-retry gate)", () => {
  it("accepts a full-body portrait cutout", () => {
    expect(personLayerSanity(900, 1400).ok).toBe(true);
  });
  it("rejects a landscape blob and a sliver with readable reasons", () => {
    const wide = personLayerSanity(2000, 500);
    expect(wide.ok).toBe(false);
    expect(wide.reason).toContain("landscape");
    const sliver = personLayerSanity(100, 1400);
    expect(sliver.ok).toBe(false);
    expect(sliver.reason).toContain("sliver");
  });
});

// ------------------------------------------------------------------
// Проверки визуального паттерна (Задание 2, Фаза 4). Валидатор считает их тем
// же кодом, что и замеры эталонов (`lib/patternMiner.ts`).
// ------------------------------------------------------------------
describe("pattern checks (Задание 2)", () => {
  async function renderScene(seed = "brandX") {
    const person = await solidLayer(400, 900, [200, 170, 120, 255]);
    const pieces = [
      await solidLayer(420, 700, [220, 180, 60, 255]),
      await solidLayer(150, 120, [230, 190, 70, 255]),
      await solidLayer(180, 140, [230, 190, 70, 255]),
    ];
    const res = await composeAsset(
      EMAIL_HERO_V3,
      "email.hero",
      3,
      { person, itemPieces: pieces },
      seed,
    );
    if (!res.ok) throw new Error(res.reason);
    return res;
  }

  it("прогоняет проверки паттерна и объясняет каждый провал числами", async () => {
    const c = await renderScene();
    const report = await validateComposedAsset(EMAIL_HERO_V3, {
      scales: c.scales,
      metadata: c.metadata,
      overlayMask: c.overlayMask,
    });
    const keys = report.checks.map((x) => x.key);
    for (const k of ["glow-plate", "decor-coverage", "decor-count", "core-coverage", "bleed", "back-crop-top", "typography", "color-key"]) {
      expect(keys).toContain(k);
    }
    // Детали обязаны быть числовыми: по ним дизайнер понимает, что не так.
    for (const check of report.checks) expect(check.detail.length).toBeGreaterThan(0);
  });

  it("плашка на месте и углы прозрачны (V2′)", async () => {
    const c = await renderScene();
    const report = await validateComposedAsset(EMAIL_HERO_V3, {
      scales: c.scales,
      metadata: c.metadata,
      overlayMask: c.overlayMask,
    });
    expect(report.checks.find((x) => x.key === "glow-plate")!.passed).toBe(true);
  });

  it("bleed и кроп заднего плана выполняются (V7, V10b)", async () => {
    const c = await renderScene();
    const report = await validateComposedAsset(EMAIL_HERO_V3, {
      scales: c.scales,
      metadata: c.metadata,
      overlayMask: c.overlayMask,
    });
    expect(report.checks.find((x) => x.key === "bleed")!.passed).toBe(true);
    expect(report.checks.find((x) => x.key === "back-crop-top")!.passed).toBe(true);
  });

  it("не трогает push/pop-up — у них нет блока scatter (DV-B2)", async () => {
    const person = await solidLayer(400, 900, [200, 170, 120, 255]);
    const res = await composeAsset(PUSH_HERO_V1, "push.hero", 1, { person }, "s");
    if (!res.ok) throw new Error(res.reason);
    const report = await validateComposedAsset(PUSH_HERO_V1, {
      scales: res.scales,
      metadata: res.metadata,
      overlayMask: res.overlayMask,
    });
    const keys = report.checks.map((x) => x.key);
    expect(keys).not.toContain("decor-coverage");
    expect(keys).not.toContain("glow-plate");
  });
});
