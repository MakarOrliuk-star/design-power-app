import { prisma } from "../lib/prisma.js";
import { runPersonFal, runBriaExpand } from "../lib/fal.js";
import { getOrCreateNormalizedLayer, fetchBuffer } from "../services/layerCache.js";
import { getActiveLayoutSpec, EMAIL_HERO_KEY } from "../services/layoutSpec.js";
import type { LayoutSpecRow } from "../services/layoutSpec.js";
import { composeAsset } from "../lib/composeEngine.js";
import type { EngineLayer } from "../lib/composeEngine.js";
import { validateComposedAsset, personLayerSanity } from "../lib/assetValidator.js";
import {
  composeLayersUrl,
  uploadBuffer,
  uploadFromUrl,
  uploadFromUrlTransformed,
  withRetry,
} from "../lib/cloudinary.js";
import type { ComposeLayer } from "../lib/cloudinary.js";
import { nearestFalAspect, probeImageSize } from "../lib/imageSize.js";
import { getPrompt } from "../services/prompts.js";
import { buildPersonPromptMemoized } from "./person.processor.js";
import { getBundleQueue } from "./index.js";
import type { Prisma } from "../../generated/prisma/client.js";
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

/**
 * Layer generation contract (Phase 2, TASK §3.3 / Фаза 2): appended to the
 * admin-editable prompt templates in code, so every brand's layer arrives in
 * the shape the normalizer + compositor expect — one subject, fully in frame,
 * on an even background the background-removal step can cut cleanly.
 */
export const PERSON_LAYER_CONTRACT =
  "Single character only, full body from head to feet, feet fully visible and not cropped, " +
  "standing in a confident advertising pose facing slightly toward the center (3/4 view), " +
  "with clear margins between the character and every frame edge, on a plain even light-gray " +
  "studio background with strong contrast to the character. No text, no logos, no other objects.";
/** Bounded auto-retry for a broken person layer (Phase 4, лимит DI-Q13). */
export const PERSON_LAYER_RETRIES = 1;

export const ITEM_LAYER_CONTRACT =
  "Render the objects as ONE compact cluster, fully inside the frame with clear margins on " +
  "every side, nothing cropped by the edges, on a plain even light-gray studio background " +
  "with strong contrast to the objects. No text, no logos, no characters.";

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

/** Fractional zone box (0..1 of the canvas) from BundleType.assets[].zones. */
export interface ZoneBox {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type AssetZones = Record<string, ZoneBox>;

/**
 * Hard numeric boundaries from the admin-configured zones (email mask scheme,
 * figma/crm-bundle: item ≤ 25%, person ≥ 75%, protected 25–75%). Explicit
 * percentages hold the model to the frame far better than "left third" prose;
 * the frames are editable from the admin panel without code changes (D13).
 */
export function zoneDirectives(zones: AssetZones | undefined): string[] {
  if (!zones) return [];
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const out: string[] = [];
  if (zones.item) {
    out.push(
      `HARD BOUNDARY for the decorative object cluster: it must stay strictly inside the left section, between the left edge and ${pct(zones.item.x + zones.item.w)} of the canvas width — no part of any object may cross that line toward the center.`,
    );
  }
  if (zones.person) {
    out.push(
      `HARD BOUNDARY for the character: it must stay strictly inside the right section, between ${pct(zones.person.x)} of the canvas width and the right edge — no part of the character (hair, arms, held items) may cross that line toward the center.`,
    );
  }
  if (zones.protected) {
    out.push(
      `PROTECTED CLEAN ZONE: the central band between ${pct(zones.protected.x)} and ${pct(zones.protected.x + zones.protected.w)} of the width is reserved for a large headline and a CTA button — keep it completely free of objects, characters and symbols. Only tiny, soft-focus decorative particles are allowed there, and only near its very top and bottom edges, never in the middle.`,
    );
  }
  return out;
}

/**
 * Mask-layout composition directive per asset type (figma/crm-bundle stencils).
 * The reference images are passed in the order [template?, person, item?] and
 * the prompt addresses them by role. Unknown asset keys (future bundle types)
 * get a generic full-canvas composition. Admin-configured `zones` add hard
 * numeric boundaries on top of the prose layout.
 */
export function compositionPrompt(
  assetKey: string,
  opts: { hasTemplate: boolean; hasItem: boolean; neuralPrompt: string; zones?: AssetZones },
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
      "Layout (email hero banner, like a magazine cover): the character stands at the RIGHT EDGE of the canvas, LARGE — filling almost the full canvas height, torso touching or slightly cropped by the right edge. The detailed graphic objects form one large cluster pressed against the LEFT EDGE, partially cropped by it. The CENTRAL HALF of the canvas must stay COMPLETELY EMPTY — no objects, characters, symbols or text there, only the smooth continuous background with a soft ambient glow; that central area is reserved for a large headline and a CTA button added later. Small blurred ambience particles may float near the top and bottom edges only.",
    push:
      "Layout (push banner): place the character in the CENTER holding a glowing focal medallion, large — nearly the full canvas height. Scatter slot symbols, chips and cherries dynamically around the whole canvas out to its edges. There is NO protected empty area — the entire canvas may be filled with graphics.",
    popup:
      "Layout (pop-up): main character in the CENTER holding the central artifact, large. Accent emblems/symbols pressed into the left and right sides, scattered ambient objects around, all the way to the edges. Detailed graphics are allowed everywhere — no protected text zones.",
  };
  const layout =
    layouts[assetKey] ??
    "Layout: balanced advertising composition with the character as the focal point and the decorative objects arranged around it.";

