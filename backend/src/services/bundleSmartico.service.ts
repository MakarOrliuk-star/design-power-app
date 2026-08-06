import { prisma } from "../lib/prisma.js";
import { cloudinaryConfigured } from "../env.js";
import { uploadSmarticoAsset } from "../lib/smartico/uploadAsset.js";
import { buildBrandMap, normalizeBrand } from "../lib/smartico/detect.js";
import type { NormalizedBrand, TypeKey } from "../lib/smartico/detect.js";
import { generateOutputs, generateSafeZoneOutputs } from "../lib/smartico/generate.js";
import type { OutputBlock, SafeZoneMeta, UrlMap } from "../lib/smartico/generate.js";
import { stripGenderName } from "./bundle.service.js";

/**
 * "Send to Smartico" for Image Bundles (TASK crm-bundle Phase 6, D6): the
 * Unique Smartico contract — APPROVED assets are re-uploaded to the
 * smartico/<namespace> Cloudinary folder via uploadSmarticoAsset (MD5 dedup,
 * deterministic public ids, idempotent re-send) and turned into paste-ready
 * JS functions (buildFunction on state.core_sm_brand_id, canonical names from
 * the SmarticoBrand table). There is no Smartico HTTP API in this product —
 * the manager pastes the emitted functions manually (same as Unique Smartico).
 *
 * Tone-of-voice mapping (D3 → Smartico, implementation decision D14): Smartico
 * keys images by brand_id and knows nothing about (Men)/(Women), so the
 * functions are grouped into tone BUCKETS — a "Men" set and a "Women" set of
 * per-type functions (the manager pastes each set into the matching audience
 * segment). Ungendered brands (e.g. Corgi) are included in every bucket. When
 * the bundle has no gendered variants at all, a single unlabeled set is emitted.
 */

// Bundle asset keys → Smartico TypeKeys (Unique Smartico naming).
const TYPE_OF: Record<string, TypeKey> = {
  email: "email",
  push: "push",
  popup: "pop-up",
};

export interface BundleSendStats {
  total: number;
  uploaded: number;
  reused: number;
  failed: number;
  failedItems: string[];
  suspicious: string[]; // base brand names missing from the SmarticoBrand table
  skipped: string[]; // asset keys with no Smartico type mapping
}

export type SendBundleResult =
  | { ok: true; sendId: string; outputs: OutputBlock[]; stats: BundleSendStats }
  | { ok: false; error: "no_approved_assets" | "cloudinary_not_configured" }
  | null;

function genderOf(brandName: string): "men" | "women" | null {
  const m = /\((men|man|women|woman)\)\s*$/i.exec(brandName);
  if (!m) return null;
  return m[1]!.toLowerCase().startsWith("w") ? "women" : "men";
}

/**
 * Safe-zone metadata of an engine-composed email hero (TASK email-composition,
 * DI-Q9): the письмо is assembled in Smartico, so the geometry the text must
 * respect travels with the images. Assets rendered by the legacy/ai path carry
 * no `safeZonePct` and are simply skipped.
 */
function safeZoneOf(metadata: unknown): { zone: SafeZoneMeta; spec: string } | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const m = metadata as Record<string, unknown>;
  const z = m.safeZonePct as Record<string, unknown> | null | undefined;
  if (!z || ["x", "y", "w", "h"].some((k) => typeof z[k] !== "number")) return null;
  const color = typeof m.recommendedTextColor === "string" ? m.recommendedTextColor : "#111111";
  const contrastPair = m.textContrast as Record<string, unknown> | null | undefined;
  const isDarkText = color.toLowerCase() !== "#ffffff";
  const contrastRaw = contrastPair?.[isDarkText ? "dark" : "white"];
  const specKey = typeof m.specKey === "string" ? m.specKey : "layout spec";
  const specVersion = typeof m.specVersion === "number" ? m.specVersion : 1;
  return {
    zone: {
      x: z.x as number,
      y: z.y as number,
      w: z.w as number,
      h: z.h as number,
      color,
      contrast: typeof contrastRaw === "number" ? contrastRaw : 0,
    },
    spec: `${specKey}@v${specVersion}`,
  };
}

