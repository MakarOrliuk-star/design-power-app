import sharp from "sharp";
import { splitLayerPieces } from "./layerSplit.js";
import { normalizeLayer } from "./layerNormalize.js";
import { METHOD } from "./patternMiner.js";

/**
 * Лист декора — Задание 3, Фаза 3 (`D-N7'` шаг 3, `D-N8'`).
 *
 * Когда библиотека не покрывает концепты брифа, ОДНА генерация «набор мелких
 * предметов по концептам» даёт 8–15 объектов нужного размера — в отличие от
 * кусков ITEM-слоя, у которых замеренный медианный размер 0.08 % против
 * эталонных 0.15–0.70 % (это обрезки одного предмета, а не отдельные
 * предметы). Нарезка идёт существующей механикой: `splitLayerPieces` режет
 * связные компоненты альфы, `normalizeLayer` чистит ореолы и обрезает по
 * bbox — тем же кодом, что слои героев.
 *
 * Альфа у листа появляется до нарезки: генератор рисует на ровном светлом
 * фоне (как и слои героев), а вырезает его тот же BR-фолбэк
 * `getOrCreateNormalizedLayer`, что у person/item. Этот модуль получает уже
 * прозрачный слой — чистый buffer→pieces, без сети, детерминированный.
 */

/** Сколько кусков обязан дать удачный лист. Меньше — модель проигнорировала
 *  контракт (нарисовала один крупный объект или слиплись тени); вызывающий
 *  перегенерирует лист с другим seed, а не тащит недобор в кадр. */
export const MIN_SHEET_PIECES = 6;
/** Потолок кусков с одного листа: коридор «объектов декора» — 7–17 на кадр,
 *  и больше нарезать незачем (совпадает с MAX_PIECES сплиттера по духу, но
 *  задаётся своим именем — это контракт листа, а не сплиттера). */
export const SHEET_MAX_PIECES = 16;

/**
 * Промпт-контракт листа (в паре с ITEM_LAYER_CONTRACT / PERSON_LAYER_CONTRACT
 * из процессора): требования, без которых нарезка не работает. Раздельность
 * объектов — главное: слипшиеся тени склеивают связные компоненты, и вместо
 * 12 предметов сплиттер отдаёт 3 кляксы.
 */
export const DECOR_SHEET_CONTRACT =
  "Render 10 to 14 SEPARATE small objects: several variations of each prop, varied sizes and " +
  "varied angles. Each object fully detached from the others with wide empty gaps between them — " +
  "they must never touch, overlap or be connected by shadows. All objects fully inside the frame " +
  "with clear margins, nothing cropped by the edges, on a plain even light-gray studio background " +
  "with strong contrast to the objects. No text, no letters, no numbers, no logos, no characters, " +
  "no single dominant hero object — all props are small and comparable in size.";

/**
 * Промпт листа по концептам брифа. Детерминирован: те же концепты — тот же
 * промпт (порядок концептов уже зафиксирован клампом брифа).
 */
export function buildDecorSheetPrompt(concepts: string[]): string {
  const list = concepts.map((c) => c.replace(/_/g, " ")).join(", ");
  return `A set of small isolated casino promo props: ${list}. ${DECOR_SHEET_CONTRACT}`;
}

export interface DecorSheetPiece {
  /** Нормализованный прозрачный PNG: ореолы вычищены, обрезан по bbox. */
  png: Buffer;
  width: number;
  height: number;
  /** Непрозрачных пикселей — ключ сортировки сплиттера (крупные первыми). */
  area: number;
}

/**
 * Кусок обязан быть ОДНИМ объектом и для маски содержимого. Кусок с
 * рисованными спутниками (монета + три блёстки поодаль) связен по альфе, но
 * на маске яркости рассыпается на фрагменты — валидатор считает каждый
 * отдельным «объектом декора», и медиана размеров тонет в блёстках-пылинках.
 * Порог: главный фрагмент несёт ≥ 70 % видимой маске площади куска.
 */
export const MIN_PIECE_COHESION = 0.7;

/** Доля крупнейшего фрагмента маски яркости (композит на чёрном, порог майнера). */
async function maskCohesion(png: Buffer): Promise<number> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  // Маска L>порога тем же правилом, что у майнера, — упакована в альфа-канал,
  // чтобы фрагменты посчитал существующий сплиттер, а не второй BFS.
  const mask = Buffer.alloc(data.length);
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]! / 255;
    const lum = (0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) * a;
    if (lum > METHOD.brightThreshold) {
      mask[i + 3] = 255;
      total++;
    }
  }
  if (total === 0) return 0;
  const maskPng = await sharp(mask, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toBuffer();
  const blobs = await splitLayerPieces(maskPng, { maxPieces: 1, minPieceRatio: 0 });
  return (blobs[0]?.area ?? 0) / total;
}

/**
 * Прозрачный лист → отдельные нормализованные куски. Выбрасываются кусок, не
 * переживший нормализацию, и «рассыпчатый» кусок (см. MIN_PIECE_COHESION) —
 * лист оценивается по числу ВЫЖИВШИХ кусков против MIN_SHEET_PIECES.
 */
export async function cutDecorSheet(
  sheet: Buffer,
  opts: { maxPieces?: number } = {},
): Promise<DecorSheetPiece[]> {
  const raw = await splitLayerPieces(sheet, { maxPieces: opts.maxPieces ?? SHEET_MAX_PIECES });
  const pieces: DecorSheetPiece[] = [];
  for (const p of raw) {
    const norm = await normalizeLayer(p.png);
    if (!norm.ok) continue;
    if ((await maskCohesion(norm.png)) < MIN_PIECE_COHESION) continue;
    pieces.push({ png: norm.png, width: norm.width, height: norm.height, area: p.area });
  }
  return pieces;
}
