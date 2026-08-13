import { prisma } from "../lib/prisma.js";
import { getBundleQueue } from "../queues/index.js";
import { canStartGeneration, deriveBundleStatus } from "./bundleStatus.js";
import type { BundleAssetStatus } from "./bundleStatus.js";
import { refCountsByBrand, resolveRefPoolName, MIN_REFS_FOR_GENERATION } from "./variationRefs.js";

// Image Bundles domain service (TASK crm-bundle, R-PLAN §3/§6/§7).

/** One asset slot of a bundle type (BundleType.assets Json element). */
export interface BundleTypeAsset {
  key: string; // "email" | "popup" | "push" (extensible, D2)
  label: string;
  width: number;
  height: number;
  templateUrl?: string; // stage-B background template (D13, Phase 4)
  zones?: Record<string, { x: number; y: number; w: number; h: number }>;
  // "ai" (default): single multi-reference generation + canvas fit.
  // "layered" (D10 v2, email): background layer + transparent person/item
  // cutouts composited into their zone boxes by pixels — hard guarantee.
  // "ai_reference" (TASK ai-reference + safe-zone/auto-heal): новая композиция
  // целиком из 5–15 референс-баннеров вариации (gpt-image-2 /edit) + приёмка
  // VLM + auto-healing; выдаёт ОДИН ассет — прозрачную версию без текста.
  composeMode?: "ai" | "layered" | "ai_reference";
  // TASK multiformat-promo (A2-1): якорь стиля кампании среди ai_reference-
  // ассетов — он генерируется ПЕРВЫМ, остальные наследуют его стиль. Не задан
  // ни на одном ассете → якорь выбирается по правилу resolveStyleAnchorKey.
  styleAnchor?: boolean;
  // Versioned geometry (TASK email-composition, Phase 1): key into LayoutSpec;
  // the composition engine resolves the latest active version at render time.
  layoutSpecKey?: string;
  // Static decor cutouts (coins, percent signs…) the engine scatters into the
  // spec's decor bands (Phase 3). Admin-provided transparent PNG URLs.
  decorUrls?: string[];
  // Golden composite @1x for the validator's structural SSIM check (Phase 4;
  // the golden assets themselves are produced in Phase 6).
  goldenUrl?: string;
  // TASK glow-fade-density (DI3-15): пост-обработка ai_reference-ассета —
  // центральное свечение под объектами и фейд нижней кромки. Поле не задано =
  // оба включены; глобальный откат без деплоя — env AI_REF_EFFECTS=off.
  effects?: { glow?: boolean; fade?: boolean };
  // Лимит мелких предметов зависимого формата (DI3-9/DI3-14, задание 3):
  // уходит и в промпт генерации, и в чек-лист приёмщика. У якорного формата
  // игнорируется — плотность email не трогаем (DI3-10). Не задано → 8.
  maxProps?: number;
}

// ------------------------------------------------------------------
// Мультиформатное промо (TASK multiformat-promo, DI2-3/A2-1): порядок
// генерации ai_reference-ассетов. Якорь кампании рендерится первым, остальные
// форматы получают его композицию как стиль-эталон.
// ------------------------------------------------------------------

/** Ассеты типа бандла, собираемые режимом ai_reference (в порядке админа). */
export function aiReferenceAssets(typeAssets: BundleTypeAsset[]): BundleTypeAsset[] {
  return typeAssets.filter((a) => a.composeMode === "ai_reference");
}

/**
 * Ключ якорного ассета (A2-1): явный `styleAnchor: true` → "email" → первый
 * ai_reference-ассет. null — режим в типе не используется вовсе.
 */
export function resolveStyleAnchorKey(typeAssets: BundleTypeAsset[]): string | null {
  const refs = aiReferenceAssets(typeAssets);
  if (refs.length === 0) return null;
  const explicit = refs.find((a) => a.styleAnchor === true);
  if (explicit) return explicit.key;
  const email = refs.find((a) => a.key === "email");
  return (email ?? refs[0]!).key;
}

/** Ai_reference-ассеты, зависящие от якоря (все, кроме него самого). */
export function dependentAiReferenceAssets(typeAssets: BundleTypeAsset[]): BundleTypeAsset[] {
  const anchorKey = resolveStyleAnchorKey(typeAssets);
  if (!anchorKey) return [];
  return aiReferenceAssets(typeAssets).filter((a) => a.key !== anchorKey);
}

/**
 * Форматы, для которых нужно грузить референсы: ai_reference-ассеты всех
 * активных типов бандлов (вкладки RefsManager, Ф3.2). Дубликаты ключей
 * схлопываются — геометрию берём из первого вхождения.
 */
export async function listAiReferenceFormats(): Promise<
  Array<{ key: string; label: string; width: number; height: number; isAnchor: boolean }>
