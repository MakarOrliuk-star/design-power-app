// Гейт брендов по референсам (TASK ai-reference, DI-R3; TASK multiformat-promo,
// DI2-2). Бренд участвует в генерации, только если КАЖДЫЙ ai_reference-формат
// набрал минимум: у email, push и pop-up свои пулы, фолбэка между ними нет.
// Логика вынесена из стора, чтобы правило гейта проверялось тестами напрямую.

export interface RefFormatMeta {
  key: string;
  label: string;
  isAnchor?: boolean;
}
/** Бренд → формат → сколько референсов загружено. */
export type RefCountsMap = Record<string, Record<string, number>>;

export interface MissingFormat {
  label: string;
  count: number;
}

/**
 * Пул тон-варианта (DI2-10) — зеркало серверного resolveRefPoolName: у
 * варианта есть свои референсы → они, пул пуст → общий пул базового бренда.
 * `brandKey` — базовое имя, `variantName` — полное ("Betnella(Men)").
 */
export function effectiveRefCount(
  counts: RefCountsMap,
  brandKey: string,
  variantName: string,
  formatKey: string,
): number {
  if (variantName !== brandKey) {
    const own = counts[variantName]?.[formatKey] ?? 0;
    if (own > 0) return own;
  }
  return counts[brandKey]?.[formatKey] ?? 0;
}

/**
 * Форматы бренда, недобравшие минимум; пусто = бренд готов к генерации.
 * Проверяется КАЖДЫЙ тон-вариант: генерируются они оба, и у каждого свой
 * (возможно, унаследованный от базового) пул. В подписи тон появляется только
 * когда вариантов больше одного — иначе она бы шумела на обычных брендах.
 */
export function missingRefFormatsFor(
  counts: RefCountsMap,
  formats: RefFormatMeta[],
  min: number,
  brandKey: string,
  variants: Array<{ name: string; displayName: string }> = [],
): MissingFormat[] {
  const list = variants.length > 0 ? variants : [{ name: brandKey, displayName: brandKey }];
  const showTone = list.length > 1;
  const missing: MissingFormat[] = [];
  for (const variant of list) {
    for (const format of formats) {
      const count = effectiveRefCount(counts, brandKey, variant.name, format.key);
      if (count >= min) continue;
      const tone = toneLabel(variant.displayName, brandKey);
      missing.push({
        label: showTone && tone ? `${tone} · ${format.label}` : format.label,
        count,
      });
    }
  }
  return missing;
}

/** "Betnella (Men)" при базе "Betnella" → "Men"; иначе пусто. */
export function toneLabel(displayName: string, brandKey: string): string {
  const rest = displayName.replace(brandKey, "").trim();
  return rest.replace(/^\(|\)$/g, "").trim();
}

/** Число для бейджа бренда — худший формат по всем вариантам. */
export function worstRefCount(
  counts: RefCountsMap,
  formats: RefFormatMeta[],
  brandKey: string,
  variants: Array<{ name: string; displayName: string }> = [],
): number {
  if (formats.length === 0) return 0;
  const list = variants.length > 0 ? variants.map((v) => v.name) : [brandKey];
  const values = list.flatMap((name) =>
    formats.map((f) => effectiveRefCount(counts, brandKey, name, f.key)),
  );
  return Math.min(...values);
}
