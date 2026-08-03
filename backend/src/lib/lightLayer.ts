import sharp from "sharp";
import { METHOD } from "./patternMiner.js";

/**
 * Слой света — Задание 3, Фаза 4 (`D-N6`, трёхслойная модель альфы).
 *
 * Генеративный шаг рисует ТОЛЬКО атмосферу на чёрном: свечение, дымку, блики,
 * боке. Кейинг `alpha = f(яркость)` применяется только к этому слою, в котором
 * по построению нет ни одного объекта, — герои и декор приходят со своей
 * альфой уже после него. Наивный кейинг по готовому кадру съел бы чёрного
 * бульдога в чёрном костюме; здесь ему нечего есть.
 *
 * Слой заменяет процедурный радиальный градиент (`glowPlate` из спеки), и
 * контракт тот же: на тёмном фоне письма даёт брендовое свечение с чёрными
 * (прозрачными) углами.
 */

/**
 * Усиление альфы против «двойного затемнения». Кейинг делает композит на
 * чёрном равным `lum · alpha/255`; при `alpha = lum` свечение с яркостью 60
 * стало бы 14 — вдвое темнее, чем рисовала модель. Гейн 2 возвращает средним
 * яркостям почти исходную светимость, а чёрное остаётся чёрным при любом
 * гейне: `f(0) = 0`.
 */
export const LIGHT_ALPHA_GAIN = 2;

/**
 * Порог «модель нарисовала объект» для Enforce: медианная дисперсия лапласиана
 * по кадру. У чистой атмосферы (градиенты, дымка, боке) она единицы; у любого
 * предмета с контуром — сотни. Это НЕ коридор паттерна — паттерн описывает
 * кадр, а это гейт на промежуточный слой, у которого корпуса нет; значение
 * выбрано с запасом в порядок с обеих сторон.
 */
export const LIGHT_MAX_SHARPNESS = 200;

/**
 * Кейинг `D-N6`: альфа выводится из яркости Rec.709, цвет остаётся исходным.
 * Чёрное → прозрачное, свечение → полупрозрачное. Детерминирован.
 */
export async function keyLightLayer(input: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(input)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const r = data[i * 3]!;
    const g = data[i * 3 + 1]!;
    const b = data[i * 3 + 2]!;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = Math.min(255, Math.round(lum * LIGHT_ALPHA_GAIN));
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
}

/** Яркость композита «слой над чёрным» в зоне text-core — ровно та величина,
 *  которую майнер меряет как «яркость фона в центре» (`D-N2`). */
export async function lightCenterLuminance(keyed: Buffer): Promise<number> {
  const { data, info } = await sharp(keyed).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const z = METHOD.centerLumZone;
  const x0 = Math.floor(z.x0 * info.width);
  const x1 = Math.floor(z.x1 * info.width);
  const y0 = Math.floor(z.y0 * info.height);
  const y1 = Math.floor(z.y1 * info.height);
  let sum = 0;
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * info.width + x) * 4;
      const a = data[i + 3]! / 255;
      sum += (0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) * a;
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

/**
 * Нормировка яркости слоя под коридор спеки. Модель рисует свечение «на
 * глаз», а валидатор меряет числа: линейный множитель подгоняет яркость
 * центра композита к середине коридора `centerBgLum`. Углы масштабируются
 * пропорционально — их отношение к центру задаёт сама генерация (радиальный
 * спад до чёрного), и оно сохраняется.
 */
export async function normalizeLightLayer(
  keyed: Buffer,
  target: { centerLum: [number, number] },
): Promise<Buffer> {
  const mid = (target.centerLum[0] + target.centerLum[1]) / 2;
  let current = keyed;
  // Светимость композита зависит от яркости слоя КВАДРАТИЧНО (альфа сама
  // выводится из яркости), поэтому линейный шаг не попадает с первого раза —
  // фиксированное число шагов с поправкой √ratio сходится и остаётся
  // детерминированным.
  for (let step = 0; step < 3; step++) {
    const lum = await lightCenterLuminance(current);
    if (lum <= 0) return current;
    if (lum >= target.centerLum[0] && lum <= target.centerLum[1]) return current;
    const scale = Math.sqrt(mid / lum);
    current = await scaleLightLayer(current, scale);
  }
  return current;
}