> {
  const types = await prisma.bundleType.findMany({
    where: { isActive: true },
    orderBy: { createdAt: "asc" },
    select: { assets: true },
  });
  const formats = new Map<string, { key: string; label: string; width: number; height: number; isAnchor: boolean }>();
  for (const type of types) {
    const assets = (type.assets as unknown as BundleTypeAsset[]) ?? [];
    const anchorKey = resolveStyleAnchorKey(assets);
    for (const asset of aiReferenceAssets(assets)) {
      if (formats.has(asset.key)) continue;
      formats.set(asset.key, {
        key: asset.key,
        label: asset.label,
        width: asset.width,
        height: asset.height,
        isAnchor: asset.key === anchorKey,
      });
    }
  }
  return [...formats.values()];
}

// ------------------------------------------------------------------
// Brand grouping (D3/D7): one wizard toggle = one BASE brand name; only the
// trailing (Men)/(Women) tone suffix is merged. Mirrors the display-only
// stripGender in frontend/app/composables/useResult.ts — other parenthetical
// variants ((Monkey), (Duck), …) stay separate brands.
// ------------------------------------------------------------------

const GENDER_SUFFIX = /\s*\((?:men|women|man|woman)\)\s*$/i;

export function stripGenderName(name: string): string {
  return name.replace(GENDER_SUFFIX, "").trim();
}

/** Пол героя тон-варианта: "Fridayroll(Men)" → "male", "Fridayroll" → null. */
export type HeroGender = "male" | "female";

/**
 * Пол из суффикса имени варианта (TASK glow-fade-density, правка 2026-08-13).
 *
 * До этого пол героя в режиме ai_reference задавали ТОЛЬКО референсы (DI2-10),
 * и модель, сочиняя НОВУЮ сцену, регулярно меняла его: у "Fridayroll(Men)"
 * выходила женщина. Имя варианта — надёжный сигнал, который у нас уже есть,
 * поэтому он идёт и в промпт генерации, и в чек-лист приёмки, и в лечение.
 * Бренд без суффикса пола (обычный, без тон-вариантов) даёт null — там
 * персонажа по-прежнему определяют одни референсы.
 */
export function heroGenderFromBrand(name: string): HeroGender | null {
  const match = name.match(GENDER_SUFFIX);
  if (!match) return null;
  return /\((?:men|man)\)/i.test(match[0]) ? "male" : "female";
}

/** "Betnella(Men)" → "Betnella (Men)" — space + normalized tone suffix for UI. */
export function variantDisplayName(name: string): string {
  return name
    .replace(/\s*\((men|women|man|woman)\)\s*$/i, (_m, g: string) => {
      return ` (${g.toLowerCase().startsWith("m") ? "Men" : "Women"})`;
    })
    .trim();
}

export interface BundleBrandGroup {
  key: string; // base name, e.g. "Betnella"
  displayName: string;
  variants: Array<{ name: string; displayName: string }>;
}

/** Active brands grouped by base name for the wizard picker (one toggle each). */
export async function listBundleBrands(): Promise<BundleBrandGroup[]> {
  const brands = await prisma.brand.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
    select: { name: true },
  });
  const groups = new Map<string, BundleBrandGroup>();
  for (const { name } of brands) {
    const base = stripGenderName(name);
    let group = groups.get(base);
    if (!group) {
      group = { key: base, displayName: base, variants: [] };
      groups.set(base, group);
    }
    group.variants.push({ name, displayName: variantDisplayName(name) });
  }
  return [...groups.values()];
}

/** Expand chosen base names into the ACTUALLY existing active brand variants. */
export async function expandBrandVariants(
  baseNames: string[],
): Promise<Array<{ brandId: string; brandName: string; displayName: string }>> {
  const wanted = new Set(baseNames.map((n) => n.trim()).filter(Boolean));
  const brands = await prisma.brand.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
  const result: Array<{ brandId: string; brandName: string; displayName: string }> = [];
  for (const { id, name } of brands) {
    if (wanted.has(stripGenderName(name))) {
      result.push({ brandId: id, brandName: name, displayName: variantDisplayName(name) });
    }
  }
  return result;
}

// ------------------------------------------------------------------
// Status recompute (derived, mirrors recomputeBatchStatus in finalize.ts)
// ------------------------------------------------------------------

/** Re-derive Bundle.status from its assets; called after every job/launch. */
export async function recomputeBundleStatus(bundleId: string): Promise<void> {
  const assets = await prisma.bundleAsset.findMany({
    where: { bundleId },
    select: { status: true },
  });
  const derived = deriveBundleStatus(assets.map((a) => a.status as BundleAssetStatus));
  // Never demote an untouched wizard draft (no assets yet keeps DRAFT anyway).
  await prisma.bundle.update({ where: { id: bundleId }, data: { status: derived } });
}

