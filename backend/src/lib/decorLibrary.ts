import { z } from "zod";
import { CONCEPT_RE } from "./creativeBrief.js";

/**
 * Библиотека декора с тегами концептов — Задание 3, Фаза 3 (`D-N9`/`D-N9'`).
 *
 * Проблема, которую закрывают теги: `public_id` ассета — sha256-хэш, и без
 * тегов арт-директорская прослойка выбирала декор «под сакуру» из списка вида
 * `a3f91c07….png`. Связка «промпт определяет декор» по хэшам не работает.
 *
 * Хранение остаётся в тех же Json-колонках (`Brand.decorUrls`,
 * `BundleType.assets[].decorUrls`), но элемент списка теперь ЛИБО строка
 * (ручная заливка, безымянный ассет — `D-N9'`: теги желательны, не
 * обязательны), ЛИБО объект `{ url, concepts, season? }` — так автосохранение
 * нарезки листа декора (`D-N8'`) проставляет теги из `decorConcepts` брифа.
 *
 * Обратная совместимость обязательна в обе стороны: старые списки строк
 * читаются как безымянные записи, а записи без тегов сериализуются обратно
 * строками — админский JSON не меняет вида, пока тегов нет.
 */

export interface DecorEntry {
  url: string;
  /** Теги концептов; пусто = безымянный ассет, годится под любой слот. */
  concepts: string[];
  /** Сезонный ассет ставится только в кадр своего сезона. null = всесезонный. */
  season: string | null;
}

/** Цепочка источников декора (`D-N7'`); первый доступный выигрывает. */
export type DecorSource =
  | "library:brand"
  | "library:common"
  | "generated:sheet"
  | "split:item";

const entryObjectSchema = z.object({
  url: z.string().min(1),
  concepts: z.array(z.string()).optional(),
  season: z.string().nullable().optional(),
});

/** Тег обязан быть концептом того же вида, что в брифе: `^[a-z_]{2,20}$`. */
function cleanConcepts(raw: string[] | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.map((c) => c.trim().toLowerCase()))].filter((c) => CONCEPT_RE.test(c));
}

/**
 * Json-колонка → записи. Мусорные элементы выбрасываются молча: библиотека —
 * вход рендера, и битый элемент не должен ронять джобу (то же правило, что у
 * `styleProfile`).
 */
export function parseDecorEntries(raw: unknown): DecorEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: DecorEntry[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      if (item.trim()) out.push({ url: item, concepts: [], season: null });
      continue;
    }
    const parsed = entryObjectSchema.safeParse(item);
    if (!parsed.success) continue;
    out.push({
      url: parsed.data.url,
      concepts: cleanConcepts(parsed.data.concepts),
      season: parsed.data.season ?? null,
    });
  }
  return out;
}

/**
 * Записи → Json-колонка. Запись без тегов и сезона остаётся СТРОКОЙ — формат
 * ручной заливки не меняется, и старый код (и глаза в админке) видят то же,
 * что и раньше.
 */
export function serializeDecorEntries(
  entries: DecorEntry[],
): Array<string | { url: string; concepts: string[]; season?: string }> {
  return entries.map((e) => {
    if (e.concepts.length === 0 && e.season === null) return e.url;
    return { url: e.url, concepts: e.concepts, ...(e.season ? { season: e.season } : {}) };
  });
}

export function decorEntryUrls(entries: DecorEntry[]): string[] {
  return entries.map((e) => e.url);
}

/** Все концепты, представленные тегами библиотеки. */
export function taggedConcepts(entries: DecorEntry[]): Set<string> {
  return new Set(entries.flatMap((e) => e.concepts));
}

/**
 * Слияние записей с дедупликацией по URL. sha256-дедуп приёмника означает,
 * что один и тот же файл приходит с одним и тем же URL — повторная заливка
 * не плодит записи, а ДОПОЛНЯЕТ теги существующей (нарезка того же листа под
 * другую кампанию приносит новые концепты тому же ассету).
 */
export function mergeDecorEntries(
  current: DecorEntry[],
  incoming: DecorEntry[],
  cap: number,
): { merged: DecorEntry[]; skipped: number } {
  const merged = current.map((e) => ({ ...e, concepts: [...e.concepts] }));
  const byUrl = new Map(merged.map((e) => [e.url, e]));
  let skipped = 0;
  for (const inc of incoming) {
    const existing = byUrl.get(inc.url);
    if (existing) {
      existing.concepts = [...new Set([...existing.concepts, ...inc.concepts])];
      if (existing.season === null) existing.season = inc.season;
      continue;
    }
    if (merged.length >= cap) {
      skipped++;
      continue;
    }
    const copy = { ...inc, concepts: [...inc.concepts] };
    merged.push(copy);
    byUrl.set(copy.url, copy);
  }
  return { merged, skipped };
}

