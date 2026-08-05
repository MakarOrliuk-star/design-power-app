import sharp from "sharp";
import type { FractionZone } from "./aiAssetValidator.js";

/**
 * Пиксель считается белым фоном при люме >= порога (A-2: фон чисто-белый;
 * допуск на jpeg-артефакты и лёгкое свечение). Живёт здесь, а не в валидаторе,
 * чтобы мок валидатора в тестах пайплайна не обнулял порог: валидатор
 * импортирует его отсюда.
 */
export const CENTER_BG_MIN_LUMA = 235;

/**
 * Гарантия «чистого центра», вариант A-5 (TASK ai-reference): banana собирает
 * композицию хорошо, но размерность safe-зоны не выдерживает. Правка A-4
 * (пере-раскладка боковых групп) признана неудачной — она перекраивала
 * композицию. Теперь композиция НЕ трогается, вместо этого «раздвигается
 * центр» (идея Пользователя):
 *
 *   1. «Летуны» — связные компоненты не-белых пикселей ЦЕЛИКОМ внутри чистой
 *      зоны — стираются заливкой белым (зона и так обязана быть белой).
 *   2. Если боковые группы залезают в зону — кадр режется по самой «пустой»
 *      вертикали у середины, в разрез вставляется белая полоса нужной ширины,
 *      затем весь кадр равномерно уменьшается обратно до целевой ширины с
 *      якорем к низу (сверху добавляется белое — фон и так белый). Каждая
 *      половина композиции остаётся пиксельно нетронутой, только чуть мельче.
 *
 * Ужатие ограничено MIN_WIDEN_SCALE: дальше полоса не растёт, остаточное
 * «лёгкое залезание» item сбоку принято Пользователем как допустимое —
 * порог чека center ослаблен соответственно (CENTER_CLEAR_MIN_RATIO).
 *
 * Генеративный филл (Bria GenFill / FLUX Fill на fal.ai) рассмотрен и
 * отвергнут: вставка белая — дорисовывать нечего, а филл может насыпать в
 * центр новые пропсы и стоит денег на каждую попытку.
 */

export interface CenterEnforceResult {
  buffer: Buffer;
  /** Стёртые «летуны» в чистой зоне. */
  erased: number;
  /** Ширина вставленной белой полосы в исходных px (0 — не раздвигали). */
  gapPx: number;
  /** Итоговый коэффициент уменьшения кадра (1 — не раздвигали). */
  scale: number;
  /** Колонка разреза в исходных px (null — не раздвигали). */
  seamX: number | null;
  /** Буфер был изменён (иначе возвращён исходный без перекодирования). */
  changed: boolean;
}

/** Компоненты меньше этого — шум сжатия, не объект. */
const MIN_COMPONENT_PX = 4;

/** Запас заливки вокруг bbox летуна: анти-алиас и остаточное свечение. */
const FILL_PAD_PX = 2;

/** Сколько пикселей интрузии в зоне игнорируем как анти-алиас. */
const INTRUSION_MIN_PX = 8;

/** Ниже этого кадр не ужимаем: остаток интрузии допустим (решение Пользователя). */
const MIN_WIDEN_SCALE = 0.72;

/** Разрез ищем в этой доле ширины вокруг середины кадра. */
const SEAM_SEARCH_HALF = 0.04;

/** Зазор между группой и границей зоны после раздвижки. */
const SECTION_GAP_PX = 6;

