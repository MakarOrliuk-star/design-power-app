import sharp from "sharp";

/**
 * Метрики визуального паттерна (Задание 2, Фаза 4).
 *
 * Один и тот же код считает числа и для ЭТАЛОНОВ дизайнеров, и для наших
 * композитов. Это принципиально: коридоры V4/V5/V6/V7 сняты с эталонов, и
 * если валидатор будет мерить их иначе, чем мерил калибровочный скрипт,
 * пороги разъедутся молча. `scripts/measure-visual-pattern.ts` и
 * `lib/assetValidator.ts` импортируют отсюда, своих реализаций не держат.
 *
 * ОПРЕДЕЛЕНИЯ (контракт, зафиксирован в Фазе 0):
 *  - brightness = (R+G+B)/3 по каналам, скомпонованным НА ЧЁРНОМ;
 *  - «значимый пиксель»:
 *      · изображение БЕЗ реальной альфы (эталон-JPEG) → brightness > 70,
 *      · изображение С альфой (наш композит)          → alpha >= 128;
 *  - компонент — связная область значимых пикселей (8-связность).
 */

/** Порог яркости для непрозрачных изображений (TASK §2.1). */
export const BRIGHT_THRESHOLD = 70;
/** Порог альфы для прозрачных. */
export const ALPHA_THRESHOLD = 128;
/** Меньше этого — шум, а не объект декора (TASK §2.2 «объектов > 150 px»). */
export const MIN_DECOR_AREA = 150;

export interface Raster {
  width: number;
  height: number;
  /** RGB, скомпонованный на чёрном, 3 байта на пиксель. */
  rgb: Uint8Array;
  alpha: Uint8Array;
  /** Есть ли в файле РЕАЛЬНАЯ прозрачность (а не формальный канал). */
  hasAlpha: boolean;
  mask: Uint8Array;
}

export async function loadRaster(input: Buffer): Promise<Raster> {
  const img = sharp(input);
  const meta = await img.metadata();
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  const rgb = new Uint8Array(n * 3);
  const alpha = new Uint8Array(n);
  let transparentPixels = 0;
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3]!;
    alpha[i] = a;
    if (a < 255) transparentPixels++;
    rgb[i * 3] = Math.round((data[i * 4]! * a) / 255);
    rgb[i * 3 + 1] = Math.round((data[i * 4 + 1]! * a) / 255);
    rgb[i * 3 + 2] = Math.round((data[i * 4 + 2]! * a) / 255);
  }
  // PNG может иметь альфа-канал формально и быть полностью непрозрачным —
  // тогда мерить надо по яркости, как эталон.
  const hasAlpha = Boolean(meta.hasAlpha) && transparentPixels > n * 0.001;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    mask[i] = hasAlpha
      ? alpha[i]! >= ALPHA_THRESHOLD
        ? 1
        : 0
      : brightnessAt(rgb, i) > BRIGHT_THRESHOLD
        ? 1
        : 0;
  }
  return { width: info.width, height: info.height, rgb, alpha, hasAlpha, mask };
}

export function brightnessAt(rgb: Uint8Array, i: number): number {
  return (rgb[i * 3]! + rgb[i * 3 + 1]! + rgb[i * 3 + 2]!) / 3;
}

export interface Component {
  area: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  edge: { left: number; right: number; top: number; bottom: number };
}

