import { prisma } from "../lib/prisma.js";
import { runPersonFal, runBriaExpand } from "../lib/fal.js";
import { uploadFromUrl, withRetry } from "../lib/cloudinary.js";
import { nearestFalAspect, probeImageSize } from "../lib/imageSize.js";
import { getPrompt } from "../services/prompts.js";
import { buildPersonPromptMemoized } from "./person.processor.js";
import { getBundleQueue } from "./index.js";
import { recomputeBundleStatus } from "../services/bundle.service.js";
import type { BundleTypeAsset } from "../services/bundle.service.js";

/**
 * Image Bundles pipeline (TASK crm-bundle Phase 4, R-PLAN §6, D10–D13).
 *
 * Stage A — "prepare-variant": one shared PERSON (existing person pipeline:
 * brand refs + brand PERSON template + the bundle's neural prompt) and one
 * shared ITEM anchor (brand's own ITEM template when it exists, else the
 * admin-editable "bundle_default" preset) per brand variant. Both are reused
 * by all of the variant's assets and by per-asset regenerates.
 *
 * Stage B — "render-asset": AI-composition (nano-banana multi-image edit) of
 * [template?, person, item?] into the mask layout, then Bria expand to the
 * exact canvas (nano-banana is aspect-ratio-only — 2:1 does not exist, D5),
 * then a pixel-size validation probe.
 *
 * Failures mark the asset(s) FAILED with a reason (house pattern — logical
 * failures don't throw, the Regenerate button is the retry path); the bundle
 * status is re-derived after every terminal transition.
 */

// Built-in fallback if neither the brand ITEM template nor the admin-seeded
// "bundle_default" preset exists (D12).
export const DEFAULT_BUNDLE_ITEM_PROMPT =
  "Casino slot item collection for an advertising creative: golden lucky seven symbols, casino chips, cherries, gold coins. Detailed glossy 3D render, isolated objects on a clean dark background, vivid advertising quality, no text. Theme: {{prompt}}";

export const BUNDLE_DEFAULT_ITEM_KEY = "bundle_default";

/** Brand ITEM template (key = brand name) → bundle_default preset → built-in. */
export async function buildBundleItemPrompt(brandName: string, userPrompt: string): Promise<string> {
  const u = userPrompt.trim();
  const wrapper =
    (await getPrompt("ITEM", brandName)) ||
    (await getPrompt("ITEM", BUNDLE_DEFAULT_ITEM_KEY)) ||
    DEFAULT_BUNDLE_ITEM_PROMPT;
  if (wrapper.includes("{{prompt}}")) return wrapper.split("{{prompt}}").join(u);
  return u ? `${wrapper}\n${u}` : wrapper;
}

/**
 * Mask-layout composition directive per asset type (figma/crm-bundle stencils).
 * The reference images are passed in the order [template?, person, item?] and
 * the prompt addresses them by role. Unknown asset keys (future bundle types)
 * get a generic full-canvas composition.
 */
