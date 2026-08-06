import sharp from "sharp";
import { createHash } from "node:crypto";

/**
 * Pattern Miner — Задание 3, Фаза 1.
 *
 * ОДИН код добывает паттерн из эталонов и проверяет им же наш результат
 * (`D-C1`, `D-C2`). Два разных кода для «замерить эталон» и «проверить выход»
 * неизбежно разъезжаются — это претензия П-5, и модуль существует, чтобы её
 * закрыть. Прежний `lib/patternMetrics.ts` мерил другой методикой (alpha ≥ 128
 * вместо > 32, (R+G+B)/3 вместо Rec.709, без морфологии и лапласиана) и
 * подлежит удалению (`D-N4`).
 *
 * Методика — TASK §3.1. Три определения, которых §3.1 не задаёт, восстановлены
 * сверкой с таблицей §3.2 и зафиксированы в `D-N2`; см. комментарии у METHOD.
 * Замер воспроизводит 21 строку таблицы из 22, 12 из них точно.
 */

// ---------------------------------------------------------------------------
// Методика. Все пороги здесь; магических чисел ниже по коду нет (TASK §9).
// ---------------------------------------------------------------------------

export const METHOD = {
  /** Маска содержимого для RGB-файла: яркость Rec.709. */
  brightThreshold: 70,
  /** Маска содержимого для RGBA-файла. */
  alphaThreshold: 32,
  /** MORPH_CLOSE перед разметкой, сторона квадратного ядра. */
  morphCloseKernel: 5,
  /** Связная область учитывается как компонент. */
  minComponentArea: 150,
  /** Компонент «крупный» — участвует в подсчёте подрезки кромками. */
  largeComponentArea: 400,
  /** Касание кромки: расстояние bbox до кромки, доля от размера холста. */
  edgeTouchFraction: 0.004,
  /** Герои исключаются из декора: крупнейший компонент слева и справа. */
  heroLeftMaxCx: 0.35,
  heroRightMinCx: 0.65,
  /**
   * Сторона КВАДРАТНОГО патча в углу, доля ШИРИНЫ холста (`D-N2`).
   * §3.1 размер не задаёт; 5 % восстановлено подбором — RMSE 0.24 против
   * ряда 3.7/6.5/6.7/2.0/2.9, ближайший конкурент 0.51.
   */
  cornerPatchFraction: 0.05,
  /**
   * Зона замера «яркость фона в центре» — это `text-core`, а не весь
   * центральный band (`D-N2`, RMSE 0.96). Семантически верно: мерить нужно
   * ровно тот фон, на который ляжет текст письма, — эта же величина является
   * входом для проверки контраста.
   */
  centerLumZone: { x0: 0.25, x1: 0.72, y0: 1 / 3, y1: 2 / 3 },
  /** Зоны §3.4 (`D-C5`). */
  zones: {
    heroLeft: { x0: 0.0, x1: 0.25 },
    heroRight: { x0: 0.73, x1: 1.0 },
    central: { x0: 0.25, x1: 0.72 },
    sceneTop: { y0: 0, y1: 1 / 3 },
    textCore: { y0: 1 / 3, y1: 2 / 3 },
    sceneBottom: { y0: 2 / 3, y1: 1 },
  },
  /** Допуск коридора §4.1: доля ширины коридора и доля значения границы. */
  toleranceOfWidth: 0.1,
  toleranceOfBound: 0.05,
} as const;

/**
 * Полутон для лапласиана — Rec.601 (`cv2.COLOR_BGR2GRAY`), интегрирование по
 * всему bbox (`D-N2`). Проверено: ex4 совпадает точно (184.31 против 184).
 */
