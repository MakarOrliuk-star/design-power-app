import sharp from "sharp";
import type { OverlayOptions } from "sharp";
import type { FractionZone } from "./aiAssetValidator.js";

/**
 * Пиксель считается белым фоном при люме >= порога (A-2: фон чисто-белый;
 * допуск на jpeg-артефакты и лёгкое свечение). Живёт здесь, а не в валидаторе,
 * чтобы мок валидатора в тестах пайплайна не обнулял порог: валидатор
 * импортирует его отсюда.
 */
export const CENTER_BG_MIN_LUMA = 235;

/**
 * Гарантия «чистого центра» (A-4, TASK ai-reference): модель даже под строгим
 * контрактом заводит item/персонажа и мелкие партиклы в центральную полосу,
 * и три ретрая сгорают. Фон по A-2 чисто-белый, поэтому раскладку можно
 * чинить детерминированно, без второго AI-прохода:
 *
 *   1. «Летуны» — связные компоненты не-белых пикселей ЦЕЛИКОМ внутри чистой
 *      зоны — просто стираются (bbox заливается белым: зона и так обязана
 *      быть белой).
 *   2. Боковые группы (item слева / персонаж справа), залезшие в зону, —
 *      вырезаются целиком и вписываются обратно в СВОЮ секцию: масштаб вниз
 *      с якорем к своему краю канваса и к низу группы (как на email mask).
 *      Резать пропс «по живому» нельзя, поэтому группа уменьшается вся.
 *
 * Если группу пришлось бы ужать сильнее MIN_GROUP_SCALE — раскладка признаётся
 * безнадёжной и не трогается: её добьёт чек «center» и обычный ретрай.
 */

export interface CenterEnforceResult {
  buffer: Buffer;
  /** Стёртые «летуны» в чистой зоне. */
  erased: number;
  /** Коэффициент ужатия левой группы (null — не трогали). */
  scaledLeft: number | null;
  /** Коэффициент ужатия правой группы (null — не трогали). */
  scaledRight: number | null;
  /** Буфер был изменён (иначе возвращён исходный без перекодирования). */
  changed: boolean;
}

/** Компоненты меньше этого — шум сжатия, не объект. */
const MIN_COMPONENT_PX = 4;

/** Запас заливки вокруг bbox летуна: анти-алиас и остаточное свечение. */
const FILL_PAD_PX = 2;

/** Сколько пикселей компоненты в зоне считаем «залезла» (анти-алиас не в счёт). */
const INTRUSION_MIN_PX = 8;

/** Ниже этого группу не ужимаем — композиция безнадёжна, пусть решает ретрай. */
const MIN_GROUP_SCALE = 0.55;

/** Зазор между группой и границей чистой зоны после вписывания. */
const SECTION_GAP_PX = 6;

