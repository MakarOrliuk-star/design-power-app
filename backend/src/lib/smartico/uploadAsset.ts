import { createHash } from "node:crypto";
import { prisma } from "../prisma.js";
import { uploadBuffer, withRetry } from "../cloudinary.js";
import type { TypeKey, LocaleKey } from "./detect.js";

/**
 * Upload one Smartico image to Cloudinary with MD5 de-dup, shared by both the
 * ZIP and Google Drive generation jobs. An asset is keyed by
 * (namespace, brand, type, locale) in the SmarticoAsset table; if the bytes are
 * unchanged (same MD5) we reuse the stored secure_url instead of re-uploading.
 *
 * `namespace` is the campaign/pack name — the ZIP archive name for the ZIP flow,
 * or "<branch> — <event>" for the Drive flow. It maps to the SmarticoAsset
 * `zipName` column (a generic per-pack namespace, despite the legacy name).
 */

// "card" is the Tournament Smartico image (card.webp); it isn't a CRM TypeKey but
// shares the same dedup/upload path. The DB `type` column is a plain string.
export type AssetType = TypeKey | "card";

export interface AssetParams {
  namespace: string;
  brand: string;
  type: AssetType;
  locale: LocaleKey;
}

export type AssetStatus = "uploaded" | "reused" | "failed";

export interface AssetOutcome {
  url: string | null;
  status: AssetStatus;
  error?: string;
}

/** Cloudinary public_ids / folders must be filesystem-safe. */
export function sanitize(s: string): string {
  return (
    s
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "x"
  );
}

export function publicIdFor(brand: string, type: AssetType, locale: LocaleKey): string {
  return `${sanitize(brand)}_${sanitize(type)}${locale === "KO" ? "_ko" : ""}`;
}

export async function uploadSmarticoAsset(
  buffer: Buffer,
  { namespace, brand, type, locale }: AssetParams,
): Promise<AssetOutcome> {
  const md5 = createHash("md5").update(buffer).digest("hex");
  const where = {
    zipName_brand_type_locale: { zipName: namespace, brand, type, locale },
  };

  const existing = await prisma.smarticoAsset.findUnique({ where });
  if (existing && existing.md5 === md5) {
    return { url: existing.secureUrl, status: "reused" };
  }

  const folder = `smartico/${sanitize(namespace)}`;
  const publicId = publicIdFor(brand, type, locale);
  const up = await withRetry(
    () => uploadBuffer(buffer, publicId, folder, true),
    `${brand}/${type}`,
  );

  if (up.success && up.secure_url) {
    await prisma.smarticoAsset.upsert({
      where,
      create: {
        zipName: namespace,
        brand,
        type,
        locale,
        md5,
        secureUrl: up.secure_url,
        publicId: up.public_id ?? publicId,
      },
      update: { md5, secureUrl: up.secure_url, publicId: up.public_id ?? publicId },
    });
    return { url: up.secure_url, status: "uploaded" };
  }

  return { url: null, status: "failed", ...(up.error ? { error: up.error } : {}) };
}
