import { describe, it, expect } from "vitest";
import sharp from "sharp";
import {
  computeSubjectPlacement,
  computeDecorPlacements,
  composeAsset,
  mulberry32,
  seedToInt,
} from "../src/lib/composeEngine.js";
import type { EngineLayer } from "../src/lib/composeEngine.js";
import { EMAIL_HERO_V1 } from "../src/services/layoutSpec.js";

// Composition engine tests (TASK email-composition, Phase 3): placement math
// against the calibrated spec, pixel-level composite checks on synthetics,
// byte determinism, safe-zone metadata.

const W = 1200;
const H = 600;
const spec = EMAIL_HERO_V1;

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

async function grayBackground(l: number): Promise<Buffer> {
  return sharp({
    create: { width: 300, height: 150, channels: 3, background: { r: l, g: l, b: l } },
  })
    .png()
    .toBuffer();
}

describe("computeSubjectPlacement (RC1/RC2 fix)", () => {
  it("person: height = fitHeight.target of the CANVAS regardless of layer aspect", () => {
    // Narrow layer (600×1600) and wide layer (900×1200) both land at 0.80·H.
    for (const [lw, lh] of [
      [600, 1600],
      [900, 1200],
    ] as const) {
      const box = computeSubjectPlacement(spec.subjects.person, lw, lh, W, H, spec.baseline);
      expect(box.h).toBeCloseTo(0.8 * H, 5);
      // Feet on the baseline (общая линия, RC2).
      expect(box.y + box.h).toBeCloseTo(0.92 * H, 5);
    }
  });

  it("person: pressed to the right edge of its zone (anchor bottom-right)", () => {
    const box = computeSubjectPlacement(spec.subjects.person, 600, 1600, W, H, spec.baseline);
    expect(box.x + box.w).toBeCloseTo(1.0 * W, 5); // zone right edge = canvas edge
    expect(box.x).toBeGreaterThanOrEqual(0.75 * W - 1e-6); // never crosses into the center
  });

  it("person: a very wide layer bleeds over the RIGHT edge (overflow), never into the center", () => {
    // 1:1 subject at target 0.8H → 480px wide > zone 300px + overflow 60px.
    const box = computeSubjectPlacement(spec.subjects.person, 1000, 1000, W, H, spec.baseline);
    // Width clamped to zone + right overflow (300 + 60 = 360px).
    expect(box.w).toBeCloseTo(360, 5);
    expect(box.x).toBeCloseTo(0.75 * W, 5); // left edge stays on the zone line
    expect(box.x + box.w).toBeCloseTo(W + 0.05 * W, 5); // bleeds past the canvas
  });

  it("item: centered in the left quarter at 0.62·H on the same baseline", () => {
    const box = computeSubjectPlacement(spec.subjects.item, 700, 900, W, H, spec.baseline);
    expect(box.h).toBeCloseTo(0.62 * H, 5);
    expect(box.y + box.h).toBeCloseTo(0.92 * H, 5);
    const zoneCenter = 0.125 * W;
    expect(box.x + box.w / 2).toBeCloseTo(zoneCenter, 5);
  });
});

describe("computeDecorPlacements", () => {
  it("is deterministic for the same seed and never touches text envelopes", () => {
    const dims = [
      { width: 200, height: 200 },
      { width: 300, height: 150 },
      { width: 100, height: 250 },
    ];
    const a = computeDecorPlacements(spec, dims, W, H, mulberry32(seedToInt("seed-1")));
    const b = computeDecorPlacements(spec, dims, W, H, mulberry32(seedToInt("seed-1")));
    expect(a).toEqual(b);

    const cores = spec.safe!.coreRects.map((r) => ({
      x: r.x * W,
      y: r.y * H,
      w: r.w * W,
      h: r.h * H,
    }));
    for (const box of a) {
      if (!box) continue;
      for (const c of cores) {
        const overlaps =
          box.x < c.x + c.w && box.x + box.w > c.x && box.y < c.y + c.h && box.y + box.h > c.y;
        expect(overlaps).toBe(false);
      }
    }
  });

  it("different seeds give a different layout", () => {
    const dims = [{ width: 200, height: 200 }];
    const a = computeDecorPlacements(spec, dims, W, H, mulberry32(seedToInt("seed-1")));
    const b = computeDecorPlacements(spec, dims, W, H, mulberry32(seedToInt("seed-2")));
    expect(a).not.toEqual(b);
  });
});

