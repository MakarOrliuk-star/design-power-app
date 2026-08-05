import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { enforceCenterClearZone } from "../src/lib/centerCleanup.js";
import { validateAiAsset } from "../src/lib/aiAssetValidator.js";

// Доводка центра (A-5, TASK ai-reference): летуны стираются, при интрузии
// боковых групп центр раздвигается белой полосой (композиция не трогается,
// только равномерно мельчает с якорем к низу). Канвас 1200×600 — реальная
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

async function darkAt(buffer: Buffer): Promise<(x: number, y: number) => boolean> {
  const { data, info } = await sharp(buffer).greyscale().raw().toBuffer({ resolveWithObject: true });
  return (x, y) => data[y * info.width + x]! < 235;
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
    expect(res.gapPx).toBe(0);
    expect(res.buffer).toBe(img);
  });

  it("летун в центре стирается без раздвижки, центр-чек проходит", async () => {
    const img = await whiteCanvas([
      { input: await darkBlock(250, 400), left: 20, top: 180 },
      { input: await darkBlock(250, 500), left: 920, top: 80 },
      { input: await darkBlock(50, 50), left: 580, top: 150 }, // «монетка» в зоне
    ]);
    const res = await enforceCenterClearZone(img, ZONE);
    expect(res.changed).toBe(true);
    expect(res.erased).toBe(1);
    expect(res.gapPx).toBe(0);

    const report = await validateAiAsset(res.buffer, W, H, { centerClearZone: ZONE });
    expect(report.checks.find((c) => c.key === "center")!.passed).toBe(true);
  });

  it("интрузия левой группы: центр раздвигается, композиция сторон сохраняется", async () => {
    // Левая группа 0..429 заходит за границу зоны (336) на ~94px.
    const img = await whiteCanvas([
      { input: await darkBlock(430, 400), left: 0, top: 200 },
      { input: await darkBlock(250, 500), left: 920, top: 80 },
    ]);
    const res = await enforceCenterClearZone(img, ZONE);
    expect(res.changed).toBe(true);
    expect(res.gapPx).toBeGreaterThan(0);
    expect(res.scale).toBeLessThan(1);
    expect(res.scale).toBeGreaterThanOrEqual(0.72);
    expect(res.seamX).not.toBeNull();

    const report = await validateAiAsset(res.buffer, W, H, { centerClearZone: ZONE });
    expect(report.checks.find((c) => c.key === "center")!.passed).toBe(true);

    // Обе группы на месте: левая у левого края с якорем к низу, правая —
    // правее зоны (её край сместился внутрь: в тесте группа не у края канваса).
    const dark = await darkAt(res.buffer);
    expect(dark(2, 598)).toBe(true);
    expect(dark(2, 40)).toBe(false); // сверху белая полоса после ужатия
    let rightSideDark = false;
    for (let x = 900; x < W && !rightSideDark; x += 4)
      for (let y = 300; y < H; y += 4)
        if (dark(x, y)) {
          rightSideDark = true;
          break;
        }
    expect(rightSideDark).toBe(true);
  });

  it("интрузия обеих групп: белая полоса шире, зона свободна", async () => {
    const img = await whiteCanvas([
      { input: await darkBlock(430, 400), left: 0, top: 200 },
      { input: await darkBlock(430, 500), left: 770, top: 90 },
    ]);
    const res = await enforceCenterClearZone(img, ZONE);
    expect(res.changed).toBe(true);
    expect(res.gapPx).toBeGreaterThan(0);

    const report = await validateAiAsset(res.buffer, W, H, { centerClearZone: ZONE });
    expect(report.checks.find((c) => c.key === "center")!.passed).toBe(true);
  });

  it("экстремальная интрузия: ужатие клампится на 0.72, остаток допускается", async () => {
    // Группа почти во всю ширину — полностью зону не освободить.
    const img = await whiteCanvas([{ input: await darkBlock(1000, 300), left: 0, top: 250 }]);
    const res = await enforceCenterClearZone(img, ZONE);
    expect(res.changed).toBe(true);
    expect(res.scale).toBeGreaterThanOrEqual(0.72);
    expect(res.scale).toBeLessThanOrEqual(0.73);
  });
});
