import type { Job } from "bullmq";
import { prisma } from "../lib/prisma.js";
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
import { uploadSmarticoAsset, publicIdFor } from "../lib/smartico/uploadAsset.js";
import { scanImageBuffer, newScanBudget } from "../lib/textScan.js";
import type { SmarticoJobData } from "./index.js";

const UPLOAD_CONCURRENCY = 5;
const LOCALES: LocaleKey[] = ["default", "KO"];

export interface SmarticoUrlSlot {
  default: string | null;
  KO: string | null;
}
/** Email image flagged by the marketing-text scanner (TASK Трек A). */
export interface TextWarning {
  brand: string;
  publicId: string;
  url: string;
  md5: string; // whitelist key for "пометить ок"
  text: string; // what the model could read
  confidence: number; // 0..1 (UI shows a coarse badge, not the raw number)
  driveFolderId: string | null; // Drive flow: "перейти к замене" link target
}
export interface SmarticoJobResult {
  zipName: string;
  selectedTypes: TypeKey[];
  urls: Record<string, Partial<Record<TypeKey, SmarticoUrlSlot>>>; // keyed by raw brand
  brands: NormalizedBrand[];
  /** Uploaded "All brands" default image — becomes the fallback of every function. */
  allBrandsDefaultUrl: string | null;
  outputs: OutputBlock[]; // ready-to-paste Smartico functions / labels
  /** Email images with baked-in marketing text (already whitelisted ones excluded). */
  textWarnings: TextWarning[];
  stats: {
    total: number;
    uploaded: number;
    reused: number;
    failed: number;
    failedItems: string[];
  };
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
    // The "All brands" default image is extracted alongside the typed assets.
    const allBrandsPath = structure.allBrandsDefault;
    if (allBrandsPath) wanted.add(allBrandsPath);
    const total = wanted.size;

    const rows = await prisma.smarticoBrand.findMany({ select: { name: true } });
    const brandMap = buildBrandMap(rows.map((r) => r.name));

    const urls: SmarticoJobResult["urls"] = {};
    let allBrandsDefaultUrl: string | null = null;
    const textWarnings: TextWarning[] = [];
    const scanBudget = newScanBudget(); // общий бюджет скана на весь пак
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
        const isDefault = path === allBrandsPath;
        const m = isDefault
          ? { brand: "All brands", type: "default" as const, locale: "default" as const }
          : meta.get(path)!;
        const label = isDefault
          ? "All brands/default"
          : `${m.brand}/${m.type}${m.locale === "KO" ? "/KO" : ""}`;
        try {
          const outcome = await uploadSmarticoAsset(buffer, {
            namespace: zipName,
            brand: m.brand,
            type: m.type,
            locale: m.locale,
          });
          if (isDefault) allBrandsDefaultUrl = outcome.url;
          else setUrl(m.brand, m.type as TypeKey, m.locale, outcome.url);
          if (outcome.status === "uploaded") uploaded++;
          else if (outcome.status === "reused") reused++;
          else {
            failed++;
            failedItems.push(label);
            console.error(`⚠️ Smartico upload failed for ${label}: ${outcome.error ?? "unknown"}`);
          }
          // Скан текста — только email-картинки (решение интервью A6); best-effort.
          if (!isDefault && m.type === "email" && outcome.url) {
            const scan = await scanImageBuffer(buffer, scanBudget);
            if (scan?.hasText && !scan.approvedOk) {
              textWarnings.push({
                brand: m.brand,
                publicId: publicIdFor(m.brand, "email", m.locale),
                url: outcome.url,
                md5: scan.md5,
                text: scan.text,
                confidence: scan.confidence,
                driveFolderId: null, // ZIP-поток: источника в Drive нет
              });
            }
          }
        } catch (e) {
          if (!isDefault) setUrl(m.brand, m.type as TypeKey, m.locale, null);
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
    const outputs = generateOutputs(urls, selectedTypes, brands, allBrandsDefaultUrl);
    textWarnings.sort((a, b) => a.brand.localeCompare(b.brand));

    await job.updateProgress(100);
    return {
      zipName,
      selectedTypes,
      urls,
      brands,
      allBrandsDefaultUrl,
      outputs,
      textWarnings,
      stats: { total, uploaded, reused, failed, failedItems },
    };
  } finally {
    await removeToken(token);
  }
}