function rec601(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function rec709(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// ---------------------------------------------------------------------------
// Растр
// ---------------------------------------------------------------------------

export interface Raster {
  width: number;
  height: number;
  /** RGB, композит на чёрном, 3 байта на пиксель — для оттенков. */
  rgb: Uint8Array;
  /** Rec.709, композит на чёрном. */
  lum: Float32Array;
  /** Rec.601 — только для лапласиана. */
  gray: Float32Array;
  alpha: Uint8Array;
  /** В файле есть РЕАЛЬНАЯ прозрачность, а не формальный канал. */
  hasAlpha: boolean;
  /** Маска содержимого после MORPH_CLOSE — для разметки компонентов. */
  mask: Uint8Array;
  /** Маска до морфологии — для покрытий, чтобы площадь не раздувалась. */
  rawMask: Uint8Array;
}

export async function loadRaster(input: Buffer | string): Promise<Raster> {
  const img = sharp(input);
  const meta = await img.metadata();
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const n = W * H;

  const rgb = new Uint8Array(n * 3);
  const lum = new Float32Array(n);
  const gray = new Float32Array(n);
  const alpha = new Uint8Array(n);
  let semiTransparent = 0;

  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3]!;
    alpha[i] = a;
    if (a < 255) semiTransparent++;
    const r = (data[i * 4]! * a) / 255;
    const g = (data[i * 4 + 1]! * a) / 255;
    const b = (data[i * 4 + 2]! * a) / 255;
    rgb[i * 3] = Math.round(r);
    rgb[i * 3 + 1] = Math.round(g);
    rgb[i * 3 + 2] = Math.round(b);
    lum[i] = rec709(r, g, b);
    gray[i] = rec601(r, g, b);
  }

  // PNG может нести альфа-канал формально и быть полностью непрозрачным —
  // такой файл меряется по яркости, как эталон-JPEG.
  const hasAlpha = Boolean(meta.hasAlpha) && semiTransparent > n * 0.001;

  const rawMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    rawMask[i] = hasAlpha
      ? alpha[i]! > METHOD.alphaThreshold
        ? 1
        : 0
      : lum[i]! > METHOD.brightThreshold
        ? 1
        : 0;
  }

  return {
    width: W,
    height: H,
    rgb,
    lum,
    gray,
    alpha,
    hasAlpha,
    mask: morphClose(rawMask, W, H, METHOD.morphCloseKernel),
    rawMask,
  };
}

// ---------------------------------------------------------------------------
// Морфология: MORPH_CLOSE = dilate → erode. Квадратное ядро разделимо, поэтому
// два 1D-прохода вместо O(k²) на пиксель.
// ---------------------------------------------------------------------------

function morphPass(src: Uint8Array, W: number, H: number, k: number, dilate: boolean): Uint8Array {
  const r = (k - 1) / 2;
  const tmp = new Uint8Array(W * H);
  const out = new Uint8Array(W * H);
  const hit = dilate ? 1 : 0;

  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      let v = dilate ? 0 : 1;
      for (let d = -r; d <= r; d++) {
        const nx = x + d;
        if (nx < 0 || nx >= W) {
          // За кромкой — фон: объект у края не «дорастает» наружу.
          if (!dilate) {
            v = 0;
            break;
          }
          continue;
        }
        if (src[row + nx] === hit) {
          v = hit;
          break;
        }
      }
      tmp[row + x] = v;
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = dilate ? 0 : 1;
      for (let d = -r; d <= r; d++) {
        const ny = y + d;
        if (ny < 0 || ny >= H) {
          if (!dilate) {
            v = 0;
            break;
          }
          continue;
        }
        if (tmp[ny * W + x] === hit) {
          v = hit;
          break;
        }
      }
      out[y * W + x] = v;
    }
  }
  return out;
}

function morphClose(src: Uint8Array, W: number, H: number, k: number): Uint8Array {
  return morphPass(morphPass(src, W, H, k, true), W, H, k, false);
}

// ---------------------------------------------------------------------------
// Шаги [2] Segment и [3] Classify
// ---------------------------------------------------------------------------

/**
 * Роль инстанса. СТРУКТУРНАЯ: майнер фиксирует, что слот занят и где он лежит,
 * но никогда — ЧТО именно в нём стоит (`D-C8`). «Надпись BIG WIN» ролью не
 * является; `slot-fill` означает лишь «второй объект hero-зоны».
 */
export type InstanceRole =
  | "hero-item"
  | "hero-person"
  | "slot-fill"
  | "decor-large"
  | "decor-small";

