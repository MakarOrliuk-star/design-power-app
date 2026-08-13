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
 * Вырезание белого фона: RGB сохраняется, меняется только альфа.
 * Фоновые пиксели прозрачны, кромка объектов — полупрозрачна по яркости,
 * всё остальное непрозрачно.
 */
export async function keyWhiteBackground(input: Buffer): Promise<Buffer> {
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

  return sharp(out, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * Объединение двух вырезок по максимуму альфы.
 *
 * Bria лучше отрабатывает сложную кромку (шерсть, листва) — её альфа
 * побеждает там, где она вообще что-то оставила. Белый кей возвращает
 * объекты, которые Bria сочла фоном и стёрла в ноль. Максимум даёт и то, и
 * другое; цвет берётся из вырезки Bria (у неё кромка уже очищена от белого).
 */
export async function mergeCutoutAlpha(briaPng: Buffer, keyedPng: Buffer): Promise<Buffer> {
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
  for (let i = 0; i < n; i++) {
    const aB = bria.data[i * 4 + 3]!;
    const aK = keyed.data[i * 4 + 3]!;
    const useKeyed = aK > aB;
    const src = useKeyed ? keyed.data : bria.data;
    out[i * 4] = src[i * 4]!;
    out[i * 4 + 1] = src[i * 4 + 1]!;
    out[i * 4 + 2] = src[i * 4 + 2]!;
    out[i * 4 + 3] = useKeyed ? aK : aB;
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
