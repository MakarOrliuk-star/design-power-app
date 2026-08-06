import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { splitLayerPieces, MIN_PIECE_PX } from "../src/lib/layerSplit.js";

/**
 * Item splitting: the ITEM generation returns several props on one layer, and
 * the эталоны (push/pop-up) place them individually around the character. The
 * splitter must cut the layer into exactly those props — largest first, each
 * trimmed to itself, never dragging a neighbour along.
 */

/** Canvas with opaque rectangles at given positions (rest transparent). */
async function canvasWith(
  w: number,
  h: number,
  rects: Array<{ x: number; y: number; w: number; h: number; rgb?: [number, number, number] }>,
): Promise<Buffer> {
  const data = Buffer.alloc(w * h * 4);
  for (const r of rects) {
    const [cr, cg, cb] = r.rgb ?? [200, 100, 50];
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const o = (y * w + x) * 4;
        data[o] = cr;
        data[o + 1] = cg;
        data[o + 2] = cb;
        data[o + 3] = 255;
      }
    }
  }
  return sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

describe("splitLayerPieces", () => {
  it("cuts separated props into pieces, largest first, each trimmed to itself", async () => {
    const png = await canvasWith(400, 300, [
      { x: 10, y: 10, w: 120, h: 200, rgb: [255, 0, 0] }, // hero
      { x: 250, y: 20, w: 60, h: 60, rgb: [0, 255, 0] },
      { x: 260, y: 200, w: 80, h: 50, rgb: [0, 0, 255] },
    ]);

    const pieces = await splitLayerPieces(png);
    expect(pieces).toHaveLength(3);
    expect([pieces[0]!.width, pieces[0]!.height]).toEqual([120, 200]);
    expect([pieces[1]!.width, pieces[1]!.height]).toEqual([80, 50]);
    expect([pieces[2]!.width, pieces[2]!.height]).toEqual([60, 60]);
    expect(pieces[0]!.area).toBeGreaterThan(pieces[1]!.area);

    // Each piece carries only its own object: the hero crop is fully opaque red.
    const hero = await sharp(pieces[0]!.png).raw().toBuffer({ resolveWithObject: true });
    expect(hero.info.channels).toBe(4);
    expect([hero.data[0], hero.data[1], hero.data[2], hero.data[3]]).toEqual([255, 0, 0, 255]);
  });

  it("blanks a neighbour that merely overlaps the piece's bounding box", async () => {
    // The L-shaped hero's bbox contains the small square, but they never touch.
    const png = await canvasWith(200, 200, [
      { x: 0, y: 0, w: 30, h: 160, rgb: [255, 0, 0] },
      { x: 0, y: 130, w: 160, h: 30, rgb: [255, 0, 0] },
      { x: 90, y: 40, w: 40, h: 40, rgb: [0, 255, 0] },
    ]);

    const pieces = await splitLayerPieces(png);
    expect(pieces).toHaveLength(2);
    const hero = await sharp(pieces[0]!.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    // Where the green square sits inside the hero bbox the alpha must be 0.
    const o = (60 * hero.info.width + 110) * 4;
    expect(hero.data[o + 3]).toBe(0);
  });

  it("drops cutout debris and keeps a single-object layer as one piece", async () => {
    const dust = Math.floor(Math.sqrt(MIN_PIECE_PX) / 2);
    const png = await canvasWith(300, 300, [
      { x: 20, y: 20, w: 200, h: 200 },
      { x: 280, y: 280, w: dust, h: dust }, // speck below the floor
    ]);
    const pieces = await splitLayerPieces(png);
    expect(pieces).toHaveLength(1);
    expect([pieces[0]!.width, pieces[0]!.height]).toEqual([200, 200]);
  });

  it("caps the number of pieces and is byte-deterministic", async () => {
    const rects = Array.from({ length: 6 }, (_, i) => ({
      x: 10 + i * 60,
      y: 10 + (i % 2) * 100,
      w: 40 + i * 4,
      h: 40 + i * 4,
    }));
    const png = await canvasWith(400, 200, rects);

    const capped = await splitLayerPieces(png, { maxPieces: 3 });
    expect(capped).toHaveLength(3);
    const again = await splitLayerPieces(png, { maxPieces: 3 });
    expect(capped.map((p) => p.png.equals(again[capped.indexOf(p)]!.png)).every(Boolean)).toBe(true);
  });

  it("returns nothing for an empty layer", async () => {
    const png = await canvasWith(100, 100, []);
    expect(await splitLayerPieces(png)).toEqual([]);
  });
});