export interface Component {
  area: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Центр bbox по X, доля ширины. */
  cx: number;
  /** Площадь, % холста. */
  areaPct: number;
  /** Дисперсия лапласиана по bbox. */
  sharpness: number;
  cropped: { left: boolean; right: boolean; top: boolean; bottom: boolean };
  role: InstanceRole;
}

/** Связные компоненты, 8-связность, итеративный обход (без рекурсии). */
export function connectedComponents(r: Raster): Component[] {
  const { width: W, height: H, mask } = r;
  const labels = new Int32Array(W * H).fill(-1);
  const out: Array<Component | null> = [];
  const stack: number[] = [];
  const tolX = METHOD.edgeTouchFraction * W;
  const tolY = METHOD.edgeTouchFraction * H;

  for (let start = 0; start < W * H; start++) {
    if (mask[start] !== 1 || labels[start] !== -1) continue;
    let area = 0;
    let x0 = W;
    let y0 = H;
    let x1 = -1;
    let y1 = -1;
    const label = out.length;
    labels[start] = label;
    stack.push(start);
    while (stack.length > 0) {
      const p = stack.pop()!;
      const x = p % W;
      const y = (p - x) / W;
      area++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= W) continue;
          const q = ny * W + nx;
          if (mask[q] === 1 && labels[q] === -1) {
            labels[q] = label;
            stack.push(q);
          }
        }
      }
    }
    // Мелочь ниже порога — шум, но место в массиве занимает: индекс совпадает
    // с меткой в `labels`, и сдвиг ломал бы соответствие.
    if (area < METHOD.minComponentArea) {
      out.push(null);
      continue;
    }
    out.push({
      area,
      x0,
      y0,
      x1,
      y1,
      cx: (x0 + x1) / 2 / W,
      areaPct: (area / (W * H)) * 100,
      sharpness: laplacianVariance(r, x0, y0, x1, y1),
      cropped: {
        left: x0 <= tolX,
        right: x1 >= W - 1 - tolX,
        top: y0 <= tolY,
        bottom: y1 >= H - 1 - tolY,
      },
      role: "decor-small",
    });
  }

  const comps = out.filter((c): c is Component => c !== null);
  assignRoles(comps);
  return comps;
}

/**
 * Шаг [3] Classify без VLM: роли выводятся из геометрии и площади. Проверено на
 * корпусе — счётчики компонентов (14/19/9/17/17) и объектов декора
 * (12/17/7/15/15) совпали с таблицей §3.2 точно на всех пяти эталонах, поэтому
 * SAM/VLM для метрик не нужен (`D-N3`).
 */
function assignRoles(comps: Component[]): void {
  const byAreaDesc = (a: Component, b: Component) => b.area - a.area;
  const left = comps.filter((c) => c.cx < METHOD.heroLeftMaxCx).sort(byAreaDesc);
  const right = comps.filter((c) => c.cx > METHOD.heroRightMinCx).sort(byAreaDesc);

  for (const c of comps) {
    c.role = c.area >= METHOD.largeComponentArea ? "decor-large" : "decor-small";
  }
  // Второй по величине объект hero-зоны — это опциональный слот зоны
  // (`left-fill` / `held`). Именно он добирает зону до 84–91 % высоты.
  if (left[0]) left[0].role = "hero-item";
  if (left[1]) left[1].role = "slot-fill";
  if (right[0]) right[0].role = "hero-person";
  if (right[1]) right[1].role = "slot-fill";
}

