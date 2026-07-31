import { createHash } from "node:crypto";
import { uploadBuffer, withRetry } from "../lib/cloudinary.js";
import { hasUsefulAlpha, normalizeLayer } from "../lib/layerNormalize.js";
import { prisma } from "../lib/prisma.js";
import { runPersonFal, runBriaRemoveBg } from "../lib/fal.js";
import { fetchBuffer } from "./layerCache.js";
import {
  parseDecorEntries,
  serializeDecorEntries,
  mergeDecorEntries,
  type DecorEntry,
} from "../lib/decorLibrary.js";
import {
  buildDecorSheetPrompt,
  cutDecorSheet,
  MIN_SHEET_PIECES,
  type DecorSheetPiece,
} from "../lib/decorSheet.js";
import type { Prisma } from "../../generated/prisma/client.js";

/**
 * Приём декора — общий для двух путей (Фаза 3, `D-N8'`):
 *
 *   1. ручная заливка из админки (`routes/decor.ts`) — как раньше;
 *   2. автосохранение нарезки листа декора — первый рендер бренда наполняет
 *      его библиотеку, последующие берут готовое и не платят за генерацию.
 *      Библиотека — кэш, а не предусловие.
 *
 * Правила одни на оба пути: нормализация тем же кодом, что слои героев,
 * дедупликация `public_id = sha256(нормализованные байты)`, потолок записей.
 * Два приёмника разъехались бы так же, как разъехались две методики замера
 * (претензия П-5) — поэтому приёмник один.
 */

/** Куда в Cloudinary складываются ассеты библиотеки. */
export const DECOR_FOLDER = "crm-bundle/decor";
/** Столько записей принимает уровень библиотеки (слот или бренд). */
export const MAX_DECOR_PER_SLOT = 20;

export type DecorIngestResult =
  | { ok: true; url: string; width: number; height: number }
  | { ok: false; reason: string };

/**
 * Один буфер → нормализованный ассет в Cloudinary. `alphaGate` включён для
 * ручной заливки (непрозрачный PNG превратился бы в плашку на баннере) и
 * выключен для кусков листа — у них альфа по построению, а после обрезки по
 * bbox плотный объект может честно не иметь 5 % прозрачных пикселей.
 */
export async function ingestDecorBuffer(
  raw: Buffer,
  label: string,
  opts: { alphaGate?: boolean } = {},
): Promise<DecorIngestResult> {
  if ((opts.alphaGate ?? true) && !(await hasUsefulAlpha(raw))) {
    return {
      ok: false,
      reason: "нет прозрачного фона — вырежьте объект и сохраните PNG с альфа-каналом",
    };
  }
  // Тот же нормализатор, что и для слоёв персонажа/item: чистка ореолов
  // и обрезка по фактическому bbox, иначе масштаб в раскладке врёт.
  const norm = await normalizeLayer(raw);
  if (!norm.ok) return { ok: false, reason: norm.reason };

  const publicId = createHash("sha256").update(norm.png).digest("hex").slice(0, 32);
  const up = await withRetry(() => uploadBuffer(norm.png, publicId, DECOR_FOLDER), `decor ${label}`);
  if (!up.success || !up.secure_url) {
    return { ok: false, reason: up.error ?? "загрузка в Cloudinary не удалась" };
  }
  return { ok: true, url: up.secure_url, width: norm.width, height: norm.height };
}

/**
 * Дописать записи в библиотеку бренда: дедуп по URL (sha256-дедуп приёмника
 * гарантирует «тот же файл — тот же URL»), слияние тегов у существующих
 * записей, потолок MAX_DECOR_PER_SLOT, порядок сохраняется — раскладка
 * сидирована по списку.
 */
export async function attachEntriesToBrand(
  brandId: string,
  incoming: DecorEntry[],
): Promise<{ brandId: string; total: number; skipped: number }> {
  const brand = await prisma.brand.findUnique({
    where: { id: brandId },
    select: { decorUrls: true },
  });
  const current = parseDecorEntries(brand?.decorUrls);
  const { merged, skipped } = mergeDecorEntries(current, incoming, MAX_DECOR_PER_SLOT);
  await prisma.brand.update({
    where: { id: brandId },
    data: { decorUrls: serializeDecorEntries(merged) as unknown as Prisma.InputJsonValue },
  });
  return { brandId, total: merged.length, skipped };
}

