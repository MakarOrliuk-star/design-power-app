import { prisma } from "../lib/prisma.js";
import { cloudinaryConfigured } from "../env.js";
import { uploadSmarticoAsset } from "../lib/smartico/uploadAsset.js";
import { buildBrandMap, normalizeBrand } from "../lib/smartico/detect.js";
import type { NormalizedBrand, TypeKey } from "../lib/smartico/detect.js";
import { generateOutputs } from "../lib/smartico/generate.js";
import type { OutputBlock, UrlMap } from "../lib/smartico/generate.js";
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
  const buckets = new Map<"men" | "women" | "all", { urls: UrlMap; brands: Map<string, NormalizedBrand> }>();
  const hasGendered = approved.some((e) => e.gender !== null);
  const bucketKeys: Array<"men" | "women" | "all"> = hasGendered ? ["men", "women"] : ["all"];
  for (const key of bucketKeys) buckets.set(key, { urls: {}, brands: new Map() });

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
    for (const target of targets) {
      const bucket = buckets.get(target)!;
      bucket.brands.set(base, normalized);
      const slot = (bucket.urls[base] ??= {});
      slot[type] = { default: outcome.url, KO: null };
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