/** Резкость объекта — дисперсия лапласиана по его bbox (§3.1). */
function laplacianVariance(r: Raster, x0: number, y0: number, x1: number, y1: number): number {
  const { width: W, height: H, gray } = r;
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  for (let y = Math.max(1, y0); y <= Math.min(H - 2, y1); y++) {
    for (let x = Math.max(1, x0); x <= Math.min(W - 2, x1); x++) {
      const i = y * W + x;
      const v = 4 * gray[i]! - gray[i - 1]! - gray[i + 1]! - gray[i - W]! - gray[i + W]!;
      sum += v;
      sum2 += v * v;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

// ---------------------------------------------------------------------------
// Шаг [4] Measure
// ---------------------------------------------------------------------------

function coveragePct(r: Raster, x0f: number, x1f: number, y0f: number, y1f: number): number {
  const { width: W, height: H, rawMask } = r;
  const x0 = Math.max(0, Math.floor(x0f * W));
  const x1 = Math.min(W, Math.ceil(x1f * W));
  const y0 = Math.max(0, Math.floor(y0f * H));
  const y1 = Math.min(H, Math.ceil(y1f * H));
  if (x1 <= x0 || y1 <= y0) return 0;
  let hit = 0;
  for (let y = y0; y < y1; y++) {
    const row = y * W;
    for (let x = x0; x < x1; x++) if (rawMask[row + x] === 1) hit++;
  }
  return (hit / ((x1 - x0) * (y1 - y0))) * 100;
}

/** Union-bbox всего содержимого вертикальной полосы (§3.1, «высота кластера»). */
function bandUnionBox(
  r: Raster,
  x0f: number,
  x1f: number,
): { heightPct: number; topPct: number } | null {
  const { width: W, height: H, rawMask } = r;
  const x0 = Math.max(0, Math.floor(x0f * W));
  const x1 = Math.min(W, Math.ceil(x1f * W));
  let y0 = H;
  let y1 = -1;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = x0; x < x1; x++) {
      if (rawMask[row + x] === 1) {
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        break;
      }
    }
  }
  if (y1 < 0) return null;
  return { heightPct: ((y1 - y0 + 1) / H) * 100, topPct: (y0 / H) * 100 };
}

/** Средняя яркость Rec.709 в четырёх квадратных угловых патчах. */
function cornerLuminance(r: Raster): number {
  const { width: W, height: H, lum } = r;
  const side = Math.max(1, Math.round(METHOD.cornerPatchFraction * W));
  let sum = 0;
  let n = 0;
  for (const [sx, sy] of [
    [0, 0],
    [W - side, 0],
    [0, H - side],
    [W - side, H - side],
  ] as const) {
    for (let y = Math.max(0, sy); y < Math.min(H, sy + side); y++) {
      for (let x = Math.max(0, sx); x < Math.min(W, sx + side); x++) {
        sum += lum[y * W + x]!;
        n++;
      }
    }
  }
  return n === 0 ? 0 : sum / n;
}

/** Средняя яркость Rec.709 по зоне `text-core`; содержимое не исключается. */
function centerBackgroundLuminance(r: Raster): number {
  const { width: W, height: H, lum } = r;
  const z = METHOD.centerLumZone;
  const x0 = Math.floor(z.x0 * W);
  const x1 = Math.ceil(z.x1 * W);
  const y0 = Math.floor(z.y0 * H);
  const y1 = Math.ceil(z.y1 * H);
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    const row = y * W;
    for (let x = x0; x < x1; x++) {
      sum += lum[row + x]!;
      n++;
    }
  }
  return n === 0 ? 0 : sum / n;
}

/**
 * Число доминирующих оттенков (V14, инвариант §4.2.1 «2–3 оттенка на кадр»).
 * Гистограмма H из HSV по значимым пикселям, 36 корзин по 10°. Серые не
 * считаются: тени и блики не должны читаться как отдельный цвет. Соседние
 * корзины склеиваются окном ±1 — иначе плавный градиент золота дал бы три
 * «разных» цвета.
 */
