import { z } from "zod";
import { prisma } from "../lib/prisma.js";

/**
 * Layout spec — the deterministic-composition contract (TASK email-composition,
 * Phase 1; R-PLAN §2). All geometry is fractions of the canvas (0..1) so the
 * same spec stays valid at @1x and @2x. The composition engine (Phase 3) and
 * the validator (Phase 4) both read ONLY this structure — no magic numbers in
 * code, no `if (brand === ...)`.
 *
 * Calibration source: `figma/crm-bundle/example email with text.PNG`
 * (1325×664), measured by pixel scan 2026-07-27:
 *   - item cluster x 2.6–24% of W, top ≈ 30% H;
 *   - person x 74.9–99.8% of W (touches the right edge), hair top ≈ 12% H;
 *   - both stand on a common ground line ≈ 92% H (reflection below it);
 *   - central 25–75% is the offer area; decor enters it only in the top band
 *     (y < 24%) and the two bottom corners, never over the text envelopes.
 */

const frac = z.number().min(0).max(1);

export const rectSchema = z
  .object({ x: frac, y: frac, w: frac, h: frac })
  .refine((r) => r.x + r.w <= 1.0001 && r.y + r.h <= 1.0001, {
    message: "rect must stay inside the canvas (x+w<=1, y+h<=1)",
  });
export type SpecRect = z.infer<typeof rectSchema>;

const fitHeightSchema = z
  .object({ min: frac, target: frac, max: frac })
  .refine((f) => f.min <= f.target && f.target <= f.max, {
    message: "fitHeight must satisfy min <= target <= max",
  });

/** Allowed bleed OUTSIDE the subject zone, fractions of canvas W/H per side. */
const overflowSchema = z.object({
  left: z.number().min(0).max(0.5).default(0),
  right: z.number().min(0).max(0.5).default(0),
  top: z.number().min(0).max(0.5).default(0),
  bottom: z.number().min(0).max(0.5).default(0),
});

export const subjectSpecSchema = z.object({
  zone: rectSchema,
  anchor: z.enum(["bottom-left", "bottom-center", "bottom-right"]),
  // Subject height after fit, as a fraction of CANVAS height (not zone width —
  // that was root cause RC1). The engine scales the alpha-bbox to `target`,
  // the validator accepts anything inside [min, max].
  fitHeight: fitHeightSchema,
  overflow: overflowSchema,
});
export type SubjectSpec = z.infer<typeof subjectSpecSchema>;

export const layoutSpecSchema = z.object({
  canvas: z.object({
    w: z.number().int().min(64).max(4096),
    h: z.number().int().min(64).max(4096),
    // Output scale factors: [1, 2] → 1200×600 + 2400×1200 retina (D-E2).
    scales: z.array(z.number().int().min(1).max(4)).nonempty(),
  }),
  // DI-Q6: the background is a static admin-uploaded asset shared by all
  // brands; the engine never generates it.
  background: z.object({ source: z.enum(["static"]) }),
  // Common ground line both subjects stand on, fraction of canvas height.
  baseline: frac,
  subjects: z.object({
    item: subjectSpecSchema,
    person: subjectSpecSchema,
  }),
  // Optional: push/popup have no protected text area (their specs omit it).
  safe: z
    .object({
      // Soft zone: opaque overlay coverage must stay <= maxCoverage.
      zone: rectSchema,
      maxCoverage: frac,
      // Hard text envelopes: 0 opaque overlay pixels allowed (validator core
      // check). Decor placement must subtract these from its bands.
      coreRects: z.array(rectSchema),
    })
    .optional(),
  decor: z
    .object({
      // Bands where decor may be placed (minus safe.coreRects).
      bands: z.array(rectSchema),
      // Max decor element height, fraction of canvas height.
      maxItemSize: frac,
      // Layout randomness must be seeded per asset → reproducible.
      seeded: z.literal(true),
    })
    .optional(),
  // Validator thresholds (Phase 4). Optional — the validator falls back to
  // its built-in defaults when the section (or a field) is absent.
  validation: z
    .object({
      // WCAG contrast of the recommended text color vs the worst core rect.
      minContrast: z.number().min(1).max(21).optional(),
      // Max luminance std dev inside a core rect («пёстрый» фон под текстом).
      maxLuminanceStd: frac.optional(),
      // Min structural similarity against the golden composite (when set).
      minSsim: frac.optional(),
    })
    .optional(),
});
export type LayoutSpecData = z.infer<typeof layoutSpecSchema>;

