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
  // "transparent" (DI-Q6 v2, требование заказчика): the asset is delivered as
  // an alpha PNG — subjects and decor on an empty canvas, the письмо/пуш puts
  // its own background underneath. "static" keeps the admin-uploaded neutral
  // background baked in. The engine never GENERATES a background either way.
  background: z.object({ source: z.enum(["transparent", "static"]) }),
  // Common ground line both subjects stand on, fraction of canvas height.
  baseline: frac,
  subjects: z.object({
    // Optional: push/pop-up (эталоны 2026-07-27) have no standing item cluster
    // — every object is scattered decor around the centered character.
    item: subjectSpecSchema.optional(),
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
      // Min decor element height — keeps scattered props from shrinking into
      // specks on large bands (fraction of canvas height).
      minItemSize: frac.optional(),
      // Layout randomness must be seeded per asset → reproducible.
      seeded: z.literal(true),
      // Where the scattered props come from: admin-uploaded PNGs ("static"),
      // the connected blobs of the generated ITEM layer ("item"), or both.
      // "item" is what the push/pop-up эталоны show: A/J/Q letters and
      // banknotes cut out of one generation and thrown around the character.
      source: z.enum(["static", "item", "static+item"]).optional(),
      // Cap on scattered props per asset (the splitter can return more).
      maxPieces: z.number().int().min(0).max(24).optional(),
      // Seeded tilt of each prop, ±degrees (эталоны: notes/letters ~±25°).
      rotationMaxDeg: z.number().min(0).max(180).optional(),
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

/**
 * email.hero v2 — доставка с ПРОЗРАЧНЫМ фоном (требование заказчика, отменяет
 * DI-Q6 «общий статичный фон»): ассет отдаётся PNG с альфой, фон под текстом
 * кладёт письмо. Геометрия та же, кроме допуска item влево: 6% вместо 4% —
 * это значение и было зафиксировано в Фазе 0 (DI-Q5), а широкая гроздь
 * объектов при 4% упиралась в ширину зоны и не добирала минимальную высоту.
 */
export const EMAIL_HERO_V2: LayoutSpecData = {
  ...EMAIL_HERO_V1,
  // Один масштаб = один файл в Cloudinary (требование заказчика 2026-07-27,
  // уточняет D-E2): retina-копии не хранятся. Вернуть @2x = добавить 2 в
  // `scales` новой версией спеки, деплой не нужен.
  canvas: { ...EMAIL_HERO_V1.canvas, scales: [1] },
  background: { source: "transparent" },
  subjects: {
    ...EMAIL_HERO_V1.subjects,
    item: {
      ...EMAIL_HERO_V1.subjects.item!,
      overflow: { ...EMAIL_HERO_V1.subjects.item!.overflow, left: 0.06 },
    },
  },
  // Эталон email: крупный предмет стоит слева, а мелочь (монеты, купюры,
  // проценты) разбросана по периферии — это те же куски ITEM-слоя, что и в
  // push/pop-up, только самый крупный из них становится левым субъектом.
  decor: {
    ...EMAIL_HERO_V1.decor!,
    minItemSize: 0.1,
    source: "static+item",
    maxPieces: 4,
    rotationMaxDeg: 15,
  },
};

// ------------------------------------------------------------------
// push / pop-up — те же структуры, что и email (TASK Фаза 1: «модель обязана
// их принимать»). Раскладка повторяет ai-режим этих типов: персонаж по центру
// во весь рост, объекты слева, декор по краям, защищённой зоны под текст НЕТ.
// Фон прозрачный. Значения — первая калибровка «от описания», а не от эталона:
// правятся в админке новой версией, без деплоя.
// ------------------------------------------------------------------

/**
 * push.hero v1 — откалибровано по `figma/crm-bundle/push-эталон.png`
 * (1024×512, пиксельный скан 2026-07-27, фон-подложка отфильтрована по цвету):
 *   - персонаж по центру, x 0.29–0.69, y 0.025–0.949 → высота ≈0.92 H,
 *     базовая линия ≈0.95 H (низ не подрезан краем);
 *   - реквизит (буквы A/J/Q, купюры) разбросан по левой и правой третям,
 *     высоты 0.12–0.38 H, часть подрезана краями холста, наклон ~±25°;
 *   - защищённой зоны под текст нет.
 */
export const PUSH_HERO_KEY = "push.hero";

export const PUSH_HERO_V1: LayoutSpecData = {
  canvas: { w: 1024, h: 512, scales: [1] },
  background: { source: "transparent" },
  baseline: 0.95,
  subjects: {
    person: {
      zone: { x: 0.28, y: 0, w: 0.44, h: 1 },
      anchor: "bottom-center",
      fitHeight: { min: 0.85, target: 0.92, max: 0.98 },
      overflow: { left: 0.04, right: 0.04, top: 0, bottom: 0.02 },
    },
  },
  decor: {
    // Левая и правая трети, вплотную к краям (в эталоне купюры подрезаны).
    bands: [
      { x: 0.02, y: 0.04, w: 0.26, h: 0.9 },
      { x: 0.7, y: 0.04, w: 0.28, h: 0.9 },
    ],
    maxItemSize: 0.38,
    minItemSize: 0.14,
    seeded: true,
    source: "static+item",
    maxPieces: 6,
    rotationMaxDeg: 25,
  },
  validation: { minSsim: 0.55 },
};

/**
 * popup.hero v1 — откалибровано по `figma/crm-bundle/pop-up эталон.png`
 * (800×600, тот же скан): персонаж по центру x 0.28–0.72, y 0.072–0.948 →
 * высота ≈0.88 H на базовой линии ≈0.95 H; реквизит 0.10–0.35 H по левому и
 * правому краям, часть уходит за край; защищённой зоны нет.
 */
export const POPUP_HERO_KEY = "popup.hero";

export const POPUP_HERO_V1: LayoutSpecData = {
  canvas: { w: 800, h: 600, scales: [1] },
  background: { source: "transparent" },
  baseline: 0.95,
  subjects: {
    person: {
      zone: { x: 0.28, y: 0, w: 0.44, h: 1 },
      anchor: "bottom-center",
      fitHeight: { min: 0.8, target: 0.88, max: 0.95 },
      overflow: { left: 0.04, right: 0.04, top: 0, bottom: 0.02 },
    },
  },
  decor: {
    bands: [
      { x: 0, y: 0.06, w: 0.28, h: 0.88 },
      { x: 0.72, y: 0.06, w: 0.28, h: 0.88 },
    ],
    maxItemSize: 0.35,
    minItemSize: 0.13,
    seeded: true,
    source: "static+item",
    maxPieces: 6,
    rotationMaxDeg: 25,
  },
  validation: { minSsim: 0.55 },
};

/** assetKey → spec key when the bundle type config does not pin one. */
export const SPEC_KEY_BY_ASSET: Record<string, string> = {
  email: EMAIL_HERO_KEY,
  push: PUSH_HERO_KEY,
  popup: POPUP_HERO_KEY,
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
