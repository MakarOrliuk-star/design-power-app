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
  // П5 «поясной кроп» через пост-кроп кодом (DV-C3): слой персонажа остаётся
  // ОДИН на все три ассета (полный рост), а email оставляет от его альфа-bbox
  // верхнюю долю. Отсутствует → слой берётся целиком, как в push/pop-up.
  cropTopFraction: z.number().min(0.2).max(1).optional(),
});
export type SubjectSpec = z.infer<typeof subjectSpecSchema>;

// ------------------------------------------------------------------
// Задание 2 «Визуальный паттерн» — блоки сцены (R-PLAN-email-visual-pattern).
// Все опциональные: спеки v1/v2, push и pop-up продолжают валидироваться.
// ------------------------------------------------------------------

/** Замкнутый числовой диапазон [min, max]. */
const range = <T extends z.ZodTypeAny>(inner: T) =>
  z.tuple([inner, inner]).refine(([lo, hi]) => Number(lo) <= Number(hi), {
    message: "range must satisfy min <= max",
  });

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "expected #RRGGBB");

/**
 * П1 — полупрозрачная радиальная подложка (DV-A1). НЕ фон: углы остаются
 * alpha 0, чтобы письмо подложило свой фон. Ровно так сделано в эталонах
 * дизайнеров — замер `эталон email.png`: alpha 47 в центре → 0 к краю, углы 0.
 *
 * Радиус задан в НОРМИРОВАННОМ КВАДРАТЕ: точка (x, y) холста переводится в
 * ((x/W − 0.5)·2, (y/H − 0.5)·2), поэтому одно и то же число работает на
 * 1200×600, 1024×512 и 800×600 без пересчёта.
 */
export const glowPlateSchema = z.object({
  // "auto-from-layers" — hue берётся из самих слоёв персонажа и item. Это и
  // есть приём П8 «единый цветовой ключ»: свечение гарантированно из той же
  // палитры, что и объекты, и не требует ручной настройки на каждый бренд.
  // Детерминировано: те же байты слоёв → тот же цвет.
  colorSource: z.enum(["auto-from-layers", "fixed"]),
  fixedColor: hexColor.optional(),
  /** Непрозрачность в центре, 0..1. Эталон email: 47/255 ≈ 0.18. */
  alphaCenter: frac,
  /** Радиус в нормированном квадрате, где 1.0 — середина кромки холста. */
  radius: z.number().min(0.1).max(2),
  falloff: z.enum(["smooth", "linear"]),
});
export type GlowPlateSpec = z.infer<typeof glowPlateSchema>;

/** Один план глубины (приём П2). */
export const scatterLayerSchema = z.object({
  id: z.enum(["back", "mid", "front"]),
  count: range(z.number().int().min(0).max(24)),
  /** Высота объекта, доля высоты холста. */
  sizePct: range(frac),
  blurPx: range(z.number().min(0).max(64)),
  opacity: range(frac),
  /** П4: объект ОБЯЗАН быть подрезан краем холста (слой `back` — монета). */
  mustCropEdge: z.boolean(),
  edges: z.array(z.enum(["top", "bottom", "left", "right"])).optional(),
});

/**
 * П2 + П3 — раскладка декора. Модель «нормированное эллиптическое кольцо»
 * вместо прямоугольных банд: объекты кладутся на радиусе r ∈ [rMin, rMax] от
 * центра холста, поэтому центр пустеет ЕСТЕСТВЕННО, а не по запрету.
 *
 * Откалибровано `scripts/calibrate-scatter.ts` по 134 объектам эталонов 1–5:
 * при r < 0.42 нет НИ ОДНОГО объекта, p05..p95 радиусов = 0.57..1.15.
 * Побочный эффект rMax > 1.0: часть объектов неизбежно свисает за кромку —
 * приём П4 (bleed) получается из геометрии, а не из отдельного правила.
 */