/** Связные компоненты, 8-связность, итеративный обход (без рекурсии). */
export function connectedComponents(r: Raster): Component[] {
  const { width: W, height: H, mask } = r;
  const labels = new Int32Array(W * H).fill(-1);
  const comps: Component[] = [];
  const stack: number[] = [];
  for (let start = 0; start < W * H; start++) {
    if (mask[start] !== 1 || labels[start] !== -1) continue;
    const label = comps.length;
    const c: Component = {
      area: 0,
      x0: W,
      y0: H,
      x1: -1,
      y1: -1,
      edge: { left: 0, right: 0, top: 0, bottom: 0 },
    };
    labels[start] = label;
    stack.push(start);
    while (stack.length > 0) {
      const p = stack.pop()!;
      const x = p % W;
      const y = (p - x) / W;
      c.area++;
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      if (x === 0) c.edge.left++;
      if (x === W - 1) c.edge.right++;
      if (y === 0) c.edge.top++;
      if (y === H - 1) c.edge.bottom++;
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
    comps.push(c);
  }
  return comps;
}

/** Доля значимых пикселей в вертикальной полосе [x, x+w) долей ширины, %. */
export function bandCoveragePct(r: Raster, x: number, w: number): number {
  const { width: W, height: H, mask } = r;
  const x0 = Math.max(0, Math.floor(x * W));
  const x1 = Math.min(W, Math.ceil((x + w) * W));
  if (x1 <= x0) return 0;
  let hit = 0;
  for (let y = 0; y < H; y++) for (let px = x0; px < x1; px++) if (mask[y * W + px] === 1) hit++;
  return (hit / ((x1 - x0) * H)) * 100;
}

/** Число объектов декора, чей bbox пересекает полосу (V5). */
export function bandObjectCount(comps: Component[], r: Raster, x: number, w: number): number {
  const x0 = Math.floor(x * r.width);
  const x1 = Math.ceil((x + w) * r.width);
  return comps.filter((c) => c.area > MIN_DECOR_AREA && c.x1 >= x0 && c.x0 < x1).length;
}

/** Сколько объектов подрезано кромкой холста (V7). */
export function croppedByEdgeCount(comps: Component[]): number {
  return comps.filter(
    (c) =>
      c.area > MIN_DECOR_AREA &&
      c.edge.left + c.edge.right + c.edge.top + c.edge.bottom > 0,
  ).length;
}

/** Средняя альфа в круге радиуса `radius` (доля ширины) вокруг центра. */
export function centerAlpha(r: Raster, radius: number): number {
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

/**
 * Доля ПОЛНОСТЬЮ прозрачных пикселей, %. Это и есть проверяемый смысл D-E5:
 * под ассетом должен быть виден фон письма.
 *
 * Именно эта величина, а не «альфа в углах»: угол законно закрывает объект
 * декора, подрезанный кромкой (приём П4), и максимум по углам давал бы 255 на
 * совершенно правильном кадре.
 */
export function transparentSharePct(r: Raster): number {
  let clear = 0;
  for (let i = 0; i < r.alpha.length; i++) if (r.alpha[i] === 0) clear++;
  return (clear / r.alpha.length) * 100;
}

/** Максимальная альфа в четырёх углах (квадраты 2%×2%). */
export function cornerAlphaMax(r: Raster): number {
  const { width: W, height: H, alpha } = r;
  const cw = Math.max(1, Math.round(0.02 * W));
  const ch = Math.max(1, Math.round(0.02 * H));
  let max = 0;
  for (let y = 0; y < H; y++) {
    if (y >= ch && y < H - ch) continue;
    for (let x = 0; x < W; x++) {
      if (x >= cw && x < W - cw) continue;
      const a = alpha[y * W + x]!;
      if (a > max) max = a;
    }
  }
  return max;
}

/**
 * Число доминирующих оттенков (V12, приём П8). Гистограмма H из HSV по
 * значимым пикселям, 36 корзин по 10°; корзина считается доминирующей, если
 * держит ≥ 8% цветных пикселей. Серые (низкая насыщенность) не учитываются —
 * тени и блики не должны считаться отдельным «цветом».
 */
export function dominantHueCount(r: Raster, minShare = 0.08): number {
  const { width: W, height: H, rgb, mask } = r;
  const bins = new Array(36).fill(0);
  let colored = 0;
  for (let i = 0; i < W * H; i++) {
    if (mask[i] !== 1) continue;
    const red = rgb[i * 3]!;
    const green = rgb[i * 3 + 1]!;
    const blue = rgb[i * 3 + 2]!;
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const delta = max - min;
    if (max < 32 || delta / Math.max(1, max) < 0.18) continue; // серое/тёмное
    let hue: number;
    if (max === red) hue = ((green - blue) / delta) % 6;
    else if (max === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
    hue = ((hue * 60) % 360 + 360) % 360;
    bins[Math.floor(hue / 10)]!++;
    colored++;
  }
  if (colored === 0) return 0;
  // Соседние корзины — один и тот же оттенок с разбросом; склеиваем окном ±1,
  // иначе плавный градиент золота читался бы как три «разных» цвета.
  const merged = bins.map((_, i) => bins[(i + 35) % 36]! + bins[i]! + bins[(i + 1) % 36]!);
  let count = 0;
  for (let i = 0; i < 36; i++) {
    const v = merged[i]!;
    if (v / colored < minShare) continue;
    // Локальный максимум — иначе одна широкая гряда даст несколько «пиков».
    if (v >= merged[(i + 35) % 36]! && v > merged[(i + 1) % 36]!) count++;
  }
  return count;
}
