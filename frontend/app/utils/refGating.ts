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

/** Форматы бренда, недобравшие минимум; пусто = бренд готов к генерации. */
export function missingRefFormatsFor(
  counts: RefCountsMap,
  formats: RefFormatMeta[],
  min: number,
  brandKey: string,
): MissingFormat[] {
  const byFormat = counts[brandKey] ?? {};
  return formats
    .map((f) => ({ label: f.label, count: byFormat[f.key] ?? 0 }))
    .filter((f) => f.count < min);
}

/** Число для бейджа бренда — худший формат (по нему и блокировка). */
export function worstRefCount(
  counts: RefCountsMap,
  formats: RefFormatMeta[],
  brandKey: string,
): number {
  if (formats.length === 0) return 0;
  const byFormat = counts[brandKey] ?? {};
  return Math.min(...formats.map((f) => byFormat[f.key] ?? 0));
}