  const campaign = opts.neuralPrompt.trim();
  return [
    "Compose a single polished advertising creative.",
    ...refs,
    layout,
    ...zoneDirectives(opts.zones),
    campaign ? `Campaign brief: ${campaign}.` : "",
    "FULL-BLEED: the background scene must cover the entire canvas edge to edge — absolutely no borders, frames, empty bands or transparent margins.",
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

// Bria's outpaint can leave a feathered/semi-transparent seam along the outer
// canvas edges (видимая «прозрачная рамка» на живом прогоне). The fix: expand
// onto a canvas BLEED px larger on every side, then center-crop back to the
// exact target at upload time — the artifact ring is cut away deterministically.
export const EXPAND_BLEED = 32;

/** Placement for the bleed-expanded canvas (target + BLEED on each side). */
export function computeBleedPlacement(
  srcW: number,
  srcH: number,
  targetW: number,
  targetH: number,
  bleed = EXPAND_BLEED,
): { canvasW: number; canvasH: number; imgW: number; imgH: number; originX: number; originY: number } {
  const inner = computeCanvasPlacement(srcW, srcH, targetW, targetH);
  return {
    canvasW: targetW + 2 * bleed,
    canvasH: targetH + 2 * bleed,
    imgW: inner.imgW,
    imgH: inner.imgH,
    originX: inner.originX + bleed,
    originY: inner.originY + bleed,
  };
}

const EXPAND_PROMPT =
  "Seamlessly continue the existing background scene into the new margins, matching its colors, lighting and texture exactly. No borders, no frames, no empty or transparent areas.";

/** Two sizes have the same aspect ratio (within a pixel-rounding tolerance). */
function sameAspect(w1: number, h1: number, w2: number, h2: number): boolean {
  return Math.abs(w1 / h1 - w2 / h2) < 0.01;
}

/**
 * Fit a generated image to the exact mask canvas (D5) and store it:
 * - exact size → plain upload;
 * - same aspect → Cloudinary incoming resize (`c_fill`), no extra fal call;
 * - different aspect → bleed-expand via Bria, then signed incoming
 *   center-crop back to the target (cuts the outpaint edge artifacts).
 */
export async function fitAndStoreAsset(
  sourceUrl: string,
  targetW: number,
  targetH: number,
  fileName: string,
  folder: string,
  retryLabel: string,
): Promise<{ ok: true; url: string; publicId: string } | { ok: false; reason: string }> {
  const size = await probeImageSize(sourceUrl);
  if (!size) return { ok: false, reason: "probe: could not read the generated image size" };

  let uploadCall: () => ReturnType<typeof uploadFromUrl>;
  if (size.width === targetW && size.height === targetH) {
    uploadCall = () => uploadFromUrl(sourceUrl, fileName, folder);
  } else if (sameAspect(size.width, size.height, targetW, targetH)) {
    uploadCall = () =>
      uploadFromUrlTransformed(sourceUrl, fileName, folder, `c_fill,w_${targetW},h_${targetH}`);
  } else {
    const placement = computeBleedPlacement(size.width, size.height, targetW, targetH);
    const expanded = await runBriaExpand(sourceUrl, { ...placement, prompt: EXPAND_PROMPT });
    if (!expanded.success || !expanded.imageUrl) {
      return { ok: false, reason: `expand: ${expanded.error ?? "unknown"}` };
    }
    const expandedUrl = expanded.imageUrl;
    uploadCall = () =>
      uploadFromUrlTransformed(expandedUrl, fileName, folder, `c_crop,g_center,w_${targetW},h_${targetH}`);
  }

  const up = await withRetry(uploadCall, retryLabel);
  if (!up.success || !up.secure_url) return { ok: false, reason: `upload: ${up.error ?? "unknown"}` };

  // D5 guarantee: the STORED asset is exactly the canonical canvas.
  const finalSize = await probeImageSize(up.secure_url);
  if (finalSize && (finalSize.width !== targetW || finalSize.height !== targetH)) {
    return {
      ok: false,
      reason: `size mismatch: got ${finalSize.width}×${finalSize.height}, want ${targetW}×${targetH}`,
    };
  }
  return { ok: true, url: up.secure_url, publicId: up.public_id ?? "" };
}

// ------------------------------------------------------------------
// Layered compose (D10 v2 — email): zone boxes → Cloudinary layers.
// ------------------------------------------------------------------

/** Inset the layer fit-boxes from the zone edges so cutouts don't touch lines. */
export const LAYER_PAD = 8;

// Default email sections per the customer's mask scheme (D13a) — used when a
// layered asset has no zones configured.
const DEFAULT_LAYER_ZONES: AssetZones = {
  item: { x: 0, y: 0, w: 0.25, h: 1 },
  person: { x: 0.75, y: 0, w: 0.25, h: 1 },
};

/**
 * Compute the Cloudinary layer placements from the fractional zones. The item
 * sits vertically centered against the LEFT edge of its section; the person is
 * anchored bottom-right (like the reference banner). Pure — unit-tested.
 */
export function computeLayerPlacements(
  zones: AssetZones | undefined,
  canvasW: number,
  canvasH: number,
): { person: Omit<ComposeLayer, "publicId">; item: Omit<ComposeLayer, "publicId"> } {
  const z = { ...DEFAULT_LAYER_ZONES, ...(zones ?? {}) };
  const itemZone = z.item!;
  const personZone = z.person!;

  const box = (zone: ZoneBox) => ({
    w: Math.max(1, Math.round(zone.w * canvasW) - 2 * LAYER_PAD),
    h: Math.max(1, Math.round(zone.h * canvasH) - 2 * LAYER_PAD),
  });

  const itemBox = box(itemZone);
  const personBox = box(personZone);
  return {
    // g_west + x = left margin of the item section (+pad).
    item: {
      ...itemBox,
      gravity: "west",
      x: Math.round(itemZone.x * canvasW) + LAYER_PAD,
      y: 0,
    },
    // g_south_east + x = right margin of the person section (+pad): the
    // character stands on the bottom edge, pressed to the right.
    person: {
      ...personBox,
      gravity: "south_east",
      x: Math.round((1 - (personZone.x + personZone.w)) * canvasW) + LAYER_PAD,
      y: 0,
    },
  };
}

/**
 * Background-layer prompt. Эталон (example email.webp): фона «как такового
 * нет» — very light, almost-white neutral studio wall, no scene. Objects and
 * the character live on separate layers, so the backdrop must stay invisible.
 */
export function backgroundPrompt(neuralPrompt: string): string {
  const campaign = neuralPrompt.trim();
  return [
    "An almost empty advertising backdrop like a bright studio wall: very light neutral gray, smooth and flat, with only an extremely subtle soft gradient and at most a few tiny out-of-focus floating particles.",
    campaign ? `Only a faint hint of this campaign's mood is allowed in the soft accent lighting: ${campaign}.` : "",
    "The backdrop must look nearly blank — NO scene, NO fabric, NO texture, NO dark or saturated colors, and STRICTLY NO objects, NO characters, NO symbols, NO text, NO logos.",
    "FULL-BLEED: cover the entire canvas edge to edge, no borders or frames.",
  ]
    .filter(Boolean)
    .join(" ");
}

// ------------------------------------------------------------------
// Stage A — prepare-variant
// ------------------------------------------------------------------

export async function processPrepareVariantJob(bundleId: string, variantId: string): Promise<void> {
  const variant = await prisma.bundleBrandVariant.findUnique({
    where: { id: variantId },
    include: {
      bundle: {
        select: { id: true, neuralPrompt: true, bundleType: { select: { assets: true } } },
      },
    },
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

  // 1) Shared PERSON (D11) — the existing person pipeline + the layer contract
  //    (Phase 2): full body, feet visible, even contrasty background.
  const personUserText = `${neuralPrompt}\n${PERSON_LAYER_CONTRACT}`.trim();
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

  // 2) Shared ITEM anchor (D12) + the layer contract (Phase 2).
  const itemPrompt = `${await buildBundleItemPrompt(variant.brandName, neuralPrompt)} ${ITEM_LAYER_CONTRACT}`;
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

  // 3) Normalized transparent layers (Phase 2, replaces the e_trim cutouts):
  //    download → BR fallback when the source has no alpha → sharp alpha
  //    cleanup + bbox-trim → deterministic Cloudinary asset cached by source
  //    hash. personCutoutId/itemCutoutId keep pointing at the (now normalized)
  //    cutouts so the current renderer works unchanged; the hashes let the
  //    Phase 3 engine resolve exact bbox dimensions from NormalizedLayer.
  const typeAssets = variant.bundle.bundleType.assets as unknown as BundleTypeAsset[];
  let personCutoutId: string | null = null;
  let itemCutoutId: string | null = null;
  let personLayerHash: string | null = null;
  let itemLayerHash: string | null = null;
  let personUrl = personUp.secure_url;
  if (typeAssets.some((a) => a.composeMode === "layered")) {
    // Person layer with a sanity gate + bounded auto-retry (Phase 4, TASK
    // «перегенерация проблемного слоя»): a broken cutout is regenerated HERE,
    // before any asset render — all of the variant's assets stay consistent.
    let personLayer = await getOrCreateNormalizedLayer(personUrl, `person#${variantId}`);
    let sanity = personLayer.ok
      ? personLayerSanity(personLayer.width, personLayer.height)
      : { ok: false, reason: personLayer.reason };
    for (let retry = 1; retry <= PERSON_LAYER_RETRIES && !sanity.ok; retry++) {
      console.warn(`♻️ person layer retry ${retry}/${PERSON_LAYER_RETRIES} for ${variantId}: ${sanity.reason}`);
      const rerun = await runPersonFal(personPrompt, refs, "3:4", brand?.imageModel ?? null);
      if (!rerun.success || !rerun.imageUrl) {
        await failVariant(`person retry: ${rerun.error ?? "unknown"}`);
        return;
      }
      const reup = await withRetry(
        () =>
          uploadFromUrl(rerun.imageUrl!, `${variant.brandName}_person_${Date.now()}`, `bundles/${bundleId}`),
        `bundle-person-retry#${variantId}`,
      );
      if (!reup.success || !reup.secure_url) {
        await failVariant(`person retry upload: ${reup.error ?? "unknown"}`);
        return;
      }
      personUrl = reup.secure_url;
      personLayer = await getOrCreateNormalizedLayer(personUrl, `person#${variantId}`);
      sanity = personLayer.ok
        ? personLayerSanity(personLayer.width, personLayer.height)
        : { ok: false, reason: personLayer.reason };
    }
    if (!personLayer.ok || !sanity.ok) {
      await failVariant(
        `person layer: ${sanity.reason} (после ${1 + PERSON_LAYER_RETRIES} попыток)`,
      );
      return;
    }
    personCutoutId = personLayer.publicId;
    personLayerHash = personLayer.hash;

    const itemLayer = await getOrCreateNormalizedLayer(itemUp.secure_url, `item#${variantId}`);
    if (!itemLayer.ok) {
      await failVariant(`item cutout: ${itemLayer.reason}`);
      return;
    }
    itemCutoutId = itemLayer.publicId;
    itemLayerHash = itemLayer.hash;
  }

  await prisma.bundleBrandVariant.update({
    where: { id: variantId },
    data: {
      // personUrl may point at a sanity-retry regeneration — every asset of
      // the variant (email layers AND ai-mode push/popup) uses the same one.
      personImageUrl: personUrl,
      itemImageUrl: itemUp.secure_url,
      personCutoutId,
      itemCutoutId,
      personLayerHash,
      itemLayerHash,
    },
  });

  // 4) Stage B fan-out: render every asset that is still in the pipeline.
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
// Engine render (Phase 3): spec + normalized layers → deterministic composite.
// ------------------------------------------------------------------

type EngineRenderResult =
  | { ok: true; imageUrl: string; metadata: Prisma.InputJsonValue }
  // metadata on failure = the validator report for the CRM «почему не прошло».
  | { ok: false; reason: string; metadata?: Prisma.InputJsonValue };

/**
 * Render a layered asset with the composition engine: static background
 * (DI-Q6, обязателен), normalized layers resolved by hash, admin decor
 * cutouts, seeded decor layout, @1x/@2x uploads with DETERMINISTIC public ids
 * (re-render overwrites — no duplicates), metadata for the email template.
 */
async function renderLayeredWithEngine(opts: {
  bundleId: string;
  assetId: string;
  assetKey: string;
  variantId: string;
  personLayerHash: string;
  itemLayerHash: string | null;
  config: BundleTypeAsset;
  specRow: LayoutSpecRow;
}): Promise<EngineRenderResult> {
  const { specRow, config } = opts;
  const spec = specRow.spec;

  if (config.width !== spec.canvas.w || config.height !== spec.canvas.h) {
    return {
      ok: false,
      reason: `canvas mismatch: asset config ${config.width}×${config.height} vs spec ${spec.canvas.w}×${spec.canvas.h}`,
    };
  }
  // DI-Q6: the background is a static admin asset — never generated.
  if (!config.templateUrl) {
    return {
      ok: false,
      reason: `background: static template for "${opts.assetKey}" is not uploaded (Админка → Image Bundles — шаблоны типов)`,
    };
  }
  const bg = await fetchBuffer(config.templateUrl);
  if (!bg) return { ok: false, reason: "background: download failed" };

  const loadLayer = async (hash: string, label: string): Promise<EngineLayer | { error: string }> => {
    const row = await prisma.normalizedLayer.findUnique({ where: { sourceHash: hash } });
    if (!row) return { error: `${label}: normalized layer missing — regenerate the bundle` };
    const buf = await fetchBuffer(row.url);
    if (!buf) return { error: `${label}: layer download failed` };
    return { data: buf, width: row.width, height: row.height };
  };

  const person = await loadLayer(opts.personLayerHash, "person");
  if ("error" in person) return { ok: false, reason: person.error };
  let item: EngineLayer | undefined;
  if (opts.itemLayerHash) {
    const loaded = await loadLayer(opts.itemLayerHash, "item");
    if ("error" in loaded) return { ok: false, reason: loaded.error };
    item = loaded;
  }

  // Static decor cutouts — normalized + cached exactly like subject layers.
  const decor: EngineLayer[] = [];
  for (const [i, url] of (config.decorUrls ?? []).entries()) {
    const norm = await getOrCreateNormalizedLayer(url, `decor${i}#${opts.assetKey}`);
    if (!norm.ok) return { ok: false, reason: `decor[${i}]: ${norm.reason}` };
    const buf = await fetchBuffer(norm.url);
    if (!buf) return { ok: false, reason: `decor[${i}]: download failed` };
    decor.push({ data: buf, width: norm.width, height: norm.height });
  }

  // Optional golden reference for the structural check (assets come in Phase 6).
  let golden: Buffer | null = null;
  if (config.goldenUrl) {
    golden = await fetchBuffer(config.goldenUrl);
    if (!golden) console.warn(`⚠️ golden download failed for ${opts.assetKey} — SSIM check skipped`);
  }

  // Same inputs → same seed → byte-identical composite. On a safe-zone
  // violation caused by DECOR layout, re-seed and re-compose (переподбор
  // раскладки, TASK Фаза 4); subject/background failures are deterministic —
  // retrying the compose cannot change them, so we fail fast with the report.
  const baseSeed = `${opts.assetId}:v${specRow.version}:${opts.personLayerHash}:${opts.itemLayerHash ?? ""}`;
  const MAX_COMPOSE_ATTEMPTS = 3; // 1 + 2 пересева декора (лимит DI-Q13)
  let composed: Awaited<ReturnType<typeof composeAsset>> | null = null;
  let report: Awaited<ReturnType<typeof validateComposedAsset>> | null = null;
  let attempts = 0;
  for (let attempt = 0; attempt < MAX_COMPOSE_ATTEMPTS; attempt++) {
    const seed = attempt === 0 ? baseSeed : `${baseSeed}:r${attempt}`;
    const c = await composeAsset(
      spec,
      specRow.key,
      specRow.version,
      { background: bg, person, ...(item ? { item } : {}), decor },
      seed,
    );
    if (!c.ok) return c;
    const r = await validateComposedAsset(spec, {
      scales: c.scales,
      metadata: c.metadata,
      overlayMask: c.overlayMask,
      ...(golden ? { golden } : {}),
    });
    composed = c;
    report = r;
    attempts = attempt + 1;
    if (r.passed) break;
    const decorLayoutOnly =
      decor.length > 0 &&
      r.failedKeys.every((k) => k === "safe-core-clean" || k === "safe-coverage");
    if (!decorLayoutOnly) break;
    console.warn(`♻️ compose re-seed ${attempt + 1} for ${opts.assetKey}#${opts.assetId}: ${r.failedKeys.join(", ")}`);
  }
  if (!composed?.ok || !report) return { ok: false, reason: "compose: no attempt completed" };

  const validatorMeta = { passed: report.passed, attempts, checks: report.checks };
  if (!report.passed) {
    const details = report.checks
      .filter((c) => !c.passed)
      .map((c) => `${c.key}: ${c.detail}`)
      .join("; ");
    return {
      ok: false,
      reason: `validation failed — ${details}`,
      metadata: {
        ...composed.metadata,
        validator: validatorMeta,
      } as unknown as Prisma.InputJsonValue,
    };
  }

  const baseId = `${opts.variantId}_${opts.assetKey}_v${specRow.version}`;
  const folder = `bundles/${opts.bundleId}`;
  let imageUrl = "";
  let retinaUrl: string | null = null;
  for (const s of composed.scales) {
    const publicId = s.scale === 1 ? baseId : `${baseId}_${s.scale}x`;
    const up = await withRetry(
      () => uploadBuffer(s.png, publicId, folder),
      `engine#${opts.assetId}@${s.scale}x`,
    );
    if (!up.success || !up.secure_url) {
      return { ok: false, reason: `upload@${s.scale}x: ${up.error ?? "unknown"}` };
    }
    if (s.scale === 1) imageUrl = up.secure_url;
    else retinaUrl = up.secure_url;
  }
  if (!imageUrl) return { ok: false, reason: "upload: no base-scale output" };

  const m = composed.metadata;
  console.log(
    `🎬 engine ${opts.assetKey}#${opts.assetId}: spec=${specRow.key}@v${specRow.version} ` +
      `person=${JSON.stringify(m.layers.person)} item=${JSON.stringify(m.layers.item)} ` +
      `decor=${m.layers.decorPlaced}/${decor.length} lum=${m.luminance} text=${m.recommendedTextColor} ` +
      `validator=passed@${attempts}`,
  );
  return {
    ok: true,
    imageUrl,
    metadata: { ...m, retinaUrl, validator: validatorMeta } as unknown as Prisma.InputJsonValue,
  };
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

  // Layered mode (D10 v2): the zones are enforced by pixels, not the prompt.
  if (config?.composeMode === "layered") {
    if (!variant.personCutoutId) {
      await fail("missing person cutout — regenerate the bundle");
      return;
    }

    // Engine path (Phase 3): versioned spec + Phase 2 layer hashes → sharp
    // composite with metadata. Bundles rendered before Phase 2 have no layer
    // hashes and fall through to the legacy Cloudinary compose below.
    const specKey =
      config.layoutSpecKey ?? (asset.assetKey === "email" ? EMAIL_HERO_KEY : null);
    if (specKey && variant.personLayerHash) {
      let specRow: LayoutSpecRow | null = null;
      try {
        specRow = await getActiveLayoutSpec(specKey);
      } catch (err) {
        await fail(
          `layout spec "${specKey}" is corrupted: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      if (specRow) {
        const done = await renderLayeredWithEngine({
          bundleId,
          assetId,
          assetKey: asset.assetKey,
          variantId,
          personLayerHash: variant.personLayerHash,
          itemLayerHash: variant.itemLayerHash,
          config,
          specRow,
        });
        if (!done.ok) {
          // Keep the validator report on the FAILED asset — the CRM shows WHY.
          await prisma.bundleAsset.update({
            where: { id: assetId },
            data: {
              status: "FAILED",
              errorMessage: done.reason,
              ...(done.metadata !== undefined ? { metadata: done.metadata } : {}),
            },
          });
          await recomputeBundleStatus(bundleId);
          return;
        }
        await prisma.bundleAsset.update({
          where: { id: assetId },
          data: {
            status: "DONE",
            imageUrl: done.imageUrl,
            metadata: done.metadata,
            errorMessage: null,
          },
        });
        await recomputeBundleStatus(bundleId);
        return;
      }
    }

    // Background layer: the admin template when set, else a generated
    // ambience-only backdrop — in both cases stored at the exact canvas.
    let bgPublicId: string;
    if (config.templateUrl) {
      const bgUp = await withRetry(
        () =>
          uploadFromUrlTransformed(
            config.templateUrl!,
            `bg_${assetId}_${Date.now()}`,
            `bundles/${bundleId}`,
            `c_fill,w_${targetW},h_${targetH}`,
          ),
        `bundle-bg#${assetId}`,
      );
      if (!bgUp.success || !bgUp.public_id) {
        await fail(`background template: ${bgUp.error ?? "upload failed"}`);
        return;
      }
      bgPublicId = bgUp.public_id;
    } else {
      const bgGen = await runPersonFal(
        backgroundPrompt(variant.bundle.neuralPrompt),
        [],
        nearestFalAspect(targetW, targetH),
        null,
      );
      if (!bgGen.success || !bgGen.imageUrl) {
        await fail(`background: ${bgGen.error ?? "unknown"}`);
        return;
      }
      const bgFit = await fitAndStoreAsset(
        bgGen.imageUrl,
        targetW,
        targetH,
        `bg_${assetId}_${Date.now()}`,
        `bundles/${bundleId}`,
        `bundle-bg#${assetId}`,
      );
      if (!bgFit.ok) {
        await fail(`background ${bgFit.reason}`);
        return;
      }
      if (!bgFit.publicId) {
        await fail("background: missing public id");
        return;
      }
      bgPublicId = bgFit.publicId;
    }

    // Compose the layers into their zone boxes and store the flattened result.
    const placements = computeLayerPlacements(config.zones, targetW, targetH);
    const layers: ComposeLayer[] = [];
    if (variant.itemCutoutId) layers.push({ publicId: variant.itemCutoutId, ...placements.item });
    layers.push({ publicId: variant.personCutoutId, ...placements.person });
    const composedUrl = composeLayersUrl(bgPublicId, layers);

    const finalUp = await withRetry(
      () =>
        uploadFromUrl(
          composedUrl,
          `${variant.brandName}_${asset.assetKey}_${Date.now()}`,
          `bundles/${bundleId}`,
        ),
      `bundle-asset#${assetId}`,
    );
    if (!finalUp.success || !finalUp.secure_url) {
      await fail(`compose upload: ${finalUp.error ?? "unknown"}`);
      return;
    }
    const finalSize = await probeImageSize(finalUp.secure_url);
    if (finalSize && (finalSize.width !== targetW || finalSize.height !== targetH)) {
      await fail(`size mismatch: got ${finalSize.width}×${finalSize.height}, want ${targetW}×${targetH}`);
      return;
    }

    await prisma.bundleAsset.update({
      where: { id: assetId },
      data: { status: "DONE", imageUrl: finalUp.secure_url, errorMessage: null },
    });
    await recomputeBundleStatus(bundleId);
    return;
  }

  // Compose: [template?, person, item?] + mask-layout directive (D10/D13).
  const imageUrls = [config?.templateUrl, variant.personImageUrl, variant.itemImageUrl].filter(
    (u): u is string => typeof u === "string" && u.length > 0,
  );
  const prompt = compositionPrompt(asset.assetKey, {
    hasTemplate: Boolean(config?.templateUrl),
    hasItem: Boolean(variant.itemImageUrl),
    neuralPrompt: variant.bundle.neuralPrompt,
    ...(config?.zones ? { zones: config.zones } : {}),
  });

  const gen = await runPersonFal(prompt, imageUrls, nearestFalAspect(targetW, targetH), null);
  if (!gen.success || !gen.imageUrl) {
    await fail(`compose: ${gen.error ?? "unknown"}`);
    return;
  }

  const fitted = await fitAndStoreAsset(
    gen.imageUrl,
    targetW,
    targetH,
    `${variant.brandName}_${asset.assetKey}_${Date.now()}`,
    `bundles/${bundleId}`,
    `bundle-asset#${assetId}`,
  );
  if (!fitted.ok) {
    await fail(fitted.reason);
    return;
  }

  await prisma.bundleAsset.update({
    where: { id: assetId },
    data: { status: "DONE", imageUrl: fitted.url, errorMessage: null },
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
    "Do not add text, letters, logos or watermarks. Keep the protected empty areas empty. " +
    "Full-bleed: the background must cover the entire canvas edge to edge, no borders or frames.";
  const run = await runPersonFal(prompt, [sourceUrl], nearestFalAspect(asset.width, asset.height), null);
  if (!run.success || !run.imageUrl) {
    await fail(`edit: ${run.error ?? "unknown"}`);
    return;
  }

  const fitted = await fitAndStoreAsset(
    run.imageUrl,
    asset.width,
    asset.height,
    `${asset.variant.brandName}_${asset.assetKey}_edit_${Date.now()}`,
    `bundles/${bundleId}`,
    `bundle-edit#${assetId}`,
  );
  if (!fitted.ok) {
    await fail(`edit ${fitted.reason}`);
    return;
  }

  await prisma.bundleAsset.update({
    where: { id: assetId },
    data: { status: "DONE", imageUrl: fitted.url, errorMessage: null },
  });
  await recomputeBundleStatus(bundleId);
}
