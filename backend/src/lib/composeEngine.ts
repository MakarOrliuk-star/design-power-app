import { createHash } from "node:crypto";
import sharp from "sharp";
import type { LayoutSpecData, SubjectSpec, SpecRect } from "../services/layoutSpec.js";
import { cropLayerTop } from "./layerNormalize.js";
import { renderToken, resolveMaterial } from "./typography3d.js";

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

// ------------------------------------------------------------------
// Задание 2, Фаза 3 — сцена вместо вставки объектов
// ------------------------------------------------------------------

/**
 * Раскладка по кольцу (П2/П3). Нормированный квадрат: точка холста (x, y) →
 * ((x/W − 0.5)·2, (y/H − 0.5)·2), поэтому радиус из спеки работает на любой
 * пропорции холста без пересчёта.
 *
 * Два свойства получаются из геометрии, а не из отдельных правил:
 *  - ядро 40–60% пустеет само (в эталонах при r < 0.42 нет ни одного объекта);
 *  - при rMax > 1.0 часть объектов свисает за кромку — это приём П4 (bleed).
 *
 * Поэтому бокс здесь НЕ зажимается в холст: `overlay` обрежет что нужно.
 */
export function computeRingPlacements(
  ring: { rMin: number; rMax: number },
  angleWeights: number[],
  dims: Array<{
    width: number;
    height: number;
    targetH: number;
    fill?: number;
    /** Объект удовлетворяет правилу ambience (блюр + приглушённость) и в ядро
     *  допускается сверх бюджета — TASK §4.4 «только расфокусированная
     *  ambience», DV-B1. */
    ambience?: boolean;
  }>,
  cores: Box[],
  canvasW: number,
  canvasH: number,
  rand: () => number,
  /** Ядро 40–60% (DV-B1): полоса с бюджетом покрытия, а не запретом. */
  coreBand?: { x: number; w: number; maxCoverage: number },
): Array<Box | null> {
  const total = angleWeights.reduce((a, b) => a + b, 0);
  const placed: Box[] = [];

  // Бюджет ядра расходуется по мере раскладки: полоса не запрещена (эталоны
  // дают там 0.7–2.4% ярких пикселей), но и залить её нельзя.
  const bandBox = coreBand
    ? { x: coreBand.x * canvasW, y: 0, w: coreBand.w * canvasW, h: canvasH }
    : null;
  const bandBudget = bandBox ? bandBox.w * bandBox.h * (coreBand?.maxCoverage ?? 1) : Infinity;
  let bandUsed = 0;

  const areaInBand = (b: Box): number => {
    if (!bandBox) return 0;
    const w = Math.max(0, Math.min(b.x + b.w, bandBox.x + bandBox.w) - Math.max(b.x, bandBox.x));
    const h = Math.max(0, Math.min(b.y + b.h, bandBox.y + bandBox.h) - Math.max(b.y, bandBox.y));
    return w * h;
  };

  /** Сектор по весам: чаще выпадает тот, что плотнее заполнен в эталонах. */
  const pickSector = (): number => {
    if (total <= 0) return Math.floor(rand() * angleWeights.length);
    let t = rand() * total;
    for (let i = 0; i < angleWeights.length; i++) {
      t -= angleWeights[i]!;
      if (t <= 0) return i;
    }
    return angleWeights.length - 1;
  };

  return dims.map((d) => {
    const h = d.targetH;
    const w = (d.width / d.height) * h;
    for (let attempt = 0; attempt < 40; attempt++) {
      const sector = pickSector();
      const sectorSpan = 360 / angleWeights.length;
      const theta = ((sector + rand()) * sectorSpan * Math.PI) / 180;
      const r = ring.rMin + rand() * (ring.rMax - ring.rMin);
      // Из нормированного квадрата обратно в пиксели.
      const cx = (Math.cos(theta) * r * 0.5 + 0.5) * canvasW;
      const cy = (Math.sin(theta) * r * 0.5 + 0.5) * canvasH;
      const box = { x: cx - w / 2, y: cy - h / 2, w, h };
      // Текстовые конверты неприкосновенны, взаимные наложения не нужны.
      if (cores.some((c) => intersects(box, c))) continue;
      if (placed.some((p) => intersects(box, p))) continue;
      // Объект целиком за холстом бесполезен — он ничего не добавит в кадр.
      if (box.x + w <= 0 || box.x >= canvasW || box.y + h <= 0 || box.y >= canvasH) continue;
      // Бюджет считается по НЕПРОЗРАЧНЫМ пикселям, а не по габариту: у
      // повёрнутой монеты полбокса — пустота, и по габариту полоса «кончалась»
      // втрое раньше, чем на самом деле. Расфокусированная ambience в ядро
      // допускается сверх бюджета — так это описано в TASK §4.4.
      if (!d.ambience) {
        const inBand = areaInBand(box) * (d.fill ?? 1);
        if (bandUsed + inBand > bandBudget) continue; // бюджет ядра исчерпан
        bandUsed += inBand;
      }
      placed.push(box);
      return box;
    }
    return null;
  });
}

