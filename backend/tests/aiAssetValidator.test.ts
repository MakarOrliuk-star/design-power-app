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

  it("нечитаемый буфер = непройденный size-чек, не исключение", async () => {
    const report = await validateAiAsset(Buffer.from("not an image"), W, H);
    expect(report.passed).toBe(false);
    expect(report.checks[0]!.key).toBe("size");
  });
});
