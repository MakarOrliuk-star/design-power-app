/**
 * Пере-применение эффектов к уже сгенерированным ai_reference-ассетам
 * (TASK glow-fade-density, R-PLAN §3.6, допущение A-D3).
 *
 * Зачем отдельный скрипт: свечение и фейд — чистая функция от вырезанного PNG,
 * поэтому старые бандлы не надо перегенерировать. Берём сохранённый чистый
 * вырез (`metadata.effects.sourceUrl`, а у ассетов, сделанных до задания, —
 * детерминированный public id `_transparent`), накладываем текущий конфиг и
 * перезаливаем `_final`. Ни одной платной генерации: единственный внешний
 * вызов — выбор цвета свечения у якорных ассетов, и он кэшируется в metadata.
 *
 * Запуск (из backend):
 *   npx tsx scripts/reapply-effects.ts --dry-run
 *   npx tsx scripts/reapply-effects.ts
 *   npx tsx scripts/reapply-effects.ts --bundle=<bundleId>
 *
 * Идемпотентен: повторный прогон даёт тот же результат, потому что источником
 * всегда служит чистый вырез, а не текущая картинка ассета.
 */
import "../src/env.js";
import { prisma } from "../src/lib/prisma.js";
import {
  applyEffectsToAsset,
  AI_REF_SAFE_ZONE,
  AI_REF_SUFFIX_FINAL,
} from "../src/services/aiReferencePipeline.js";
import { resolveEffectsConfig } from "../src/lib/promoEffects.js";
import type { EffectsToggle } from "../src/lib/promoEffects.js";
import {
  resolveStyleAnchorKey,
  type BundleTypeAsset,
} from "../src/services/bundle.service.js";
import { pickGenerationRefs } from "../src/services/variationRefs.js";
import { stripGenderName } from "../src/services/bundle.service.js";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const BUNDLE_ID = args.find((a) => a.startsWith("--bundle="))?.slice("--bundle=".length) ?? null;

interface AssetMeta {
  specKey?: unknown;
  effects?: { sourceUrl?: unknown; glowHex?: unknown };
  qa?: { baseUrl?: unknown };
}

async function main(): Promise<void> {
  const assets = await prisma.bundleAsset.findMany({
    where: {
      status: "DONE",
      ...(BUNDLE_ID ? { variant: { bundleId: BUNDLE_ID } } : {}),
    },
    select: {
      id: true,
      assetKey: true,
      variantId: true,
      imageUrl: true,
      metadata: true,
      variant: {
        select: {
          brandName: true,
          bundleId: true,
          bundle: {
            select: { presetId: true, bundleType: { select: { assets: true } } },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  let touched = 0;
  let skipped = 0;
  for (const asset of assets) {
    const meta = (asset.metadata ?? {}) as AssetMeta;
    if (meta.specKey !== "ai_reference") continue;

    const typeAssets = asset.variant.bundle.bundleType.assets as unknown as BundleTypeAsset[];
    const config = typeAssets.find((a) => a.key === asset.assetKey);
    const isAnchor = resolveStyleAnchorKey(typeAssets) === asset.assetKey;
    const effectsConfig = resolveEffectsConfig((config?.effects ?? null) as EffectsToggle | null);
    const folder = `bundles/${asset.variant.bundleId}`;

    // Источник — чистый вырез. Поле `effects.sourceUrl` есть только у ассетов,
    // прошедших через новый пайплайн; у сделанных ДО задания эффектов не было
    // вовсе, поэтому их `imageUrl` и есть чистый вырез. Так источник берётся
    // из данных, а не собирается из предположений о public id.
    const sourceUrl =
      typeof meta.effects?.sourceUrl === "string" && meta.effects.sourceUrl
        ? meta.effects.sourceUrl
        : asset.imageUrl;
    if (!sourceUrl) {
      console.warn(`⚠ ${asset.assetKey}#${asset.id}: нет исходной картинки — пропущен`);
      skipped++;
      continue;
    }
    const colorSourceUrl =
      typeof meta.qa?.baseUrl === "string" && meta.qa.baseUrl ? meta.qa.baseUrl : sourceUrl;

    if (DRY_RUN) {
      const state = effectsConfig.glow || effectsConfig.fade ? "применить" : "снять";
      console.log(
        `· ${asset.assetKey}#${asset.id} (${asset.variant.brandName}) — ${state}; источник ${sourceUrl}`,
      );
      touched++;
      continue;
    }

    // Референсы нужны только арт-директору при выборе цвета; у зависимых
    // форматов цвет наследуется, у ассетов с уже выбранным цветом — берётся
    // из metadata, поэтому пустой список здесь безопасен.
    let refUrls: string[] = [];
    const presetId = asset.variant.bundle.presetId;
    const needsColor = Boolean(effectsConfig.glow) && typeof meta.effects?.glowHex !== "string";
    if (needsColor && isAnchor && presetId) {
      try {
        const refs = await pickGenerationRefs(
          presetId,
          asset.variant.brandName,
          asset.assetKey,
          stripGenderName(asset.variant.brandName),
        );
        refUrls = refs.refs.map((r) => r.imageUrl);
      } catch {
        // Референсы пропали — арт-директор обойдётся одной композицией.
      }
    }

    const inherited = typeof meta.effects?.glowHex === "string" ? meta.effects.glowHex : null;
    const result = await applyEffectsToAsset({
      transparentUrl: sourceUrl,
      colorSourceUrl,
      refUrls,
      config: effectsConfig,
      inheritedGlowHex: inherited,
      publicId: `${asset.variantId}_${asset.assetKey}${AI_REF_SUFFIX_FINAL}`,
      folder,
      logTag: `reapply#${asset.id}`,
      safeZone: isAnchor ? AI_REF_SAFE_ZONE : null,
    });

    if (result.meta.error) {
      console.warn(`⚠ ${asset.assetKey}#${asset.id}: ${result.meta.error} — пропущен`);
      skipped++;
      continue;
    }

    await prisma.bundleAsset.update({
      where: { id: asset.id },
      data: {
        imageUrl: result.imageUrl,
        metadata: {
          ...(asset.metadata as object),
          ...(result.textColor ? { recommendedTextColor: result.textColor } : {}),
          effects: result.meta,
        } as never,
      },
    });
    touched++;
    console.log(
      `✓ ${asset.assetKey}#${asset.id} (${asset.variant.brandName}) — ` +
        (result.meta.applied ? `glow=${result.meta.glowHex}` : "эффекты сняты"),
    );
  }

  console.log(
    `\n${DRY_RUN ? "DRY RUN: " : ""}обработано ${touched}, пропущено ${skipped}` +
      (BUNDLE_ID ? ` (бандл ${BUNDLE_ID})` : ""),
  );
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