export const scatterSchema = z.object({
  ring: z
    .object({ rMin: z.number().min(0).max(2), rMax: z.number().min(0).max(2) })
    .refine((r) => r.rMin < r.rMax, { message: "ring must satisfy rMin < rMax" }),
  /**
   * Веса восьми секторов по 45°, начиная с 0° = вправо и далее ПО ЧАСОВОЙ
   * (90° = вниз, экранная система координат). Замер эталонов даёт перевес
   * верхней половины: [22, 6, 10, 20, 15, 13, 21, 27].
   */
  angleWeights: z.array(z.number().min(0)).length(8),
  layers: z.array(scatterLayerSchema).nonempty(),
  rotationMaxDeg: z.number().min(0).max(180),
  /** Коридоры приёмки (V4/V5) — те же числа проверяет валидатор. */
  band: z.object({ x: frac, w: frac }),
  targetCoveragePct: range(z.number().min(0).max(100)),
  targetObjectCount: range(z.number().int().min(0).max(64)),
});
export type ScatterSpec = z.infer<typeof scatterSchema>;

/**
 * П7 — 3D-типографика как объект сцены. Рисуется SVG-ом через librsvg,
 * который есть в сборке sharp (проверено в Фазе 0) — генератор не участвует,
 * текст точный, рендер побайтово детерминирован.
 */
export const typography3dSchema = z.object({
  slots: z.array(
    z.object({
      id: z.string().min(1),
      /** Запасные токены. Основной источник — бриф кампании (см. ниже). */
      tokens: z.array(z.string().min(1)).nonempty(),
      /**
       * Откуда берётся надпись (поправка заказчика 2026-07-28: «не обязательно
       * BIG WIN — всё зависит от промпта»):
       *   "campaign-or-spec" — из брифа кампании, иначе из `tokens` (по умолчанию);
       *   "campaign"         — только из брифа; бриф молчит → слот пропускается;
       *   "spec"             — всегда из `tokens`, бриф игнорируется.
       */
      tokensSource: z.enum(["campaign-or-spec", "campaign", "spec"]).optional(),
      zone: z.enum(["item", "person"]),
      placement: z.enum(["overlap-item", "beside-person", "in-hands"]),
      /** П6 (DV-C4): `in-hands` рисует НЕ движок — объект приходит вместе со
       *  слоем персонажа. Такой слот выключен, пока это не изменится. */
      enabled: z.boolean(),
      /** Высота надписи, доля высоты холста. */
      sizePct: frac,
    }),
  ),
  /** Ключ материала (золото / неон / глянец) из конфига бренда. */
  material: z.string().min(1),
  style: z.object({
    bevel: z.boolean(),
    specular: z.boolean(),
    ownShadow: z.boolean(),
    perspective: z.boolean(),
  }),
});

/** П8 — цветовая связность кадра. */
export const colorKeySchema = z.object({
  maxHues: z.number().int().min(1).max(8),
  /** К чему применяется приведение цвета. */
  enforceOn: z.array(z.enum(["item", "person", "scatter", "glowPlate"])).nonempty(),
  edgeBlend: z.object({
    haloRemoval: z.boolean(),
    darkEdgeFalloffPx: range(z.number().min(0).max(16)),
  }),
});

