import { prisma } from "../lib/prisma.js";
import { runPersonFal } from "../lib/fal.js";
import { fitAndStoreAsset } from "../lib/assetFit.js";
import {
  processAiReferenceAsset,
  parentOfDerivedKey,
  loadAnchorContext,
} from "../services/aiReferencePipeline.js";
import { getOrCreateNormalizedLayer, fetchBuffer } from "../services/layerCache.js";
import { getActiveLayoutSpec, SPEC_KEY_BY_ASSET } from "../services/layoutSpec.js";
import type { LayoutSpecRow } from "../services/layoutSpec.js";
import { composeAsset, dominantColor, rgbToHex } from "../lib/composeEngine.js";
import { deriveTokens } from "../lib/typography3d.js";
import { clampStyleProfile, requestStyleProfile } from "../lib/styleProfile.js";
import type { StyleProfile } from "../lib/styleProfile.js";
import { splitLayerPieces } from "../lib/layerSplit.js";
import { parseDecorEntries, decorEntryUrls } from "../lib/decorLibrary.js";
import { renderSceneAsset } from "../services/scenePipeline.js";
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
import {
  recomputeBundleStatus,
  resolveStyleAnchorKey,
  dependentAiReferenceAssets,
} from "../services/bundle.service.js";
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
  // Взгляд в камеру — требование TASK Фазы 2 и приём эталонов 1–5: персонаж
  // «продаёт» зрителю, а не смотрит в сторону из кадра.
  "eyes looking straight at the camera (direct eye contact with the viewer), " +
  "with clear margins between the character and every frame edge, on a plain even light-gray " +
  "studio background with strong contrast to the character. No text, no logos, no other objects.";
/** Bounded auto-retry for a broken person layer (Phase 4, лимит DI-Q13). */
export const PERSON_LAYER_RETRIES = 1;

/** The compositor CUTS this layer into its separate objects (layerSplit) and
 *  places them individually — the hero object stands in the item zone (email),
 *  the rest scatter around the character (эталоны push/pop-up). So the objects
 *  must not touch each other, and the hero one must be portrait-shaped: the
 *  item zone is the left quarter of a 2:1 canvas, taller than it is wide. */
export const ITEM_LAYER_CONTRACT =
  "Render 4 to 6 SEPARATE objects, each fully detached from the others with wide empty gaps " +
  "between them — they must never touch, overlap or be connected by shadows. One main object " +
  "is noticeably larger than the rest and clearly taller than it is wide (portrait, about 2:3); " +
  "the others are small props of varied shapes. Spread them apart across the frame, all fully " +
  "inside it with clear margins, nothing cropped by the edges, on a plain even light-gray " +
  "studio background with strong contrast to the objects. No text, no logos, no characters.";

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

// Fit-хелперы вынесены в lib/assetFit.ts (TASK ai-reference): пайплайн
// ai_reference в services/ использует их без циклического импорта процессора.
// Ре-экспорт сохраняет прежние импорты (тесты, соседние модули).
export {
  computeCanvasPlacement,
  computeBleedPlacement,
  EXPAND_BLEED,
} from "../lib/assetFit.js";
export { fitAndStoreAsset };

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

/** `Brand.decorUrls` — строки И тегированные записи (`D-N9'`): автосохранение
 *  нарезки листа пишет `{url, concepts}`, и старый фильтр «только строки»
 *  молча выбрасывал бы их — библиотека казалась бы пустой. */
function brandDecorUrlsOf(raw: unknown): string[] {
  return decorEntryUrls(parseDecorEntries(raw));
}

/**
 * DV-E1 — получить style-profile варианта. Возвращает:
 *   - `undefined` — колонку не трогать (ручной override, прослойке нечего
 *     крутить при неактивной сцене, или модель недоступна — сохранённое
 *     значение остаётся);
 *   - `StyleProfile` — свежий профиль от модели, записать.
 *
 * Гейт «прослойке есть что крутить»: хотя бы у одного layered-ассета активная
 * спека содержит блок `scatter` (= ветка сцены). Пока v3 выключена, вызовы
 * модели не тратятся — включение v3 в админке автоматически включает и
 * прослойку для НОВЫХ бандлов.
 */