// ------------------------------------------------------------------
// Generation launch (R-PLAN §6): expand variants, reset assets, enqueue
// stage-A jobs. Idempotent — re-launch reuses the same variant/asset rows.
// ------------------------------------------------------------------

export type LaunchResult =
  | { ok: true; variantCount: number; assetCount: number }
  | {
      ok: false;
      error:
        | "already_generating"
        | "no_brands"
        | "queue_unavailable"
        | "preset_required"
        | "refs_missing";
      /**
       * refs_missing: пары «бренд × формат» с числом референсов < минимума
       * (DI-R3; формат добавлен в TASK multiformat-promo, DI2-2).
       */
      missingRefs?: Array<{ brandName: string; assetKey: string; count: number; min: number }>;
    };

export async function launchGeneration(bundleId: string): Promise<LaunchResult | null> {
  const bundle = await prisma.bundle.findUnique({
    where: { id: bundleId },
    include: { bundleType: true },
  });
  if (!bundle) return null;
  if (!canStartGeneration(bundle.status)) return { ok: false, error: "already_generating" };

  const baseNames = (bundle.brandNames as string[]) ?? [];
  const variants = await expandBrandVariants(baseNames);
  if (variants.length === 0) return { ok: false, error: "no_brands" };

  const typeAssets = bundle.bundleType.assets as unknown as BundleTypeAsset[];

  // Гейт ai_reference (fail-fast ДО очереди, R-PLAN §1.3): вариация выбрана и
  // у каждого выбранного БАЗОВОГО бренда достаточно референсов НА КАЖДЫЙ
  // ai_reference-формат (DI2-2 — фолбэка «push берёт email-рефы» нет).
  const aiRefAssets = aiReferenceAssets(typeAssets);
  if (aiRefAssets.length > 0) {
    if (!bundle.presetId) return { ok: false, error: "preset_required" };
    const counts = await refCountsByBrand(bundle.presetId);
    // Проверяем КАЖДЫЙ тон-вариант (DI2-10): у "Betnella(Men)" может быть свой
    // пул, а может не быть — тогда считается общий пул базового бренда.
    const missing = variants
      .flatMap((variant) =>
        aiRefAssets.map((asset) => ({
          brandName: variant.displayName,
          assetKey: asset.key,
          count: resolveRefPoolName(
            counts,
            variant.brandName,
            stripGenderName(variant.brandName),
            asset.key,
          ).count,
          min: MIN_REFS_FOR_GENERATION,
        })),
      )
      .filter((m) => m.count < MIN_REFS_FOR_GENERATION);
    if (missing.length > 0) return { ok: false, error: "refs_missing", missingRefs: missing };
  }

  // Upsert variants + assets and reset them for a fresh run. brandNames are
  // locked after the first launch (route-level), so the expansion is stable;
  // stale variants are removed defensively anyway.
  const variantIds: string[] = [];
  await prisma.$transaction(async (tx) => {
    await tx.bundleBrandVariant.deleteMany({
      where: { bundleId, brandName: { notIn: variants.map((v) => v.brandName) } },
    });
    for (const v of variants) {
      const row = await tx.bundleBrandVariant.upsert({
        where: { bundleId_brandName: { bundleId, brandName: v.brandName } },
        create: { bundleId, ...v },
        // Full re-run regenerates the shared person/item artifacts (stage A).
        update: {
          brandId: v.brandId,
          displayName: v.displayName,
          personImageUrl: null,
          itemImageUrl: null,
          personCutoutId: null,
          itemCutoutId: null,
        },
      });
      variantIds.push(row.id);
      // Производные строки ai_reference прошлого запуска (email_notext/…)
      // и ассеты удалённых из типа ключей: сносим — новый запуск создаст
      // семейство заново от свежей композиции (иначе рядом с новым родителем
      // останутся «свежие» производные от старой).
      await tx.bundleAsset.deleteMany({
        where: { variantId: row.id, assetKey: { notIn: typeAssets.map((a) => a.key) } },
      });
      for (const a of typeAssets) {
        await tx.bundleAsset.upsert({
          where: { variantId_assetKey: { variantId: row.id, assetKey: a.key } },
          create: {
            bundleId,
            variantId: row.id,
            assetKey: a.key,
            width: a.width,
            height: a.height,
            status: "PENDING",
          },
          update: {
            width: a.width,
            height: a.height,
            status: "PENDING",
            approved: false,
            errorMessage: null,
            imageUrl: null,
          },
        });
      }
    }
    await tx.bundle.update({ where: { id: bundleId }, data: { status: "GENERATING" } });
  });

  try {
    const queue = getBundleQueue();
    await queue.addBulk(
      variantIds.map((variantId) => ({
        name: "prepare-variant" as const,
        data: { bundleId, variantId },
      })),
    );
  } catch (err) {
    console.error("bundle enqueue failed:", err);
    await prisma.bundleAsset.updateMany({
      where: { bundleId },
      data: { status: "FAILED", errorMessage: "queue_unavailable" },
    });
    await recomputeBundleStatus(bundleId);
    return { ok: false, error: "queue_unavailable" };
  }

  return { ok: true, variantCount: variantIds.length, assetCount: variantIds.length * typeAssets.length };
}