/** Parse + validate a spec payload; throws ZodError with readable issues. */
export function validateLayoutSpec(data: unknown): LayoutSpecData {
  return layoutSpecSchema.parse(data);
}

// ------------------------------------------------------------------
// email.hero v1 — calibrated against the customer's reference (see header).
// Seeded create-only; later versions are created from the admin panel.
// ------------------------------------------------------------------

export const EMAIL_HERO_KEY = "email.hero";

export const EMAIL_HERO_V1: LayoutSpecData = {
  canvas: { w: 1200, h: 600, scales: [1, 2] },
  background: { source: "static" },
  baseline: 0.92,
  subjects: {
    // Cone: measured x 2.6–24%, top ≈30% H → height ≈0.62 H, centered in the
    // left quarter, feet on the ground line, small bleed allowance only.
    item: {
      zone: { x: 0, y: 0, w: 0.25, h: 1 },
      anchor: "bottom-center",
      fitHeight: { min: 0.55, target: 0.62, max: 0.68 },
      overflow: { left: 0.04, right: 0, top: 0, bottom: 0.02 },
    },
    // Character: measured x 74.9–99.8% (pressed to the right edge, may be
    // cropped by it), hair top ≈12% H → height ≈0.80 H on the same line.
    person: {
      zone: { x: 0.75, y: 0, w: 0.25, h: 1 },
      anchor: "bottom-right",
      fitHeight: { min: 0.74, target: 0.8, max: 0.86 },
      overflow: { left: 0, right: 0.05, top: 0, bottom: 0.03 },
    },
  },
  safe: {
    zone: { x: 0.25, y: 0.04, w: 0.5, h: 0.92 },
    maxCoverage: 0.1,
    coreRects: [
      // "UP TO" line (narrow, top-center).
      { x: 0.4, y: 0.08, w: 0.2, h: 0.18 },
      // Amount + "+N FREE SPINS" block (the widest envelope).
      { x: 0.26, y: 0.26, w: 0.48, h: 0.42 },
      // CTA button.
      { x: 0.36, y: 0.7, w: 0.28, h: 0.2 },
    ],
  },
  decor: {
    bands: [
      // Center-top band (banknote/coins in the reference).
      { x: 0.25, y: 0, w: 0.5, h: 0.24 },
      // Bottom corners of the center (coin left, banknote right).
      { x: 0.25, y: 0.68, w: 0.12, h: 0.28 },
      { x: 0.6, y: 0.68, w: 0.15, h: 0.28 },
    ],
    maxItemSize: 0.22,
    seeded: true,
  },
  validation: {
    minContrast: 4.5, // WCAG AA (TASK §4 Фаза 4, п.5)
    maxLuminanceStd: 0.16,
    minSsim: 0.55,
  },
};

// ------------------------------------------------------------------
// DB access
// ------------------------------------------------------------------

export interface LayoutSpecRow {
  id: string;
  key: string;
  version: number;
  spec: LayoutSpecData;
  isActive: boolean;
}

/**
 * Latest ACTIVE version for a key (render path). Old bundles that stored a
 * specific version keep using it — resolve those via getLayoutSpecVersion.
 */
export async function getActiveLayoutSpec(key: string): Promise<LayoutSpecRow | null> {
  const row = await prisma.layoutSpec.findFirst({
    where: { key, isActive: true },
    orderBy: { version: "desc" },
  });
  if (!row) return null;
  return { ...row, spec: validateLayoutSpec(row.spec) };
}

/** Exact pinned version (re-render of an existing bundle). */
export async function getLayoutSpecVersion(
  key: string,
  version: number,
): Promise<LayoutSpecRow | null> {
  const row = await prisma.layoutSpec.findUnique({
    where: { key_version: { key, version } },
  });
  if (!row) return null;
  return { ...row, spec: validateLayoutSpec(row.spec) };
}

/**
 * Create the next version for a key (admin "save as new version"). Versions
 * are immutable — there is deliberately no update path for `spec`.
 */
export async function createLayoutSpecVersion(
  key: string,
  spec: LayoutSpecData,
  createdBy?: string,
): Promise<LayoutSpecRow> {
  const last = await prisma.layoutSpec.findFirst({
    where: { key },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const row = await prisma.layoutSpec.create({
    data: {
      key,
      version: (last?.version ?? 0) + 1,
      spec,
      createdBy: createdBy ?? null,
    },
  });
  return { ...row, spec: validateLayoutSpec(row.spec) };
}
