import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { enforceCenterClearZone } from "../src/lib/centerCleanup.js";
import { validateAiAsset } from "../src/lib/aiAssetValidator.js";

// Доводка центра (A-4, TASK ai-reference): летуны стираются, боковые группы,
// залезшие в чистую зону, ужимаются в свои секции. Канвас 1200×600 — реальная
// геометрия email-ассета, зона как в пайплайне.

const W = 1200;
const H = 600;
const ZONE = { x: 0.28, y: 0.08, w: 0.44, h: 0.62 };

/** Плотный тёмный блок (детерминированный шум, без белых пикселей). */
async function darkBlock(w: number, h: number): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3);
  let seed = 9;
  for (let i = 0; i < raw.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    raw[i] = seed % 160; // люма заведомо < 235
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

async function whiteCanvas(overlays: sharp.OverlayOptions[]): Promise<Buffer> {
  return sharp({
    create: { width: W, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite(overlays)
    .png()
    .toBuffer();
}

describe("enforceCenterClearZone", () => {
  it("чистая композиция: буфер не меняется", async () => {
    const img = await whiteCanvas([
      { input: await darkBlock(250, 400), left: 20, top: 180 }, // левая группа в секции
      { input: await darkBlock(250, 500), left: 920, top: 80 }, // правая группа в секции
    ]);
    const res = await enforceCenterClearZone(img, ZONE);
    expect(res.changed).toBe(false);
    expect(res.erased).toBe(0);
    expect(res.buffer).toBe(img);
  });

  it("летун в центре стирается, центр-чек проходит", async () => {
    const img = await whiteCanvas([
      { input: await darkBlock(250, 400), left: 20, top: 180 },
      { input: await darkBlock(250, 500), left: 920, top: 80 },
      { input: await darkBlock(50, 50), left: 580, top: 150 }, // «монетка» в зоне
    ]);
    const res = await enforceCenterClearZone(img, ZONE);
    expect(res.changed).toBe(true);
    expect(res.erased).toBe(1);
    expect(res.scaledLeft).toBeNull();
    expect(res.scaledRight).toBeNull();

    const report = await validateAiAsset(res.buffer, W, H, { centerClearZone: ZONE });
    expect(report.checks.find((c) => c.key === "center")!.passed).toBe(true);
  });

  it("левая группа, залезшая в зону, ужимается в свою секцию", async () => {
    // Группа 0..430px — заходит за границу зоны (336px) на ~94px.
    const img = await whiteCanvas([
      { input: await darkBlock(430, 400), left: 0, top: 200 },
      { input: await darkBlock(250, 500), left: 920, top: 80 },
    ]);
    const res = await enforceCenterClearZone(img, ZONE);
    expect(res.changed).toBe(true);
    expect(res.scaledLeft).not.toBeNull();
    expect(res.scaledLeft!).toBeLessThan(1);
    expect(res.scaledLeft!).toBeGreaterThanOrEqual(0.55);
    expect(res.scaledRight).toBeNull();

    const report = await validateAiAsset(res.buffer, W, H, { centerClearZone: ZONE });
    expect(report.checks.find((c) => c.key === "center")!.passed).toBe(true);

    // Якорь сохранён: группа у левого края, прижата к своей нижней линии,
    // а её прежний верх (y=200) освободился — ужатие ушло вниз.
    const { data, info } = await sharp(res.buffer).greyscale().raw().toBuffer({ resolveWithObject: true });
    const dark = (x: number, y: number) => data[y * info.width + x]! < 235;
    expect(dark(2, 598)).toBe(true); // нижняя линия группы на месте
    expect(dark(2, 210)).toBe(false); // прежний верх группы теперь белый
  });

  it("правая группа (персонаж), залезшая в зону, ужимается к правому краю", async () => {
    // Группа 770..1199 — левый край на 94px внутри зоны (правая граница 864).
    const img = await whiteCanvas([
      { input: await darkBlock(250, 400), left: 20, top: 180 },
      { input: await darkBlock(430, 500), left: 770, top: 90 },
    ]);
    const res = await enforceCenterClearZone(img, ZONE);
    expect(res.changed).toBe(true);
    expect(res.scaledRight).not.toBeNull();
    expect(res.scaledLeft).toBeNull();

    const report = await validateAiAsset(res.buffer, W, H, { centerClearZone: ZONE });
    expect(report.checks.find((c) => c.key === "center")!.passed).toBe(true);

    // Якорь: правый край группы остался у прежнего правого края (1199).
    const { data, info } = await sharp(res.buffer).greyscale().raw().toBuffer({ resolveWithObject: true });
    const dark = (x: number, y: number) => data[y * info.width + x]! < 235;
    expect(dark(1198, 580)).toBe(true);
  });

  it("безнадёжная раскладка (нужно ужатие сильнее лимита) не трогается", async () => {
    // Группа почти во всю ширину: scale ≈ 330/1100 < 0.55 → отказ от доводки.
    const img = await whiteCanvas([{ input: await darkBlock(1100, 300), left: 0, top: 250 }]);
    const res = await enforceCenterClearZone(img, ZONE);
    expect(res.scaledLeft).toBeNull();
    expect(res.scaledRight).toBeNull();
    expect(res.changed).toBe(false);
  });
});
