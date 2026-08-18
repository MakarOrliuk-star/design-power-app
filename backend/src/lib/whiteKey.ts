import sharp from "sharp";

/**
 * Вырезание по СВЯЗНОМУ белому фону (правка 2026-08-14).
 *
 * Причина: заказчик заметил, что в промежуточном кадре `_push_try1` предметы
 * есть, а в `_transparent` их уже нет. `fal-ai/bria/background/remove` — это
 * ML-сегментация «главного объекта»: она оставляет героя и вычищает всё, что
 * считает фоном, включая парящие пропсы. Требование FOCUS (часть предметов
 * намеренно в расфокусе и смазе) делает их для неё ещё более «фоновыми».
 *
 * Но фон композиции чисто белый ПО КОНТРАКТУ, и это подтверждают чеки
 * `borders`/`center`. Значит вырезание — не задача сегментации: достаточно
 * залить прозрачностью белое, СВЯЗАННОЕ С КРАЯМИ кадра. Такой кей не решает,
 * что в кадре главное, поэтому не может потерять предмет.
 *
 * Связность принципиальна: белая панама на герое (эталон `push1 ok`) или белая
 * карта в центре с краем не соединены, поэтому остаются непрозрачными —
 * наивный порог по яркости их бы съел.
 */

/** Яркость, с которой пиксель считается фоновым (тот же порог, что у чеков). */
export const BG_LUMA_MIN = 244;

/**
 * Ширина мягкой кромки в пикселях. Край объекта на белом — это антиалиасинг,
 * и бинарная альфа даёт «пилу» плюс белый ореол на тёмном фоне письма.
 */
export const EDGE_SOFT_RADIUS = 2;

function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Маска фона: заливка от всех граничных пикселей по «почти белому».
 * Возвращает Uint8Array (1 = фон) размером width×height.
 */
export function floodFillBackground(
  gray: Uint8Array,
  width: number,
  height: number,
  threshold = BG_LUMA_MIN,
): Uint8Array {
  const bg = new Uint8Array(width * height);
  // Стек вместо рекурсии: кадр 1200×600 переполнил бы call stack.
  const stack = new Int32Array(width * height);
  let top = 0;

  const push = (i: number) => {
    if (bg[i] === 1 || gray[i]! < threshold) return;
    bg[i] = 1;
    stack[top++] = i;
  };

  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + width - 1);
  }

  while (top > 0) {
    const i = stack[--top]!;
    const x = i % width;
    const y = (i - x) / width;
    if (x > 0) push(i - 1);
    if (x < width - 1) push(i + 1);
    if (y > 0) push(i - width);
    if (y < height - 1) push(i + width);
  }
  return bg;
}

/**
 * Сквозные отверстия (TASK no-baked-text, правка 2026-08-17).
 *
 * Заказчик: «объект должен быть сквозным, а она заполнила пустоту белым».
 * Причина ровно в связности выше: заливка идёт ОТ КРАЁВ кадра, поэтому белое
 * внутри замкнутого контура — дырка бублика, просвет между рукой и корпусом,
 * отверстие подковы — остаётся непрозрачным. На белой подложке письма это не
 * видно, а на цветной вылезает белая клякса внутри предмета.
 *
 * Снимать связность нельзя — она защищает БЕЛЫЕ ОБЪЕКТЫ (панама на герое из
 * эталона `push1 ok`, белая карта в центре). Поэтому замкнутые области
 * делятся на «дырки» и «объекты» по двум признакам:
 *
 * 1. ПЛОСКОСТЬ. Просвет фона — это заливка #FFFFFF, отрисованная моделью как
 *    фон: разброс яркости в ней near-zero. У белого предмета есть светотень,
 *    градиент и собственный контур — разброс заметный. Это главный признак.
 * 2. ПЛОЩАДЬ. Очень крупная замкнутая область — почти наверняка не «дырка», а
 *    композиционная проблема (например, кадр распался на две половины), и
 *    выбивать её опасно: получим сквозную прореху в середине креатива.
 *
 * Порог плоскости намеренно жёсткий: ложно пробитый белый предмет — заметный
 * брак, а пропущенная дырка всего лишь остаётся как было.
 */
export const HOLE_FLATNESS_MAX_SPREAD = 6;
export const HOLE_MAX_AREA_RATIO = 0.12;
/** Мельче — это антиалиасинг и мусор, а не отверстие. */
export const HOLE_MIN_AREA_PX = 24;

