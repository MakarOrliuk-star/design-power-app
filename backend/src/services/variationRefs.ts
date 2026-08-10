import { prisma } from "../lib/prisma.js";

/**
 * Референсы вариаций (TASK ai-reference, DI-R3/R5; TASK multiformat-promo, DI2-1/2).
 *
 * Референс — ГОТОВЫЙ баннер, загруженный админом/CRM_SUPER под тройку
 * «вариация (NeuralPromptPreset) × базовый бренд × ФОРМАТ». Из них
 * gpt-image-2 (или nano-banana-2) /edit собирает новую композицию целиком,
 * поэтому:
 *   - на тройке хранится 5..15 файлов (меньше 5 — генерация формата закрыта);
 *   - в один вызов модели уходят первые MAX_EDIT_REFS по sortOrder — жёсткий
 *     лимит /edit, DI-R5. Порядок админа = приоритет.
 *
 * Формат (`assetKey`) совпадает с ключом ассета в `BundleType.assets[]`
 * ("email" / "popup" / "push"): у форматов разная стилистика, поэтому пулы
 * референсов раздельные и фолбэка «push берёт email-рефы» нет (DI2-2).
 */

export const MIN_REFS_FOR_GENERATION = 5;
export const MAX_REFS_PER_PAIR = 15;
/** Лимит image_urls у nano-banana-2 /edit (fal.ai; см. тж. falModels.ts). */
export const MAX_EDIT_REFS = 14;

/** Формат по умолчанию — совпадает с @default("email") в схеме (DI2-1). */
export const DEFAULT_REF_ASSET_KEY = "email";

export const REFS_FOLDER = "bundle_refs";

export interface VariationRefDto {
  id: string;
  presetId: string;
  brandName: string;
  assetKey: string;
  imageUrl: string;
  publicId: string;
  width: number;
  height: number;
  sortOrder: number;
  createdAt: Date;
}

/** Счётчики одной вариации: бренд → формат → сколько референсов. */
export type RefCounts = Record<string, Record<string, number>>;

/** Все референсы тройки (вариация × бренд × формат), в порядке админа. */
export async function listRefs(
  presetId: string,
  brandName: string,
  assetKey: string,
): Promise<VariationRefDto[]> {
  return prisma.variationReference.findMany({
    where: { presetId, brandName, assetKey },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
}

/**
 * Счётчики по брендам и форматам для бейджей мастера и вкладок RefsManager
 * («Betnella: email 7, push 5», DI-R12/DI2-2).
 */
export async function refCountsByBrand(presetId: string): Promise<RefCounts> {
  const rows = await prisma.variationReference.groupBy({
    by: ["brandName", "assetKey"],
    where: { presetId },
    _count: { _all: true },
  });
  const counts: RefCounts = {};
  for (const row of rows) {
    (counts[row.brandName] ??= {})[row.assetKey] = row._count._all;
  }
  return counts;
}

/** Сколько референсов у пары бренд×формат в готовых счётчиках (0, если нет). */
export function countFor(counts: RefCounts, brandName: string, assetKey: string): number {
  return counts[brandName]?.[assetKey] ?? 0;
}

/**
 * Референсы, уходящие в генерацию: первые MAX_EDIT_REFS по порядку админа.
 * Бросает, если меньше MIN_REFS_FOR_GENERATION — процессор переводит ассет в
 * FAILED с этой причиной (гейт в роуте generate должен был отсечь раньше).
 */
export async function pickGenerationRefs(
  presetId: string,
  brandName: string,
  assetKey: string,
): Promise<VariationRefDto[]> {
  const refs = await listRefs(presetId, brandName, assetKey);
  if (refs.length < MIN_REFS_FOR_GENERATION) {
    throw new Error(
      `ai_reference: у бренда "${brandName}" (формат ${assetKey}) ${refs.length} референсов, нужно >= ${MIN_REFS_FOR_GENERATION}`,
    );
  }
  return refs.slice(0, MAX_EDIT_REFS);
}

/** Слаг бренда для папки Cloudinary (кириллица/скобки → безопасные дефисы). */
export function brandSlug(brandName: string): string {
  const slug = brandName
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "brand";
}

/**
 * Папка Cloudinary тройки. У email путь ИСТОРИЧЕСКИЙ (без подпапки формата):
 * public_id уже загруженных баннеров считался от него, и дедуп по publicId
 * должен продолжать их узнавать. Остальные форматы уходят в свои подпапки —
 * заодно это и разводит public_id одного и того же файла по форматам, из-за
 * чего уникальный ключ [presetId, brandName, publicId] им не мешает.
 */
export function refsFolder(presetId: string, brandName: string, assetKey: string): string {
  const base = `${REFS_FOLDER}/${presetId}/${brandSlug(brandName)}`;
  return assetKey === DEFAULT_REF_ASSET_KEY ? base : `${base}/${brandSlug(assetKey)}`;
}