/** Сколько объектов бокса реально подрезано кромкой холста (V7). */
export function countCroppedByEdge(boxes: Array<Box | null>, canvasW: number, canvasH: number): number {
  return boxes.filter(
    (b) => b !== null && (b.x < 0 || b.y < 0 || b.x + b.w > canvasW || b.y + b.h > canvasH),
  ).length;
}

/**
 * Средний цвет непрозрачных пикселей слоёв — источник hue для плашки при
 * `colorSource: "auto-from-layers"` (приём П8). Считается по байтам слоёв,
 * поэтому детерминирован и не требует настройки на каждый бренд.
 *
 * Насыщенность поднимается принудительно: усреднение по всему субъекту тянет
 * в серый, а плашке нужен ЦВЕТ, иначе свечение выглядит грязным пятном.
 */
export async function dominantColor(layers: EngineLayer[]): Promise<[number, number, number]> {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (const layer of layers) {
    // Уменьшаем перед усреднением: точность та же, работы на два порядка меньше.
    const { data, info } = await sharp(layer.data)
      .resize(32, 32, { fit: "fill" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (let i = 0; i < info.width * info.height; i++) {
      const a = data[i * 4 + 3]!;
      if (a < 128) continue;
      r += data[i * 4]!;
      g += data[i * 4 + 1]!;
      b += data[i * 4 + 2]!;
      n++;
    }
  }
  if (n === 0) return [255, 200, 160]; // тёплый нейтральный, как в эталоне email
  return saturate([r / n, g / n, b / n]);
}

/**
 * Доля непрозрачных пикселей слоя. Нужна бюджету ядра: у повёрнутой монеты
 * половина габарита — пустота, и оценка «по боксу» завышает покрытие втрое.
 * Считается на уменьшенной копии — точности хватает, работы на два порядка
 * меньше, результат детерминирован.
 */
export async function opaqueRatio(layer: EngineLayer): Promise<number> {
  const { data, info } = await sharp(layer.data)
    .resize(32, 32, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let opaque = 0;
  const n = info.width * info.height;
  for (let i = 0; i < n; i++) if (data[i * 4 + 3]! >= 128) opaque++;
  return opaque / n;
}

/** Тянет цвет к насыщенному, сохраняя оттенок. */
function saturate([r, g, b]: [number, number, number]): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max <= 0) return [255, 200, 160];
  // Растягиваем канальный контраст от среднего — это и есть рост насыщенности.
  const mid = (max + min) / 2;
  const stretch = 1.9;
  const out = ([r, g, b] as const).map((c) =>
    Math.max(0, Math.min(255, Math.round(mid + (c - mid) * stretch))),
  ) as [number, number, number];
  // И поднимаем яркость: плашка светится, а не темнит.
  const peak = Math.max(...out);
  if (peak < 200) {
    const k = 200 / Math.max(1, peak);
    return out.map((c) => Math.min(255, Math.round(c * k))) as [number, number, number];
  }
  return out;
}

/**
 * П1 — полупрозрачная радиальная плашка. НЕ фон: углы остаются alpha 0, чтобы
 * письмо подложило свой фон (D-E5). Растр строится вручную — это быстрее и
 * детерминированнее SVG-градиента, а формула спада документирована здесь.
 */
export async function renderGlowPlate(
  plate: { alphaCenter: number; radius: number; falloff: "smooth" | "linear" },
  color: [number, number, number],
  width: number,
  height: number,
): Promise<Bytes> {
  const data = Buffer.alloc(width * height * 4);
  const peak = Math.round(Math.max(0, Math.min(1, plate.alphaCenter)) * 255);
  for (let y = 0; y < height; y++) {
    // Нормированный квадрат — та же система, что у кольца раскладки.
    const v = (y / height - 0.5) * 2;
    for (let x = 0; x < width; x++) {
      const u = (x / width - 0.5) * 2;
      const t = Math.hypot(u, v) / plate.radius;
      let k: number;
      if (t >= 1) {
        k = 0;
      } else if (plate.falloff === "linear") {
        k = 1 - t;
      } else {
        // smooth: (1 − t²)² — совпадает с профилем `эталон email.png`
        // (alpha 47 в центре → ~16 на r≈0.66 → 0 к краю) лучше линейного.
        const s = 1 - t * t;
        k = s * s;
      }
      const i = (y * width + x) * 4;
      data[i] = color[0];
      data[i + 1] = color[1];
      data[i + 2] = color[2];
      data[i + 3] = Math.round(peak * k);
    }
  }
  return sharp(data, { raw: { width, height, channels: 4 } }).png(PNG_OPTS).toBuffer();
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
  /**
   * Токены надписей из брифа кампании (поправка заказчика 2026-07-28: «не
   * обязательно BIG WIN — всё зависит от промпта»). Пусто → слот берёт
   * запасные токены из спеки или пропускается, смотря по `tokensSource`.
   */
  campaignTokens?: string[];
  /**
   * Style-profile «казино-дизайнера» (DV-E1) — уже зажатый клампами вход:
   * hue плашки (перекрывает ТОЛЬКО auto-from-layers), материал типографики,
   * плотность рассыпки как доля коридора спеки. Никаких координат: выбор
   * декора и токены применяются выше по стеку (процессор), геометрию профиль
   * не трогает в принципе.
   */
  styleProfile?: {
    glowHex?: string | undefined;
    typoMaterial?: string | undefined;
    density?: number | undefined;
  };
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
  /** Показатели сцены (Задание 2). null для спек без блока `scatter`. */
  scene: {
    /** Цвет плашки — вычисленный из слоёв или заданный в спеке. */
    glowColor: string | null;
    /** Сколько объектов декора подрезано кромкой холста (V7). */
    croppedByEdge: number;
    /** Есть ли объект заднего плана, подрезанный ВЕРХНИМ краем (V10b). */
    backCropsTop: boolean;
    /** Сколько надписей отрисовано (V11). */
    typographyTokens: number;
  } | null;
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

/**
 * Блюр и прозрачность слоя (П2 — планы глубины). Блюр настоящий, а не
 * декоративный: именно градиент размытия отличает сцену от коллажа.
 * Альфа масштабируется по сырым байтам — так работает на любом входе, в
 * отличие от blend-режимов, которые зависят от наличия альфа-канала.
 */
export async function applyLayerEffects(
  layer: EngineLayer,
  blurPx: number,
  opacity: number,
): Promise<EngineLayer> {
  if (blurPx <= 0 && opacity >= 1) return layer;
  let img = sharp(layer.data).ensureAlpha();
  // sharp игнорирует сигму меньше 0.3 — округляем вверх, чтобы «blur 1»
  // из спеки действительно давал мягкий край.
  if (blurPx > 0) img = img.blur(Math.max(0.3, blurPx / 2));
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  if (opacity < 1) {
    for (let i = 3; i < data.length; i += 4) data[i] = Math.round(data[i]! * opacity);
  }
  const png = await sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png(PNG_OPTS)
    .toBuffer();
  return { data: png, width: info.width, height: info.height };
}

/**
 * П8 — приведение слоя к цветовому ключу кадра. Смешивает цвет пикселей с
 * ключевым в долю `strength`, сохраняя яркость и альфу.
 *
 * Зачем: персонаж, item и декор приходят из РАЗНЫХ генераций, и каждый несёт
 * свою палитру. Именно эта рассогласованность читается как «коллаж» — в
 * эталонах на кадр приходится 2–3 оттенка. Тянем не в плоский цвет, а к
 * общему ключу, иначе объекты потеряют объём.
 */
export async function tintToKey(
  layer: EngineLayer,
  key: [number, number, number],
  strength: number,
): Promise<EngineLayer> {
  if (strength <= 0) return layer;
  const k = Math.min(1, strength);
  const { data, info } = await sharp(layer.data)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]! === 0) continue;
    // Яркость пикселя сохраняем, к ключу тянем только цветность — так тень
    // остаётся тенью, а блик бликом.
    const lum = (data[i]! * 0.299 + data[i + 1]! * 0.587 + data[i + 2]! * 0.114) / 255;
    for (let c = 0; c < 3; c++) {
      const keyed = key[c]! * lum;
      data[i + c] = Math.round(data[i + c]! * (1 - k) + keyed * k);
    }
  }
  const png = await sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png(PNG_OPTS)
    .toBuffer();
  return { data: png, width: info.width, height: info.height };
}