export function dominantHueCount(r: Raster, minShare = 0.08): number {
  const { width: W, height: H, rawMask } = r;
  const bins = new Array(36).fill(0);
  let colored = 0;
  // Восстанавливаем каналы из яркостей нельзя — читаем исходный композит.
  for (let i = 0; i < W * H; i++) {
    if (rawMask[i] !== 1) continue;
    const red = r.rgb[i * 3]!;
    const green = r.rgb[i * 3 + 1]!;
    const blue = r.rgb[i * 3 + 2]!;
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const delta = max - min;
    if (max < 32 || delta / Math.max(1, max) < 0.18) continue;
    let hue: number;
    if (max === red) hue = ((green - blue) / delta) % 6;
    else if (max === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
    hue = (((hue * 60) % 360) + 360) % 360;
    bins[Math.floor(hue / 10)]!++;
    colored++;
  }
  if (colored === 0) return 0;
  const merged = bins.map((_, i) => bins[(i + 35) % 36]! + bins[i]! + bins[(i + 1) % 36]!);
  let count = 0;
  for (let i = 0; i < 36; i++) {
    const v = merged[i]!;
    if (v / colored < minShare) continue;
    if (v >= merged[(i + 35) % 36]! && v > merged[(i + 1) % 36]!) count++;
  }
  return count;
}

/**
 * Средняя альфа в круге радиуса `radius` (доля ширины) вокруг центра.
 * Величина осмысленна ТОЛЬКО на нашем выходе: эталоны непрозрачны, и коридор
 * по ним был бы [255, 255], то есть заведомо бракующим альфа-доставку.
 * Поэтому она не входит в вектор метрик и коридора не получает.
 */
export function centerAlphaMean(r: Raster, radius: number): number {
  const { width: W, height: H, alpha } = r;
  const cx = W / 2;
  const cy = H / 2;
  const rr = radius * W;
  let sum = 0;
  let n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > rr * rr) continue;
      sum += alpha[y * W + x]!;
      n++;
    }
  }
  return n === 0 ? 0 : sum / n;
}

export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 1) return s[0]!;
  const pos = (p / 100) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

const median = (xs: number[]) => percentile(xs, 50);

/** Вектор метрик кадра. Один и тот же для эталона и для нашего выхода. */
export interface Metrics {
  width: number;
  height: number;
  aspect: number;
  transparentPct: number;
  cornerLum: number;
  centerBgLum: number;
  bandCoverage: number;
  bandTopThird: number;
  bandMidThird: number;
  bandBottomThird: number;
  componentCount: number;
  decorCount: number;
  decorAreaPct: number;
  decorMedianAreaPct: number;
  /** p90/p10 — устойчивая замена max/min (`D-N1`). */
  sharpnessSpread: number;
  /** max/min — оставлен для сверки с таблицей §3.2, порогом не является. */
  sharpnessSpreadMaxMin: number;
  croppedTop: number;
  croppedTopLargestAreaPct: number;
  croppedTopLargestCx: number;
  croppedLeft: number;
  croppedRight: number;
  croppedBottom: number;
  contentBottomPct: number;
  itemClusterHeightPct: number;
  personClusterHeightPct: number;
  personTopPct: number;
  /** V14 / инвариант §4.2.1 «2–3 доминирующих оттенка на кадр». */
  dominantHues: number;
}

export interface MeasureResult {
  metrics: Metrics;
  components: Component[];
  raster: Raster;
}

