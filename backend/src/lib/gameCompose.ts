import sharp from "sharp";
import type { GameTemplateSpec } from "./gameTemplate.js";

/**
 * Game composition engine (TASK game-manager, Phase 2).
 *
 * `stencil + background + person → composite`. Pure buffers in, buffers out:
 * no network, no DB — the service orchestrates. Mirrors the contract of
 * lib/composeEngine.ts, including its determinism rule: a fixed resize kernel
 * and fixed PNG encoder options, so identical inputs give byte-identical
 * output and the placement math stays regression-testable.
 */

export const SCALE_MIN = 0.5;
export const SCALE_MAX = 1.5;
export const BLUR_SIGMA_MIN = 1;
export const BLUR_SIGMA_MAX = 40;
/** Mock: the Scale slider sits dead centre → 100% is the default. */
export const SCALE_DEFAULT = 1;
export const BLUR_SIGMA_DEFAULT = 12;

export interface ComposeOptions {
  /** Q10: the checkbox switches it on, the slider sets the radius. */
  blur: boolean;
  blurSigma: number;
  /** Q9: scales the PERSON inside the stencil, never the whole canvas. */
  scale: number;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The wire shape: every field optional and explicitly `| undefined`, which is
 * what `exactOptionalPropertyTypes` requires of a zod-parsed body.
 */
export type ComposeOptionsInput = {
  [K in keyof ComposeOptions]?: ComposeOptions[K] | undefined;
};

export const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(Math.max(v, lo), hi);

export function normalizeOptions(raw: ComposeOptionsInput | null | undefined): ComposeOptions {
  return {
    blur: raw?.blur === true,
    blurSigma: clamp(
      typeof raw?.blurSigma === "number" && Number.isFinite(raw.blurSigma)
        ? raw.blurSigma
        : BLUR_SIGMA_DEFAULT,
      BLUR_SIGMA_MIN,
      BLUR_SIGMA_MAX,
    ),
    scale: clamp(
      typeof raw?.scale === "number" && Number.isFinite(raw.scale) ? raw.scale : SCALE_DEFAULT,
      SCALE_MIN,
      SCALE_MAX,
    ),
  };
}

/**
 * Where the person lands on the canvas.
 *
 * At scale = 1 the person is `contain`-fitted into the square that bounds the
 * stencil's fit circle — so a tall character touches the circle top and bottom,
 * a wide one touches its sides, and neither is ever distorted. The scale slider
 * then multiplies that fit, and the result is centred on the circle centre.
 *
 * Pure integer math on the way out: sharp's composite takes whole pixels, and
 * rounding once here (rather than inside sharp) is what keeps the output
 * byte-stable.
 */
export function computePersonBox(
  spec: GameTemplateSpec,
  personW: number,
  personH: number,
  canvasW: number,
  canvasH: number,
  scale: number,
): Box {
  const { centerX, centerY, innerRadius, outerRadius, fitCircle } = spec.person;
  const radius = (fitCircle === "inner" ? innerRadius : outerRadius) * canvasW;
  const zone = radius * 2;

  // contain-fit into the zone square, then apply the slider
  const fit = Math.min(zone / personW, zone / personH) * scale;
  const width = Math.max(1, Math.round(personW * fit));
  const height = Math.max(1, Math.round(personH * fit));

  const cx = centerX * canvasW;
  const cy = centerY * canvasH;
  return {
    left: Math.round(cx - width / 2),
    top: Math.round(cy - height / 2),
    width,
    height,
  };
}

/** Fixed encoder options — determinism (see the file header). */
const PNG_OPTIONS = { compressionLevel: 9, effort: 10, palette: false } as const;
const KERNEL = sharp.kernel.lanczos3;

/**
 * Background: cover the canvas (centre-cropped), optionally blurred.
 * The blur is applied AFTER the resize so its radius means the same thing at
 * every source resolution, and the canvas is re-extended afterwards because
 * sharp's blur bleeds transparent edges on an already-exact canvas.
 */
export async function renderBackground(
  background: Buffer,
  canvasW: number,
  canvasH: number,
  options: ComposeOptions,
): Promise<Buffer> {
  let pipeline = sharp(background)
    .resize(canvasW, canvasH, { fit: "cover", position: "centre", kernel: KERNEL })
    .flatten({ background: "#000000" });
  if (options.blur) pipeline = pipeline.blur(options.blurSigma);
  return pipeline.png(PNG_OPTIONS).toBuffer();
}

/**
 * Trim the person to its opaque bounding box before fitting.
 *
 * A cut-out PNG is usually mostly empty space; fitting the FILE rather than the
 * character would leave it floating small and off-centre inside the stencil.
 * `trim` is a no-op on an opaque JPEG, so the same path serves both.
 */
export async function trimPerson(person: Buffer): Promise<{ buffer: Buffer; width: number; height: number }> {
  try {
    const { data, info } = await sharp(person)
      .ensureAlpha()
      .trim({ threshold: 1 })
      .png(PNG_OPTIONS)
      .toBuffer({ resolveWithObject: true });
    return { buffer: data, width: info.width, height: info.height };
  } catch {
    // A fully transparent (or otherwise untrimmable) layer — keep it as-is
    // rather than failing the whole composition.
    const meta = await sharp(person).metadata();
    return { buffer: person, width: meta.width ?? 1, height: meta.height ?? 1 };
  }
}

export interface ClippedBox {
  /** Where the visible part lands on the canvas. */
  left: number;
  top: number;
  /** Which part of the scaled layer is visible (source rect). */
  sourceLeft: number;
  sourceTop: number;
  width: number;
  height: number;
}

/**
 * Intersect the person box with the canvas.
 *
 * At scale 1.5 with the default stencil the person is 1.5x the canvas width, so
 * it genuinely hangs off every edge — and sharp refuses to composite a layer
 * that does not fit. Cropping the layer to the visible rectangle (rather than
 * shrinking it) is what makes the top of the Scale slider mean "zoom in" and
 * not "the image silently stops growing". Returns null when nothing is visible.
 */
export function clipToCanvas(box: Box, canvasW: number, canvasH: number): ClippedBox | null {
  const left = Math.max(0, box.left);
  const top = Math.max(0, box.top);
  const right = Math.min(canvasW, box.left + box.width);
  const bottom = Math.min(canvasH, box.top + box.height);
  if (right <= left || bottom <= top) return null;
  return {
    left,
    top,
    sourceLeft: left - box.left,
    sourceTop: top - box.top,
    width: right - left,
    height: bottom - top,
  };
}

export interface ComposeResult {
  buffer: Buffer;
  personBox: Box | null;
}

/**
 * The whole composition. Either layer may be missing: the page lets a designer
 * preview a background alone, or a person on a transparent canvas.
 */
export async function composeGameImage(params: {
  spec: GameTemplateSpec;
  canvasW: number;
  canvasH: number;
  background: Buffer | null;
  person: Buffer | null;
  options: ComposeOptions;
}): Promise<ComposeResult> {
  const { spec, canvasW, canvasH, background, person, options } = params;

  const base = background
    ? await renderBackground(background, canvasW, canvasH, options)
    : await sharp({
        create: {
          width: canvasW,
          height: canvasH,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
        .png(PNG_OPTIONS)
        .toBuffer();

  if (!person) return { buffer: base, personBox: null };

  const trimmed = await trimPerson(person);
  const box = computePersonBox(spec, trimmed.width, trimmed.height, canvasW, canvasH, options.scale);
  const clip = clipToCanvas(box, canvasW, canvasH);
  if (!clip) return { buffer: base, personBox: box };

  const scaled = sharp(trimmed.buffer).resize(box.width, box.height, {
    fit: "fill",
    kernel: KERNEL,
  });
  // Only extract when the layer actually overflows — a no-op extract still
  // re-encodes, and skipping it keeps the common path byte-identical.
  const layer =
    clip.width === box.width && clip.height === box.height
      ? await scaled.png(PNG_OPTIONS).toBuffer()
      : await scaled
          .png(PNG_OPTIONS)
          .toBuffer()
          .then((b) =>
            sharp(b)
              .extract({
                left: clip.sourceLeft,
                top: clip.sourceTop,
                width: clip.width,
                height: clip.height,
              })
              .png(PNG_OPTIONS)
              .toBuffer(),
          );

  const buffer = await sharp(base)
    .composite([{ input: layer, left: clip.left, top: clip.top }])
    .png(PNG_OPTIONS)
    .toBuffer();

  return { buffer, personBox: box };
}
