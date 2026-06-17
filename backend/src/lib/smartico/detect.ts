/**
 * Smartico ZIP structure detector (Stage 2).
 *
 * Pure, side-effect-free parsing of a flat list of ZIP entry paths into a
 * brand → type → locale map. Supports BOTH archive layouts (TASK A1):
 *
 *   Legacy:  DES-XXXXX / Brand / file
 *            DES-XXXXX / Oscar brands / Brand / file        (sibling folders ignored)
 *            → type detected from the FILENAME token (email / push / pop-up)
 *
 *   New:     Brand / Name / CRM / {email|push|pop-up_1|pop-up_2|subitem} / file
 *            → only the CRM subtree is read; CONTENT/SMARTICO siblings ignored;
 *              type = the leaf folder name under CRM; `subitem` ignored.
 *
 * Locale: "KO" when the word "korean" appears anywhere in the entry path,
 * otherwise "default" (mirrors the legacy `korean` token rule, widened to also
 * catch a `korean` folder).
 */

export type LocaleKey = "default" | "KO";

/** Canonical campaign types. Each becomes its own checkbox + its own function. */
export type TypeKey = "email" | "push" | "pop-up" | "pop-up_1" | "pop-up_2";

export const TYPE_ORDER: TypeKey[] = ["email", "push", "pop-up", "pop-up_1", "pop-up_2"];

export interface TypeSlot {
  default: string | null; // ZIP entry path
  KO: string | null;
}
export type BrandTypes = Partial<Record<TypeKey, TypeSlot>>;

export interface ParsedStructure {
  /** raw brand folder name → its detected type slots */
  brands: Record<string, BrandTypes>;
}

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, "");

/** Entries we never treat as content. */
function isJunkPath(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.includes("__macosx/") ||
    lower.endsWith(".ds_store") ||
    lower.split("/").some((seg) => seg.startsWith("._"))
  );
}

/** zip-slip / malformed-path guard: reject absolute paths or `..` segments. */
export function isUnsafePath(path: string): boolean {
  if (path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path)) return true;
  return path.split(/[\\/]/).some((seg) => seg === "..");
}

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

/** Map a clean leaf folder name (new structure) to a canonical type, or null. */
export function typeFromFolder(name: string): TypeKey | null {
  const n = norm(name);
  if (n.includes("subitem")) return null;
  if (/^pop-?up_?1$/.test(n)) return "pop-up_1";
  if (/^pop-?up_?2$/.test(n)) return "pop-up_2";
  if (/^pop-?up$/.test(n)) return "pop-up";
  if (/^push$/.test(n)) return "push";
  if (/^email$/.test(n)) return "email";
  return null;
}

/** Detect a type token embedded in a filename (legacy rule, widened for _1/_2). */
export function typeFromFilename(filename: string): TypeKey | null {
  const base = stripExt(filename);
  if (/(?:^|[^a-z0-9])subitem(?:[^a-z0-9]|$)/i.test(base)) return null;
  if (/(?:^|[^a-z0-9])pop[-_ ]?up[-_ ]?1(?:[^0-9]|$)/i.test(base)) return "pop-up_1";
  if (/(?:^|[^a-z0-9])pop[-_ ]?up[-_ ]?2(?:[^0-9]|$)/i.test(base)) return "pop-up_2";
  if (/(?:^|[^a-z0-9])pop[-_ ]?up(?:[^a-z0-9]|$)/i.test(base)) return "pop-up";
  if (/(?:^|[^a-z0-9])push(?:[^a-z0-9]|$)/i.test(base)) return "push";
  if (/(?:^|[^a-z0-9])email(?:[^a-z0-9]|$)/i.test(base)) return "email";
  return null;
}

function localeOf(path: string): LocaleKey {
  return path.toLowerCase().includes("korean") ? "KO" : "default";
}

function ensureSlot(brands: Record<string, BrandTypes>, brand: string, type: TypeKey): TypeSlot {
  const b = (brands[brand] ??= {});
  return (b[type] ??= { default: null, KO: null });
}