/**
 * П10 — контровой свет по контуру субъекта. Силуэт растягивается, красится
 * ключевым цветом, размывается и кладётся ПОД слой: по краю остаётся ободок,
 * который отделяет фигуру от подложки. Без него вырезка выглядит наклеенной.
 */
export async function renderRimLight(
  layer: EngineLayer,
  color: [number, number, number],
  strength: number,
): Promise<Bytes> {
  const grow = Math.max(2, Math.round(Math.min(layer.width, layer.height) * 0.02));
  const { data, info } = await sharp(layer.data)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  // Силуэт: цвет ключевой, альфа — от исходной.
  for (let i = 0; i < data.length; i += 4) {
    data[i] = color[0]!;
    data[i + 1] = color[1]!;
    data[i + 2] = color[2]!;
    data[i + 3] = Math.round(data[i + 3]! * strength);
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .blur(grow)
    .png(PNG_OPTS)
    .toBuffer();
}

/**
 * П11 — контактная тень под субъектом: тёмный эллипс у нижней кромки. В
 * эталонах объекты не висят, а стоят; без тени даже правильный якорь по низу
 * читается как «объект приклеен к краю».
 */
export async function renderContactShadow(
  box: Box,
  canvasW: number,
  canvasH: number,
  opacity: number,
): Promise<{ png: Bytes; box: Box } | null> {
  const w = Math.round(box.w * 1.15);
  const h = Math.round(Math.max(8, box.h * 0.06));
  if (w < 2 || h < 2) return null;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<defs><radialGradient id="g"><stop offset="0" stop-color="#000" stop-opacity="${opacity}"/>` +
    `<stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient></defs>` +
    `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}" fill="url(#g)"/></svg>`;
  const png = await sharp(Buffer.from(svg)).png(PNG_OPTS).toBuffer();
  return {
    png,
    box: {
      x: box.x + box.w / 2 - w / 2,
      y: Math.min(canvasH, box.y + box.h) - h / 2,
      w,
      h,
    },
  };
}

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

export function rgbToHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** Целое в [lo, hi] по сидированному генератору. */
function pickInt(lo: number, hi: number, rand: () => number): number {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

/**
 * П2 — три плана глубины. Пул декора распределяется по слоям `back` / `mid` /
 * `front`: каждому свой размер, блюр и прозрачность. Крупная размытая монета
 * на заднем плане и есть то, что превращает набор наклеек в кадр с объективом.
 *
 * Порядок возврата = порядок отрисовки внутри своего яруса; сами ярусы
 * разносит по z вызывающий (`back` под субъектами, `mid`/`front` — над).
 */
async function buildScatterScene(
  scatter: NonNullable<LayoutSpecData["scatter"]>,
  coreRects: SpecRect[],
  coreBand: { x: number; w: number; maxCoverage: number } | null,
  ambienceRule: { minBlurPx: number; maxOpacity: number } | null,
  pool: EngineLayer[],
  W: number,
  H: number,
  rand: () => number,
  /** DV-E1: плотность рассыпки 0..1 — позиция ВНУТРИ коридора count спеки.
   *  undefined → прежний сидированный выбор. Выйти за коридор нельзя. */
  density?: number,
): Promise<{ layers: EngineLayer[]; boxes: Array<Box | null>; backCount: number }> {
  if (pool.length === 0) return { layers: [], boxes: [], backCount: 0 };

  const cores = coreRects.map((r) => fracRect(r, W, H));
  const layers: EngineLayer[] = [];
  const dims: Array<{
    width: number;
    height: number;
    targetH: number;
    fill: number;
    ambience: boolean;
  }> = [];
  let backCount = 0;
  let poolIdx = 0;

  for (const layerSpec of scatter.layers) {
    // Плотность профиля смещает счётчик внутри коридора [min, max] спеки;
    // без профиля — сидированный выбор, как раньше. Кламп не нужен: доля
    // 0..1 по построению не выводит за границы коридора.
    const count =
      density === undefined
        ? pickInt(layerSpec.count[0], layerSpec.count[1], rand)
        : layerSpec.count[0] + Math.round(density * (layerSpec.count[1] - layerSpec.count[0]));
    for (let i = 0; i < count; i++) {
      // Пул меньше нужного числа объектов — переиспользуем по кругу: лучше
      // повтор ассета под другим углом и размером, чем дыра в кадре.
      const src = pool[poolIdx % pool.length]!;
      poolIdx++;

      const angle =
        scatter.rotationMaxDeg > 0
          ? Math.round((rand() * 2 - 1) * scatter.rotationMaxDeg)
          : 0;
      let prepared = src;
      if (angle !== 0) {
        const rotated = await sharp(src.data)
          .rotate(angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .png(PNG_OPTS)
          .toBuffer({ resolveWithObject: true });
        prepared = { data: rotated.data, width: rotated.info.width, height: rotated.info.height };
      }
      const blur = layerSpec.blurPx[0] + rand() * (layerSpec.blurPx[1] - layerSpec.blurPx[0]);
      const opacity =
        layerSpec.opacity[0] + rand() * (layerSpec.opacity[1] - layerSpec.opacity[0]);
      prepared = await applyLayerEffects(prepared, blur, opacity);

      const sizePct =
        layerSpec.sizePct[0] + rand() * (layerSpec.sizePct[1] - layerSpec.sizePct[0]);
      layers.push(prepared);
      dims.push({
        width: prepared.width,
        height: prepared.height,
        targetH: sizePct * H,
        fill: await opaqueRatio(prepared),
        // Дословно правило DV-B1: размыт достаточно И приглушён достаточно.
        ambience: ambienceRule
          ? blur >= ambienceRule.minBlurPx && opacity <= ambienceRule.maxOpacity
          : false,
      });
      if (layerSpec.id === "back") backCount++;
    }
  }

  const boxes = computeRingPlacements(
    scatter.ring,
    scatter.angleWeights,
    dims,
    cores,
    W,
    H,
    rand,
    coreBand ?? undefined,
  );

  // П4 для слоя `back`: спека требует, чтобы он был подрезан верхним краем.
  // Если сидированная раскладка не дала этого сама — поднимаем первый
  // размещённый объект яруса так, чтобы он вышел за верхнюю кромку.
  const backSpec = scatter.layers.find((l) => l.id === "back");
  if (backSpec?.mustCropEdge && backSpec.edges?.includes("top")) {
    const already = boxes.slice(0, backCount).some((b) => b !== null && b.y < 0);
    if (!already) {
      const idx = boxes.slice(0, backCount).findIndex((b) => b !== null);
      if (idx >= 0) {
        const b = boxes[idx]!;
        boxes[idx] = { ...b, y: -b.h * 0.35 };
      }
    }
  }

  return { layers, boxes, backCount };
}

/**
 * Загоняет бокс целиком в холст: сначала ужимает, если он шире/выше кадра,
 * потом сдвигает. Пропорция сохраняется — иначе буквы поплывут.
 */
function clampInside(box: Box, canvasW: number, canvasH: number): Box {
  let { w, h } = box;
  const scale = Math.min(1, canvasW / w, canvasH / h);
  w *= scale;
  h *= scale;
  const x = Math.max(0, Math.min(box.x, canvasW - w));
  const y = Math.max(0, Math.min(box.y, canvasH - h));
  return { x, y, w, h };
}

export interface TypoPlacement {
  layer: EngineLayer;
  box: Box;
  /** Рисуется ли надпись ПОД персонажем (brandMark у item) или над ним. */
  under: boolean;
}

/**
 * П7 — размещение надписей. Координаты берутся от боксов субъектов, то есть
 * из спеки, а не из того, что нарисовала модель (D-E4).
 *
 * `beside-person` — это решение DV-C4′: табличку ставим РЯДОМ с персонажем, а
 * не в руки. Вложить в руки композитор не может (детекции рук нет), а просить
 * объект у генератора нельзя — слой персонажа общий с push/pop-up, где у части
 * брендов персонаж животное без рук.
 */
async function buildTypography(
  typo: NonNullable<LayoutSpecData["typography3d"]>,
  boxes: { item: Box | null; person: Box },
  W: number,
  H: number,
  rand: () => number,
  /** Границы safe-зоны в пикселях [левая, правая]; null — зоны нет. */
  safeZone: [number, number] | null,
  /** Токены из брифа кампании; пусто → работают запасные из спеки. */
  campaignTokens: string[],
  /** DV-E1: материал из style-profile — уже проверенный клампом ключ
   *  TYPO_MATERIALS; перекрывает материал спеки. */
  materialOverride?: string,
): Promise<TypoPlacement[]> {
  const out: TypoPlacement[] = [];
  const material = resolveMaterial(materialOverride ?? typo.material);

  for (const slot of typo.slots) {
    if (!slot.enabled) continue;
    const anchor = slot.zone === "item" ? boxes.item : boxes.person;
    if (!anchor) continue;

    // Надпись следует за кампанией, а не за спекой: спека держит запасной
    // вариант, а слот с `tokensSource: "campaign"` вовсе пропускается, если
    // бриф ничего не просил — навязывать «BIG WIN» неверно.
    const source = slot.tokensSource ?? "campaign-or-spec";
    let pool: string[];
    if (source === "spec") pool = slot.tokens;
    else if (campaignTokens.length > 0) pool = campaignTokens;
    else if (source === "campaign") continue;
    else pool = slot.tokens;

    const token = pool[Math.floor(rand() * pool.length)] ?? pool[0]!;
    const targetH = slot.sizePct * H;
    const rendered = await renderToken({
      token,
      // Кегль ≈ высота растра минус запас на фаску и тень; точный размер
      // выставит ресайз при композите, здесь важно лишь качество растра.
      fontSizePx: Math.max(24, Math.round(targetH * 1.1)),
      material,
      skewDeg: typo.style.perspective ? 8 : 0,
      rotateDeg: typo.style.perspective ? -5 : 0,
      bevel: typo.style.bevel,
      specular: typo.style.specular,
      ownShadow: typo.style.ownShadow,
    });

    // Надпись обязана уместиться в СВОЮ свободную полосу — слева от safe-зоны
    // для слотов item, справа для слотов person. Иначе широкий токен
    // (`SCATTER` ≈4:1, `BIG WIN` ≈3.5:1) заезжает на конверт строки оффера, и
    // валидатор законно бракует кадр по `safe-core-clean`.
    const window: [number, number] =
      safeZone === null
        ? [0, W]
        : slot.zone === "item"
          ? [0, safeZone[0]]
          : [safeZone[1], W];

    let h = targetH;
    let w = (rendered.width / rendered.height) * h;
    const available = window[1] - window[0];
    if (w > available) {
      w = available;
      h = (rendered.height / rendered.width) * w;
    }

    let x: number;
    let y: number;
    if (slot.placement === "overlap-item") {
      // Поверх нижней трети item — как `SCATTER` в лепестках у эталонов.
      x = anchor.x + anchor.w / 2 - w / 2;
      y = anchor.y + anchor.h * 0.62;
    } else if (slot.placement === "beside-person") {
      // DV-C4′: надпись ложится НА нижнюю часть персонажа со сдвигом влево —
      // так она читается как «в руках», а не как приклеенная сбоку.
      x = anchor.x + anchor.w / 2 - w * 0.62;
      y = anchor.y + anchor.h * 0.44;
    } else {
      x = anchor.x + anchor.w / 2 - w / 2;
      y = anchor.y + anchor.h * 0.45;
    }
    x = Math.max(window[0], Math.min(x, window[1] - w));
    const box: Box = { x, y, w, h };
    // Надпись — это оффер, и подрезать её краем нельзя: в эталонах FS,
    // SCATTER и BIG WIN всегда целиком в кадре, в отличие от декора и
    // субъектов, которым bleed как раз предписан (П4).
    out.push({
      layer: { data: rendered.png, width: rendered.width, height: rendered.height },
      box: clampInside(box, W, H),
      under: slot.zone === "item",
    });
  }
  return out;
}

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

  // П5 (DV-C3): поясной кроп режется ЗДЕСЬ, из общего слоя в полный рост, —
  // так решение остаётся в спеке, а слой персонажа один на все три ассета.
  let person = inputs.person;
  const cropTop = spec.subjects.person.cropTopFraction;
  if (cropTop !== undefined && cropTop < 1) {
    const cropped = await cropLayerTop(person.data, cropTop);
    if (!cropped.ok) {
      return { ok: false, reason: `person crop: ${cropped.reason}` };
    }
    person = { data: cropped.png, width: cropped.width, height: cropped.height };
  }

  const personBox = computeSubjectPlacement(
    spec.subjects.person,
    person.width,
    person.height,
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

  // Сцена (Задание 2) или прежняя раскладка по бандам. Ветка выбирается
  // наличием `scatter` в спеке: v2, push и pop-up идут старым путём и не
  // меняются, v3 собирает планы глубины по кольцу.
  const scene = spec.scatter
    ? await buildScatterScene(
        spec.scatter,
        spec.safe?.coreRects ?? [],
        spec.safe?.levels?.core ?? null,
        spec.safe?.levels?.ambience ?? null,
        decorLayers,
        W,
        H,
        rand,
        inputs.styleProfile?.density,
      )
    : null;

  const decorBoxes = scene
    ? scene.boxes
    : computeDecorPlacements(
        spec,
        decorLayers.map((d) => ({ width: d.width, height: d.height })),
        W,
        H,
        rand,
      );
  let sceneLayers = scene ? scene.layers : decorLayers;

  // П1 — плашка. Цвет либо задан, либо выводится из самих слоёв: так свечение
  // гарантированно из одной палитры с объектами (приём П8), без ручной
  // настройки на каждый бренд.
  const plateSpec = spec.background.glowPlate;
  let plateColor: [number, number, number] | null = null;
  if (plateSpec) {
    if (plateSpec.colorSource === "fixed" && plateSpec.fixedColor) {
      // `fixed` в спеке — явная воля админа, профиль его НЕ перекрывает.
      plateColor = hexToRgb(plateSpec.fixedColor);
    } else if (inputs.styleProfile?.glowHex) {
      // DV-E1: профиль перекрывает только auto-from-layers.
      plateColor = hexToRgb(inputs.styleProfile.glowHex);
    } else {
      plateColor = await dominantColor([person, ...(itemSubject ? [itemSubject] : [])]);
    }
  }

  // П7 — надписи. Рисуем сами через librsvg: генератор искажает буквы, а токен
  // приходит из конфига бренда и обязан быть точным.
  // П8 — декор приводится к цветовому ключу кадра. Библиотека декора общая на
  // все бренды (DV-C2), поэтому без этого шага золотая монета попадёт в
  // неоново-розовый кадр как чужая. Субъекты не трогаем: персонаж и item —
  // это идентичность бренда, её перекрашивать нельзя.
  if (spec.colorKey?.enforceOn.includes("scatter") && plateColor && sceneLayers.length > 0) {
    const tinted: EngineLayer[] = [];
    for (const l of sceneLayers) tinted.push(await tintToKey(l, plateColor, 0.35));
    sceneLayers = tinted;
  }

  const safeZonePx: [number, number] | null = spec.safe
    ? [spec.safe.zone.x * W, (spec.safe.zone.x + spec.safe.zone.w) * W]
    : null;
  const typoPlacements = spec.typography3d
    ? await buildTypography(
        spec.typography3d,
        { item: itemBox, person: personBox },
        W,
        H,
        rand,
        safeZonePx,
        inputs.campaignTokens ?? [],
        inputs.styleProfile?.typoMaterial,
      )
    : [];

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

      // ВАЖНО: плашка НЕ входит в `overlays`. Этот стек — пиксельная правда
      // валидатора о том, «чиста ли текстовая зона», и он обязан содержать
      // только размещённую графику. Плашка же по замыслу лежит ПОД текстом
      // (в эталонах свечение как раз за оффером), и, попав в маску, она
      // проваливала бы `safe-core-clean` на любом корректном кадре.
      // Подкладывается она ниже, после сборки стека.

      // z-order (TASK §5): плашка → scatter.back → контактные тени → item →
      // brandMark → person → heldSign → scatter.mid/front.
      const backEnd = scene ? scene.backCount : sceneLayers.length;
      for (let i = 0; i < backEnd; i++) {
        const box = decorBoxes[i];
        if (box) overlays = await overlay(overlays, sceneLayers[i]!, mul(box), sw, sh);
      }

      // П11 — контактные тени ложатся ПОД субъектами: иначе даже правильный
      // якорь по низу читается как «объект приклеен к краю».
      if (spec.colorKey) {
        for (const b of [itemBox, personBox]) {
          if (!b) continue;
          const shadow = await renderContactShadow(mul(b), sw, sh, 0.45);
          if (shadow) {
            overlays = await overlay(
              overlays,
              { data: shadow.png, width: Math.round(shadow.box.w), height: Math.round(shadow.box.h) },
              shadow.box,
              sw,
              sh,
            );
          }
        }
      }

      if (itemSubject && itemBox) overlays = await overlay(overlays, itemSubject, mul(itemBox), sw, sh);
      for (const t of typoPlacements.filter((p) => p.under)) {
        overlays = await overlay(overlays, t.layer, mul(t.box), sw, sh);
      }
      // П10 — контровой свет: ободок ключевого цвета ПОД персонажем, чтобы
      // фигура отделялась от подложки, а не лежала на ней вырезкой.
      if (spec.colorKey && plateColor) {
        const rim = await renderRimLight(person, plateColor, 0.55);
        const grow = Math.max(2, Math.round(Math.min(personBox.w, personBox.h) * 0.02)) * scale;
        const rimBox = mul(personBox);
        overlays = await overlay(
          overlays,
          { data: rim, width: person.width, height: person.height },
          { x: rimBox.x - grow, y: rimBox.y - grow, w: rimBox.w + grow * 2, h: rimBox.h + grow * 2 },
          sw,
          sh,
        );
      }
      overlays = await overlay(overlays, person, mul(personBox), sw, sh);
      for (const t of typoPlacements.filter((p) => !p.under)) {
        overlays = await overlay(overlays, t.layer, mul(t.box), sw, sh);
      }
      for (let i = backEnd; i < sceneLayers.length; i++) {
        const box = decorBoxes[i];
        if (box) overlays = await overlay(overlays, sceneLayers[i]!, mul(box), sw, sh);
      }
      // Маска — до подкладывания плашки (см. комментарий выше).
      if (scale === 1) overlayMask = overlays;

      // П1 — плашка подкладывается ПОД собранный стек. Углы у неё alpha 0,
      // поэтому письмо по-прежнему видно под ассетом (D-E5).
      let withPlate: Bytes = overlays;
      if (plateSpec && plateColor) {
        const plate = await renderGlowPlate(plateSpec, plateColor, sw, sh);
        withPlate = await sharp(plate)
          .composite([{ input: overlays, left: 0, top: 0 }])
          .png(PNG_OPTS)
          .toBuffer();
      }

      // Transparent delivery: the overlay stack IS the asset — an alpha PNG of
      // the canonical size, empty everywhere the layers do not cover.
      const canvas: Bytes = background
        ? await sharp(background)
            .resize(sw, sh, { fit: "cover", position: "centre", kernel: "lanczos3" })
            .ensureAlpha()
            .composite([{ input: withPlate, left: 0, top: 0 }])
            .png(PNG_OPTS)
            .toBuffer()
        : withPlate;

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
      // Задание 2 — то, что проверяет валидатор Фазы 4 (V2′/V7/V10b/V11).
      scene: spec.scatter
        ? {
            glowColor: plateColor ? rgbToHex(plateColor) : null,
            croppedByEdge: countCroppedByEdge(decorBoxes, W, H),
            backCropsTop: scene ? decorBoxes.slice(0, scene.backCount).some((b) => b !== null && b.y < 0) : false,
            typographyTokens: typoPlacements.length,
          }
        : null,
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