async function buildVariantStyleProfile(opts: {
  typeAssets: BundleTypeAsset[];
  existing: unknown;
  campaignPrompt: string;
  brandName: string;
  /** Библиотека декора БРЕНДА (DV-C2′): непустая перекрывает общую. */
  brandDecorUrls: string[];
  personLayer: { url: string; width: number; height: number } | null;
}): Promise<StyleProfile | undefined> {
  // Ограничение 4: ручной override из админки живёт, пока его не сняли руками.
  const existing = opts.existing as { source?: unknown } | null;
  if (existing && existing.source === "manual") return undefined;

  const slotUrls: string[] = [];
  let sceneActive = false;
  for (const config of opts.typeAssets) {
    if (config.composeMode !== "layered") continue;
    const specKey = config.layoutSpecKey ?? SPEC_KEY_BY_ASSET[config.key] ?? null;
    if (!specKey) continue;
    try {
      const specRow = await getActiveLayoutSpec(specKey);
      if (specRow?.spec.scatter) {
        sceneActive = true;
        for (const url of config.decorUrls ?? []) {
          if (!slotUrls.includes(url)) slotUrls.push(url);
        }
      }
    } catch {
      // Битая спека уронит рендер своим внятным сообщением (stage B);
      // прослойка тут ни при чём и не должна валить stage A.
    }
  }
  if (!sceneActive) return undefined;
  // DV-C2′: модель выбирает из той же библиотеки, из которой потом соберёт
  // кадр рендер, — у бренда своя, у остальных общая.
  const libraryUrls = opts.brandDecorUrls.length > 0 ? opts.brandDecorUrls : slotUrls;

  // Цвет, который движок увидел бы в auto-режиме, — чтобы модель предлагала
  // hue, гармонирующий с реально сгенерированными слоями, а не вслепую.
  let layerColorHex: string | null = null;
  if (opts.personLayer) {
    const buf = await fetchBuffer(opts.personLayer.url);
    if (buf) {
      try {
        layerColorHex = rgbToHex(
          await dominantColor([
            { data: buf, width: opts.personLayer.width, height: opts.personLayer.height },
          ]),
        );
      } catch {
        /* цвет — подсказка, не условие */
      }
    }
  }

  const profile = await requestStyleProfile({
    campaignPrompt: opts.campaignPrompt,
    brandName: opts.brandName,
    libraryUrls,
    layerColorHex,
  });
  if (!profile) return undefined; // фолбэк: сохранённое (или ничего) остаётся
  console.log(
    `🎨 style-profile ${opts.brandName}: glow=${profile.glowHex ?? "auto"} ` +
      `material=${profile.typoMaterial ?? "spec"} tokens=${(profile.tokens ?? []).join("|") || "—"} ` +
      `density=${profile.density ?? "seeded"} decor=${profile.decorUrls?.length ?? "all"}`,
  );
  return profile;
}

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

  // TASK ai-reference: если ВСЕ ассеты типа — ai_reference, персона/предмет/
  // style-profile не нужны вовсе (композиция собирается из референсов
  // вариации). Пропускаем stage A и сразу раздаём render-джобы. Смешанный тип
  // (ai_reference + layered) идёт обычным путём — слои нужны соседним ассетам.
  const allTypeAssets = variant.bundle.bundleType.assets as unknown as BundleTypeAsset[];
  if (allTypeAssets.length > 0 && allTypeAssets.every((a) => a.composeMode === "ai_reference")) {
    const pending = await prisma.bundleAsset.findMany({
      where: { variantId, status: { in: ["PENDING", "GENERATING"] } },
      select: { id: true, assetKey: true },
    });
    if (pending.length === 0) {
      await recomputeBundleStatus(bundleId);
      return;
    }
    await prisma.bundleAsset.updateMany({
      where: { id: { in: pending.map((a) => a.id) } },
      data: { status: "GENERATING" },
    });
    // TASK multiformat-promo (DI2-3): единый стиль кампании требует порядка —
    // сначала якорь (email), и только по его успеху процессор якоря ставит
    // push/pop-up (они получат его композицию стиль-эталоном). Если якорь уже
    // готов (перезапуск только зависимых) — ставим их сразу, контекст якоря
    // они прочитают из его метаданных.
    const anchorKey = resolveStyleAnchorKey(allTypeAssets);
    const anchorPending = pending.find((a) => a.assetKey === anchorKey);
    const toQueue = anchorPending ? [anchorPending] : pending;
    await getBundleQueue().addBulk(
      toQueue.map((a) => ({
        name: "render-asset" as const,
        data: { bundleId, variantId, assetId: a.id },
      })),
    );
    return;
  }

  const brand = await prisma.brand.findUnique({
    where: { name: variant.brandName },
    select: {
      imageModel: true,
      decorUrls: true,
      nanoRef: { select: { referenceImages: true } },
    },
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

  // DV-E1 — style-profile «казино-дизайнера»: ОДИН вызов модели на
  // brand-variant, результат сохраняется здесь и переживает любые повторные
  // рендеры ассетов (ограничение 2). Ручной override (`source: "manual"`)
  // не перетирается. Любой сбой → null: рендер идёт как без прослойки.
  const personLayerRow = personLayerHash
    ? await prisma.normalizedLayer.findUnique({ where: { sourceHash: personLayerHash } })
    : null;
  const styleProfile = await buildVariantStyleProfile({
    typeAssets,
    existing: variant.styleProfile,
    campaignPrompt: neuralPrompt,
    brandName: variant.brandName,
    brandDecorUrls: brandDecorUrlsOf(brand?.decorUrls),
    personLayer: personLayerRow
      ? { url: personLayerRow.url, width: personLayerRow.width, height: personLayerRow.height }
      : null,
  });

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
      ...(styleProfile !== undefined
        ? { styleProfile: styleProfile as unknown as Prisma.InputJsonValue }
        : {}),
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
  /** Бриф кампании — из него берутся токены надписей (DV-C4′, поправка
   *  заказчика: «не обязательно BIG WIN — всё зависит от промпта»). */
  campaignPrompt: string;
  /** Сырой style-profile с варианта (DV-E1) — клампится ЗДЕСЬ, при каждом
   *  рендере: библиотека декора могла измениться после сохранения профиля. */
  styleProfile: unknown;
  /** Библиотека декора БРЕНДА (DV-C2′): непустая перекрывает общую слота. */
  brandDecorUrls: string[];
  /** Для scene-пайплайна (Фаза 6): бренд и сырые Json-колонки библиотек. */
  brandName: string;
  brandId: string | null;
  brandDecorRaw: unknown;
}): Promise<EngineRenderResult> {
  const { specRow, config } = opts;
  const spec = specRow.spec;

  // Задание 3, Фаза 6: флаг в активной версии спеки уводит рендер в новый
  // пайплайн «промпт → композиция» (services/scenePipeline.ts). Старый путь
  // ниже не тронут — откат = активировать версию спеки без флага, без деплоя.
  if (spec.scenePipeline) {
    if (!opts.itemLayerHash) {
      return { ok: false, reason: "scene pipeline: item layer missing — regenerate the bundle" };
    }
    return renderSceneAsset({
      bundleId: opts.bundleId,
      variantId: opts.variantId,
      assetId: opts.assetId,
      assetKey: opts.assetKey,
      brandName: opts.brandName,
      brandId: opts.brandId,
      campaignPrompt: opts.campaignPrompt,
      personLayerHash: opts.personLayerHash,
      itemLayerHash: opts.itemLayerHash,
      canvas: { w: spec.canvas.w, h: spec.canvas.h },
      ...(spec.subjects.person.cropTopFraction !== undefined
        ? { personCropTopFraction: spec.subjects.person.cropTopFraction }
        : {}),
      brandDecorRaw: opts.brandDecorRaw,
      commonDecorRaw: config.decorUrls ?? [],
    });
  }

  // DV-C2′: у бренда своя библиотека — общая остаётся фолбэком для брендов
  // без своего набора.
  const libraryUrls =
    opts.brandDecorUrls.length > 0 ? opts.brandDecorUrls : (config.decorUrls ?? []);

  // Ограничение 3 DV-E1: сохранённый профиль зажимается в коридоры на входе
  // рендера. Мусор/устаревшие ссылки деградируют к дефолтам, а не роняют джобу.
  const profile = clampStyleProfile(opts.styleProfile, { libraryUrls });

  if (config.width !== spec.canvas.w || config.height !== spec.canvas.h) {
    return {
      ok: false,
      reason: `canvas mismatch: asset config ${config.width}×${config.height} vs spec ${spec.canvas.w}×${spec.canvas.h}`,
    };
  }
  // Background comes from the spec, never from a generation: "transparent"
  // ships an alpha PNG (фон кладёт письмо), "static" bakes in the admin asset.
  let bg: Buffer | undefined;
  if (spec.background.source === "static") {
    if (!config.templateUrl) {
      return {
        ok: false,
        // Name the spec: "no template" is a CONSEQUENCE of the active version
        // asking for a baked-in background. Switching that version to
        // `background.source: "transparent"` is the other way out.
        reason:
          `background: spec ${specRow.key}@v${specRow.version} requires a static background, ` +
          `but no template is uploaded for "${opts.assetKey}" — either upload one ` +
          `(Админка → Image Bundles — шаблоны типов) or activate a spec version with ` +
          `"background": {"source": "transparent"} (Админка → Композиция — layout-спеки)`,
      };
    }
    const loaded = await fetchBuffer(config.templateUrl);
    if (!loaded) return { ok: false, reason: "background: download failed" };
    bg = loaded;
  }

  const loadLayer = async (hash: string, label: string): Promise<EngineLayer | { error: string }> => {
    const row = await prisma.normalizedLayer.findUnique({ where: { sourceHash: hash } });
    if (!row) return { error: `${label}: normalized layer missing — regenerate the bundle` };
    const buf = await fetchBuffer(row.url);
    if (!buf) return { error: `${label}: layer download failed` };
    return { data: buf, width: row.width, height: row.height };
  };

  let person = await loadLayer(opts.personLayerHash, "person");
  if ("error" in person) return { ok: false, reason: person.error };

  // Контракт слоя требует «single character only», но генератор регулярно
  // добавляет рядом летающие монетки/фишки. Они раздувают bbox слоя В ШИРИНУ,
  // движок упирается в ширину зоны и роняет высоту персонажа (живой прогон:
  // 52% при коридоре 78–91%). Крупнейший связный компонент = персонаж;
  // побочные куски не выбрасываются, а уходят в реквизит сцены — в эталонах
  // монеты вокруг персонажа и есть декор.
  let personProps: EngineLayer[] = [];
  const personSplit = await splitLayerPieces(person.data, {});
  if (personSplit.length > 1) {
    const [main, ...extras] = personSplit;
    person = { data: main!.png, width: main!.width, height: main!.height };
    personProps = extras.map((p) => ({ data: p.png, width: p.width, height: p.height }));
    console.log(
      `✂️ person layer ${opts.assetKey}#${opts.assetId}: ${personSplit.length} компонент(а) — ` +
        `персонаж ${main!.width}×${main!.height}, ${personProps.length} шт. в реквизит`,
    );
  }

  // The ITEM generation returns several separate objects on one layer; the
  // эталоны place them as individual props. Cutting the layer into its
  // connected blobs gives the engine those props (largest first): with an item
  // subject in the spec it stands in its zone, the rest scatter.
  let itemPieces: EngineLayer[] = [];
  if (opts.itemLayerHash) {
    const loaded = await loadLayer(opts.itemLayerHash, "item");
    if ("error" in loaded) return { ok: false, reason: loaded.error };
    // +1: the hero piece may be spent on the item subject, the cap counts props.
    const maxPieces = spec.decor?.maxPieces;
    const cut = await splitLayerPieces(
      loaded.data,
      maxPieces === undefined ? {} : { maxPieces: maxPieces + 1 },
    );
    itemPieces = cut.map((p) => ({ data: p.png, width: p.width, height: p.height }));
    // A layer the splitter cannot read (single ragged blob, no alpha) still
    // renders — as the one item it always was.
    if (itemPieces.length === 0) itemPieces = [loaded];
    console.log(
      `✂️ item layer ${opts.assetKey}#${opts.assetId}: ${itemPieces.length} piece(s) ` +
        itemPieces.map((p) => `${p.width}×${p.height}`).join(", "),
    );
  }
  // Монетки, отрезанные от слоя персонажа, — в общий пул реквизита. В КОНЕЦ:
  // первый кусок пула — кандидат в субъект item, и им обязан остаться кусок
  // ITEM-слоя, а не случайная монета (потому же и только при непустом пуле).
  if (itemPieces.length > 0) itemPieces = [...itemPieces, ...personProps];

  // Static decor cutouts — normalized + cached exactly like subject layers.
  // DV-E1: профиль может СУЗИТЬ библиотеку до ассетов, уместных кампании
  // (кламп уже отбросил чужие URL; пустой выбор = вся библиотека).
  const decorSourceUrls = profile?.decorUrls ?? libraryUrls;
  const decor: EngineLayer[] = [];
  for (const [i, url] of decorSourceUrls.entries()) {
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

  // Canonical size only (D-E7): a spec that still lists retina scales renders
  // and stores just the smallest one, so no `_2x` twin appears in Cloudinary.
  const canonicalScale = Math.min(...spec.canvas.scales);
  if (spec.canvas.scales.length > 1) {
    console.log(
      `ℹ️ ${opts.assetKey}#${opts.assetId}: spec lists scales ${spec.canvas.scales.join(",")} — ` +
        `rendering @${canonicalScale}x only (retina copies disabled)`,
    );
  }
  const renderSpec = { ...spec, canvas: { ...spec.canvas, scales: [canonicalScale] as [number] } };
  let composed: Awaited<ReturnType<typeof composeAsset>> | null = null;
  let report: Awaited<ReturnType<typeof validateComposedAsset>> | null = null;
  let attempts = 0;
  for (let attempt = 0; attempt < MAX_COMPOSE_ATTEMPTS; attempt++) {
    const seed = attempt === 0 ? baseSeed : `${baseSeed}:r${attempt}`;
    const c = await composeAsset(
      renderSpec,
      specRow.key,
      specRow.version,
      {
        ...(bg ? { background: bg } : {}),
        person,
        itemPieces,
        decor,
        // DV-E1: токены профиля приоритетнее эвристики по КАПСУ — модель
        // подбирала их под оффер. Пусто → прежний deriveTokens.
        campaignTokens: profile?.tokens?.length
          ? profile.tokens
          : deriveTokens(opts.campaignPrompt),
        ...(profile ? { styleProfile: profile } : {}),
      },
      seed,
    );
    if (!c.ok) return c;
    const r = await validateComposedAsset(renderSpec, {
      scales: c.scales,
      metadata: c.metadata,
      overlayMask: c.overlayMask,
      ...(golden ? { golden } : {}),
    });
    composed = c;
    report = r;
    attempts = attempt + 1;
    if (r.passed) break;
    // Пересев помогает только тем провалам, которые зависят от РАСКЛАДКИ.
    // Масштаб субъекта или отсутствующая плашка от смены сида не изменятся —
    // на них повтор только сожжёт время воркера.
    const reseedable = new Set([
      "safe-core-clean",
      "safe-coverage",
      // Задание 2: покрытие и число объектов в полосе, bleed, кроп заднего
      // плана и чистота ядра — всё это результат сидированной раскладки.
      "decor-coverage",
      "decor-count",
      "core-coverage",
      "bleed",
      "back-crop-top",
    ]);
    const decorLayoutOnly =
      decor.length + itemPieces.length > 0 && r.failedKeys.every((k) => reseedable.has(k));
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

  // ONE stored file per asset — the canonical size (D-E7): retina copies are
  // not rendered and not uploaded. The deterministic public id keeps
  // re-renders overwriting instead of piling up.
  const baseId = `${opts.variantId}_${opts.assetKey}_v${specRow.version}`;
  const folder = `bundles/${opts.bundleId}`;
  const master = composed.scales.reduce((a, b) => (b.scale < a.scale ? b : a));
  const masterId = master.scale === 1 ? baseId : `${baseId}_${master.scale}x`;
  const up = await withRetry(
    () => uploadBuffer(master.png, masterId, folder),
    `engine#${opts.assetId}@${master.scale}x`,
  );
  if (!up.success || !up.secure_url) {
    return { ok: false, reason: `upload@${master.scale}x: ${up.error ?? "unknown"}` };
  }
  const imageUrl = up.secure_url;
  const retinaUrl = null;

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

/**
 * Постановка зависимых форматов после якоря (TASK multiformat-promo, DI2-3).
 *
 * Берём только ассеты, ждущие прогон (PENDING/GENERATING): уже готовые строки
 * каскад не трогает — их перегенерацию инициирует regenerateAsset, который
 * сам переводит зависимые в GENERATING перед постановкой якоря (DI2-9).
 * Якорь упал — зависимые не имеют смысла: единый стиль кампании недостижим.
 */
async function dispatchDependentAssets(opts: {
  bundleId: string;
  variantId: string;
  dependentKeys: string[];
  anchorOk: boolean;
  anchorKey: string;
}): Promise<void> {
  const { bundleId, variantId, dependentKeys, anchorOk, anchorKey } = opts;
  const rows = await prisma.bundleAsset.findMany({
    where: {
      variantId,
      assetKey: { in: dependentKeys },
      status: { in: ["PENDING", "GENERATING"] },
    },
    select: { id: true },
  });
  if (rows.length === 0) return;
  const ids = rows.map((r) => r.id);

  if (!anchorOk) {
    await prisma.bundleAsset.updateMany({
      where: { id: { in: ids } },
      data: {
        status: "FAILED",
        errorMessage: `ai_reference: якорный ассет "${anchorKey}" не сгенерирован — перегенерируйте его`,
      },
    });
    await recomputeBundleStatus(bundleId);
    return;
  }

  await prisma.bundleAsset.updateMany({
    where: { id: { in: ids } },
    data: { status: "GENERATING", errorMessage: null },
  });
  await getBundleQueue().addBulk(
    ids.map((assetId) => ({
      name: "render-asset" as const,
      data: { bundleId, variantId, assetId },
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
  const typeAssets = variant.bundle.bundleType.assets as unknown as BundleTypeAsset[];
  const config = typeAssets.find((a) => a.key === asset.assetKey);
  const targetW = config?.width ?? asset.width;
  const targetH = config?.height ?? asset.height;

  // TASK ai-reference: композиция из референсов вариации — свой пайплайн,
  // person/item не нужны (проверка personImageUrl ниже к нему не относится).
  if (config?.composeMode === "ai_reference") {
    const anchorKey = resolveStyleAnchorKey(typeAssets);
    const isAnchor = anchorKey === asset.assetKey;

    // Зависимый формат (DI2-3): стиль приходит из уже готового якоря. Якорь
    // не готов (упал/удалён) — единый стиль недостижим, ассет не гоняем.
    let anchor = null;
    if (!isAnchor) {
      anchor = anchorKey ? await loadAnchorContext(variantId, anchorKey) : null;
      if (!anchor) {
        await fail(
          `ai_reference: якорный ассет "${anchorKey ?? "?"}" не сгенерирован — перегенерируйте его`,
        );
        return;
      }
    }

    await prisma.bundleAsset.update({
      where: { id: assetId },
      data: { status: "GENERATING", errorMessage: null },
    });
    const result = await processAiReferenceAsset({
      bundleId,
      variantId,
      assetId,
      assetKey: asset.assetKey,
      brandName: variant.brandName,
      targetW,
      targetH,
      isAnchor,
      formatLabel: config.label,
      anchor,
      // TASK glow-fade-density: плотность предметов и галки эффектов —
      // данные типа бандла, правятся в /admin без деплоя (DI3-14/DI3-15).
      ...(config.maxProps !== undefined ? { maxProps: config.maxProps } : {}),
      ...(config.minProps !== undefined ? { minProps: config.minProps } : {}),
      ...(config.effects ? { effects: config.effects } : {}),
    });

    // Якорь готов → поехали зависимые форматы; якорь упал → они не имеют
    // смысла (единый стиль кампании невозможен), помечаем причиной.
    if (isAnchor) {
      const dependents = dependentAiReferenceAssets(typeAssets).map((a) => a.key);
      if (dependents.length > 0) {
        await dispatchDependentAssets({
          bundleId,
          variantId,
          dependentKeys: dependents,
          anchorOk: result.ok,
          anchorKey: asset.assetKey,
        });
      }
    }
    return;
  }

  // Legacy: производный ключ старой трёх-ассетной схемы ai_reference
  // ("email_notext"/"email_transparent") из бандлов до TASK safe-zone/auto-heal.
  // Regenerate на нём перегенерирует РОДИТЕЛЯ; новый пайплайн выдаёт один
  // ассет и сам удаляет производные строки.
  const parentKey = parentOfDerivedKey(asset.assetKey);
  const parentConfig = parentKey ? typeAssets.find((a) => a.key === parentKey) : undefined;
  if (parentKey && parentConfig?.composeMode === "ai_reference") {
    const parentAsset = await prisma.bundleAsset.findUnique({
      where: { variantId_assetKey: { variantId, assetKey: parentKey } },
      select: { id: true },
    });
    if (!parentAsset) {
      await fail(`родительский ассет "${parentKey}" не найден — перезапустите генерацию бандла`);
      return;
    }
    const parentAnchorKey = resolveStyleAnchorKey(typeAssets);
    const parentIsAnchor = parentAnchorKey === parentKey;
    const parentAnchor = parentIsAnchor
      ? null
      : parentAnchorKey
        ? await loadAnchorContext(variantId, parentAnchorKey)
        : null;
    await prisma.bundleAsset.update({
      where: { id: parentAsset.id },
      data: { status: "GENERATING", errorMessage: null },
    });
    const parentResult = await processAiReferenceAsset({
      bundleId,
      variantId,
      assetId: parentAsset.id,
      assetKey: parentKey,
      brandName: variant.brandName,
      targetW: parentConfig.width,
      targetH: parentConfig.height,
      isAnchor: parentIsAnchor,
      formatLabel: parentConfig.label,
      anchor: parentAnchor,
      ...(parentConfig.maxProps !== undefined ? { maxProps: parentConfig.maxProps } : {}),
      ...(parentConfig.minProps !== undefined ? { minProps: parentConfig.minProps } : {}),
      ...(parentConfig.effects ? { effects: parentConfig.effects } : {}),
    });
    if (parentIsAnchor) {
      const dependents = dependentAiReferenceAssets(typeAssets).map((a) => a.key);
      if (dependents.length > 0) {
        await dispatchDependentAssets({
          bundleId,
          variantId,
          dependentKeys: dependents,
          anchorOk: parentResult.ok,
          anchorKey: parentKey,
        });
      }
    }
    return;
  }

  if (!variant.personImageUrl) {
    await fail("missing person artifact — regenerate the bundle");
    return;
  }

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
    const specKey = config.layoutSpecKey ?? SPEC_KEY_BY_ASSET[asset.assetKey] ?? null;
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
        // DV-C2′: библиотека декора бренда (снимок по имени, как и остальные
        // brand-поля варианта). Бренд удалён/пуст → общая библиотека слота.
        const brandRow = await prisma.brand.findUnique({
          where: { name: variant.brandName },
          select: { id: true, decorUrls: true },
        });
        const done = await renderLayeredWithEngine({
          bundleId,
          assetId,
          assetKey: asset.assetKey,
          variantId,
          personLayerHash: variant.personLayerHash,
          itemLayerHash: variant.itemLayerHash,
          config,
          specRow,
          campaignPrompt: variant.bundle.neuralPrompt ?? "",
          styleProfile: variant.styleProfile,
          brandDecorUrls: brandDecorUrlsOf(brandRow?.decorUrls),
          brandName: variant.brandName,
          brandId: brandRow?.id ?? null,
          brandDecorRaw: brandRow?.decorUrls,
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
