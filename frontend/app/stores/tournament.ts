import { defineStore } from "pinia";

/**
 * Tournaments page state (Phase 5). Selection model:
 *  - up to 4 brands (hard cap, mirrored by the backend);
 *  - element checkboxes across the 4 categories (category checkbox = all its
 *    elements; partial selection -> indeterminate);
 *  - an independent Base/VIP toggle per moded category — switching KEEPS the
 *    checked elements (Phase 0 decision);
 *  - one global image count (1..4).
 * Prompt inputs resolve override ?? default; edits are saved per user to the
 * backend (DB, not localStorage). Generate creates one batch per category and
 * registers each in the generator store so the toolbar pills / cancel / stop
 * reuse the existing machinery.
 */

export type TourMode = "BASE" | "VIP";

export interface TourPromptInfo {
  content: string;
  updatedAt: string;
}
export interface TourOverrideInfo {
  content: string;
  defaultChanged: boolean;
}
export interface TourElement {
  id: string;
  name: string;
  order: number;
  referenceImages: string[];
  prompts: Partial<Record<TourMode, TourPromptInfo>>;
  overrides: Partial<Record<TourMode, TourOverrideInfo>>;
}
export interface TourCategory {
  id: string;
  key: string;
  name: string;
  hasModes: boolean;
  fixedMode: TourMode | null;
  order: number;
  elements: TourElement[];
}

export const MAX_TOURNAMENT_BRANDS = 4;
export const MAX_TOURNAMENT_COUNT = 4;

const ERROR_MESSAGES: Record<string, string> = {
  tournament_pipeline_not_configured: "Генерация не настроена (нет ключей fal/Cloudinary).",
  too_many_brands: "Максимум 4 бренда.",
  no_brands: "Выберите хотя бы один бренд.",
  no_selection: "Выберите хотя бы один элемент.",
  no_prompt: "У выбранного элемента нет промпта.",
  inactive_element: "Элемент был отключён администратором — обновите страницу.",
};

// ---------------------------------------------------------------------------
// Pure helpers (no Vue / no Nuxt) — directly unit-tested, mirroring useResult.
// ---------------------------------------------------------------------------

/** The effective mode of an element's category given the page toggles. */
export function effectiveMode(cat: TourCategory, modeByCategory: Record<string, TourMode>): TourMode {
  return cat.hasModes ? (modeByCategory[cat.key] ?? "BASE") : (cat.fixedMode ?? "BASE");
}

/** "all" | "some" | "none" — drives the category checkbox + indeterminate dash. */
export function categoryStateOf(
  elementIds: string[],
  checked: string[],
): "all" | "some" | "none" {
  if (!elementIds.length) return "none";
  const set = new Set(checked);
  const n = elementIds.filter((id) => set.has(id)).length;
  return n === 0 ? "none" : n === elementIds.length ? "all" : "some";
}

/** Category checkbox click: none/some -> add all its elements; all -> drop them. */
export function toggleCategoryIds(elementIds: string[], checked: string[]): string[] {
  if (categoryStateOf(elementIds, checked) === "all") {
    const drop = new Set(elementIds);
    return checked.filter((id) => !drop.has(id));
  }
  const set = new Set(checked);
  for (const id of elementIds) set.add(id);
  return [...set];
}

/** What the prompt input shows: my override, else the global default. */
export function resolvePromptValue(el: TourElement, mode: TourMode): string {
  return el.overrides[mode]?.content ?? el.prompts[mode]?.content ?? "";
}

/** Add a brand id under the hard cap; returns the list unchanged when full. */
export function addBrandCapped(selected: string[], id: string, cap = MAX_TOURNAMENT_BRANDS): string[] {
  if (selected.includes(id) || selected.length >= cap) return selected;
  return [...selected, id];
}

