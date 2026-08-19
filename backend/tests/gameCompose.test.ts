import { describe, it, expect } from "vitest";
import sharp from "sharp";
import {
  clipToCanvas,
  composeGameImage,
  computePersonBox,
  normalizeOptions,
  renderBackground,
  trimPerson,
  SCALE_MAX,
  SCALE_MIN,
  BLUR_SIGMA_MAX,
} from "../src/lib/gameCompose.js";
import {
  DEFAULT_CANVAS,
  DEFAULT_TEMPLATE_SPEC,
  guideLines,
  parseTemplateSpec,
} from "../src/lib/gameTemplate.js";

const W = DEFAULT_CANVAS.width; // 1080
const H = DEFAULT_CANVAS.height; // 1920
const spec = DEFAULT_TEMPLATE_SPEC;

/** A solid rectangle with a transparent margin — stands in for a cut-out. */
async function cutout(width: number, height: number, margin = 20): Promise<Buffer> {
  return sharp({
    create: {
      width: width + margin * 2,
      height: height + margin * 2,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: {
          create: { width, height, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
        },
        left: margin,
        top: margin,
      },
    ])
    .png()
    .toBuffer();
}

function opaque(width: number, height: number, colour = { r: 0, g: 0, b: 255 }): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: colour },
  })
    .png()
    .toBuffer();
}

/**
 * BE Test — the stencil geometry measured off the Figma export
 * (R-PLAN-game-manager.md §2.1). These are the numbers the whole composer
 * hangs on, so they are asserted directly rather than inferred from a render.
 */
describe("stencil geometry", () => {
  it("keeps the measured radii: outer spans the width, inner is ¾ of it", () => {
    expect(spec.person.outerRadius).toBe(0.5);
    expect(spec.person.innerRadius).toBe(0.375);
    expect(spec.person.innerRadius / spec.person.outerRadius).toBeCloseTo(0.75, 6);
  });

  it("derives the guides the mock draws (12.5% / 87.5% and 21.9% / 78.1%)", () => {
    const g = guideLines(spec, W, H);
    expect(g.vertical).toEqual([0.125, 0.5, 0.875]);
    // outerRadius is width-relative; on a 9:16 canvas that is 0.28125 of the height
    expect(g.horizontal[0]).toBeCloseTo(0.21875, 6);
    expect(g.horizontal[2]).toBeCloseTo(0.78125, 6);
  });

  it("falls back to the measured default for a malformed stored spec", () => {
    expect(parseTemplateSpec(null)).toEqual(spec);
    expect(parseTemplateSpec({ person: { outerRadius: "wide" } }).person.outerRadius).toBe(0.5);
  });

  it("honours a stored spec that overrides the default", () => {
    const parsed = parseTemplateSpec({ person: { ...spec.person, fitCircle: "inner" } });
    expect(parsed.person.fitCircle).toBe("inner");
  });
});

/** BE Test — option clamping. The slider can only send what the engine accepts. */
describe("normalizeOptions", () => {
  it("defaults to 100% scale, blur off", () => {
    const o = normalizeOptions(undefined);
    expect(o).toEqual({ blur: false, blurSigma: 12, scale: 1 });
  });

  it("clamps scale and blur into range", () => {
    expect(normalizeOptions({ scale: 9 }).scale).toBe(SCALE_MAX);
    expect(normalizeOptions({ scale: 0.01 }).scale).toBe(SCALE_MIN);
    expect(normalizeOptions({ blurSigma: 999 }).blurSigma).toBe(BLUR_SIGMA_MAX);
  });

  it("ignores NaN rather than propagating it into sharp", () => {
    expect(normalizeOptions({ scale: Number.NaN }).scale).toBe(1);
  });
});

/**
 * BE Test — person placement (Q9: the slider scales the PERSON).
 * At scale 1 the layer is contain-fitted into the fit circle's bounding square
 * and centred on the stencil centre.
 */
describe("computePersonBox", () => {
  it("fits a square person to the full outer circle at scale 1", () => {
    const box = computePersonBox(spec, 500, 500, W, H, 1);
    expect(box.width).toBe(W); // zone = 2 * 0.5 * 1080
    expect(box.height).toBe(W);
    expect(box.left).toBe(0);
    expect(box.top).toBe(Math.round(H / 2 - W / 2));
  });

  it("fits by the longer side, never distorting", () => {
    const box = computePersonBox(spec, 400, 800, W, H, 1);
    expect(box.height).toBe(W); // tall → height hits the zone
    expect(box.width).toBe(W / 2);
    expect(box.width / box.height).toBeCloseTo(400 / 800, 6);
  });

  it("centres on the stencil centre at any scale", () => {
    for (const scale of [0.5, 1, 1.5]) {
      const box = computePersonBox(spec, 300, 600, W, H, scale);
      expect(box.left + box.width / 2).toBeCloseTo(W / 2, 0);
      expect(box.top + box.height / 2).toBeCloseTo(H / 2, 0);
    }
  });

  it("scales linearly with the slider", () => {
    const half = computePersonBox(spec, 400, 400, W, H, 0.5);
    const full = computePersonBox(spec, 400, 400, W, H, 1);
    expect(half.width * 2).toBe(full.width);
  });

  it("uses the inner circle when the spec says so", () => {
    const inner = computePersonBox(
      { person: { ...spec.person, fitCircle: "inner" } },
      400,
      400,
      W,
      H,
      1,
    );
    expect(inner.width).toBe(Math.round(W * 0.75));
  });
});