/** Does a path segment look like the optional "Oscar brands" wrapper? */
function isOscarWrapper(seg: string): boolean {
  const n = norm(seg);
  return n.includes("oscar") && n.includes("brand");
}

/**
 * Resolve (brand, type) for a single file path. Returns null when the entry is
 * not a recognized content image (e.g. a CONTENT/SMARTICO sibling, a subitem, or
 * an unparseable depth).
 */
export function resolveEntry(path: string): { brand: string; type: TypeKey } | null {
  const segments = path.split("/").filter((p) => p.length > 0);
  if (segments.length < 2) return null;
  const filename = segments[segments.length - 1]!;

  // ---- New structure: anchored on a "CRM" segment ----
  const crmIdx = segments.findIndex((s) => norm(s) === "crm");
  if (crmIdx >= 1) {
    const brand = segments[Math.max(0, crmIdx - 2)]!.trim();
    const afterCrm = segments.slice(crmIdx + 1); // [...typeFolder?, filename]
    let type: TypeKey | null = null;
    if (afterCrm.length >= 2) {
      type = typeFromFolder(afterCrm[0]!) ?? typeFromFilename(filename);
    } else {
      type = typeFromFilename(filename);
    }
    if (!type || !brand) return null;
    return { brand, type };
  }

  // ---- Legacy structure: TopFolder / [Oscar brands /] Brand / file ----
  const oscar = segments.length >= 2 && isOscarWrapper(segments[1]!);
  let brand: string | undefined;
  if (oscar) {
    if (segments.length < 4) return null;
    brand = segments[2]!.trim();
  } else {
    if (segments.length < 3) return null;
    brand = segments[1]!.trim();
  }
  const type = typeFromFilename(filename);
  if (!type || !brand) return null;
  return { brand, type };
}

/** Parse a flat list of ZIP entry paths into the brand/type/locale structure. */
export function parseStructure(paths: string[]): ParsedStructure {
  const brands: Record<string, BrandTypes> = {};
  for (const path of paths) {
    if (!path || path.endsWith("/")) continue; // directory entry
    if (isJunkPath(path) || isUnsafePath(path)) continue;
    const resolved = resolveEntry(path);
    if (!resolved) continue;
    const slot = ensureSlot(brands, resolved.brand, resolved.type);
    slot[localeOf(path)] = path;
  }
  return { brands };
}

/** Union of detected types across all brands, in canonical order. */
export function availableTypes(structure: ParsedStructure): TypeKey[] {
  const found = new Set<TypeKey>();
  for (const types of Object.values(structure.brands)) {
    for (const t of Object.keys(types) as TypeKey[]) found.add(t);
  }
  return TYPE_ORDER.filter((t) => found.has(t));
}

/** A brand whose normalized name equals "allbrands" is the cross-brand label case. */
export function isAllBrands(rawName: string): boolean {
  return norm(rawName) === "allbrands";
}

/**
 * Build a lowercase→canonical normalization map from the admin-managed Smartico
 * brand list (matches the legacy BRAND_NAME_MAP: keyed by lowercase and by
 * lowercase-without-spaces).
 */
export function buildBrandMap(canonicalNames: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const name of canonicalNames) {
    const lower = name.toLowerCase();
    map.set(lower, name);
    map.set(lower.replace(/\s+/g, ""), name);
  }
  return map;
}

export interface NormalizedBrand {
  raw: string; // folder name as in the ZIP
  canonical: string; // mapped canonical name, or `raw` when unmatched
  matched: boolean; // found in the Smartico brand table
  suspicious: boolean; // unmatched and not the All-brands label → flag in UI
  isAllBrands: boolean;
}

export function normalizeBrand(raw: string, brandMap: Map<string, string>): NormalizedBrand {
  const allBrands = isAllBrands(raw);
  const key = raw.trim().toLowerCase();
  const keyNoSpaces = key.replace(/\s+/g, "");
  const canonical = brandMap.get(key) ?? brandMap.get(keyNoSpaces);
  const matched = Boolean(canonical);
  return {
    raw,
    canonical: canonical ?? raw,
    matched,
    suspicious: !matched && !allBrands,
    isAllBrands: allBrands,
  };
}
