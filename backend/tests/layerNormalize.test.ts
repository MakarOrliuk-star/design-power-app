import { describe, it, expect } from "vitest";
import sharp from "sharp";
import {
  hasUsefulAlpha,
  normalizeLayer,
  ALPHA_NOISE_THRESHOLD,
} from "../src/lib/layerNormalize.js";

// Real-sharp unit tests on synthetic images (TASK email-composition, Phase 2).
// Helper: RGBA canvas w×h with painted rects → PNG buffer.
interface Paint {
  x: number;
  y: number;
  w: number;
  h: number;
  rgba: [number, number, number, number];
}
async function makePng(w: number, h: number, paints: Paint[]): Promise<Buffer> {
  const data = Buffer.alloc(w * h * 4, 0);
  for (const p of paints) {
    for (let y = p.y; y < p.y + p.h; y++) {
      for (let x = p.x; x < p.x + p.w; x++) {
        const i = (y * w + x) * 4;
        data[i] = p.rgba[0];
        data[i + 1] = p.rgba[1];
        data[i + 2] = p.rgba[2];
        data[i + 3] = p.rgba[3];
      }
    }
  }
  return sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

describe("hasUsefulAlpha", () => {
  it("false for a fully opaque image (JPEG-style source → BR fallback required)", async () => {
    const png = await makePng(50, 40, [{ x: 0, y: 0, w: 50, h: 40, rgba: [200, 10, 10, 255] }]);
    expect(await hasUsefulAlpha(png)).toBe(false);
  });

  it("true for a real cutout (transparent margins)", async () => {
    const png = await makePng(50, 40, [{ x: 10, y: 10, w: 20, h: 20, rgba: [200, 10, 10, 255] }]);
    expect(await hasUsefulAlpha(png)).toBe(true);
  });
});

describe("normalizeLayer", () => {
  it("trims exactly to the subject alpha-bbox", async () => {
    const png = await makePng(100, 80, [{ x: 10, y: 5, w: 40, h: 30, rgba: [255, 0, 0, 255] }]);
    const r = await normalizeLayer(png);
    if (!r.ok) throw new Error(r.reason);
    expect({ w: r.width, h: r.height }).toEqual({ w: 40, h: 30 });
    const meta = await sharp(r.png).metadata();
    expect(meta.width).toBe(40);
    expect(meta.height).toBe(30);
    expect(meta.hasAlpha).toBe(true);
  });

  it("halo debris below the alpha threshold does not inflate the bbox (RC7)", async () => {
    const png = await makePng(100, 80, [
      { x: 20, y: 20, w: 30, h: 30, rgba: [0, 255, 0, 255] }, // subject
      { x: 80, y: 5, w: 10, h: 10, rgba: [0, 255, 0, ALPHA_NOISE_THRESHOLD - 1] }, // far debris
      { x: 10, y: 60, w: 5, h: 5, rgba: [0, 255, 0, 10] }, // faint smudge
    ]);
    const r = await normalizeLayer(png);
    if (!r.ok) throw new Error(r.reason);
    expect({ w: r.width, h: r.height }).toEqual({ w: 30, h: 30 });
  });

  it("keeps semi-transparent pixels that are ABOVE the noise threshold (soft edges)", async () => {
    const png = await makePng(60, 60, [
      { x: 20, y: 20, w: 20, h: 20, rgba: [0, 0, 255, 255] },
      { x: 16, y: 20, w: 4, h: 20, rgba: [0, 0, 255, 100] }, // soft edge left of subject
    ]);
    const r = await normalizeLayer(png);
    if (!r.ok) throw new Error(r.reason);
    expect(r.width).toBe(24); // 16..39 inclusive
  });

  it("rejects an empty layer with a readable reason", async () => {
    const png = await makePng(50, 50, [{ x: 5, y: 5, w: 10, h: 10, rgba: [255, 255, 255, 5] }]);
    const r = await normalizeLayer(png);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("empty layer");
  });

  it("rejects a microscopic subject (background removal ate the subject)", async () => {
    const png = await makePng(200, 200, [{ x: 0, y: 0, w: 5, h: 5, rgba: [255, 0, 0, 255] }]);
    const r = await normalizeLayer(png);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("subject too small");
  });

  it("is byte-deterministic: same input → identical PNG bytes", async () => {
    const png = await makePng(120, 90, [
      { x: 15, y: 10, w: 60, h: 70, rgba: [120, 60, 200, 255] },
      { x: 13, y: 8, w: 4, h: 4, rgba: [120, 60, 200, 180] },
    ]);
    const a = await normalizeLayer(png);
    const b = await normalizeLayer(png);
    if (!a.ok || !b.ok) throw new Error("normalize failed");
    expect(a.png.equals(b.png)).toBe(true);
  });

  it("reports opaqueRatio for halo diagnostics", async () => {
    const png = await makePng(100, 100, [{ x: 10, y: 10, w: 50, h: 20, rgba: [1, 2, 3, 255] }]);
    const r = await normalizeLayer(png);
    if (!r.ok) throw new Error(r.reason);
    expect(r.opaqueRatio).toBeCloseTo(1, 5); // solid rect fills its own bbox
  });

  it("fails loudly on undecodable input", async () => {
    const r = await normalizeLayer(Buffer.from("not an image"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("decode failed");
  });
});
