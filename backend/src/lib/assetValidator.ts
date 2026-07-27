import sharp from "sharp";
import type { LayoutSpecData, SpecRect } from "../services/layoutSpec.js";
import type { AssetMetadata, ComposedScale, Box } from "./composeEngine.js";

/**
 * Asset validator (TASK email-composition, Phase 4): автоприёмка каждого
 * рендера. Every check is tied to a Phase 0 defect class:
 *  - sizes            → 1206×606 / прозрачная рамка (current_gen)
 *  - safe-core-clean  → кластер item, заползший в текстовую зону (current_gen)
 *  - safe-coverage    → графика в safe-зоне сверх порога спеки
 *  - subject-position → item, висящий по центру вместо базовой линии (bad_result)
 *  - subject-scale    → пёс в 53% высоты вместо 74–86% (bad_result)
 *  - readability      → пёстрый золотой фон под текстом (bad_result)
 *  - golden-ssim      → структурное расхождение с эталонным композитом
 *
 * The safe-zone checks read the OVERLAY ALPHA MASK (composite without the
 * background) — the only pixel-honest way to tell placed graphics from the
 * background. Position/scale checks read the engine's layer boxes.
 */

type Bytes = Buffer<ArrayBufferLike>;

// Defaults when the spec's optional validation section is absent.
export const DEFAULT_MIN_CONTRAST = 4.5; // WCAG AA
export const DEFAULT_MAX_LUMINANCE_STD = 0.16;
export const DEFAULT_MIN_SSIM = 0.55;
/** Alpha ≥ this counts as opaque coverage in the soft safe zone. */
export const COVERAGE_ALPHA = 128;
/** Alpha ≥ this inside a CORE rect is a violation (stricter: halos count). */
export const CORE_ALPHA = 16;
/** Geometry tolerance, px on the @1x canvas. */
export const POSITION_TOLERANCE_PX = 2;
/** Baseline tolerance as a fraction of canvas height. */
export const BASELINE_TOLERANCE = 0.02;

export interface ValidationCheck {
  key: string;
  passed: boolean;
  detail: string;
}

export interface ValidationReport {
  passed: boolean;
  checks: ValidationCheck[];
  failedKeys: string[];
}

export interface ValidateInputs {
  scales: ComposedScale[];
  metadata: AssetMetadata;
  overlayMask: Bytes;
  /** Golden reference composite @1x (Phase 6 supplies the assets). */
  golden?: Bytes;
}

/** Sanity gate for the shared person layer (stage A auto-retry, Phase 4):
 *  a full-body standing character cutout is portrait-shaped. */
export const PERSON_ASPECT_MIN = 0.25;
export const PERSON_ASPECT_MAX = 1.1;
export function personLayerSanity(width: number, height: number): { ok: boolean; reason: string } {
  const aspect = width / height;
  if (aspect > PERSON_ASPECT_MAX) {
    return {
      ok: false,
      reason: `person layer is landscape-shaped (${width}×${height}, aspect ${aspect.toFixed(2)}) — not a full-body character`,
    };
  }
  if (aspect < PERSON_ASPECT_MIN) {
    return {
      ok: false,
      reason: `person layer is a sliver (${width}×${height}, aspect ${aspect.toFixed(2)}) — cutout likely broken`,
    };
  }
  return { ok: true, reason: "" };
}