/**
 * BE Test — clipping. Without it a scale > 1 makes sharp throw ("image to
 * composite must fit"), which would turn the top half of the slider into an
 * error instead of a zoom.
 */
describe("clipToCanvas", () => {
  it("passes a fully visible box through untouched", () => {
    const clip = clipToCanvas({ left: 10, top: 20, width: 100, height: 200 }, W, H);
    expect(clip).toEqual({ left: 10, top: 20, sourceLeft: 0, sourceTop: 0, width: 100, height: 200 });
  });

  it("crops a box that overflows every edge", () => {
    const clip = clipToCanvas({ left: -50, top: -80, width: W + 200, height: H + 300 }, W, H);
    expect(clip).toEqual({
      left: 0,
      top: 0,
      sourceLeft: 50,
      sourceTop: 80,
      width: W,
      height: H,
    });
  });

  it("returns null when nothing is visible", () => {
    expect(clipToCanvas({ left: -500, top: 0, width: 100, height: 100 }, W, H)).toBeNull();
    expect(clipToCanvas({ left: W + 10, top: 0, width: 100, height: 100 }, W, H)).toBeNull();
  });
});

/** BE Test — the person is fitted by its CONTENT, not by the file's padding. */
describe("trimPerson", () => {
  it("trims the transparent margin away", async () => {
    const { width, height } = await trimPerson(await cutout(120, 240, 60));
    expect(width).toBe(120);
    expect(height).toBe(240);
  });

  it("leaves an opaque image alone", async () => {
    const { width, height } = await trimPerson(await opaque(200, 100));
    expect(width).toBe(200);
    expect(height).toBe(100);
  });

  it("survives a fully transparent layer instead of throwing", async () => {
    const empty = await sharp({
      create: { width: 50, height: 50, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const res = await trimPerson(empty);
    expect(res.width).toBeGreaterThan(0);
  });
});

describe("renderBackground", () => {
  it("covers the canvas exactly, whatever the source aspect", async () => {
    for (const [w, h] of [[400, 400], [2000, 300], [300, 2000]] as const) {
      const out = await renderBackground(await opaque(w, h), W, H, normalizeOptions(null));
      const meta = await sharp(out).metadata();
      expect([meta.width, meta.height]).toEqual([W, H]);
    }
  });

  it("blur changes the pixels but not the size", async () => {
    const src = await sharp({
      create: { width: 200, height: 200, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite([
        {
          input: {
            create: { width: 40, height: 40, channels: 3, background: { r: 0, g: 0, b: 0 } },
          },
          left: 80,
          top: 80,
        },
      ])
      .png()
      .toBuffer();
    const plain = await renderBackground(src, 200, 400, normalizeOptions(null));
    const blurred = await renderBackground(src, 200, 400, normalizeOptions({ blur: true, blurSigma: 20 }));
    expect(blurred.equals(plain)).toBe(false);
    const meta = await sharp(blurred).metadata();
    expect([meta.width, meta.height]).toEqual([200, 400]);
  });
});

/** BE Test — the whole pipeline, including the determinism promise. */
describe("composeGameImage", () => {
  const base = { spec, canvasW: W, canvasH: H, options: normalizeOptions(null) };

  it("produces a canvas-sized PNG from both layers", async () => {
    const { buffer, personBox } = await composeGameImage({
      ...base,
      background: await opaque(800, 800),
      person: await cutout(200, 400),
    });
    const meta = await sharp(buffer).metadata();
    expect([meta.width, meta.height]).toEqual([W, H]);
    expect(personBox).not.toBeNull();
  });

  it("is byte-identical across runs (fixed kernel + encoder)", async () => {
    const bg = await opaque(800, 800);
    const person = await cutout(200, 400);
    const a = await composeGameImage({ ...base, background: bg, person });
    const b = await composeGameImage({ ...base, background: bg, person });
    expect(a.buffer.equals(b.buffer)).toBe(true);
  });

  it("renders a background with no person", async () => {
    const { buffer, personBox } = await composeGameImage({
      ...base,
      background: await opaque(400, 900),
      person: null,
    });
    expect(personBox).toBeNull();
    const meta = await sharp(buffer).metadata();
    expect([meta.width, meta.height]).toEqual([W, H]);
  });

  it("renders a person with no background, on transparency", async () => {
    const { buffer } = await composeGameImage({
      ...base,
      background: null,
      person: await cutout(200, 200),
    });
    const meta = await sharp(buffer).metadata();
    expect([meta.width, meta.height]).toEqual([W, H]);
    expect(meta.hasAlpha).toBe(true);
  });

  it("does not throw when the person overflows at max scale", async () => {
    const { buffer } = await composeGameImage({
      ...base,
      background: await opaque(800, 800),
      person: await cutout(400, 400),
      options: normalizeOptions({ scale: SCALE_MAX }),
    });
    const meta = await sharp(buffer).metadata();
    expect([meta.width, meta.height]).toEqual([W, H]);
  });

  it("scale actually changes the output", async () => {
    const bg = await opaque(800, 800);
    const person = await cutout(200, 400);
    const small = await composeGameImage({ ...base, background: bg, person, options: normalizeOptions({ scale: 0.5 }) });
    const big = await composeGameImage({ ...base, background: bg, person, options: normalizeOptions({ scale: 1.5 }) });
    expect(small.buffer.equals(big.buffer)).toBe(false);
    expect(small.personBox!.width).toBeLessThan(big.personBox!.width);
  });
});
