import { describe, it, expect } from "vitest";
import sharp from "sharp";
import {
  validateAiAsset,
  laplacianVariance,
  SHARPNESS_MIN_VARIANCE,
} from "../src/lib/aiAssetValidator.js";

// Стадия C (TASK ai-reference): детерминированные проверки цельного AI-кадра.
// Буферы собираются sharp'ом прямо в тесте — без бинарных фикстур.

const W = 300;
const H = 150;

/** Случайный «шумный» кадр — резкий по лапласиану, без рамок. */
async function noisyImage(w = W, h = H): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3);
  // mulberry32-подобный детерминированный шум — тест не должен флаковать.
  let seed = 42;
  for (let i = 0; i < raw.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    raw[i] = seed % 256;
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

/** Однотонный кадр — «мыло» (нулевая дисперсия лапласиана). */
async function flatImage(w = W, h = H, color = 128): Promise<Buffer> {
  return sharp({
    create: { width: w, height: h, channels: 3, background: { r: color, g: color, b: color } },
  })
    .png()
    .toBuffer();
}

/** Шумный кадр с чёрными полосами сверху и снизу — леттербокс. */
async function letterboxedImage(): Promise<Buffer> {
  const inner = await noisyImage(W, H - 40);
  return sharp({
    create: { width: W, height: H, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .composite([{ input: inner, left: 0, top: 20 }])
    .png()
    .toBuffer();
}

/** Шумный центр на чисто-белом фоне — целевой вид композиции по контракту A-2. */
async function whiteBackgroundImage(): Promise<Buffer> {
  const inner = await noisyImage(W - 80, H - 40);
  return sharp({
    create: { width: W, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([{ input: inner, left: 40, top: 20 }])
    .png()
    .toBuffer();
}

describe("laplacianVariance", () => {
  it("шум даёт большую дисперсию, однотонное поле — ноль", () => {
    const w = 50;
    const h = 50;
    const noise = new Uint8Array(w * h);
    let seed = 7;
    for (let i = 0; i < noise.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      noise[i] = seed % 256;
    }
    expect(laplacianVariance(noise, w, h)).toBeGreaterThan(SHARPNESS_MIN_VARIANCE);
    expect(laplacianVariance(new Uint8Array(w * h).fill(120), w, h)).toBe(0);
  });
});

describe("validateAiAsset", () => {
  it("резкий кадр точного размера без рамок проходит все чеки", async () => {
    const report = await validateAiAsset(await noisyImage(), W, H);
    expect(report.passed).toBe(true);
    expect(report.checks.map((c) => c.key)).toEqual(["size", "sharpness", "borders"]);
  });

  it("неверный размер — брак с внятной причиной", async () => {
    const report = await validateAiAsset(await noisyImage(W - 10, H), W, H);
    expect(report.passed).toBe(false);
    const size = report.checks.find((c) => c.key === "size")!;
    expect(size.passed).toBe(false);
    expect(size.detail).toContain(`${W}×${H}`);
  });

  it("однотонное «мыло» валится на резкости", async () => {
    const report = await validateAiAsset(await flatImage(), W, H);
    const sharpness = report.checks.find((c) => c.key === "sharpness")!;
    expect(sharpness.passed).toBe(false);
  });

  it("чёрные полосы на противоположных краях — леттербокс", async () => {
    const report = await validateAiAsset(await letterboxedImage(), W, H);
    const borders = report.checks.find((c) => c.key === "borders")!;
    expect(borders.passed).toBe(false);
  });

  it("белый фон по краям — НЕ леттербокс (контракт A-2: белый фон легален)", async () => {
    const report = await validateAiAsset(await whiteBackgroundImage(), W, H);
    const borders = report.checks.find((c) => c.key === "borders")!;
    expect(borders.passed).toBe(true);
  });

  it("чистый центр (A-3): без зоны чек не выполняется, с зоной — белый центр проходит", async () => {
    // Боковые группы: шум слева и справа, центральная полоса — белая.
    const side = await noisyImage(60, H);
    const img = await sharp({
      create: { width: W, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite([
        { input: side, left: 0, top: 0 },
        { input: side, left: W - 60, top: 0 },
      ])
      .png()
      .toBuffer();

    const noZone = await validateAiAsset(img, W, H);
    expect(noZone.checks.some((c) => c.key === "center")).toBe(false);

    const zone = { x: 0.28, y: 0.08, w: 0.44, h: 0.62 };
    const withZone = await validateAiAsset(img, W, H, { centerClearZone: zone });
    const center = withZone.checks.find((c) => c.key === "center")!;
    expect(center.passed).toBe(true);
  });

  it("чистый центр (A-3): пропс в центральной зоне — брак", async () => {
    const side = await noisyImage(60, H);
    const coin = await noisyImage(40, 40);
    const img = await sharp({
      create: { width: W, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite([
        { input: side, left: 0, top: 0 },
        { input: side, left: W - 60, top: 0 },
        // «Монетка» по центру текстовой зоны.
        { input: coin, left: Math.round(W / 2) - 20, top: 30 },
      ])
      .png()
      .toBuffer();

    const report = await validateAiAsset(img, W, H, {
      centerClearZone: { x: 0.28, y: 0.08, w: 0.44, h: 0.62 },
    });
    const center = report.checks.find((c) => c.key === "center")!;
    expect(center.passed).toBe(false);
    expect(center.detail).toContain("% белого");
  });

  it("нечитаемый буфер = непройденный size-чек, не исключение", async () => {
    const report = await validateAiAsset(Buffer.from("not an image"), W, H);
    expect(report.passed).toBe(false);
    expect(report.checks[0]!.key).toBe("size");
  });
});