interface Component {
  size: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  inZone: number;
  sumX: number;
}

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
  const inZone = (x: number, y: number) => x >= bx0 && x < bx1 && y >= by0 && y < by1;

  // Разметка ВСЕХ компонент кадра (4-соседство, итеративный DFS).
  const labels = new Int32Array(w * h);
  const stack: number[] = [];
  const components: Component[] = [];
  for (let sy = 0; sy < h; sy++) {
    for (let sx = 0; sx < w; sx++) {
      const si = sy * w + sx;
      if (!nonBg[si] || labels[si]) continue;
      const label = components.length + 1;
      labels[si] = label;
      stack.push(si);
      const c: Component = {
        size: 0,
        minX: sx,
        maxX: sx,
        minY: sy,
        maxY: sy,
        inZone: 0,
        sumX: 0,
      };
      while (stack.length) {
        const i = stack.pop()!;
        const x = i % w;
        const y = (i / w) | 0;
        c.size++;
        c.sumX += x;
        if (x < c.minX) c.minX = x;
        if (x > c.maxX) c.maxX = x;
        if (y < c.minY) c.minY = y;
        if (y > c.maxY) c.maxY = y;
        if (inZone(x, y)) c.inZone++;
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
      components.push(c);
    }
  }

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
      }
  };

  // Шаг 1: летуны — bbox строго внутри зоны → стереть.
  let erased = 0;
  const floaters = new Set<Component>();
  for (const c of components) {
    if (c.size < MIN_COMPONENT_PX || !c.inZone) continue;
    const inside = c.minX > bx0 && c.maxX < bx1 - 1 && c.minY > by0 && c.maxY < by1 - 1;
    if (!inside) continue;
    fillWhite(c.minX - FILL_PAD_PX, c.minY - FILL_PAD_PX, c.maxX + FILL_PAD_PX, c.maxY + FILL_PAD_PX);
    floaters.add(c);
    erased++;
  }

  // Шаг 2: боковые группы. Кластер = не-летуны с центроидом слева/справа от
  // середины; чиним сторону, только если её компоненты реально залезли в зону.
  interface Cluster {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    intrudes: boolean;
    present: boolean;
  }
  const makeCluster = (): Cluster => ({
    minX: w,
    maxX: -1,
    minY: h,
    maxY: -1,
    intrudes: false,
    present: false,
  });
  const left = makeCluster();
  const right = makeCluster();
  for (const c of components) {
    if (c.size < MIN_COMPONENT_PX || floaters.has(c)) continue;
    const side = c.sumX / c.size < w / 2 ? left : right;
    side.present = true;
    if (c.minX < side.minX) side.minX = c.minX;
    if (c.maxX > side.maxX) side.maxX = c.maxX;
    if (c.minY < side.minY) side.minY = c.minY;
    if (c.maxY > side.maxY) side.maxY = c.maxY;
    if (c.inZone >= INTRUSION_MIN_PX) side.intrudes = true;
  }

  interface Fix {
    cluster: Cluster;
    scale: number;
    newW: number;
    newH: number;
    pasteX: number;
    pasteY: number;
  }
  const planFix = (cluster: Cluster, side: "left" | "right"): Fix | null => {
    if (!cluster.present || !cluster.intrudes) return null;
    const bw = cluster.maxX - cluster.minX + 1;
    const bh = cluster.maxY - cluster.minY + 1;
    // Доступная ширина: от своего края группы до границы зоны с зазором.
    const availW =
      side === "left" ? bx0 - SECTION_GAP_PX - cluster.minX : cluster.maxX - (bx1 + SECTION_GAP_PX) + 1;
    if (availW <= 0) return null;
    // Группа залезла в зону → её bbox шире доступной секции, scale всегда < 1.
    const scale = Math.min(1, availW / bw);
    if (scale >= 1 || scale < MIN_GROUP_SCALE) return null;
    const newW = Math.max(1, Math.round(bw * scale));
    const newH = Math.max(1, Math.round(bh * scale));
    // Якорь: свой край канваса по X (minX/maxX группы), низ группы по Y.
    const pasteX = side === "left" ? cluster.minX : cluster.maxX - newW + 1;
    const pasteY = cluster.maxY - newH + 1;
    return { cluster, scale, newW, newH, pasteX, pasteY };
  };

  const leftFix = planFix(left, "left");
  const rightFix = planFix(right, "right");

  if (!erased && !leftFix && !rightFix) {
    return { buffer, erased: 0, scaledLeft: null, scaledRight: null, changed: false };
  }

  // Кропы берём из кадра ПОСЛЕ стирания летунов (bbox группы может накрывать
  // зону, где они были), потом их место заливается белым.
  const overlays: OverlayOptions[] = [];
  for (const fix of [leftFix, rightFix]) {
    if (!fix) continue;
    const { cluster } = fix;
    const crop = await sharp(data, { raw: { width: w, height: h, channels: ch } })
      .extract({
        left: cluster.minX,
        top: cluster.minY,
        width: cluster.maxX - cluster.minX + 1,
        height: cluster.maxY - cluster.minY + 1,
      })
      .resize(fix.newW, fix.newH)
      .png()
      .toBuffer();
    overlays.push({ input: crop, left: fix.pasteX, top: fix.pasteY });
  }
  // Заливка исходных мест групп — после снятия кропов.
  for (const fix of [leftFix, rightFix]) {
    if (!fix) continue;
    fillWhite(fix.cluster.minX, fix.cluster.minY, fix.cluster.maxX, fix.cluster.maxY);
  }

  let pipeline = sharp(data, { raw: { width: w, height: h, channels: ch } });
  if (overlays.length) pipeline = pipeline.composite(overlays);
  const out = await pipeline.png().toBuffer();

  return {
    buffer: out,
    erased,
    scaledLeft: leftFix ? Math.round(leftFix.scale * 100) / 100 : null,
    scaledRight: rightFix ? Math.round(rightFix.scale * 100) / 100 : null,
    changed: true,
  };
}