export const layoutSpecSchema = z.object({
  // Задание 3, Фаза 6: активная версия с этим флагом уводит рендер в новый
  // пайплайн «промпт → композиция» (services/scenePipeline.ts): бриф → план
  // из коридоров PatternSpec → слой света → цепочка декора → renderScene →
  // валидация майнером. Откат — активировать версию без флага, деплой не нужен.
  scenePipeline: z.boolean().optional(),
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
  background: z.object({
    source: z.enum(["transparent", "static"]),
    // П1 (DV-A1). Живёт внутри `background`, потому что описывает подложку, но
    // фоном НЕ является: при `source: "transparent"` углы остаются alpha 0.
    glowPlate: glowPlateSchema.optional(),
  }),
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
      // Трёхуровневая модель зон (DV-B1, TASK §4.4). Отсутствует → работает
      // прежнее правило «вся safe-зона под порогом maxCoverage».
      //   core     40–60% — почти пусто; `coreRects` внутри строже (0 пикселей);
      //   ambience 27–40% и 60–73% — декор разрешён И ОБЯЗАТЕЛЕН, но приглушён.
      // Полосу `free` описывать не нужно: это всё, что вне этих двух.
      levels: z
        .object({
          core: z.object({ x: frac, w: frac, maxCoverage: frac }),
          ambience: z.object({
            rects: z.array(rectSchema).nonempty(),
            minBlurPx: z.number().min(0).max(64),
            maxOpacity: frac,
            /** Площадь одного объекта, доля площади полосы. */
            maxItemAreaPct: frac,
            coveragePct: range(z.number().min(0).max(100)),
          }),
        })
        .optional(),
    })
    .optional(),
  // Блоки сцены Задания 2 (R-PLAN-email-visual-pattern §5.2).
  scatter: scatterSchema.optional(),
  typography3d: typography3dSchema.optional(),
  colorKey: colorKeySchema.optional(),
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
      // --- Задание 2, пороги паттерна (R-PLAN-email-visual-pattern §10) ---
      // V2′ — плашка присутствует. Яркость не проверяется: под прозрачным
      // ассетом нет фона, мерить не по чему (DV-A1).
      glowAlphaCenterMin: frac.optional(),
      // Доля полностью прозрачных пикселей, %. Именно она выражает D-E5
      // «письмо кладёт свой фон», а не альфа в углах: угол законно закрывает
      // подрезанный кромкой объект декора (приём П4).
      minTransparentSharePct: z.number().min(0).max(100).optional(),
      // V7 — сколько объектов обязаны быть подрезаны краем холста.
      minCroppedByEdge: z.number().int().min(0).max(16).optional(),
      // V10b — слой `back` подрезан верхним краем.
      requireBackCropTop: z.boolean().optional(),
      // V12 — доминирующих hue не больше (кластеризация HSV).
      maxHues: z.number().int().min(1).max(8).optional(),
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
  // Эталон email (`example email with text.PNG`): крупный предмет стоит слева,
  // а мелочь — проценты, купюры, фишки, монета — разбросана по ВСЕЙ периферии
  // кадра: верхняя полоса во всю ширину, нижняя во всю ширину и боковые поля.
  // Размеры замерены там же: % ≈0.22 H, монета ≈0.18 H, купюра ≈0.12 H.
  // Это те же куски ITEM-слоя, что и в push/pop-up, только самый крупный из
  // них становится левым субъектом. Текстовые конверты вычитаются движком.
  decor: {
    bands: [
      { x: 0.02, y: 0, w: 0.96, h: 0.24 },
      { x: 0.02, y: 0.72, w: 0.96, h: 0.26 },
      { x: 0, y: 0.24, w: 0.24, h: 0.48 },
      { x: 0.76, y: 0.24, w: 0.24, h: 0.48 },
    ],
    maxItemSize: 0.22,
    minItemSize: 0.09,
    seeded: true,
    source: "static+item",
    maxPieces: 6,
    rotationMaxDeg: 20,
  },
};

/**
 * email.hero v3 — визуальный паттерн эталонов дизайнеров (Задание 2, Фаза 1).
 *
 * v2 остаётся в истории и продолжает рендерить старые бандлы. Всё, что здесь
 * не переопределено, наследуется от v2: доставка альфа-PNG (D-E5), один файл
 * канонического размера (D-E7), safe-зона 46% (DI-Q7), текст в вёрстке (D-E1).
 *
 * Числа сняты со сканов, а не подобраны на глаз:
 *   - `scripts/mine-pattern.ts` — коридоры субъектов и полос;
 *   - `scripts/calibrate-scatter.ts` — кольцо, веса секторов, размеры слоёв
 *     (134 объекта декора из эталонов 1–5);
 *   - радиальный профиль альфы `эталон email.png` — плашка.
 * Соответствие закреплено тестами `layoutSpec.test.ts`.
 */
