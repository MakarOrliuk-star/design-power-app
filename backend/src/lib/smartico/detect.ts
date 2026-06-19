export type LocaleKey = "default" | "KO";

export type TypeKey = "email" | "push" | "pop-up" | "pop-up_1" | "pop-up_2";

export const TYPE_ORDER: TypeKey[] = ["email", "push", "pop-up", "pop-up_1", "pop-up_2"];

export interface TypeSlot {
  default: string | null; // ZIP entry path
  KO: string | null;
}
export type BrandTypes = Partial<Record<TypeKey, TypeSlot>>;

export interface ParsedStructure {
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

export function typeFromFilename(filename: string): TypeKey | null {
  const base = stripExt(filename);
  if (/(?:^|[^a-z0-9])subitem(?:[^a-z0-9]|$)/i.test(base)) return null;
  // "email_text" sits next to "email" inside CRM but is not a campaign asset —
  // ignore it so it doesn't shadow the real "email" image.
  if (/email[-_ ]?text/i.test(base)) return null;
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

export function resolveEntry(path: string): { brand: string; type: TypeKey } | null {
  const segments = path.split("/").filter((p) => p.length > 0);
  if (segments.length < 2) return null;
  const filename = segments[segments.length - 1]!;

  // ---- New structure: anchored on a "CRM" segment ----
  const crmIdx = segments.findIndex((s) => norm(s) === "crm");
  if (crmIdx >= 1) {
    const brand = segments[crmIdx - 1]!.trim();
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

/** A brand whose normalized name equals "allbrands" is the cross-brand case. */
export function isAllBrands(rawName: string): boolean {
  return norm(rawName) === "allbrands";
}

export type KoreaVariant = "standard" | "realistic";

export function koreaVariantOf(rawName: string): KoreaVariant | null {
  const n = norm(rawName);
  if (!n.includes("korea")) return null;
  return n.includes("realistic") ? "realistic" : "standard";
}

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
  suspicious: boolean; // unmatched real brand → flag in UI
  isAllBrands: boolean;
  isKorea: boolean; // Korea / Korea realistic pseudo-brand
  koreaVariant: KoreaVariant | null;
}

export function normalizeBrand(raw: string, brandMap: Map<string, string>): NormalizedBrand {
  const allBrands = isAllBrands(raw);
  const koreaVariant = koreaVariantOf(raw);
  const isKorea = koreaVariant !== null;
  const key = raw.trim().toLowerCase();
  const keyNoSpaces = key.replace(/\s+/g, "");
  const canonical = brandMap.get(key) ?? brandMap.get(keyNoSpaces);
  const matched = Boolean(canonical);
  return {
    raw,
    canonical: canonical ?? raw,
    matched,
    // Pseudo-brands (All brands / Korea) are expected to be absent from the
    // brand table, so they are never flagged as suspicious.
    suspicious: !matched && !allBrands && !isKorea,
    isAllBrands: allBrands,
    isKorea,
    koreaVariant,
  };
}