export interface EnclosedRegion {
  pixels: number[];
  /** Разброс яркости (max-min) — признак «плоская заливка фона». */
  spread: number;
  /** Доля площади кадра. */
  areaRatio: number;
  /** Прошла ли область оба критерия «это отверстие». */
  isHole: boolean;
}

/**
 * Замкнутые белые области: почти белые пиксели, НЕ связанные с краями кадра
 * (то есть не попавшие в `bg`). Возвращаются с метриками и вердиктом.
 */
export function findEnclosedWhiteRegions(
  gray: Uint8Array,
  bg: Uint8Array,
  width: number,
  height: number,
  threshold = BG_LUMA_MIN,
): EnclosedRegion[] {
  const n = width * height;
  const seen = new Uint8Array(n);
  const regions: EnclosedRegion[] = [];
  const stack = new Int32Array(n);

  for (let start = 0; start < n; start++) {
    if (seen[start] === 1 || bg[start] === 1 || gray[start]! < threshold) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    const pixels: number[] = [];
    let min = 255;
    let max = 0;

    while (top > 0) {
      const i = stack[--top]!;
      pixels.push(i);
      const g = gray[i]!;
      if (g < min) min = g;
      if (g > max) max = g;
      const x = i % width;
      const y = (i - x) / width;
      const push = (j: number) => {
        if (seen[j] === 1 || bg[j] === 1 || gray[j]! < threshold) return;
        seen[j] = 1;
        stack[top++] = j;
      };
      if (x > 0) push(i - 1);
      if (x < width - 1) push(i + 1);
      if (y > 0) push(i - width);
      if (y < height - 1) push(i + width);
    }

    const spread = max - min;
    const areaRatio = pixels.length / n;
    const isHole =
      pixels.length >= HOLE_MIN_AREA_PX &&
      spread <= HOLE_FLATNESS_MAX_SPREAD &&
      areaRatio <= HOLE_MAX_AREA_RATIO;
    regions.push({ pixels, spread, areaRatio, isHole });
  }
  return regions;
}

/**
 * Вырезание белого фона: RGB сохраняется, меняется только альфа.
 * Фоновые пиксели прозрачны, кромка объектов — полупрозрачна по яркости,
 * всё остальное непрозрачно.
 *
 * Замкнутые плоско-белые области выбиваются вместе с фоном (см.
 * `findEnclosedWhiteRegions`) — иначе предмет с отверстием не сквозной.
 */
export interface WhiteKeyResult {
  png: Buffer;
  /** 1 = сквозное отверстие; нужна слиянию с Bria (см. mergeCutoutAlpha). */
  holeMask: Uint8Array;
  /** Сколько отверстий пробито — уходит в metadata и логи. */
  holes: number;
  /** Замкнутые белые области, НЕ признанные отверстиями (белые предметы). */
  keptWhiteRegions: number;
}

/** Вырезание + маска отверстий. `keyWhiteBackground` — обёртка над ней. */
export async function keyWhiteBackgroundDetailed(input: Buffer): Promise<WhiteKeyResult> {
  const { data, info } = await sharp(input)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const n = width * height;

  const gray = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    gray[i] = Math.round(luma(data[i * 3]!, data[i * 3 + 1]!, data[i * 3 + 2]!));
  }
  const bg = floodFillBackground(gray, width, height);

  // Отверстия внутри объектов трактуем как фон: дальше по коду они получают и
  // нулевую альфу, и ту же мягкую кромку, что внешний контур, — без этого по
  // краю дырки осталась бы белая «пила».
  const holeMask = new Uint8Array(n);
  let holes = 0;
  let keptWhiteRegions = 0;
  for (const region of findEnclosedWhiteRegions(gray, bg, width, height)) {
    if (!region.isHole) {
      if (region.pixels.length >= HOLE_MIN_AREA_PX) keptWhiteRegions += 1;
      continue;
    }
    holes += 1;
    for (const i of region.pixels) {
      bg[i] = 1;
      holeMask[i] = 1;
    }
  }

  // Расстояние до фона в пределах радиуса мягкой кромки: 0 = сам фон.
  const dist = new Uint8Array(n).fill(255);
  let front: number[] = [];
  for (let i = 0; i < n; i++) {
    if (bg[i] === 1) {
      dist[i] = 0;
      front.push(i);
    }
  }
  for (let d = 1; d <= EDGE_SOFT_RADIUS && front.length > 0; d++) {
    const next: number[] = [];
    for (const i of front) {
      const x = i % width;
      const y = (i - x) / width;
      const visit = (j: number) => {
        if (dist[j] === 255) {
          dist[j] = d;
          next.push(j);
        }
      };
      if (x > 0) visit(i - 1);
      if (x < width - 1) visit(i + 1);
      if (y > 0) visit(i - width);
      if (y < height - 1) visit(i + width);
    }
    front = next;
  }

  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = data[i * 3]!;
    out[i * 4 + 1] = data[i * 3 + 1]!;
    out[i * 4 + 2] = data[i * 3 + 2]!;
    if (bg[i] === 1) {
      out[i * 4 + 3] = 0;
      continue;
    }
    if (dist[i]! <= EDGE_SOFT_RADIUS && gray[i]! >= 200) {
      // Кромка: чем светлее пиксель, тем он ближе к фону — тем прозрачнее.
      const t = (BG_LUMA_MIN - gray[i]!) / (BG_LUMA_MIN - 200);
      out[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(t * 255)));
      continue;
    }
    out[i * 4 + 3] = 255;
  }

  const png = await sharp(out, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  return { png, holeMask, holes, keptWhiteRegions };
}