async function scaleLightLayer(keyed: Buffer, scale: number): Promise<Buffer> {
  const { data, info } = await sharp(keyed).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const r = Math.min(255, Math.round(data[i * 4]! * scale));
    const g = Math.min(255, Math.round(data[i * 4 + 1]! * scale));
    const b = Math.min(255, Math.round(data[i * 4 + 2]! * scale));
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    // Альфа пересчитывается из новой яркости — иначе нормировка меняла бы
    // цвет, но не светимость композита, ради которой она и существует.
    out[i * 4 + 3] = Math.min(255, Math.round(lum * LIGHT_ALPHA_GAIN));
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
}

/** Яркость композита в четырёх угловых патчах — методика майнера (`D-N2`):
 *  квадрат со стороной 5 % ширины холста, среднее Rec.709. */
export async function lightCornerLuminance(keyed: Buffer): Promise<number> {
  const { data, info } = await sharp(keyed).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const side = Math.max(1, Math.round(info.width * METHOD.cornerPatchFraction));
  const corners: Array<[number, number]> = [
    [0, 0],
    [info.width - side, 0],
    [0, info.height - side],
    [info.width - side, info.height - side],
  ];
  let sum = 0;
  let count = 0;
  for (const [cx, cy] of corners) {
    for (let y = cy; y < cy + side; y++) {
      for (let x = cx; x < cx + side; x++) {
        const i = (y * info.width + x) * 4;
        const a = data[i + 3]! / 255;
        sum += (0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) * a;
        count++;
      }
    }
  }
  return count > 0 ? sum / count : 0;
}

/**
 * Принудительный виньет: генерации просят «PURE BLACK at all four corners»,
 * но модель соблюдает это на глаз, а валидатор меряет числа. Если углы ярче
 * коридора, слой затемняется радиально: центр не трогается, угол приводится
 * к середине коридора. Это шаг Enforce варианта C — «гарантия, а не надежда».
 */
export async function enforceLightCorners(
  keyed: Buffer,
  target: { cornerLum: [number, number] },
): Promise<Buffer> {
  // Светимость композита квадратична по яркости слоя (альфа выводится из
  // яркости) — шаг √ratio с повтором, как в normalizeLightLayer.
  let current = keyed;
  // Enforce работает ТОЛЬКО вниз. Углы темнее коридора не поднимаются:
  // «осветлить чёрный угол» означает умножить зеро-фон с зерном, и за пару
  // итераций зерно раздувается в яркие пятна — хуже слегка тёмного угла.
  // Шагов с запасом: угловой ПАТЧ шире точки угла, его внутренний край
  // темнеет слабее, чем сам угол, и √-шаг сходится к среднему по патчу
  // медленнее модели.
  for (let step = 0; step < 6; step++) {
    const corner = await lightCornerLuminance(current);
    if (corner <= target.cornerLum[1]) return current;
    const mid = (target.cornerLum[0] + target.cornerLum[1]) / 2;
    current = await vignette(current, Math.sqrt(mid / corner));
  }
  return current;
}

async function vignette(keyed: Buffer, ratio: number): Promise<Buffer> {
  const { data, info } = await sharp(keyed).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // Эллиптический радиус: 0 в центре, 1 в углу. Кубическая кривая от
      // радиуса: центр не трогается, а зона углового патча (t ≥ 0.7) давится
      // почти как сам угол — иначе среднее по патчу не сходится к коридору.
      const dx = (x - W / 2) / (W / 2);
      const dy = (y - H / 2) / (H / 2);
      const t = Math.min(1, Math.sqrt((dx * dx + dy * dy) / 2));
      const factor = 1 + (ratio - 1) * t * t * t;
      const i = (y * W + x) * 4;
      const r = Math.min(255, Math.round(data[i]! * factor));
      const g = Math.min(255, Math.round(data[i + 1]! * factor));
      const b = Math.min(255, Math.round(data[i + 2]! * factor));
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = Math.min(255, Math.round(lum * LIGHT_ALPHA_GAIN));
    }
  }
  return sharp(out, { raw: { width: W, height: H, channels: 4 } })
    .png()
    .toBuffer();
}