// ---------------------------------------------------------------------------
// Отбор под слот
// ---------------------------------------------------------------------------

export interface SelectDecorOptions {
  /** Концепты слота из scene-plan; пусто — подходит любой ассет. */
  concepts: string[];
  /** Сезон брифа: сезонный ассет чужого сезона в кадр не попадает никогда. */
  season: string | null;
  count: number;
  /** Источник детерминизма — mulberry32(seedToInt(seed)) вызывающего. */
  rand: () => number;
}

/**
 * Детерминированный отбор ассетов под слот.
 *
 * Порядок предпочтения: совпавшие по тегам → безымянные (годятся подо всё,
 * `D-N9'`) → тегированные мимо концептов слота. Последняя группа — не мусор,
 * а страховка: зоны обязаны быть заполнены (`D-C6`), и «монета вместо
 * лепестка» лучше пустой сцены — недостающий концепт всё равно уйдёт в
 * генерацию листа по цепочке.
 *
 * Внутри групп — сидированная тасовка: два рендера с одним seed выбирают
 * одни и те же ассеты в одном порядке (`D-N5`).
 */
export function selectDecorEntries(entries: DecorEntry[], opts: SelectDecorOptions): DecorEntry[] {
  const seasonal = entries.filter((e) => e.season === null || e.season === opts.season);
  const wanted = new Set(opts.concepts);
  const matched: DecorEntry[] = [];
  const wildcard: DecorEntry[] = [];
  const rest: DecorEntry[] = [];
  for (const e of seasonal) {
    if (wanted.size > 0 && e.concepts.some((c) => wanted.has(c))) matched.push(e);
    else if (e.concepts.length === 0) wildcard.push(e);
    else if (wanted.size === 0) wildcard.push(e);
    else rest.push(e);
  }
  const pool = [
    ...shuffled(matched, opts.rand),
    ...shuffled(wildcard, opts.rand),
    ...shuffled(rest, opts.rand),
  ];
  return pool.slice(0, Math.max(0, opts.count));
}

function shuffled<T>(items: T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Цепочка источников (D-N7')
// ---------------------------------------------------------------------------

export interface DecorChain {
  steps: DecorSource[];
  /** Какая библиотека выиграла: непустая брендовая перекрывает общую. */
  library: "brand" | "common" | null;
  /** Записи выигравшей библиотеки (пусто, если обе пусты). */
  entries: DecorEntry[];
  /**
   * Концепты брифа, не покрытые тегами выигравшей библиотеки, — их закрывает
   * лист декора. Безымянные ассеты концепт НЕ покрывают: они годятся под
   * любой слот, но не являются свидетельством, что «монета» в библиотеке есть.
   */
  conceptsToGenerate: string[];
}

/**
 * Рантайм-редакция цепочки `D-N7'` — исполняемая истина для рендера
 * (scene-plan несёт её же как декларацию намерения):
 *
 *   1. библиотека БРЕНДА → 2. общая → 3. лист декора → 4. куски слоя ITEM.
 *
 * Библиотека необязательна: обе пусты — план остаётся исполнимым, концепты
 * уходят в лист. Лист без концептов не генерируется — прайм «нарисуй
 * что-нибудь» дал бы декор, не связанный с кампанией, а последний рубеж
 * (куски ITEM) есть всегда.
 */
export function resolveDecorChain(opts: {
  brandEntries: DecorEntry[];
  commonEntries: DecorEntry[];
  concepts: string[];
}): DecorChain {
  const library = opts.brandEntries.length > 0 ? "brand" : opts.commonEntries.length > 0 ? "common" : null;
  const entries = library === "brand" ? opts.brandEntries : library === "common" ? opts.commonEntries : [];
  const covered = taggedConcepts(entries);
  const conceptsToGenerate = opts.concepts.filter((c) => !covered.has(c));

  const steps: DecorSource[] = [];
  if (library) steps.push(library === "brand" ? "library:brand" : "library:common");
  if (conceptsToGenerate.length > 0) steps.push("generated:sheet");
  steps.push("split:item");

  return { steps, library, entries, conceptsToGenerate };
}