async function fetchBuffer(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

export async function sendBundleToSmartico(bundleId: string): Promise<SendBundleResult> {
  if (!cloudinaryConfigured) return { ok: false, error: "cloudinary_not_configured" };

  const bundle = await prisma.bundle.findUnique({
    where: { id: bundleId },
    include: {
      variants: {
        orderBy: { brandName: "asc" },
        include: { assets: { where: { approved: true, status: "DONE" } } },
      },
    },
  });
  if (!bundle) return null;

  const approved = bundle.variants.flatMap((v) =>
    v.assets
      .filter((a) => a.imageUrl)
      .map((a) => ({ variant: v, asset: a, gender: genderOf(v.brandName) })),
  );
  if (approved.length === 0) return { ok: false, error: "no_approved_assets" };

  const send = await prisma.bundleSend.create({
    data: { bundleId, status: "PENDING" },
    select: { id: true },
  });

  // Stable idempotent namespace → smartico/bundle-<id> folder + dedup scope.
  const namespace = `bundle-${bundleId}`;
  const stats: BundleSendStats = {
    total: approved.length,
    uploaded: 0,
    reused: 0,
    failed: 0,
    failedItems: [],
    suspicious: [],
    skipped: [],
  };

  // Canonical Smartico brand mapping by BASE name (tone suffix stripped).
  const smarticoBrands = await prisma.smarticoBrand.findMany({ select: { name: true } });
  const brandMap = buildBrandMap(smarticoBrands.map((b) => b.name));

  // Upload every approved asset (MD5 dedup) and collect URLs per tone bucket.
  const buckets = new Map<
    "men" | "women" | "all",
    { urls: UrlMap; brands: Map<string, NormalizedBrand>; zones: Record<string, SafeZoneMeta> }
  >();
  const hasGendered = approved.some((e) => e.gender !== null);
  const bucketKeys: Array<"men" | "women" | "all"> = hasGendered ? ["men", "women"] : ["all"];
  for (const key of bucketKeys) buckets.set(key, { urls: {}, brands: new Map(), zones: {} });
  // Spec the emitted safe-zone block was measured against (all email assets of
  // one bundle render from the same active version).
  let specLabel = "";

  const usedTypes = new Set<TypeKey>();

  for (const { variant, asset, gender } of approved) {
    const type = TYPE_OF[asset.assetKey];
    if (!type) {
      stats.skipped.push(`${variant.brandName}/${asset.assetKey}`);
      continue;
    }

    const buffer = await fetchBuffer(asset.imageUrl!);
    if (!buffer) {
      stats.failed += 1;
      stats.failedItems.push(`${variant.brandName}/${asset.assetKey}: fetch failed`);
      continue;
    }
    const outcome = await uploadSmarticoAsset(buffer, {
      namespace,
      brand: variant.brandName, // raw variant name → distinct dedup key + public id
      type,
      locale: "default",
    });
    if (!outcome.url) {
      stats.failed += 1;
      stats.failedItems.push(`${variant.brandName}/${asset.assetKey}: ${outcome.error ?? "upload failed"}`);
      continue;
    }
    if (outcome.status === "uploaded") stats.uploaded += 1;
    else stats.reused += 1;
    usedTypes.add(type);

    const base = stripGenderName(variant.brandName);
    const normalized = normalizeBrand(base, brandMap);
    if (normalized.suspicious && !stats.suspicious.includes(base)) stats.suspicious.push(base);

    // Gendered variants land in their bucket; neutral brands in every bucket.
    const targets: Array<"men" | "women" | "all"> = hasGendered
      ? gender
        ? [gender]
        : ["men", "women"]
      : ["all"];
    const safe = type === "email" ? safeZoneOf(asset.metadata) : null;
    if (safe) specLabel = safe.spec;

    for (const target of targets) {
      const bucket = buckets.get(target)!;
      bucket.brands.set(base, normalized);
      const slot = (bucket.urls[base] ??= {});
      slot[type] = { default: outcome.url, KO: null };
      // Tone variants of one brand share a base name; the later one wins —
      // the zone is spec geometry, so they agree apart from the colour hint.
      if (safe) bucket.zones[base] = safe.zone;
    }
  }

  // Emit per-bucket function sets with a tone prefix in the block titles.
  const outputs: OutputBlock[] = [];
  const types = [...usedTypes];
  const LABEL: Record<string, string> = { men: "Men", women: "Women", all: "" };
  for (const key of bucketKeys) {
    const bucket = buckets.get(key)!;
    if (bucket.brands.size === 0) continue;
    const blocks = generateOutputs(bucket.urls, types, [...bucket.brands.values()]);
    // Geometry travels next to the images (DI-Q9): the fallback zone is the
    // spec constant every brand of the bucket rendered with.
    const firstZone = Object.values(bucket.zones)[0];
    if (firstZone) {
      blocks.push(
        ...generateSafeZoneOutputs(
          bucket.zones,
          [...bucket.brands.values()],
          firstZone,
          specLabel || "email layout spec",
        ),
      );
    }
    const prefix = LABEL[key];
    for (const block of blocks) {
      outputs.push(prefix ? { ...block, title: `${prefix} — ${block.title}` } : block);
    }
  }

  const status = outputs.length > 0 ? "DONE" : "FAILED";
  await prisma.bundleSend.update({
    where: { id: send.id },
    data: { status, outputs: outputs as unknown as object, stats: stats as unknown as object },
  });

  return { ok: true, sendId: send.id, outputs, stats };
}
