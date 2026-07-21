import { prisma } from "../lib/prisma.js";
import { getBundleQueue } from "../queues/index.js";
import { canStartGeneration, deriveBundleStatus } from "./bundleStatus.js";
import type { BundleAssetStatus } from "./bundleStatus.js";

// Image Bundles domain service (TASK crm-bundle, R-PLAN §3/§6/§7).

/** One asset slot of a bundle type (BundleType.assets Json element). */
export interface BundleTypeAsset {
  key: string; // "email" | "popup" | "push" (extensible, D2)
  label: string;
  width: number;
  height: number;
  templateUrl?: string; // stage-B background template (D13, Phase 4)
  zones?: Record<string, { x: number; y: number; w: number; h: number }>;
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
  | { ok: false; error: "already_generating" | "no_brands" | "queue_unavailable" };

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
        update: { brandId: v.brandId, displayName: v.displayName, personImageUrl: null, itemImageUrl: null },
      });
      variantIds.push(row.id);
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
    include: { variant: { select: { id: true, personImageUrl: true } } },
  });
  if (!asset) return null;
  if (asset.status === "GENERATING" || asset.status === "PENDING") return { ok: false, error: "in_flight" };

  await prisma.bundleAsset.update({
    where: { id: assetId },
    data: { status: "GENERATING", approved: false, errorMessage: null },
  });
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