/**
 * Свет обязан оставаться ФОНОМ и для валидатора: маска содержимого — это
 * яркость композита выше `METHOD.brightThreshold` (70), и пиксель света ярче
 * порога становится «объектом», склеивая кадр в один компонент. У эталонов
 * фон не пересекает порог нигде (центр 17–38). Пики ярче потолка сжимаются
 * локально (√-колено): точка остаётся светлой, но фоном. Запас 10 % — чтобы
 * блик не плясал на границе порога из-за округления.
 */
export const LIGHT_PEAK_SAFETY = 0.9;

export async function clampLightPeak(
  keyed: Buffer,
  /**
   * Потолок светимости композита. По умолчанию — чуть ниже порога маски, но
   * вызывающему стоит передавать ВЕРХ коридора `centerBgLum` спеки: «свет
   * нигде не ярче максимума фоновой яркости корпуса». Порог маски (70) минус
   * пик света — это запас, который остаётся полупрозрачным ореолам декора,
   * чтобы «декор над светом» не пробивал маску и не склеивал компоненты.
   */
  cap: number = METHOD.brightThreshold * LIGHT_PEAK_SAFETY,
): Promise<Buffer> {
  const { data, info } = await sharp(keyed).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    let r = data[i * 4]!;
    let g = data[i * 4 + 1]!;
    let b = data[i * 4 + 2]!;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const a = Math.min(255, Math.round(lum * LIGHT_ALPHA_GAIN));
    const composite = (lum * a) / 255;
    if (composite > cap) {
      // Композит квадратичен по яркости слоя → множитель √(cap/composite).
      const f = Math.sqrt(cap / composite);
      r = Math.round(r * f);
      g = Math.round(g * f);
      b = Math.round(b * f);
    }
    const lum2 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = Math.min(255, Math.round(lum2 * LIGHT_ALPHA_GAIN));
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
}

/**
 * Enforce «ABSOLUTELY NO objects»: инструкцию модели соблюдают ненадёжно, а
 * каждый нарисованный здесь объект кейинг превратит в полупрозрачный призрак.
 * Медианная дисперсия лапласиана по патчам кадра выше порога — значит в слое
 * есть контуры, и он подлежит перегенерации с другим seed.
 */
export async function lightLayerHasObjects(input: Buffer): Promise<boolean> {
  const { data, info } = await sharp(input)
    .removeAlpha()
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  // Дисперсия лапласиана по сетке патчей ~64px: локальный контур не тонет в
  // среднем по кадру, а мягкий градиент не даёт ложного срабатывания.
  const PATCH = 64;
  const variances: number[] = [];
  for (let py = 0; py + PATCH <= H; py += PATCH) {
    for (let px = 0; px + PATCH <= W; px += PATCH) {
      let sum = 0;
      let sum2 = 0;
      let count = 0;
      for (let y = py + 1; y < py + PATCH - 1; y++) {
        for (let x = px + 1; x < px + PATCH - 1; x++) {
          const i = y * W + x;
          const lap =
            4 * data[i]! - data[i - 1]! - data[i + 1]! - data[i - W]! - data[i + W]!;
          sum += lap;
          sum2 += lap * lap;
          count++;
        }
      }
      const mean = sum / count;
      variances.push(sum2 / count - mean * mean);
    }
  }
  if (variances.length === 0) return false;
  variances.sort((a, b) => a - b);
  // p95, а не максимум: единичный патч с плёночным зерном или резким бликом —
  // это ещё атмосфера; объект даёт контуры в нескольких патчах сразу.
  const p95 = variances[Math.min(variances.length - 1, Math.floor(variances.length * 0.95))]!;
  return p95 > LIGHT_MAX_SHARPNESS;
}
