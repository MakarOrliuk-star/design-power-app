import { prisma } from "../lib/prisma.js";

/**
 * Референсы вариаций (TASK ai-reference, DI-R3/R5).
 *
 * Референс — ГОТОВЫЙ email-баннер, загруженный админом/CRM_SUPER под пару
 * «вариация (NeuralPromptPreset) × базовый бренд». Из них nano-banana-2 /edit
 * собирает новую композицию целиком, поэтому:
 *   - на паре хранится 5..15 файлов (меньше 5 — генерация закрыта, DI-R3);
 *   - в один вызов модели уходят первые MAX_EDIT_REFS по sortOrder — жёсткий
 *     лимит nano-banana-2 /edit, DI-R5. Порядок админа = приоритет.
 */

export const MIN_REFS_FOR_GENERATION = 5;
export const MAX_REFS_PER_PAIR = 15;
/** Лимит image_urls у nano-banana-2 /edit (fal.ai; см. тж. falModels.ts). */
export const MAX_EDIT_REFS = 14;

export const REFS_FOLDER = "bundle_refs";

export interface VariationRefDto {
  id: string;
  presetId: string;
  brandName: string;
  imageUrl: string;
  publicId: string;
  width: number;
  height: number;
  sortOrder: number;
  createdAt: Date;
}

/** Все референсы пары, в порядке админа. */
export async function listRefs(presetId: string, brandName: string): Promise<VariationRefDto[]> {
  return prisma.variationReference.findMany({
    where: { presetId, brandName },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
}

/** Счётчики по брендам для бейджей мастера («Betnella: 7/15», DI-R12). */
export async function refCountsByBrand(presetId: string): Promise<Record<string, number>> {
  const rows = await prisma.variationReference.groupBy({
    by: ["brandName"],
    where: { presetId },
    _count: { _all: true },
  });
  return Object.fromEntries(rows.map((r) => [r.brandName, r._count._all]));
}

/**
 * Референсы, уходящие в генерацию: первые MAX_EDIT_REFS по порядку админа.
 * Бросает, если меньше MIN_REFS_FOR_GENERATION — процессор переводит ассет в
 * FAILED с этой причиной (гейт в роуте generate должен был отсечь раньше).
 */
export async function pickGenerationRefs(
  presetId: string,
  brandName: string,
): Promise<VariationRefDto[]> {
  const refs = await listRefs(presetId, brandName);
  if (refs.length < MIN_REFS_FOR_GENERATION) {
    throw new Error(
      `ai_reference: у бренда "${brandName}" ${refs.length} референсов, нужно >= ${MIN_REFS_FOR_GENERATION}`,
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
