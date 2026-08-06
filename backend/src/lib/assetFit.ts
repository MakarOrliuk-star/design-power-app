import { runBriaExpand } from "./fal.js";
import { uploadFromUrl, uploadFromUrlTransformed, withRetry } from "./cloudinary.js";
import { probeImageSize } from "./imageSize.js";

/**
 * Подгонка сгенерированной картинки к точному канвасу маски (D5).
 * Вынесено из queues/bundle.processor.ts без изменений (TASK ai-reference):
 * новый пайплайн ai_reference живёт в services/ и не может импортировать
 * процессор (цикл); процессор ре-экспортирует всё отсюда — внешние импорты
 * и тесты работают как раньше.
 */

/**
 * Center the generated image inside the exact target canvas: scale to fit
 * (contain), Bria outpaints the remaining margins. Pure — unit-tested.
 */
export function computeCanvasPlacement(
  srcW: number,
  srcH: number,
  targetW: number,
  targetH: number,
): { canvasW: number; canvasH: number; imgW: number; imgH: number; originX: number; originY: number } {
  const scale = Math.min(targetW / srcW, targetH / srcH);
  const imgW = Math.min(targetW, Math.round(srcW * scale));
  const imgH = Math.min(targetH, Math.round(srcH * scale));
  return {
    canvasW: targetW,
    canvasH: targetH,
    imgW,
    imgH,
    originX: Math.round((targetW - imgW) / 2),
    originY: Math.round((targetH - imgH) / 2),
  };
}

// Bria's outpaint can leave a feathered/semi-transparent seam along the outer
// canvas edges (видимая «прозрачная рамка» на живом прогоне). The fix: expand
// onto a canvas BLEED px larger on every side, then center-crop back to the
// exact target at upload time — the artifact ring is cut away deterministically.
export const EXPAND_BLEED = 32;

/** Placement for the bleed-expanded canvas (target + BLEED on each side). */
export function computeBleedPlacement(
  srcW: number,
  srcH: number,
  targetW: number,
  targetH: number,
  bleed = EXPAND_BLEED,
): { canvasW: number; canvasH: number; imgW: number; imgH: number; originX: number; originY: number } {
  const inner = computeCanvasPlacement(srcW, srcH, targetW, targetH);
  return {
    canvasW: targetW + 2 * bleed,
    canvasH: targetH + 2 * bleed,
    imgW: inner.imgW,
    imgH: inner.imgH,
    originX: inner.originX + bleed,
    originY: inner.originY + bleed,
  };
}

export const EXPAND_PROMPT =
  "Seamlessly continue the existing background scene into the new margins, matching its colors, lighting and texture exactly. No borders, no frames, no empty or transparent areas.";

/** Two sizes have the same aspect ratio (within a pixel-rounding tolerance). */
function sameAspect(w1: number, h1: number, w2: number, h2: number): boolean {
  return Math.abs(w1 / h1 - w2 / h2) < 0.01;
}

/**
 * Fit a generated image to the exact mask canvas (D5) and store it:
 * - exact size → plain upload;
 * - same aspect → Cloudinary incoming resize (`c_fill`), no extra fal call;
 * - different aspect → bleed-expand via Bria, then signed incoming
 *   center-crop back to the target (cuts the outpaint edge artifacts).
 */
export async function fitAndStoreAsset(
  sourceUrl: string,
  targetW: number,
  targetH: number,
  fileName: string,
  folder: string,
  retryLabel: string,
): Promise<{ ok: true; url: string; publicId: string } | { ok: false; reason: string }> {
  const size = await probeImageSize(sourceUrl);
  if (!size) return { ok: false, reason: "probe: could not read the generated image size" };

  let uploadCall: () => ReturnType<typeof uploadFromUrl>;
  if (size.width === targetW && size.height === targetH) {
    uploadCall = () => uploadFromUrl(sourceUrl, fileName, folder);
  } else if (sameAspect(size.width, size.height, targetW, targetH)) {
    uploadCall = () =>
      uploadFromUrlTransformed(sourceUrl, fileName, folder, `c_fill,w_${targetW},h_${targetH}`);
  } else {
    const placement = computeBleedPlacement(size.width, size.height, targetW, targetH);
    const expanded = await runBriaExpand(sourceUrl, { ...placement, prompt: EXPAND_PROMPT });
    if (!expanded.success || !expanded.imageUrl) {
      return { ok: false, reason: `expand: ${expanded.error ?? "unknown"}` };
    }
    const expandedUrl = expanded.imageUrl;
    uploadCall = () =>
      uploadFromUrlTransformed(expandedUrl, fileName, folder, `c_crop,g_center,w_${targetW},h_${targetH}`);
  }

  const up = await withRetry(uploadCall, retryLabel);
  if (!up.success || !up.secure_url) return { ok: false, reason: `upload: ${up.error ?? "unknown"}` };

  // D5 guarantee: the STORED asset is exactly the canonical canvas.
  const finalSize = await probeImageSize(up.secure_url);
  if (finalSize && (finalSize.width !== targetW || finalSize.height !== targetH)) {
    return {
      ok: false,
      reason: `size mismatch: got ${finalSize.width}×${finalSize.height}, want ${targetW}×${targetH}`,
    };
  }
  return { ok: true, url: up.secure_url, publicId: up.public_id ?? "" };
}