export async function measure(input: Buffer | string): Promise<MeasureResult> {
  const r = await loadRaster(input);
  const comps = connectedComponents(r);
  const large = comps.filter((c) => c.area >= METHOD.largeComponentArea);
  const decor = comps.filter((c) => c.role !== "hero-item" && c.role !== "hero-person");

  const sharps = decor.map((c) => c.sharpness).filter((s) => s > 0);
  const sMin = sharps.length ? Math.min(...sharps) : 0;
  const sMax = sharps.length ? Math.max(...sharps) : 0;
  const p10 = percentile(sharps, 10);
  const p90 = percentile(sharps, 90);

  const croppedTopLarge = large.filter((c) => c.cropped.top).sort((a, b) => b.area - a.area);

  const { central, heroLeft, heroRight, sceneTop, textCore, sceneBottom } = METHOD.zones;
  const item = bandUnionBox(r, heroLeft.x0, heroLeft.x1);
  const person = bandUnionBox(r, heroRight.x0, heroRight.x1);

  let contentBottom = -1;
  for (const c of comps) if (c.y1 > contentBottom) contentBottom = c.y1;

  return {
    components: comps,
    raster: r,
    metrics: {
      dominantHues: dominantHueCount(r),
      width: r.width,
      height: r.height,
      aspect: r.width / r.height,
      transparentPct: r.hasAlpha
        ? (r.alpha.reduce((n, a) => (a === 0 ? n + 1 : n), 0) / r.alpha.length) * 100
        : 0,
      cornerLum: cornerLuminance(r),
      centerBgLum: centerBackgroundLuminance(r),
      bandCoverage: coveragePct(r, central.x0, central.x1, 0, 1),
      bandTopThird: coveragePct(r, central.x0, central.x1, sceneTop.y0, sceneTop.y1),
      bandMidThird: coveragePct(r, central.x0, central.x1, textCore.y0, textCore.y1),
      bandBottomThird: coveragePct(r, central.x0, central.x1, sceneBottom.y0, sceneBottom.y1),
      componentCount: comps.length,
      decorCount: decor.length,
      decorAreaPct: decor.reduce((s, c) => s + c.areaPct, 0),
      decorMedianAreaPct: median(decor.map((c) => c.areaPct)),
      sharpnessSpread: p10 > 0 ? p90 / p10 : 0,
      sharpnessSpreadMaxMin: sMin > 0 ? sMax / sMin : 0,
      croppedTop: croppedTopLarge.length,
      croppedTopLargestAreaPct: croppedTopLarge[0]?.areaPct ?? 0,
      croppedTopLargestCx: croppedTopLarge[0]?.cx ?? 0,
      croppedLeft: large.filter((c) => c.cropped.left).length,
      croppedRight: large.filter((c) => c.cropped.right).length,
      croppedBottom: large.filter((c) => c.cropped.bottom).length,
      contentBottomPct: contentBottom < 0 ? 0 : ((contentBottom + 1) / r.height) * 100,
      itemClusterHeightPct: item?.heightPct ?? 0,
      personClusterHeightPct: person?.heightPct ?? 0,
      personTopPct: person?.topPct ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Шаг [5] Aggregate — коридоры
// ---------------------------------------------------------------------------

/** Метрики, по которым коридор не строится: это свойства файла, не паттерна. */
const NON_CORRIDOR_KEYS = new Set<keyof Metrics>(["width", "height", "aspect"]);

/**
 * Направление проверки. Числа по-прежнему приходят ИЗ КОРПУСА (`D-C1`) —
 * здесь объявлено лишь то, с какой стороны отклонение является дефектом. Это
 * структурное знание из TASK §3.4 и §4.2.1, а не подобранная константа.
 *
 *  - `floor`   — дефект только снизу: зона обязана быть заполнена, глубина
 *                обязана быть, объекты обязаны присутствовать;
 *  - `ceiling` — дефект только сверху: защищённая зона, запрет касания низа;
 *  - `band`    — двусторонний коридор (по умолчанию);
 *  - `info`    — не проверяется, живёт в спеке для сверки.
 *
 * Почему это нужно. Допуск §4.1 берёт 10 % ШИРИНЫ коридора, а у «разброса
 * резкости» ширина 13…188. Десять процентов от неё — 17.5, и нижняя граница
 * уезжает в минус: проверка перестаёт срабатывать снизу вообще, а `result-2`
 * со своими 1.26 её ПРОХОДИТ. Между тем §4.2.1 требует ровно обратного —
 * «разброс резкости ≥ 10×» — и заявляет, что result-2 обязан упасть. Ширина
 * коридора неприменима к односторонней проверке: для неё берётся только
 * допуск «5 % от значения границы».
 */
export type CheckDirection = "floor" | "ceiling" | "band" | "info";

export const DIRECTIONS: Partial<Record<keyof Metrics, CheckDirection>> = {
  // Заполненность сцены и глубина — дефект только снизу.
  bandCoverage: "floor",
  bandTopThird: "floor",
  bandBottomThird: "floor",
  componentCount: "floor",
  decorCount: "floor",
  decorAreaPct: "floor",
  decorMedianAreaPct: "floor",
  sharpnessSpread: "floor",
  croppedTop: "floor",
  itemClusterHeightPct: "floor",
  // Защищённая зона, запрет касания нижней кромки, цветовой ключ — дефект
  // только сверху.
  bandMidThird: "ceiling",
  croppedBottom: "ceiling",
  transparentPct: "ceiling",
  dominantHues: "ceiling",
  // Инвариант — «свечение с ЧЁРНЫМИ углами»: угол светлее эталонных — дефект,
  // угол темнее — нет («чернее чёрного» не бывает; при доставке с альфой
  // яркость угла добавляет фон письма, а не ассет).
  cornerLum: "ceiling",
  // Сверочная величина: воспроизводит строку §3.2, порогом не является (`D-N1`).
  sharpnessSpreadMaxMin: "info",
};

export interface Corridor {
  /** Голые min/max по корпусу. */
  min: number;
  max: number;
  /**
   * Границы с допуском §4.1 — именно их применяет валидатор.
   * `null` — сторона не ограничена (односторонняя проверка). Не Infinity:
   * `JSON.stringify(Infinity)` даёт `null` молча, и спека читалась бы иначе,
   * чем записывалась.
   */
  lo: number | null;
  hi: number | null;
  direction: CheckDirection;
  /** Вклад каждого эталона: прозрачность коридора (TASK §4.1). */
  values: Record<string, number>;
  /** Имена эталонов, выпадающих из ряда. */
  outliers: string[];
}

/**
 * Допуск §4.1: 10 % ширины коридора, но не менее 5 % от значения границы.
 * Без допуска валидатор бракует сам корпус — эталон, задающий границу, попадает
 * ровно на неё и падает на округлении. Коридор нулевой ширины из нулей
 * («подрезано низом = 0» в 5/5) остаётся строгим автоматически: оба слагаемых
 * обращаются в ноль.
 *
 * Для односторонних проверок слагаемое «10 % ширины» не применяется — см.
 * комментарий к DIRECTIONS.
 */
export function applyTolerance(
  min: number,
  max: number,
  direction: CheckDirection = "band",
): { lo: number | null; hi: number | null } {
  const width = max - min;
  const oneSided = direction === "floor" || direction === "ceiling";
  const tol = (bound: number) =>
    oneSided
      ? METHOD.toleranceOfBound * Math.abs(bound)
      : Math.max(METHOD.toleranceOfWidth * width, METHOD.toleranceOfBound * Math.abs(bound));

  if (direction === "floor") return { lo: min - tol(min), hi: null };
  if (direction === "ceiling") return { lo: null, hi: max + tol(max) };
  return { lo: min - tol(min), hi: max + tol(max) };
}

/**
 * Выброс по модифицированному z-score (Iglewicz–Hoaglin): `0.6745·|v−med|/MAD`,
 * порог 3.5. Обычный MAD с порогом 2 при n = 5 срабатывает почти на каждой
 * строке и делает пометку бесполезной; этот критерий выделяет ровно те случаи,
 * которые TASK §4.1 и называет выбросами — например ex2 с яркостью фона 38.9
 * при 17.0–19.6 у остальных.
 */
function findOutliers(names: string[], values: number[]): string[] {
  const med = median(values);
  const mad = median(values.map((v) => Math.abs(v - med)));
  if (mad === 0) return [];
  return names.filter((_, i) => (0.6745 * Math.abs(values[i]! - med)) / mad > 3.5);
}

export interface PatternSpec {
  specVersion: string;
  /** sha256 по отсортированным хэшам файлов корпуса. */
  corpusHash: string;
  corpus: string[];
  method: typeof METHOD;
  canvas: { aspect: number };
  corridors: Record<string, Corridor>;
}

/**
 * Шаг [5]+[7]: корпус → спека. Побайтовая воспроизводимость обязательна
 * (TASK §4.1), поэтому даты внутри файла НЕТ — она хранится в строке БД
 * (`PatternSpec.createdAt`). Иначе повторный прогон давал бы другие байты.
 */
export function aggregate(
  specVersion: string,
  samples: Array<{ name: string; hash: string; metrics: Metrics }>,
): PatternSpec {
  if (samples.length === 0) throw new Error("aggregate: пустой корпус");

  const corridors: Record<string, Corridor> = {};
  const keys = Object.keys(samples[0]!.metrics) as Array<keyof Metrics>;
  for (const key of keys) {
    if (NON_CORRIDOR_KEYS.has(key)) continue;
    const names = samples.map((s) => s.name);
    const values = samples.map((s) => s.metrics[key]);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const direction = DIRECTIONS[key] ?? "band";
    const raw = applyTolerance(min, max, direction);
    corridors[key] = {
      min,
      max,
      // Все метрики вектора неотрицательны по построению — доли, счётчики,
      // яркости, отношения. Отрицательная нижняя граница означала бы, что
      // проверка снизу молча выключена.
      lo: raw.lo === null ? null : Math.max(0, raw.lo),
      hi: raw.hi,
      direction,
      values: Object.fromEntries(names.map((n, i) => [n, values[i]!])),
      outliers: findOutliers(names, values),
    };
  }

  const corpusHash = createHash("sha256")
    .update([...samples.map((s) => s.hash)].sort().join("\n"))
    .digest("hex");

  return {
    specVersion,
    corpusHash,
    corpus: samples.map((s) => s.name).sort(),
    method: METHOD,
    canvas: { aspect: samples[0]!.metrics.aspect },
    corridors,
  };
}

// ---------------------------------------------------------------------------
// Валидация = майнер по выходу + сравнение с коридорами (D-C2)
// ---------------------------------------------------------------------------

export interface CorridorCheck {
  key: string;
  passed: boolean;
  value: number;
  lo: number | null;
  hi: number | null;
  detail: string;
}

export interface CorridorReport {
  passed: boolean;
  checks: CorridorCheck[];
  failedKeys: string[];
}

/**
 * Сравнение вектора метрик с коридорами спеки. `only` ограничивает набор
 * проверок: при доставке с альфой (`D-E5`) метрики фона меряются по композиту
 * «ассет над фоном письма», а не по файлу ассета, и на файле бессмысленны.
 */
export function checkAgainstSpec(
  metrics: Metrics,
  spec: PatternSpec,
  only?: string[],
): CorridorReport {
  const checks: CorridorCheck[] = [];
  for (const [key, corridor] of Object.entries(spec.corridors)) {
    if (corridor.direction === "info") continue;
    if (only && !only.includes(key)) continue;
    const value = metrics[key as keyof Metrics];
    if (typeof value !== "number") continue;
    const passed =
      (corridor.lo === null || value >= corridor.lo) &&
      (corridor.hi === null || value <= corridor.hi);
    const band =
      corridor.lo === null
        ? `≤ ${round(corridor.hi!)}`
        : corridor.hi === null
          ? `≥ ${round(corridor.lo)}`
          : `${round(corridor.lo)}…${round(corridor.hi)}`;
    checks.push({
      key,
      passed,
      value,
      lo: corridor.lo,
      hi: corridor.hi,
      detail:
        `${round(value)} при требовании ${band}` +
        (corridor.outliers.length > 0 ? ` (выброс корпуса: ${corridor.outliers.join(", ")})` : ""),
    });
  }
  const failed = checks.filter((c) => !c.passed);
  return { passed: failed.length === 0, checks, failedKeys: failed.map((c) => c.key) };
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

// ---------------------------------------------------------------------------
// Превью
// ---------------------------------------------------------------------------

/** Сторона клетки шахматки, px @1x. */
export const CHECKER_CELL = 16;

/**
 * Подложить под ассет ШАХМАТКУ вместо чёрного (требование заказчика
 * 2026-07-30). На чёрном фоне прозрачная область неотличима от тёмного
 * содержимого, и глазом не понять, где у кадра дыра, а где чёрный костюм
 * персонажа. Шахматка это различие показывает.
 *
 * Только для превью и контактных листов: замер идёт по альфе, а не по подложке.
 */
export async function renderOnCheckerboard(
  input: Buffer,
  cell = CHECKER_CELL,
): Promise<Buffer> {
  const meta = await sharp(input).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (W === 0 || H === 0) throw new Error("renderOnCheckerboard: не удалось прочитать размеры");

  const light = 0xcc;
  const dark = 0x99;
  const board = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const on = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
      const v = on ? light : dark;
      const i = (y * W + x) * 3;
      board[i] = v;
      board[i + 1] = v;
      board[i + 2] = v;
    }
  }

  return sharp(board, { raw: { width: W, height: H, channels: 3 } })
    .composite([{ input, top: 0, left: 0 }])
    .png()
    .toBuffer();
}