export async function validateComposedAsset(
  spec: LayoutSpecData,
  inputs: ValidateInputs,
): Promise<ValidationReport> {
  const W = spec.canvas.w;
  const H = spec.canvas.h;
  const checks: ValidationCheck[] = [];

  // 1) Exact sizes at every scale (D-E2).
  for (const s of inputs.scales) {
    const meta = await sharp(s.png).metadata();
    const ok = meta.width === W * s.scale && meta.height === H * s.scale;
    checks.push({
      key: `size@${s.scale}x`,
      passed: ok,
      detail: ok
        ? `${meta.width}×${meta.height}`
        : `got ${meta.width}×${meta.height}, want ${W * s.scale}×${H * s.scale}`,
    });
  }

  // 2) Safe-zone pixel truth from the overlay alpha mask.
  if (spec.safe) {
    const mask = await sharp(inputs.overlayMask)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const alphaAt = (x: number, y: number) => mask.data[(y * mask.info.width + x) * 4 + 3]!;

    const countAlpha = (r: SpecRect, threshold: number) => {
      const x0 = Math.max(0, Math.floor(r.x * W));
      const y0 = Math.max(0, Math.floor(r.y * H));
      const x1 = Math.min(mask.info.width, Math.ceil((r.x + r.w) * W));
      const y1 = Math.min(mask.info.height, Math.ceil((r.y + r.h) * H));
      let hit = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) if (alphaAt(x, y) >= threshold) hit++;
      return { hit, total: Math.max(1, (x1 - x0) * (y1 - y0)) };
    };

    let coreViolations = 0;
    for (const core of spec.safe.coreRects) coreViolations += countAlpha(core, CORE_ALPHA).hit;
    checks.push({
      key: "safe-core-clean",
      passed: coreViolations === 0,
      detail:
        coreViolations === 0
          ? "0 opaque pixels in text envelopes"
          : `${coreViolations} opaque px inside text envelopes (must be 0)`,
    });

    const cov = countAlpha(spec.safe.zone, COVERAGE_ALPHA);
    const coverage = cov.hit / cov.total;
    checks.push({
      key: "safe-coverage",
      passed: coverage <= spec.safe.maxCoverage,
      detail: `${(coverage * 100).toFixed(1)}% of safe zone covered (max ${(spec.safe.maxCoverage * 100).toFixed(0)}%)`,
    });
  }

  // 3–4) Subject position, baseline and scale from the engine boxes.
  const subjects: Array<[string, Box | null, (typeof spec.subjects)["person"] | undefined]> = [
    ["person", inputs.metadata.layers.person, spec.subjects.person],
    // push/pop-up have no item subject — their props are scattered decor.
    ["item", inputs.metadata.layers.item, spec.subjects.item],
  ];
  for (const [name, box, subj] of subjects) {
    if (!box || !subj) continue;
    const limitL = (subj.zone.x - subj.overflow.left) * W - POSITION_TOLERANCE_PX;
    const limitR = (subj.zone.x + subj.zone.w + subj.overflow.right) * W + POSITION_TOLERANCE_PX;
    const inZone = box.x >= limitL && box.x + box.w <= limitR;
    const baselineY = spec.baseline * H;
    const baselineOk = Math.abs(box.y + box.h - baselineY) <= BASELINE_TOLERANCE * H;
    checks.push({
      key: `${name}-position`,
      passed: inZone && baselineOk,
      detail:
        inZone && baselineOk
          ? `x ${box.x}..${box.x + box.w}, bottom ${box.y + box.h}`
          : `x ${box.x}..${box.x + box.w} (allowed ${Math.round(limitL)}..${Math.round(limitR)}), ` +
            `bottom ${box.y + box.h} vs baseline ${Math.round(baselineY)}±${Math.round(BASELINE_TOLERANCE * H)}`,
    });

    const minH = subj.fitHeight.min * H - POSITION_TOLERANCE_PX;
    const maxH = subj.fitHeight.max * H + POSITION_TOLERANCE_PX;
    const scaleOk = box.h >= minH && box.h <= maxH;
    checks.push({
      key: `${name}-scale`,
      passed: scaleOk,
      detail: scaleOk
        ? `height ${box.h}px (${((box.h / H) * 100).toFixed(0)}% of canvas)`
        : `height ${box.h}px = ${((box.h / H) * 100).toFixed(0)}% of canvas, want ${(
            subj.fitHeight.min * 100
          ).toFixed(0)}–${(subj.fitHeight.max * 100).toFixed(0)}%`,
    });
  }

  // 5) Readability of the planned text color (per worst core rect, engine metadata).
  if (spec.safe && inputs.metadata.textContrast) {
    const minContrast = spec.validation?.minContrast ?? DEFAULT_MIN_CONTRAST;
    const maxStd = spec.validation?.maxLuminanceStd ?? DEFAULT_MAX_LUMINANCE_STD;
    const best = Math.max(inputs.metadata.textContrast.white, inputs.metadata.textContrast.dark);
    const contrastOk = best >= minContrast;
    const stdOk = (inputs.metadata.luminanceStd ?? 0) <= maxStd;
    checks.push({
      key: "readability",
      passed: contrastOk && stdOk,
      detail:
        `contrast ${best.toFixed(2)}:1 (min ${minContrast}), ` +
        `luminance std ${inputs.metadata.luminanceStd} (max ${maxStd})`,
    });
  }

  // 6) Structural similarity vs the golden composite (optional).
  if (inputs.golden) {
    const minSsim = spec.validation?.minSsim ?? DEFAULT_MIN_SSIM;
    const base = inputs.scales.find((s) => s.scale === 1) ?? inputs.scales[0]!;
    const value = await ssim(base.png, inputs.golden);
    checks.push({
      key: "golden-ssim",
      passed: value >= minSsim,
      detail: `SSIM ${value.toFixed(3)} (min ${minSsim})`,
    });
  }

  const failed = checks.filter((c) => !c.passed);
  return { passed: failed.length === 0, checks, failedKeys: failed.map((c) => c.key) };
}

/**
 * Global SSIM on 64×32 grayscale downscales — structural layout comparison,
 * deliberately insensitive to per-brand colors/characters (TASK §4 Фаза 4 п.6).
 */
export async function ssim(a: Bytes, b: Bytes): Promise<number> {
  const SW = 64;
  const SH = 32;
  const gray = async (buf: Bytes) =>
    (
      await sharp(buf)
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .resize(SW, SH, { fit: "fill", kernel: "lanczos3" })
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true })
    ).data;
  const ga = await gray(a);
  const gb = await gray(b);
  const n = SW * SH;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += ga[i]!;
    mb += gb[i]!;
  }
  ma /= n;
  mb /= n;
  let va = 0;
  let vb = 0;
  let cov = 0;
  for (let i = 0; i < n; i++) {
    const da = ga[i]! - ma;
    const db = gb[i]! - mb;
    va += da * da;
    vb += db * db;
    cov += da * db;
  }
  va /= n - 1;
  vb /= n - 1;
  cov /= n - 1;
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  return ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
}