/** Обратная совместимость: только PNG, без маски отверстий. */
export async function keyWhiteBackground(input: Buffer): Promise<Buffer> {
  return (await keyWhiteBackgroundDetailed(input)).png;
}

/**
 * Объединение двух вырезок по максимуму альфы.
 *
 * Bria лучше отрабатывает сложную кромку (шерсть, листва) — её альфа
 * побеждает там, где она вообще что-то оставила. Белый кей возвращает
 * объекты, которые Bria сочла фоном и стёрла в ноль. Максимум даёт и то, и
 * другое; цвет берётся из вырезки Bria (у неё кромка уже очищена от белого).
 */
export async function mergeCutoutAlpha(
  briaPng: Buffer,
  keyedPng: Buffer,
  /**
   * Маска сквозных отверстий из белого кея (правка 2026-08-17). Обязательна
   * для гибридного режима: Bria сегментирует объект СПЛОШНЫМ силуэтом, её
   * альфа внутри дырки равна 255, и максимум альф вернул бы белую кляксу
   * обратно — то есть исправление отверстий не работало бы в дефолтном режиме.
   * В маске отверстие всегда побеждает: это не «кто лучше видит кромку», а
   * знание о том, что там фон.
   */
  holeMask?: Uint8Array,
): Promise<Buffer> {
  const bria = await sharp(briaPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const width = bria.info.width;
  const height = bria.info.height;
  // Размеры обязаны совпадать: Bria возвращает исходный канвас. Если модель
  // всё же отдала другой — приводим кей к её размеру, а не наоборот.
  const keyed = await sharp(keyedPng)
    .resize(width, height, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const n = width * height;
  const out = Buffer.alloc(n * 4);
  // Маска считалась на размере исходника; при расхождении размеров (Bria
  // отдала другой канвас) её индексы уже не совпадают — тогда безопаснее её
  // не применять, чем пробить дырки в случайных местах.
  const holes = holeMask && holeMask.length === n ? holeMask : null;

  for (let i = 0; i < n; i++) {
    const aB = bria.data[i * 4 + 3]!;
    const aK = keyed.data[i * 4 + 3]!;
    const useKeyed = aK > aB;
    const src = useKeyed ? keyed.data : bria.data;
    out[i * 4] = src[i * 4]!;
    out[i * 4 + 1] = src[i * 4 + 1]!;
    out[i * 4 + 2] = src[i * 4 + 2]!;
    // Отверстие сильнее обеих альф: Bria его не видит по построению.
    out[i * 4 + 3] = holes?.[i] === 1 ? 0 : useKeyed ? aK : aB;
  }
  return sharp(out, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** Режим вырезания: гибрид по умолчанию, откат — env без деплоя. */
export type CutoutMode = "hybrid" | "bria" | "white";

export function cutoutMode(): CutoutMode {
  const raw = (process.env.AI_REF_CUTOUT ?? "").trim().toLowerCase();
  return raw === "bria" || raw === "white" ? raw : "hybrid";
}