export const useTournamentStore = defineStore("tournament", () => {
  const categories = ref<TourCategory[]>([]);
  const loaded = ref(false);
  const loading = ref(false);
  const loadError = ref("");

  // Selection state
  const selectedBrandIds = ref<string[]>([]); // ≤ 4
  const checkedElementIds = ref<string[]>([]);
  const modeByCategory = ref<Record<string, TourMode>>({}); // per moded category
  const count = ref(1); // global stepper, 1..4

  // Run state
  const submitting = ref(false);
  const statusError = ref("");

  const elementById = computed(() => {
    const map = new Map<string, { el: TourElement; cat: TourCategory }>();
    for (const cat of categories.value)
      for (const el of cat.elements) map.set(el.id, { el, cat });
    return map;
  });

  async function load() {
    if (loading.value) return;
    loading.value = true;
    loadError.value = "";
    try {
      const res = await useApi()<{ categories: TourCategory[] }>("/api/tournament/config");
      categories.value = res.categories;
      // Default every moded category to Base (the mock's initial state).
      for (const c of res.categories)
        if (c.hasModes && !modeByCategory.value[c.key]) modeByCategory.value[c.key] = "BASE";
      // Drop checked ids that no longer exist (admin removed an element).
      const known = new Set(res.categories.flatMap((c) => c.elements.map((e) => e.id)));
      checkedElementIds.value = checkedElementIds.value.filter((id) => known.has(id));
      loaded.value = true;
    } catch {
      loadError.value = "Не удалось загрузить конфигурацию турниров.";
    } finally {
      loading.value = false;
    }
  }

  // ---- Brand selection (≤4) ----
  const brandLimitReached = computed(() => selectedBrandIds.value.length >= MAX_TOURNAMENT_BRANDS);

  /** Add a brand; silently refuses past the cap (UI disables the option too). */
  function addBrand(id: string) {
    selectedBrandIds.value = addBrandCapped(selectedBrandIds.value, id);
  }
  function removeBrand(id: string) {
    selectedBrandIds.value = selectedBrandIds.value.filter((b) => b !== id);
  }

  // ---- Element checkboxes ----
  function isChecked(elementId: string): boolean {
    return checkedElementIds.value.includes(elementId);
  }
  function toggleElement(elementId: string) {
    checkedElementIds.value = isChecked(elementId)
      ? checkedElementIds.value.filter((id) => id !== elementId)
      : [...checkedElementIds.value, elementId];
  }

  /** "all" | "some" | "none" — drives the category checkbox + indeterminate. */
  function categoryState(cat: TourCategory): "all" | "some" | "none" {
    return categoryStateOf(cat.elements.map((e) => e.id), checkedElementIds.value);
  }

  /** Category checkbox: none/some -> select all its elements; all -> clear. */
  function toggleCategory(cat: TourCategory) {
    checkedElementIds.value = toggleCategoryIds(
      cat.elements.map((e) => e.id),
      checkedElementIds.value,
    );
  }

  /** Header "Select all": every element of every category. */
  function selectAll() {
    checkedElementIds.value = categories.value.flatMap((c) => c.elements.map((e) => e.id));
  }
  function clearSelection() {
    checkedElementIds.value = [];
  }

  function setMode(cat: TourCategory, mode: TourMode) {
    // Switching Base/VIP keeps the checked elements (Phase 0 decision) — the
    // toggle only changes WHICH prompt set is shown/generated.
    modeByCategory.value = { ...modeByCategory.value, [cat.key]: mode };
  }
  function modeOf(cat: TourCategory): TourMode {
    return effectiveMode(cat, modeByCategory.value);
  }

  // ---- Prompt resolution + overrides ----
  /** What the textarea shows: my override, else the global default. */
  function promptValue(el: TourElement, mode: TourMode): string {
    return resolvePromptValue(el, mode);
  }
  function isOverridden(el: TourElement, mode: TourMode): boolean {
    return el.overrides[mode] !== undefined;
  }
  function defaultChanged(el: TourElement, mode: TourMode): boolean {
    return el.overrides[mode]?.defaultChanged ?? false;
  }

  /**
   * Persist a local edit. Saving text identical to the default resets the
   * override instead (so "undo by retyping" leaves no stale override row).
   */
  async function saveOverride(el: TourElement, mode: TourMode, content: string) {
    const trimmed = content.trim();
    const def = el.prompts[mode]?.content ?? "";
    if (!trimmed || trimmed === def.trim()) {
      await resetOverride(el, mode);
      return;
    }
    if (el.overrides[mode]?.content === trimmed) return; // no change
    try {
      await useApi()("/api/tournament/overrides", {
        method: "PUT",
        body: { elementId: el.id, mode, content: trimmed },
      });
      el.overrides = { ...el.overrides, [mode]: { content: trimmed, defaultChanged: false } };
    } catch {
      statusError.value = "Не удалось сохранить промпт.";
    }
  }

  /** "Сбросить к дефолту" — deletes my override, the global default returns. */
  async function resetOverride(el: TourElement, mode: TourMode) {
    if (!el.overrides[mode]) return;
    try {
      await useApi()(`/api/tournament/overrides?elementId=${el.id}&mode=${mode}`, {
        method: "DELETE",
      });
      const next = { ...el.overrides };
      delete next[mode];
      el.overrides = next;
    } catch {
      statusError.value = "Не удалось сбросить промпт.";
    }
  }

  /** "Оставить мой" on the default-changed banner. */
  async function keepMine(el: TourElement, mode: TourMode) {
    try {
      await useApi()("/api/tournament/overrides/ack", {
        method: "POST",
        body: { elementId: el.id, mode },
      });
      const cur = el.overrides[mode];
      if (cur) el.overrides = { ...el.overrides, [mode]: { ...cur, defaultChanged: false } };
    } catch {
      statusError.value = "Не удалось сохранить выбор.";
    }
  }

  /** "Взять новый дефолт" on the banner — same as reset. */
  async function takeNewDefault(el: TourElement, mode: TourMode) {
    await resetOverride(el, mode);
  }

  // ---- Generate ----
  const canGenerate = computed(
    () =>
      selectedBrandIds.value.length > 0 &&
      checkedElementIds.value.length > 0 &&
      !submitting.value,
  );

  async function generate() {
    statusError.value = "";
    if (!canGenerate.value) {
      statusError.value =
        selectedBrandIds.value.length === 0
          ? "Выберите хотя бы один бренд."
          : "Выберите хотя бы один элемент.";
      return;
    }
    submitting.value = true;
    try {
      const selections = checkedElementIds.value
        .map((id) => elementById.value.get(id))
        .filter((x): x is { el: TourElement; cat: TourCategory } => x !== undefined)
        .map(({ el, cat }) => ({ elementId: el.id, mode: modeOf(cat) }));
      const res = await useApi()<{
        batches: { batchId: string; categoryKey: string; count: number }[];
      }>("/api/tournament/generate", {
        method: "POST",
        body: { brandIds: selectedBrandIds.value, count: count.value, selections },
      });
      // Register in the generator store: toolbar pills (one per category),
      // per-pill cancel and the global stop all come for free.
      const gen = useGeneratorStore();
      for (const b of res.batches) gen.addBatch(b.batchId, "tournament", b.categoryKey);
    } catch (e: unknown) {
      const code = (e as { data?: { error?: string } })?.data?.error;
      statusError.value = (code && ERROR_MESSAGES[code]) || "Не удалось запустить генерацию.";
    } finally {
      submitting.value = false;
    }
  }

  return {
    categories,
    loaded,
    loading,
    loadError,
    selectedBrandIds,
    checkedElementIds,
    modeByCategory,
    count,
    submitting,
    statusError,
    brandLimitReached,
    canGenerate,
    load,
    addBrand,
    removeBrand,
    isChecked,
    toggleElement,
    categoryState,
    toggleCategory,
    selectAll,
    clearSelection,
    setMode,
    modeOf,
    promptValue,
    isOverridden,
    defaultChanged,
    saveOverride,
    resetOverride,
    keepMine,
    takeNewDefault,
    generate,
  };
});