export const EMAIL_HERO_V3: LayoutSpecData = {
  ...EMAIL_HERO_V2,

  // Замер: обе фигуры уходят ЗА нижний край, а не стоят над ним. У v2 было
  // 0.92, отсюда «8.2% воздуха снизу» и эффект висящих наклеек.
  baseline: 1.0,

  background: {
    source: "transparent",
    // Профиль `эталон email.png`: alpha 47/255 ≈ 0.18 в центре, монотонно
    // к нулю на r ≈ 1.05, углы 0. Цвет берётся из слоёв — это и есть П8.
    glowPlate: {
      colorSource: "auto-from-layers",
      alphaCenter: 0.18,
      radius: 1.05,
      falloff: "smooth",
    },
  },

  subjects: {
    // Замер эталонов: 84–91% высоты холста. У v2 стояло 55/62/68 — отсюда
    // item в 61.8% на `result.png`.
    item: {
      ...EMAIL_HERO_V2.subjects.item!,
      fitHeight: { min: 0.84, target: 0.88, max: 0.91 },
      overflow: { left: 0.08, right: 0, top: 0, bottom: 0.05 },
    },
    // Замер: 78–91% высоты, вылет вправо 6–33% правой кромки.
    person: {
      ...EMAIL_HERO_V2.subjects.person,
      fitHeight: { min: 0.78, target: 0.88, max: 0.91 },
      // right = 0.18, а не 0.08: после поясного кропа силуэт становится ЗАМЕТНО
      // шире относительно своей высоты, и при узком допуске движок упирался в
      // ширину зоны и ронял высоту персонажа до 59–73% вместо 78–91%.
      // Эталонам это не противоречит — там фигура и подрезана правой кромкой
      // (вылет 6–33% её длины), то есть часть силуэта законно уходит за холст.
      overflow: { left: 0, right: 0.18, top: 0, bottom: 0.08 },
      // П5 (DV-C3): от слоя в полный рост берём верхние 55% альфа-bbox —
      // поясной план. Слой при этом общий с push/pop-up, лишних генераций нет.
      cropTopFraction: 0.55,
    },
  },

  safe: {
    ...EMAIL_HERO_V2.safe!,
    // F5-2 (живой прогон): средний конверт v1 тянулся до 0.74, а зона
    // персонажа начинается на 0.73 — широкий поясной кроп ЗАКОННО доходит до
    // края своей зоны и залезал в конверт (safe-core-clean 2128 px). Конверт
    // выравнивается по DI-Q7: текст письма живёт в 27–73% ширины, симметрично.
    // Ширина safe-зоны в МЕТАДАННЫХ (safe.zone) не тронута — контракт E-P5.1
    // для Smartico прежний.
    coreRects: [
      { x: 0.4, y: 0.08, w: 0.2, h: 0.18 },
      { x: 0.27, y: 0.26, w: 0.46, h: 0.42 },
      { x: 0.36, y: 0.7, w: 0.28, h: 0.2 },
    ],
    // DV-B1 — трёхуровневая модель. Ширина safe-зоны не тронута:
    // контракт метаданных для Smartico (E-P5.1) остаётся прежним.
    levels: {
      // Реально пустая полоса эталонов: 0.7–2.4% ярких пикселей. TASK §4.4
      // предлагает порог 2%, но он забраковал бы ex4 (2.1%) и ex5 (2.4%) —
      // то есть две из пяти работ дизайнеров, а DoD Фазы 4 требует ровно
      // обратного: валидатор обязан пропускать все пять. Берём 2.5%.
      core: { x: 0.4, w: 0.2, maxCoverage: 0.025 },
      ambience: {
        rects: [
          { x: 0.27, y: 0, w: 0.13, h: 1 },
          { x: 0.6, y: 0, w: 0.13, h: 1 },
        ],
        minBlurPx: 4,
        maxOpacity: 0.6,
        maxItemAreaPct: 0.015,
        coveragePct: [4, 10],
      },
    },
  },

  // Кольцо вместо прямоугольных банд v2 (см. scatterSchema): центр пустеет
  // сам, bleed получается из rMax > 1.0. Унаследованный от v2 блок `decor`
  // намеренно оставлен: движок Фазы 3 предпочитает `scatter`, когда он есть,
  // а до тех пор промежуточная сборка продолжает раскладывать куски ITEM по
  // старым бандам вместо того, чтобы не раскладывать ничего.
  scatter: {
    ring: { rMin: 0.57, rMax: 1.15 },
    // Замер по секторам 45° от 0°=вправо по часовой: верхняя половина плотнее.
    angleWeights: [22, 6, 10, 20, 15, 13, 21, 27],
    layers: [
      // Крупная размытая монета, обязательно подрезанная верхним краем —
      // именно она даёт «объектив» вместо коллажа (замер: 22.3–43.2% высоты).
      {
        id: "back",
        count: [1, 2],
        sizePct: [0.22, 0.4],
        blurPx: [8, 18],
        // Верхняя граница — ровно `safe.levels.ambience.maxOpacity`. Слой
        // `back` и есть «расфокусированная ambience» из TASK §4.4, которой
        // ядро 40–60% разрешено; при opacity выше он перестаёт ей быть и
        // движок вытесняет его из центра, оставляя верх кадра пустым.
        opacity: [0.45, 0.6],
        mustCropEdge: true,
        edges: ["top"],
      },
      { id: "mid", count: [3, 5], sizePct: [0.1, 0.21], blurPx: [0, 3], opacity: [0.85, 1], mustCropEdge: false },
      { id: "front", count: [5, 9], sizePct: [0.04, 0.1], blurPx: [0, 1], opacity: [1, 1], mustCropEdge: false },
    ],
    rotationMaxDeg: 35,
    band: { x: 0.25, w: 0.47 },
    targetCoveragePct: [5.6, 10.2],
    targetObjectCount: [6, 11],
  },

  typography3d: {
    slots: [
      {
        id: "brandMark",
        tokens: ["FS", "SCATTER"],
        tokensSource: "campaign-or-spec",
        zone: "item",
        placement: "overlap-item",
        enabled: true,
        sizePct: 0.18,
      },
      {
        // П6 в редакции DV-C4′: табличку рисуем сами и ставим РЯДОМ с
        // персонажем. Вариант «просить объект у генератора» отпал находкой
        // F2-1 — слой персонажа один на все три ассета, а у части брендов
        // персонаж животное без рук, и в push/pop-up появилась бы собака с
        // табличкой.
        id: "heldSign",
        tokens: ["BIG WIN"],
        // Только из брифа: если кампания не просит надпись в руках, кадр
        // обойдётся без неё, а не получит навязанное «BIG WIN».
        tokensSource: "campaign",
        zone: "person",
        placement: "beside-person",
        enabled: true,
        sizePct: 0.22,
      },
    ],
    material: "brand.typo_material",
    style: { bevel: true, specular: true, ownShadow: true, perspective: true },
  },

  colorKey: {
    maxHues: 3,
    enforceOn: ["scatter", "glowPlate"],
    edgeBlend: { haloRemoval: true, darkEdgeFalloffPx: [2, 5] },
  },

  validation: {
    ...EMAIL_HERO_V2.validation,
    glowAlphaCenterMin: 0.12,
    minTransparentSharePct: 3,
    minCroppedByEdge: 2,
    requireBackCropTop: true,
    maxHues: 3,
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
