import sharp from "sharp";
import type { OutputInfo } from "sharp";

/**
 * Layer normalization (TASK email-composition, Phase 2; R-PLAN §4, RC7).
 * Turns a raw cutout into the composition engine's input contract: a PNG with
 * a real alpha channel, trimmed EXACTLY to the subject's alpha-bbox, with
 * semi-transparent halo debris removed. Pure buffer→buffer, no network — the
 * orchestration (download, BR fallback, upload, cache) lives in
 * services/layerCache.ts.
 *
 * Determinism: fixed decode→raw→encode pipeline and fixed PNG encoder options
 * — the same input bytes produce the same output bytes (sharp is pinned exact
 * in package.json; bump = re-baseline golden files, risk R4).
 */

/** Alpha below this is halo/debris → clamped to fully transparent. */
export const ALPHA_NOISE_THRESHOLD = 32;
/** Alpha at/above this counts as subject when measuring coverage. */
export const ALPHA_OPAQUE = 128;
/** Subject must cover at least this share of the source frame, else the
 *  cutout is junk (background removal ate the subject). */
export const MIN_SUBJECT_AREA = 0.02;
/** Share of transparent pixels for an alpha channel to count as REAL
 *  transparency (JPEG→PNG conversions have alpha=255 everywhere). */
export const MIN_USEFUL_TRANSPARENCY = 0.05;

export interface NormalizedLayerImage {
  ok: true;
  png: Buffer; // trimmed transparent PNG
  width: number; // alpha-bbox width, px
  height: number; // alpha-bbox height, px
  /** Subject pixels / bbox area — low values signal a ragged/halo-heavy cutout. */
  opaqueRatio: number;
}
export interface NormalizeFailure {
  ok: false;
  reason: string;
}

/**
 * True when the image has an alpha channel that actually cuts anything out.
 * False → the caller must run background removal (fallback of TASK §3.3).
 */
export async function hasUsefulAlpha(input: Buffer): Promise<boolean> {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const total = info.width * info.height;
  if (total === 0) return false;
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i]! < ALPHA_OPAQUE) transparent++;
  }
  return transparent / total >= MIN_USEFUL_TRANSPARENCY;
}

/**
 * Clamp halo alpha, find the subject alpha-bbox, crop to it, re-encode PNG.
 * The bbox is computed from CLEANED alpha, so stray semi-transparent debris
 * far from the subject cannot inflate the bbox (that inflation is exactly how
 * the subject ended up mis-scaled — RC1/RC7).
 */
export async function normalizeLayer(
  input: Buffer,
): Promise<NormalizedLayerImage | NormalizeFailure> {
  let decoded: { data: Buffer; info: OutputInfo };
  try {
    decoded = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  } catch (err) {
    return { ok: false, reason: `decode failed: ${err instanceof Error ? err.message : err}` };
  }
  const { data, info } = decoded;
  const { width: w, height: h } = info;

  let minX = w;
  let maxX = -1;
  let minY = h;
  let maxY = -1;
  let subjectPx = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ai = (y * w + x) * 4 + 3;
      const a = data[ai]!;
      if (a < ALPHA_NOISE_THRESHOLD) {
        data[ai] = 0; // kill halo/debris
        continue;
      }
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (a >= ALPHA_OPAQUE) subjectPx++;
    }
  }

  if (maxX < 0) return { ok: false, reason: "empty layer: no subject pixels after alpha cleanup" };
  if (subjectPx / (w * h) < MIN_SUBJECT_AREA) {
    return {
      ok: false,
      reason: `subject too small: ${((subjectPx / (w * h)) * 100).toFixed(2)}% of frame (min ${MIN_SUBJECT_AREA * 100}%)`,
    };
  }

  const bboxW = maxX - minX + 1;
  const bboxH = maxY - minY + 1;
  const png = await sharp(data, { raw: { width: w, height: h, channels: 4 } })
    .extract({ left: minX, top: minY, width: bboxW, height: bboxH })
    .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
    .toBuffer();

  return {
    ok: true,
    png,
    width: bboxW,
    height: bboxH,
    opaqueRatio: subjectPx / (bboxW * bboxH),
  };
}

/**
 * П5 «поясной кроп» (Задание 2, DV-C3). Оставляет верхнюю долю уже
 * нормализованного слоя и заново обрезает результат по его собственному
 * альфа-bbox: у поясного плана силуэт уже, чем у фигуры в полный рост, и без
 * повторного трима по бокам осталась бы пустота, которая врёт масштабу.
 *
 * Зачем кодом, а не отдельной генерацией: слой персонажа ОДИН на email, push и
 * pop-up (stage A `prepare-variant`). Резать копию дешевле, чем генерировать
 * второго персонажа на каждый brand-variant, и результат детерминирован.
 *
 * Проверять, что после реза субъект остался портретным, обязан вызывающий
 * (`personLayerSanity`): рез по доле не знает, где у фигуры пояс, и на
 * нетиповой позе может попасть по рукам.
 */
export async function cropLayerTop(
  input: Buffer,
  fraction: number,
): Promise<NormalizedLayerImage | NormalizeFailure> {
  if (!(fraction > 0) || fraction > 1) {
    return { ok: false, reason: `cropTopFraction must be in (0, 1], got ${fraction}` };
  }
  if (fraction === 1) return normalizeLayer(input);

  let meta: { width?: number; height?: number };
  try {
    meta = await sharp(input).metadata();
  } catch (err) {
    return { ok: false, reason: `decode failed: ${err instanceof Error ? err.message : err}` };
  }
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (w < 1 || h < 1) return { ok: false, reason: "empty layer: zero-sized input" };

  const keep = Math.max(1, Math.round(h * fraction));
  let top: Buffer;
  try {
    top = await sharp(input)
      .ensureAlpha()
      .extract({ left: 0, top: 0, width: w, height: keep })
      .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
      .toBuffer();
  } catch (err) {
    return { ok: false, reason: `crop failed: ${err instanceof Error ? err.message : err}` };
  }
  // Повторный проход снимает боковые поля и чистит альфу того же среза.
  return normalizeLayer(top);
}