describe("composeAsset", () => {
  it("renders exact canvas sizes at @1x and @2x with subjects at spec positions", async () => {
    const bg = await grayBackground(230);
    const person = await solidLayer(60, 160, [255, 0, 0, 255]);
    const item = await solidLayer(70, 90, [0, 0, 255, 255]);

    const r = await composeAsset(spec, "email.hero", 1, { background: bg, person, item }, "s1");
    if (!r.ok) throw new Error(r.reason);
    expect(r.scales.map((s) => [s.width, s.height])).toEqual([
      [1200, 600],
      [2400, 1200],
    ]);

    // Pixel probes on @1x: red person pixel inside its zone near the baseline,
    // blue item pixel in the left quarter, untouched background in safe core.
    const base = r.scales[0]!;
    const raw = await sharp(base.png).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => {
      const o = (y * 1200 + x) * raw.info.channels;
      return [raw.data[o], raw.data[o + 1], raw.data[o + 2]];
    };
    const p = r.metadata.layers.person;
    expect(px(p.x + Math.floor(p.w / 2), p.y + Math.floor(p.h / 2))).toEqual([255, 0, 0]);
    const i = r.metadata.layers.item!;
    expect(px(i.x + Math.floor(i.w / 2), i.y + Math.floor(i.h / 2))).toEqual([0, 0, 255]);
    expect(px(600, 300)).toEqual([230, 230, 230]); // safe core stays clean background

    // Person box matches the placement contract.
    expect(p.y + p.h).toBe(Math.round(0.92 * 600));
    expect(p.h).toBe(Math.round(0.8 * 600));
  });

  it("is byte-deterministic across runs (same inputs, same seed)", async () => {
    const bg = await grayBackground(230);
    const person = await solidLayer(60, 160, [255, 0, 0, 255]);
    const decor = [await solidLayer(40, 40, [0, 200, 0, 255])];
    const a = await composeAsset(spec, "email.hero", 1, { background: bg, person, decor }, "s1");
    const b = await composeAsset(spec, "email.hero", 1, { background: bg, person, decor }, "s1");
    if (!a.ok || !b.ok) throw new Error("compose failed");
    expect(a.scales[0]!.png.equals(b.scales[0]!.png)).toBe(true);
    expect(a.scales[1]!.png.equals(b.scales[1]!.png)).toBe(true);
    expect(a.metadata).toEqual(b.metadata);
  });

  it("safe-zone metadata: light background → dark text recommended, AA-grade contrast", async () => {
    const bg = await grayBackground(235);
    const person = await solidLayer(60, 160, [255, 0, 0, 255]);
    const r = await composeAsset(spec, "email.hero", 1, { background: bg, person }, "s1");
    if (!r.ok) throw new Error(r.reason);
    expect(r.metadata.safeZonePct).toEqual({ x: 25, y: 4, w: 50, h: 92 });
    expect(r.metadata.recommendedTextColor).toBe("#111111");
    expect(r.metadata.textContrast!.dark).toBeGreaterThanOrEqual(4.5);
    expect(r.metadata.luminance).toBeGreaterThan(0.7);
    expect(r.metadata.luminanceStd).toBeLessThan(0.05);
  });

  it("dark background → white text recommended", async () => {
    const bg = await grayBackground(20);
    const person = await solidLayer(60, 160, [255, 0, 0, 255]);
    const r = await composeAsset(spec, "email.hero", 1, { background: bg, person }, "s1");
    if (!r.ok) throw new Error(r.reason);
    expect(r.metadata.recommendedTextColor).toBe("#FFFFFF");
    expect(r.metadata.textContrast!.white).toBeGreaterThanOrEqual(4.5);
  });

  it("decor is composited inside bands and counted in metadata", async () => {
    const bg = await grayBackground(230);
    const person = await solidLayer(60, 160, [255, 0, 0, 255]);
    const decor = [
      await solidLayer(50, 50, [0, 200, 0, 255]),
      await solidLayer(50, 50, [200, 0, 200, 255]),
    ];
    const r = await composeAsset(spec, "email.hero", 1, { background: bg, person, decor }, "sX");
    if (!r.ok) throw new Error(r.reason);
    expect(r.metadata.layers.decorPlaced + r.metadata.layers.decorSkipped).toBe(2);
    expect(r.metadata.layers.decorPlaced).toBeGreaterThan(0);
  });
});