export function compositionPrompt(
  assetKey: string,
  opts: { hasTemplate: boolean; hasItem: boolean; neuralPrompt: string },
): string {
  const refs: string[] = [];
  if (opts.hasTemplate)
    refs.push(
      "Use the first reference image as the background template: keep its composition zones, palette and lighting.",
    );
  refs.push(
    `Take the main character exactly from the ${opts.hasTemplate ? "second" : "first"} reference image — same identity, costume and art style.`,
  );
  if (opts.hasItem)
    refs.push(
      "Take the decorative objects (slot symbols, chips, coins) from the last reference image and keep their style.",
    );

  const layouts: Record<string, string> = {
    email:
      "Layout (email hero banner): place the character on the RIGHT third of the canvas as the active anchor. Place the detailed graphic objects on the LEFT third as the graphical anchor. KEEP THE CENTRAL THIRD EMPTY — no objects, characters or text there, only a subtly blurred ambient background; that zone is reserved for dynamic text and CTA buttons added later.",
    push:
      "Layout (push banner): place the character in the CENTER holding a glowing focal medallion. Scatter slot symbols, chips and cherries dynamically around the whole canvas. There is NO protected empty area — the entire canvas may be filled with graphics.",
    popup:
      "Layout (pop-up): main character in the CENTER holding the central artifact. Accent emblems/symbols on the left and right sides, scattered ambient objects around. Detailed graphics are allowed everywhere — no protected text zones.",
  };
  const layout =
    layouts[assetKey] ??
    "Layout: balanced advertising composition with the character as the focal point and the decorative objects arranged around it.";

  const campaign = opts.neuralPrompt.trim();
  return [
    "Compose a single polished advertising creative.",
    ...refs,
    layout,
    campaign ? `Campaign brief: ${campaign}.` : "",
    "No text, no letters, no logos, no watermarks. Professional advertising quality, coherent lighting across all elements.",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Center the generated image inside the exact target canvas: scale to fit
 * (contain), Bria outpaints the remaining margins. Pure — unit-tested.
 */
export function computeCanvasPlacement(
  srcW: number,
  srcH: number,
  targetW: number,
  targetH: number,
): { canvasW: number; canvasH: number; imgW: number; imgH: number; originX: number; originY: number } {
  const scale = Math.min(targetW / srcW, targetH / srcH);
  const imgW = Math.min(targetW, Math.round(srcW * scale));
  const imgH = Math.min(targetH, Math.round(srcH * scale));
  return {
    canvasW: targetW,
    canvasH: targetH,
    imgW,
    imgH,
    originX: Math.round((targetW - imgW) / 2),
    originY: Math.round((targetH - imgH) / 2),
  };
}

// ------------------------------------------------------------------
// Stage A — prepare-variant
// ------------------------------------------------------------------

export async function processPrepareVariantJob(bundleId: string, variantId: string): Promise<void> {
  const variant = await prisma.bundleBrandVariant.findUnique({
    where: { id: variantId },
    include: { bundle: { select: { id: true, neuralPrompt: true } } },
  });
  if (!variant || variant.bundleId !== bundleId) return; // deleted → no-op

  const failVariant = async (reason: string) => {
    await prisma.bundleAsset.updateMany({
      where: { variantId, status: { in: ["PENDING", "GENERATING"] } },
      data: { status: "FAILED", errorMessage: reason },
    });
    await recomputeBundleStatus(bundleId);
  };

  const brand = await prisma.brand.findUnique({
    where: { name: variant.brandName },
    select: { imageModel: true, nanoRef: { select: { referenceImages: true } } },
  });
  const refs = brand?.nanoRef?.referenceImages ?? [];
  const neuralPrompt = variant.bundle.neuralPrompt;

  // 1) Shared PERSON (D11) — the existing person pipeline, full-body pose.
  const personUserText =
    `${neuralPrompt}\nFull-body character in a confident advertising pose, suitable for placement on a promo banner.`.trim();
  const personPrompt = await buildPersonPromptMemoized(bundleId, variant.brandName, personUserText);
  const personRun = await runPersonFal(personPrompt, refs, "3:4", brand?.imageModel ?? null);
  if (!personRun.success || !personRun.imageUrl) {
    await failVariant(`person: ${personRun.error ?? "unknown"}`);
    return;
  }
  const personUp = await withRetry(
    () => uploadFromUrl(personRun.imageUrl!, `${variant.brandName}_person_${Date.now()}`, `bundles/${bundleId}`),
    `bundle-person#${variantId}`,
  );
  if (!personUp.success || !personUp.secure_url) {
    await failVariant(`person upload: ${personUp.error ?? "unknown"}`);
    return;
  }

  // 2) Shared ITEM anchor (D12).
  const itemPrompt = await buildBundleItemPrompt(variant.brandName, neuralPrompt);
  const itemRun = await runPersonFal(itemPrompt, [], "1:1", null);
  if (!itemRun.success || !itemRun.imageUrl) {
    await failVariant(`item: ${itemRun.error ?? "unknown"}`);
    return;
  }
  const itemUp = await withRetry(
    () => uploadFromUrl(itemRun.imageUrl!, `${variant.brandName}_item_${Date.now()}`, `bundles/${bundleId}`),
    `bundle-item#${variantId}`,
  );
  if (!itemUp.success || !itemUp.secure_url) {
    await failVariant(`item upload: ${itemUp.error ?? "unknown"}`);
    return;
  }

  await prisma.bundleBrandVariant.update({
    where: { id: variantId },
    data: { personImageUrl: personUp.secure_url, itemImageUrl: itemUp.secure_url },
  });

  // 3) Stage B fan-out: render every asset that is still in the pipeline.
  const assets = await prisma.bundleAsset.findMany({
    where: { variantId, status: { in: ["PENDING", "GENERATING"] } },
    select: { id: true },
  });
  if (assets.length === 0) {
    await recomputeBundleStatus(bundleId);
    return;
  }
  await prisma.bundleAsset.updateMany({
    where: { id: { in: assets.map((a) => a.id) } },
    data: { status: "GENERATING" },
  });
  await getBundleQueue().addBulk(
    assets.map((a) => ({
      name: "render-asset" as const,
      data: { bundleId, variantId, assetId: a.id },
    })),
  );
}

// ------------------------------------------------------------------
// Stage B — render-asset
// ------------------------------------------------------------------

export async function processRenderAssetJob(
  bundleId: string,
  variantId: string,
  assetId: string,
): Promise<void> {
  const asset = await prisma.bundleAsset.findUnique({
    where: { id: assetId },
    include: {
      variant: {
        include: {
          bundle: {
            select: { id: true, neuralPrompt: true, bundleType: { select: { assets: true } } },
          },
        },
      },
    },
  });
  if (!asset || asset.bundleId !== bundleId || asset.variantId !== variantId) return;

  const fail = async (reason: string) => {
    await prisma.bundleAsset.update({
      where: { id: assetId },
      data: { status: "FAILED", errorMessage: reason },
    });
    await recomputeBundleStatus(bundleId);
  };

  const variant = asset.variant;
  if (!variant.personImageUrl) {
    await fail("missing person artifact — regenerate the bundle");
    return;
  }

  const typeAssets = variant.bundle.bundleType.assets as unknown as BundleTypeAsset[];
  const config = typeAssets.find((a) => a.key === asset.assetKey);
  const targetW = config?.width ?? asset.width;
  const targetH = config?.height ?? asset.height;

  await prisma.bundleAsset.update({
    where: { id: assetId },
    data: { status: "GENERATING", errorMessage: null },
  });

  // Compose: [template?, person, item?] + mask-layout directive (D10/D13).
  const imageUrls = [config?.templateUrl, variant.personImageUrl, variant.itemImageUrl].filter(
    (u): u is string => typeof u === "string" && u.length > 0,
  );
  const prompt = compositionPrompt(asset.assetKey, {
    hasTemplate: Boolean(config?.templateUrl),
    hasItem: Boolean(variant.itemImageUrl),
    neuralPrompt: variant.bundle.neuralPrompt,
  });

  const gen = await runPersonFal(prompt, imageUrls, nearestFalAspect(targetW, targetH), null);
  if (!gen.success || !gen.imageUrl) {
    await fail(`compose: ${gen.error ?? "unknown"}`);
    return;
  }

  // Fit to the exact mask canvas (D5): outpaint margins via Bria when the
  // generated aspect differs; a same-ratio result is just placed full-bleed.
  let finalUrl = gen.imageUrl;
  const size = await probeImageSize(gen.imageUrl);
  if (!size) {
    await fail("probe: could not read the generated image size");
    return;
  }
  if (size.width !== targetW || size.height !== targetH) {
    const placement = computeCanvasPlacement(size.width, size.height, targetW, targetH);
    const expanded = await runBriaExpand(gen.imageUrl, placement);
    if (!expanded.success || !expanded.imageUrl) {
      await fail(`expand: ${expanded.error ?? "unknown"}`);
      return;
    }
    finalUrl = expanded.imageUrl;
    const finalSize = await probeImageSize(finalUrl);
    if (finalSize && (finalSize.width !== targetW || finalSize.height !== targetH)) {
      await fail(`size mismatch: got ${finalSize.width}×${finalSize.height}, want ${targetW}×${targetH}`);
      return;
    }
  }

  const up = await withRetry(
    () =>
      uploadFromUrl(
        finalUrl,
        `${variant.brandName}_${asset.assetKey}_${Date.now()}`,
        `bundles/${bundleId}`,
      ),
    `bundle-asset#${assetId}`,
  );
  if (!up.success || !up.secure_url) {
    await fail(`upload: ${up.error ?? "unknown"}`);
    return;
  }

  await prisma.bundleAsset.update({
    where: { id: assetId },
    data: { status: "DONE", imageUrl: up.secure_url, errorMessage: null },
  });
  await recomputeBundleStatus(bundleId);
}

// ------------------------------------------------------------------
// Edit-asset (D9): text-prompt img2img edit of the CURRENT asset image.
// The canvas size is preserved (probe → Bria expand when the model drifts).
// ------------------------------------------------------------------

export async function processEditAssetJob(
  bundleId: string,
  variantId: string,
  assetId: string,
  editPrompt: string,
): Promise<void> {
  const asset = await prisma.bundleAsset.findUnique({
    where: { id: assetId },
    include: { variant: { select: { id: true, brandName: true } } },
  });
  if (!asset || asset.bundleId !== bundleId || asset.variantId !== variantId) return;

  const fail = async (reason: string) => {
    await prisma.bundleAsset.update({
      where: { id: assetId },
      data: { status: "FAILED", errorMessage: reason },
    });
    await recomputeBundleStatus(bundleId);
  };

  const sourceUrl = asset.imageUrl;
  if (!sourceUrl) {
    await fail("edit: no source image");
    return;
  }

  const prompt =
    `Based on the reference image, keep the same composition, characters, style and layout. ${editPrompt.trim()} ` +
    "Do not add text, letters, logos or watermarks. Keep the protected empty areas empty.";
  const run = await runPersonFal(prompt, [sourceUrl], nearestFalAspect(asset.width, asset.height), null);
  if (!run.success || !run.imageUrl) {
    await fail(`edit: ${run.error ?? "unknown"}`);
    return;
  }

  let finalUrl = run.imageUrl;
  const size = await probeImageSize(run.imageUrl);
  if (!size) {
    await fail("edit probe: could not read the edited image size");
    return;
  }
  if (size.width !== asset.width || size.height !== asset.height) {
    const placement = computeCanvasPlacement(size.width, size.height, asset.width, asset.height);
    const expanded = await runBriaExpand(run.imageUrl, placement);
    if (!expanded.success || !expanded.imageUrl) {
      await fail(`edit expand: ${expanded.error ?? "unknown"}`);
      return;
    }
    finalUrl = expanded.imageUrl;
  }

  const up = await withRetry(
    () =>
      uploadFromUrl(
        finalUrl,
        `${asset.variant.brandName}_${asset.assetKey}_edit_${Date.now()}`,
        `bundles/${bundleId}`,
      ),
    `bundle-edit#${assetId}`,
  );
  if (!up.success || !up.secure_url) {
    await fail(`edit upload: ${up.error ?? "unknown"}`);
    return;
  }

  await prisma.bundleAsset.update({
    where: { id: assetId },
    data: { status: "DONE", imageUrl: up.secure_url, errorMessage: null },
  });
  await recomputeBundleStatus(bundleId);
}