export async function enforceCenterClearZone(
  buffer: Buffer,
  zone: FractionZone,
): Promise<CenterEnforceResult> {
  const { data, info } = await sharp(buffer)
    .flatten({ background: "#ffffff" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: ch } = info;

  // Бинарная маска «не фон» по той же люме, что у чека center (BT.601).
  const nonBg = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += ch) {
    const luma = 0.299 * data[p]! + 0.587 * data[p + 1]! + 0.114 * data[p + 2]!;
    if (luma < CENTER_BG_MIN_LUMA) nonBg[i] = 1;
  }

  const bx0 = Math.floor(zone.x * w);
  const by0 = Math.floor(zone.y * h);
  const bx1 = Math.ceil((zone.x + zone.w) * w);
  const by1 = Math.ceil((zone.y + zone.h) * h);

  const fillWhite = (x0: number, y0: number, x1: number, y1: number) => {
    const fx0 = Math.max(0, x0);
    const fy0 = Math.max(0, y0);
    const fx1 = Math.min(w - 1, x1);
    const fy1 = Math.min(h - 1, y1);
    for (let y = fy0; y <= fy1; y++)
      for (let x = fx0; x <= fx1; x++) {
        const p = (y * w + x) * ch;
        data[p] = 255;
        data[p + 1] = 255;
        data[p + 2] = 255;
        if (ch === 4) data[p + 3] = 255;
        nonBg[y * w + x] = 0;
      }
  };

  // Шаг 1: летуны. Разметка компонент (4-соседство, итеративный DFS) с
  // затравками в зоне; bbox строго внутри зоны → стереть.
  const labels = new Int32Array(w * h);
  const stack: number[] = [];
  let erased = 0;
  let label = 0;
  for (let sy = by0; sy < by1; sy++) {
    for (let sx = bx0; sx < bx1; sx++) {
      const si = sy * w + sx;
      if (!nonBg[si] || labels[si]) continue;
      label++;
      labels[si] = label;
      stack.push(si);
      let size = 0;
      let minX = sx;
      let maxX = sx;
      let minY = sy;
      let maxY = sy;
      while (stack.length) {
        const i = stack.pop()!;
        const x = i % w;
        const y = (i / w) | 0;
        size++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (x > 0 && nonBg[i - 1] && !labels[i - 1]) {
          labels[i - 1] = label;
          stack.push(i - 1);
        }
        if (x < w - 1 && nonBg[i + 1] && !labels[i + 1]) {
          labels[i + 1] = label;
          stack.push(i + 1);
        }
        if (y > 0 && nonBg[i - w] && !labels[i - w]) {
          labels[i - w] = label;
          stack.push(i - w);
        }
        if (y < h - 1 && nonBg[i + w] && !labels[i + w]) {
          labels[i + w] = label;
          stack.push(i + w);
        }
      }
      if (size < MIN_COMPONENT_PX) continue;
      const inside = minX > bx0 && maxX < bx1 - 1 && minY > by0 && maxY < by1 - 1;
      if (!inside) continue;
      fillWhite(minX - FILL_PAD_PX, minY - FILL_PAD_PX, maxX + FILL_PAD_PX, maxY + FILL_PAD_PX);
      erased++;
    }
  }

  // Шаг 2: интрузия боковых групп в зону (по строкам зоны, после стирания
  // летунов). Lmax — насколько левая сторона заходит вправо, Rmin — правая влево.
  const mid = Math.floor(w / 2);
  let lMax = -1;
  let rMin = w;
  let lCount = 0;
  let rCount = 0;
  for (let y = by0; y < by1; y++)
    for (let x = bx0; x < bx1; x++) {
      if (!nonBg[y * w + x]) continue;
      if (x < mid) {
        lCount++;
        if (x > lMax) lMax = x;
      } else {
        rCount++;
        if (x < rMin) rMin = x;
      }
    }
  const leftIntrudes = lCount >= INTRUSION_MIN_PX;
  const rightIntrudes = rCount >= INTRUSION_MIN_PX;

  let gapPx = 0;
  let scale = 1;
  let seamX: number | null = null;

  if (leftIntrudes || rightIntrudes) {
    // Требуемое уменьшение: после вставки полосы G кадр ужимается s = w/(w+G);
    // левый край зоны должен освободиться (Lmax·s <= bx0 - зазор), правый —
    // симметрично ((Rmin+G)·s >= bx1 + зазор).
    const sLeft = leftIntrudes ? (bx0 - SECTION_GAP_PX) / (lMax + 1) : 1;
    const sRight = rightIntrudes ? (w - bx1 - SECTION_GAP_PX) / (w - rMin) : 1;
    scale = Math.max(MIN_WIDEN_SCALE, Math.min(1, sLeft, sRight));
    if (scale < 1) {
      gapPx = Math.round(w * (1 / scale - 1));
      scale = w / (w + gapPx);

      // Разрез — самая «пустая» вертикаль вокруг середины (меньше шансов
      // распилить нижний декор, легально пересекающий центр).
      const half = Math.max(1, Math.round(w * SEAM_SEARCH_HALF));
      let best = mid;
      let bestCount = Infinity;
      for (let x = mid - half; x <= mid + half; x++) {
        let cnt = 0;
        for (let y = 0; y < h; y++) if (nonBg[y * w + x]) cnt++;
        if (cnt < bestCount) {
          bestCount = cnt;
          best = x;
        }
      }
      seamX = best;
    }
  }

  if (!erased && !gapPx) {
    return { buffer, erased: 0, gapPx: 0, scale: 1, seamX: null, changed: false };
  }

  const base = sharp(data, { raw: { width: w, height: h, channels: ch } });
  let out: Buffer;
  if (!gapPx || seamX === null) {
    out = await base.png().toBuffer();
  } else {
    const leftCrop = await base
      .clone()
      .extract({ left: 0, top: 0, width: seamX, height: h })
      .png()
      .toBuffer();
    const rightCrop = await base
      .clone()
      .extract({ left: seamX, top: 0, width: w - seamX, height: h })
      .png()
      .toBuffer();
    const newH = Math.max(1, Math.round(h * scale));
    const shrunk = await sharp({
      create: { width: w + gapPx, height: h, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite([
        { input: leftCrop, left: 0, top: 0 },
        { input: rightCrop, left: seamX + gapPx, top: 0 },
      ])
      .png()
      .toBuffer();
    const resized = await sharp(shrunk).resize(w, newH).png().toBuffer();
    // Якорь к низу: сверху белая полоса (фон белый — шов не виден).
    out = await sharp({
      create: { width: w, height: h, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .composite([{ input: resized, left: 0, top: h - newH }])
      .png()
      .toBuffer();
  }

  return {
    buffer: out,
    erased,
    gapPx,
    scale: Math.round(scale * 100) / 100,
    seamX,
    changed: true,
  };
}
