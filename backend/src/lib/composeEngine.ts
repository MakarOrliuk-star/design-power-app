import { createHash } from "node:crypto";
import sharp from "sharp";
import type { LayoutSpecData, SubjectSpec, SpecRect } from "../services/layoutSpec.js";

/**
 * Composition engine (TASK email-composition, Phase 3; R-PLAN §3/§6).
 * `spec + layers → composite` — position, scale and z-order come ONLY from the
 * layout spec; nothing depends on what the neural net drew (D-E4). Pure
 * buffers in, buffers out: no network, no DB — the render job orchestrates.
 *
 * Determinism: fixed resize kernel + fixed PNG encoder options + a seeded
 * PRNG for decor layout → identical inputs produce byte-identical output at
 * every scale (regression-testable, R-PLAN DoD Phase 3).
 */

// ------------------------------------------------------------------
// Seeded PRNG (mulberry32) — decor layout randomness must replay exactly.
// ------------------------------------------------------------------

export function seedToInt(seedStr: string): number {
  const h = createHash("sha256").update(seedStr).digest();
  return h.readUInt32LE(0);
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------
// Placement math (pure, unit-tested against the reference numbers)
// ------------------------------------------------------------------

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Fit a subject layer (alpha-bbox dimensions) into its spec zone on a
 * canvasW×canvasH canvas: scale so the subject height hits fitHeight.target
 * of the CANVAS height (RC1 fix — never the zone width), clamp into the zone
 * ± allowed overflow, stand the bottom edge on the baseline.
 */
export function computeSubjectPlacement(
  subject: SubjectSpec,
  layerW: number,
  layerH: number,
  canvasW: number,
  canvasH: number,
  baseline: number,
): Box {
  const zoneL = subject.zone.x * canvasW;
  const zoneR = (subject.zone.x + subject.zone.w) * canvasW;
  const limitL = zoneL - subject.overflow.left * canvasW;
  const limitR = zoneR + subject.overflow.right * canvasW;

  let h = subject.fitHeight.target * canvasH;
  let w = (layerW / layerH) * h;

  // Wider than the zone + overflow allows → shrink (validator later checks the
  // resulting height is still ≥ fitHeight.min).
  const maxW = limitR - limitL;
  if (w > maxW) {
    w = maxW;
    h = (layerH / layerW) * w;
  }

  let x: number;
  switch (subject.anchor) {
    case "bottom-left": {
      x = zoneL;
      if (x + w > limitR) x = limitR - w;
      if (x < limitL) x = limitL;
      break;
    }
    case "bottom-right": {
      x = zoneR - w;
      if (x < limitL) x = limitL;
      break;
    }
    case "bottom-center": {
      x = (zoneL + zoneR) / 2 - w / 2;
      if (x < limitL) x = limitL;
      if (x + w > limitR) x = limitR - w;
      break;
    }
  }

  // Feet on the ground line (общая базовая линия, RC2 fix).
  const y = baseline * canvasH - h;
  return { x, y, w, h };
}

/** Deterministic decor placement: bands minus core rects, seeded positions. */
export function computeDecorPlacements(
  spec: LayoutSpecData,
  decorDims: Array<{ width: number; height: number }>,
  canvasW: number,
  canvasH: number,
  rand: () => number,
): Array<Box | null> {
  const decorSpec = spec.decor;
  if (!decorSpec || decorSpec.bands.length === 0) return decorDims.map(() => null);
  const cores = (spec.safe?.coreRects ?? []).map((r) => fracRect(r, canvasW, canvasH));
  // Props scatter between minItemSize and maxItemSize of the canvas height;
  // without a min they keep the historical 55–100% of max spread.
  const minSize = decorSpec.minItemSize ?? decorSpec.maxItemSize * 0.55;

  // Props must not pile up on each other either (эталоны: они разнесены), so
  // every placement is also checked against the ones already placed.
  const placed: Box[] = [];
  return decorDims.map((dim, i) => {
    const band = fracRect(decorSpec.bands[i % decorSpec.bands.length]!, canvasW, canvasH);
    const sizeFactor = minSize + rand() * Math.max(0, decorSpec.maxItemSize - minSize);
    let h = Math.min(sizeFactor * canvasH, band.h);
    let w = (dim.width / dim.height) * h;
    if (w > band.w) {
      w = band.w;
      h = (dim.height / dim.width) * w;
    }
    for (let attempt = 0; attempt < 24; attempt++) {
      const x = band.x + rand() * (band.w - w);
      const y = band.y + rand() * (band.h - h);
      const box = { x, y, w, h };
      if (cores.some((c) => intersects(box, c))) continue;
      if (placed.some((p) => intersects(box, p))) continue;
      placed.push(box);
      return box;
    }
    return null; // no room left without collisions → skip this prop
  });
}

function fracRect(r: SpecRect, canvasW: number, canvasH: number): Box {
  return { x: r.x * canvasW, y: r.y * canvasH, w: r.w * canvasW, h: r.h * canvasH };
}

function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// ------------------------------------------------------------------
// Compositing
// ------------------------------------------------------------------

/** Node 22 typings split Buffer by backing store; sharp emits both flavors. */
type Bytes = Buffer<ArrayBufferLike>;

export interface EngineLayer {
  data: Bytes; // normalized transparent PNG (alpha-bbox trimmed, Phase 2)
  width: number; // bbox px
  height: number;
}

export interface ComposeInputs {
  /** Static admin asset (any size — cover-resized). Required only when the
   *  spec says `background.source === "static"`; with "transparent" the asset
   *  ships as an alpha PNG and this must be absent. */
  background?: Bytes;
  person: EngineLayer;
  /** Explicit item subject. When absent, the largest item PIECE takes the
   *  role (the spec decides whether there is an item subject at all). */
  item?: EngineLayer;
  /** Admin-uploaded static decor cutouts. */
  decor?: EngineLayer[];
  /** Connected blobs of the generated ITEM layer, largest first (layerSplit) —
   *  the props the эталоны scatter around the character. */
  itemPieces?: EngineLayer[];
}

export interface AssetMetadata {
  specKey: string;
  specVersion: number;
  seed: string;
  canvas: { w: number; h: number };
  /** Safe zone for the email template, percentages 0–100 of the image. */
  safeZonePct: { x: number; y: number; w: number; h: number } | null;
  /** Mean WCAG relative luminance of the safe zone (0–1) + its std dev. */
  luminance: number | null;
  luminanceStd: number | null;
  /** WCAG contrast ratios of the safe zone against white / near-black text. */
  textContrast: { white: number; dark: number } | null;
  recommendedTextColor: string | null;
  layers: {
    person: Box;
    item: Box | null;
    decorPlaced: number;
    decorSkipped: number;
  };
}

export interface ComposedScale {
  scale: number;
  width: number;
  height: number;
  png: Bytes;
}

export type ComposeResult =
  | {
      ok: true;
      scales: ComposedScale[];
      metadata: AssetMetadata;
      /** @1x overlay stack WITHOUT the background (transparent PNG): the
       *  validator's pixel truth for "is the safe zone actually clean". */
      overlayMask: Bytes;
    }
  | { ok: false; reason: string };

const PNG_OPTS = { compressionLevel: 9, adaptiveFiltering: false, palette: false } as const;

/** Resize a layer PNG and composite it onto the canvas, cropping the parts
 *  that bleed past the canvas edges (sharp rejects negative offsets). */
async function overlay(
  canvasPng: Bytes,
  layer: EngineLayer,
  box: Box,
  canvasW: number,
  canvasH: number,
): Promise<Bytes> {
  const w = Math.max(1, Math.round(box.w));
  const h = Math.max(1, Math.round(box.h));
  const x = Math.round(box.x);
  const y = Math.round(box.y);

  const visL = Math.max(0, x);
  const visT = Math.max(0, y);
  const visR = Math.min(canvasW, x + w);
  const visB = Math.min(canvasH, y + h);
  if (visR <= visL || visB <= visT) return canvasPng; // fully off-canvas

  let img = sharp(layer.data).resize(w, h, { fit: "fill", kernel: "lanczos3" });
  if (visL !== x || visT !== y || visR !== x + w || visB !== y + h) {
    img = sharp(await img.png(PNG_OPTS).toBuffer()).extract({
      left: visL - x,
      top: visT - y,
      width: visR - visL,
      height: visB - visT,
    });
  }
  const overlayPng = await img.png(PNG_OPTS).toBuffer();
  return sharp(canvasPng)
    .composite([{ input: overlayPng, left: visL, top: visT }])
    .png(PNG_OPTS)
    .toBuffer();
}

/** WCAG relative luminance stats over a region of the composite. */
async function safeZoneStats(
  png: Bytes,
  zone: Box,
): Promise<{ mean: number; std: number }> {
  const region = await sharp(png)
    .extract({
      left: Math.round(zone.x),
      top: Math.round(zone.y),
      width: Math.max(1, Math.round(zone.w)),
      height: Math.max(1, Math.round(zone.h)),
    })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { data, info } = region;
  const ch = info.channels;
  const n = info.width * info.height;
  let sum = 0;
  let sumSq = 0;
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  for (let i = 0; i < n; i++) {
    const o = i * ch;
    const L = 0.2126 * lin(data[o]!) + 0.7152 * lin(data[o + 1]!) + 0.0722 * lin(data[o + 2]!);
    sum += L;
    sumSq += L * L;
  }
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  return { mean, std: Math.sqrt(variance) };
}

function contrastRatio(l1: number, l2: number): number {
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE_L = 1.0;
const DARK_TEXT = "#111111";
const DARK_L = 0.0056; // relative luminance of #111111

/**
 * Compose the asset at every spec scale. Placement is computed once in @1x
 * fractional coordinates and multiplied per scale, so @2x is the SAME layout,
 * not a re-derived one.
 */
export async function composeAsset(
  spec: LayoutSpecData,
  specKey: string,
  specVersion: number,
  inputs: ComposeInputs,
  seedStr: string,
): Promise<ComposeResult> {
  const W = spec.canvas.w;
  const H = spec.canvas.h;

  const wantsBackground = spec.background.source === "static";
  if (wantsBackground && !inputs.background) {
    return { ok: false, reason: "background: spec requires a static background, none supplied" };
  }
  // The spec — not the caller — decides whether a background is baked in.
  const background = wantsBackground ? inputs.background : undefined;

  const personBox = computeSubjectPlacement(
    spec.subjects.person,
    inputs.person.width,
    inputs.person.height,
    W,
    H,
    spec.baseline,
  );
  // Item pieces (layerSplit): with an item subject in the spec the LARGEST
  // piece stands in its zone — как рожок в эталоне email — and the rest become
  // scattered props; without one (push/pop-up) every piece is a prop.
  const pieces = inputs.itemPieces ?? [];
  const itemSubject = spec.subjects.item ? (inputs.item ?? pieces[0]) : undefined;
  const leftoverPieces = inputs.item || !spec.subjects.item ? pieces : pieces.slice(1);

  const itemBox =
    spec.subjects.item && itemSubject
      ? computeSubjectPlacement(
          spec.subjects.item,
          itemSubject.width,
          itemSubject.height,
          W,
          H,
          spec.baseline,
        )
      : null;

  const rand = mulberry32(seedToInt(seedStr));
  const decorSource = spec.decor?.source ?? "static";
  const decorAll = [
    ...(decorSource === "static" || decorSource === "static+item" ? (inputs.decor ?? []) : []),
    ...(decorSource === "item" || decorSource === "static+item" ? leftoverPieces : []),
  ];
  const decor = decorAll.slice(0, spec.decor?.maxPieces ?? decorAll.length);

  // Seeded tilt per prop (эталоны: буквы и купюры лежат под углом). Rotating
  // BEFORE placement keeps the placement math working on the real bbox.
  const maxTilt = spec.decor?.rotationMaxDeg ?? 0;
  const decorLayers: EngineLayer[] = [];
  for (const layer of decor) {
    const angle = maxTilt > 0 ? Math.round((rand() * 2 - 1) * maxTilt) : 0;
    if (angle === 0) {
      decorLayers.push(layer);
      continue;
    }
    const rotated = await sharp(layer.data)
      .rotate(angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png(PNG_OPTS)
      .toBuffer({ resolveWithObject: true });
    decorLayers.push({
      data: rotated.data,
      width: rotated.info.width,
      height: rotated.info.height,
    });
  }

  const decorBoxes = computeDecorPlacements(
    spec,
    decorLayers.map((d) => ({ width: d.width, height: d.height })),
    W,
    H,
    rand,
  );

  const scales: ComposedScale[] = [];
  let overlayMask: Bytes | null = null;
  try {
    for (const scale of spec.canvas.scales) {
      const sw = W * scale;
      const sh = H * scale;

      // The overlay stack is built on a TRANSPARENT canvas first — it doubles
      // as the validator's alpha mask — then flattened onto the background.
      let overlays: Bytes = await sharp({
        create: { width: sw, height: sh, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .png(PNG_OPTS)
        .toBuffer();

      const mul = (b: Box): Box => ({ x: b.x * scale, y: b.y * scale, w: b.w * scale, h: b.h * scale });

      // z-order (TASK §3.1): background → decor → item → person.
      for (let i = 0; i < decorLayers.length; i++) {
        const box = decorBoxes[i];
        if (box) overlays = await overlay(overlays, decorLayers[i]!, mul(box), sw, sh);
      }
      if (itemSubject && itemBox) overlays = await overlay(overlays, itemSubject, mul(itemBox), sw, sh);
      overlays = await overlay(overlays, inputs.person, mul(personBox), sw, sh);
      if (scale === 1) overlayMask = overlays;

      // Transparent delivery: the overlay stack IS the asset — an alpha PNG of
      // the canonical size, empty everywhere the layers do not cover.
      const canvas: Bytes = background
        ? await sharp(background)
            .resize(sw, sh, { fit: "cover", position: "centre", kernel: "lanczos3" })
            .ensureAlpha()
            .composite([{ input: overlays, left: 0, top: 0 }])
            .png(PNG_OPTS)
            .toBuffer()
        : overlays;

      scales.push({ scale, width: sw, height: sh, png: canvas });
    }
  } catch (err) {
    return { ok: false, reason: `compose: ${err instanceof Error ? err.message : err}` };
  }
  if (!overlayMask) {
    // scales never include 1 only if the spec says so; use the first scale.
    overlayMask = await sharp(scales[0]!.png).ensureAlpha().png(PNG_OPTS).toBuffer();
  }

  // Metadata from the @1x composite (D-E1: вёрстка кладёт текст по этим числам).
  const base = scales.find((s) => s.scale === 1) ?? scales[0]!;
  let safeZonePct: AssetMetadata["safeZonePct"] = null;
  let luminance: number | null = null;
  let luminanceStd: number | null = null;
  let textContrast: AssetMetadata["textContrast"] = null;
  let recommendedTextColor: string | null = null;
  if (spec.safe) {
    const z = spec.safe.zone;
    safeZonePct = {
      x: Math.round(z.x * 1000) / 10,
      y: Math.round(z.y * 1000) / 10,
      w: Math.round(z.w * 1000) / 10,
      h: Math.round(z.h * 1000) / 10,
    };
  }
  // Luminance/contrast describe the BACKGROUND under the text. With a
  // transparent asset that background belongs to the письмо, not to us — the
  // numbers would be measured against empty pixels, so they stay null and the
  // validator's readability check (gated on textContrast) is skipped.
  if (spec.safe && wantsBackground) {
    const z = spec.safe.zone;
    // Readability is measured where the TEXT actually sits — per core rect,
    // worst case governs (decor bands inside the safe zone must not skew it).
    const regions = spec.safe.coreRects.length > 0 ? spec.safe.coreRects : [z];
    let meanSum = 0;
    let worstStd = 0;
    let worstWhite = Infinity;
    let worstDark = Infinity;
    for (const r of regions) {
      const stats = await safeZoneStats(base.png, fracRect(r, base.width, base.height));
      meanSum += stats.mean;
      if (stats.std > worstStd) worstStd = stats.std;
      const white = contrastRatio(WHITE_L, stats.mean);
      const dark = contrastRatio(DARK_L, stats.mean);
      if (white < worstWhite) worstWhite = white;
      if (dark < worstDark) worstDark = dark;
    }
    luminance = Math.round((meanSum / regions.length) * 1000) / 1000;
    luminanceStd = Math.round(worstStd * 1000) / 1000;
    textContrast = {
      white: Math.round(worstWhite * 100) / 100,
      dark: Math.round(worstDark * 100) / 100,
    };
    recommendedTextColor = textContrast.white >= textContrast.dark ? "#FFFFFF" : DARK_TEXT;
  }

  return {
    ok: true,
    scales,
    overlayMask,
    metadata: {
      specKey,
      specVersion,
      seed: seedStr,
      canvas: { w: W, h: H },
      safeZonePct,
      luminance,
      luminanceStd,
      textContrast,
      recommendedTextColor,
      layers: {
        person: roundBox(personBox),
        item: itemBox ? roundBox(itemBox) : null,
        decorPlaced: decorBoxes.filter(Boolean).length,
        decorSkipped: decorBoxes.filter((b) => !b).length,
      },
    },
  };
}

function roundBox(b: Box): Box {
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    w: Math.round(b.w),
    h: Math.round(b.h),
  };
}
