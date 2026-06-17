import { createHash } from "node:crypto";
import type { Job } from "bullmq";
import { prisma } from "../lib/prisma.js";
import { uploadBuffer, withRetry } from "../lib/cloudinary.js";
import { listEntryPaths, extractAndProcess } from "../lib/smartico/zip.js";
import { zipPathForToken, removeToken } from "../lib/smartico/storage.js";
import {
  parseStructure,
  buildBrandMap,
  normalizeBrand,
  type TypeKey,
  type LocaleKey,
  type NormalizedBrand,
} from "../lib/smartico/detect.js";
import { generateOutputs, type OutputBlock } from "../lib/smartico/generate.js";
import type { SmarticoJobData } from "./index.js";

const UPLOAD_CONCURRENCY = 5;
const LOCALES: LocaleKey[] = ["default", "KO"];

export interface SmarticoUrlSlot {
  default: string | null;
  KO: string | null;
}
export interface SmarticoJobResult {
  zipName: string;
  selectedTypes: TypeKey[];
  urls: Record<string, Partial<Record<TypeKey, SmarticoUrlSlot>>>; // keyed by raw brand
  brands: NormalizedBrand[];
  outputs: OutputBlock[]; // ready-to-paste Smartico functions / labels
  stats: {
    total: number;
    uploaded: number;
    reused: number;
    failed: number;
    failedItems: string[];
  };
}

function sanitize(s: string): string {
  return (
    s
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "x"
  );
}

function publicIdFor(brand: string, type: TypeKey, locale: LocaleKey): string {
  return `${sanitize(brand)}_${sanitize(type)}${locale === "KO" ? "_ko" : ""}`;
}

export async function processSmarticoJob(job: Job<SmarticoJobData>): Promise<SmarticoJobResult> {
  const { token, zipName } = job.data;
  const selectedTypes = job.data.selectedTypes as TypeKey[];
  const zipPath = zipPathForToken(token);

  try {
    const paths = await listEntryPaths(zipPath);
    const structure = parseStructure(paths);

    // Build the set of entry paths to extract + a path→(brand,type,locale) map.
    const meta = new Map<string, { brand: string; type: TypeKey; locale: LocaleKey }>();
    const wanted = new Set<string>();
    for (const [brand, types] of Object.entries(structure.brands)) {
      for (const type of selectedTypes) {
        const slot = types[type];
        if (!slot) continue;
        for (const locale of LOCALES) {
          const p = slot[locale];
          if (p) {
            wanted.add(p);
            meta.set(p, { brand, type, locale });
          }
        }
      }
    }
    const total = wanted.size;

    const rows = await prisma.smarticoBrand.findMany({ select: { name: true } });
    const brandMap = buildBrandMap(rows.map((r) => r.name));

    const urls: SmarticoJobResult["urls"] = {};
    const failedItems: string[] = [];
    let uploaded = 0;
    let reused = 0;
    let failed = 0;
    let processed = 0;

    const setUrl = (brand: string, type: TypeKey, locale: LocaleKey, url: string | null) => {
      const b = (urls[brand] ??= {});
      const slot = (b[type] ??= { default: null, KO: null });
      slot[locale] = url;
    };

    if (total > 0) {
      await extractAndProcess(zipPath, wanted, UPLOAD_CONCURRENCY, async (path, buffer) => {
        const m = meta.get(path)!;
        const label = `${m.brand}/${m.type}${m.locale === "KO" ? "/KO" : ""}`;
        const md5 = createHash("md5").update(buffer).digest("hex");
        const where = {
          zipName_brand_type_locale: {
            zipName,
            brand: m.brand,
            type: m.type,
            locale: m.locale,
          },
        };
        try {
          const existing = await prisma.smarticoAsset.findUnique({ where });
          if (existing && existing.md5 === md5) {
            setUrl(m.brand, m.type, m.locale, existing.secureUrl);
            reused++;
          } else {
            const folder = `smartico/${sanitize(zipName)}`;
            const publicId = publicIdFor(m.brand, m.type, m.locale);
            const up = await withRetry(
              () => uploadBuffer(buffer, publicId, folder, true),
              label,
            );
            if (up.success && up.secure_url) {
              await prisma.smarticoAsset.upsert({
                where,
                create: {
                  zipName,
                  brand: m.brand,
                  type: m.type,
                  locale: m.locale,
                  md5,
                  secureUrl: up.secure_url,
                  publicId: up.public_id ?? publicId,
                },
                update: { md5, secureUrl: up.secure_url, publicId: up.public_id ?? publicId },
              });
              setUrl(m.brand, m.type, m.locale, up.secure_url);
              uploaded++;
            } else {
              setUrl(m.brand, m.type, m.locale, null);
              failed++;
              failedItems.push(label);
              console.error(`⚠️ Smartico upload failed for ${label}: ${up.error ?? "unknown"}`);
            }
          }
        } catch (e) {
          setUrl(m.brand, m.type, m.locale, null);
          failed++;
          failedItems.push(label);
          console.error(`⚠️ Smartico upload error for ${label}:`, e);
        } finally {
          processed++;
          // Reserve 100% for the completed state; processing tops out at 99%.
          await job.updateProgress(Math.min(99, Math.round((processed / total) * 100)));
        }
      });
    }

    const brands = Object.keys(urls).map((raw) => normalizeBrand(raw, brandMap));
    const outputs = generateOutputs(urls, selectedTypes, brands);

    await job.updateProgress(100);
    return {
      zipName,
      selectedTypes,
      urls,
      brands,
      outputs,
      stats: { total, uploaded, reused, failed, failedItems },
    };
  } finally {
    await removeToken(token);
  }
}