/**
 * Автосохранение нарезки листа (`D-N8'`): куски уходят через тот же приёмник,
 * теги проставляются из `decorConcepts` брифа автоматически (`D-N9'`) — лист
 * генерировался по этим концептам, и его куски им и соответствуют. Сезонный
 * бриф помечает куски сезоном: снежинка не попадёт в летний кадр.
 *
 * Сбой одного куска не топит остальные — библиотека пополняется тем, что
 * пережило приём, а недобор доберёт следующий шаг цепочки.
 */
export async function saveSheetPiecesToBrandLibrary(opts: {
  brandId: string;
  pieces: DecorSheetPiece[];
  concepts: string[];
  season?: string | null;
}): Promise<{ saved: DecorEntry[]; failed: number; skipped: number }> {
  const entries: DecorEntry[] = [];
  let failed = 0;
  for (const [i, piece] of opts.pieces.entries()) {
    const up = await ingestDecorBuffer(piece.png, `sheet-piece-${i}`, { alphaGate: false });
    if (!up.ok) {
      failed++;
      continue;
    }
    entries.push({ url: up.url, concepts: opts.concepts, season: opts.season ?? null });
  }
  if (entries.length === 0) return { saved: [], failed, skipped: 0 };
  const { skipped } = await attachEntriesToBrand(opts.brandId, entries);
  return { saved: entries, failed, skipped };
}

// ---------------------------------------------------------------------------
// Лист декора: шаг [3] цепочки D-N7'
// ---------------------------------------------------------------------------

/** Попыток генерации листа: 1 + повтор — тот же лимит, что у слоя персонажа
 *  (`PERSON_LAYER_RETRIES`, DI-Q13): бесконечная догонка жжёт бюджет. */
export const SHEET_ATTEMPTS = 2;

export type DecorSheetResult =
  | { ok: true; pieces: DecorSheetPiece[] }
  | { ok: false; reason: string };

/**
 * Одна генерация «набор мелких предметов по концептам» → прозрачный лист →
 * нарезка. Альфа появляется тем же путём, что у слоёв героев: провайдер
 * рисует на ровном светлом фоне, BR-фолбэк вырезает (`runBriaRemoveBg`).
 *
 * Лист, отдавший меньше `MIN_SHEET_PIECES` кусков, — это модель, которая
 * проигнорировала контракт (один крупный объект, слипшиеся тени). Он
 * перегенерируется, а не тащит недобор в кадр.
 */
export async function generateDecorSheetPieces(
  concepts: string[],
  label: string,
): Promise<DecorSheetResult> {
  // Прайм «нарисуй что-нибудь» запрещён (`resolveDecorChain`): лист без
  // концептов дал бы декор, не связанный с кампанией.
  if (concepts.length === 0) return { ok: false, reason: "лист без концептов не генерируется" };
  const prompt = buildDecorSheetPrompt(concepts);

  let lastReason = "unknown";
  for (let attempt = 1; attempt <= SHEET_ATTEMPTS; attempt++) {
    if (attempt > 1) console.warn(`♻️ decor sheet retry ${attempt}/${SHEET_ATTEMPTS} for ${label}: ${lastReason}`);
    const gen = await runPersonFal(prompt, [], "1:1", null);
    if (!gen.success || !gen.imageUrl) {
      lastReason = `generation: ${gen.error ?? "unknown"}`;
      continue;
    }
    const src = await fetchBuffer(gen.imageUrl);
    if (!src) {
      lastReason = "sheet download failed";
      continue;
    }
    let sheet = src;
    if (!(await hasUsefulAlpha(src))) {
      const br = await runBriaRemoveBg(gen.imageUrl);
      if (!br.success || !br.imageUrl) {
        lastReason = `background removal: ${br.error ?? "unknown"}`;
        continue;
      }
      const cut = await fetchBuffer(br.imageUrl);
      if (!cut) {
        lastReason = "cutout download failed";
        continue;
      }
      sheet = cut;
    }
    const pieces = await cutDecorSheet(sheet);
    if (pieces.length < MIN_SHEET_PIECES) {
      lastReason = `лист дал ${pieces.length} кусков при минимуме ${MIN_SHEET_PIECES} — контракт листа нарушен`;
      continue;
    }
    console.log(`🧩 decor sheet ${label}: ${pieces.length} кусков из одной генерации [${concepts.join(", ")}]`);
    return { ok: true, pieces };
  }
  return { ok: false, reason: lastReason };
}