/** Text-prompt Edit of a finished asset (D9): img2img from the current image. */
export async function editAsset(
  bundleId: string,
  assetId: string,
  prompt: string,
): Promise<{ ok: true } | { ok: false; error: "not_editable" | "queue_unavailable" } | null> {
  const asset = await prisma.bundleAsset.findFirst({
    where: { id: assetId, bundleId },
    select: { id: true, status: true, imageUrl: true, variantId: true },
  });
  if (!asset) return null;
  // Only a finished asset with an image can be edited (Result-card button).
  if (asset.status !== "DONE" || !asset.imageUrl) return { ok: false, error: "not_editable" };

  await prisma.bundleAsset.update({
    where: { id: assetId },
    data: { status: "GENERATING", approved: false, errorMessage: null },
  });
  await prisma.bundle.update({ where: { id: bundleId }, data: { status: "GENERATING" } });

  try {
    await getBundleQueue().add("edit-asset", {
      bundleId,
      variantId: asset.variantId,
      assetId,
      editPrompt: prompt,
    });
  } catch (err) {
    console.error("bundle edit enqueue failed:", err);
    await prisma.bundleAsset.update({
      where: { id: assetId },
      data: { status: "FAILED", errorMessage: "queue_unavailable" },
    });
    await recomputeBundleStatus(bundleId);
    return { ok: false, error: "queue_unavailable" };
  }
  return { ok: true };
}

/** Per-asset regenerate: stage B only (reuses the variant's person/item). */
export async function regenerateAsset(
  bundleId: string,
  assetId: string,
): Promise<{ ok: true } | { ok: false; error: "in_flight" | "queue_unavailable" } | null> {
  const asset = await prisma.bundleAsset.findFirst({
    where: { id: assetId, bundleId },
    include: {
      variant: {
        select: {
          id: true,
          personImageUrl: true,
          bundle: { select: { bundleType: { select: { assets: true } } } },
        },
      },
    },
  });
  if (!asset) return null;
  if (asset.status === "GENERATING" || asset.status === "PENDING") return { ok: false, error: "in_flight" };

  // Каскад DI2-9: Regenerate якорного ассета (email) перерисовывает и
  // зависимые форматы — иначе push/pop-up останутся в стиле старой кампании.
  // Зависимые ставятся в GENERATING здесь, а в очередь их отправит процессор
  // якоря после его успеха (порядок из DI2-3).
  const typeAssets = (asset.variant.bundle.bundleType.assets as unknown as BundleTypeAsset[]) ?? [];
  const isAnchor = resolveStyleAnchorKey(typeAssets) === asset.assetKey;
  const dependentKeys = isAnchor ? dependentAiReferenceAssets(typeAssets).map((a) => a.key) : [];
  if (dependentKeys.length > 0) {
    const busy = await prisma.bundleAsset.count({
      where: {
        variantId: asset.variant.id,
        assetKey: { in: dependentKeys },
        status: { in: ["PENDING", "GENERATING"] },
      },
    });
    if (busy > 0) return { ok: false, error: "in_flight" };
  }

  await prisma.bundleAsset.update({
    where: { id: assetId },
    data: { status: "GENERATING", approved: false, errorMessage: null },
  });
  if (dependentKeys.length > 0) {
    await prisma.bundleAsset.updateMany({
      where: { variantId: asset.variant.id, assetKey: { in: dependentKeys } },
      data: { status: "GENERATING", approved: false, errorMessage: null },
    });
  }
  await prisma.bundle.update({ where: { id: bundleId }, data: { status: "GENERATING" } });

  try {
    const queue = getBundleQueue();
    if (asset.variant.personImageUrl) {
      await queue.add("render-asset", { bundleId, variantId: asset.variant.id, assetId });
    } else {
      // Stage A never finished for this variant (e.g. it failed) — redo it;
      // the processor re-renders the variant's non-DONE assets afterwards.
      await queue.add("prepare-variant", { bundleId, variantId: asset.variant.id });
    }
  } catch (err) {
    console.error("bundle asset enqueue failed:", err);
    await prisma.bundleAsset.update({
      where: { id: assetId },
      data: { status: "FAILED", errorMessage: "queue_unavailable" },
    });
    await recomputeBundleStatus(bundleId);
    return { ok: false, error: "queue_unavailable" };
  }
  return { ok: true };
}
