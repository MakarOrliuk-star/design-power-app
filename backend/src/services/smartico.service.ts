import { prisma } from "../lib/prisma.js";
import { listEntryPaths } from "../lib/smartico/zip.js";
import {
  parseStructure,
  availableTypes,
  normalizeBrand,
  buildBrandMap,
  type TypeKey,
} from "../lib/smartico/detect.js";

/**
 * Smartico analysis (Stage 2): inspect an uploaded ZIP and report which brands /
 * campaign types it contains, normalized against the admin-managed brand list.
 * No decompression — only the central directory is read.
 */

export interface AnalyzedBrand {
  raw: string; // brand folder name as found in the ZIP
  canonical: string; // mapped canonical Smartico name (or `raw` when unmatched)
  matched: boolean; // present in the SmarticoBrand table
  suspicious: boolean; // unmatched and not the All-brands label
  isAllBrands: boolean; // cross-brand label case (legacy "All brands")
  types: Partial<Record<TypeKey, { default: boolean; KO: boolean }>>;
  imageCount: number;
}

export interface AnalyzeResult {
  zipName: string;
  availableTypes: TypeKey[];
  brands: AnalyzedBrand[];
  suspiciousBrands: string[]; // raw names to highlight in the UI
  totalImages: number;
}

export async function analyzeZip(zipPath: string, zipName: string): Promise<AnalyzeResult> {
  const paths = await listEntryPaths(zipPath);
  const structure = parseStructure(paths);
  const types = availableTypes(structure);

  const rows = await prisma.smarticoBrand.findMany({ select: { name: true } });
  const brandMap = buildBrandMap(rows.map((r) => r.name));

  const brands: AnalyzedBrand[] = Object.entries(structure.brands)
    .map(([raw, slots]) => {
      const nb = normalizeBrand(raw, brandMap);
      const typeFlags: AnalyzedBrand["types"] = {};
      let imageCount = 0;
      for (const [type, slot] of Object.entries(slots)) {
        const hasDefault = Boolean(slot.default);
        const hasKO = Boolean(slot.KO);
        typeFlags[type as TypeKey] = { default: hasDefault, KO: hasKO };
        if (hasDefault) imageCount++;
        if (hasKO) imageCount++;
      }
      return { ...nb, types: typeFlags, imageCount };
    })
    .sort((a, b) => a.raw.localeCompare(b.raw));

  return {
    zipName,
    availableTypes: types,
    brands,
    suspiciousBrands: brands.filter((b) => b.suspicious).map((b) => b.raw),
    totalImages: brands.reduce((sum, b) => sum + b.imageCount, 0),
  };
}
