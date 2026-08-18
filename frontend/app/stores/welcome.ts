import { defineStore } from "pinia";
import type { WelAspect, WelCategory, WelElement } from "~/types/welcome";

/**
 * Welcome packs page state (TASK welcome-packs, Phase 5).
 *
 * Deliberately a standalone store rather than a shared one with tournaments
 * (заказчик: «чтобы не связывало страницы»). It is also simpler: with no
 * Base/VIP modes the unit of selection is just the element id, so the
 * "elementId:MODE" key machinery of the tournament store has no counterpart
 * here.
 *
 * Prompt inputs resolve override ?? default; edits are saved per user to the
 * backend (DB, not localStorage). Generate creates one batch per category and
 * registers each in the generator store, so the toolbar pills / cancel / stop
 * reuse the existing machinery.
 */

export type { WelAspect, WelCategory, WelElement };

export const MAX_WELCOME_BRANDS = 4;
export const MAX_WELCOME_COUNT = 4;

const ERROR_MESSAGES: Record<string, string> = {
  welcome_pipeline_not_configured: "Генерация не настроена (нет ключей fal/Cloudinary).",
  too_many_brands: "Максимум 4 бренда.",
  no_brands: "Выберите хотя бы один бренд.",
  no_selection: "Выберите хотя бы один элемент.",
  no_prompt: "У выбранного элемента нет промпта — задайте его в «Edit Welcome packs».",
  inactive_element: "Элемент был отключён — обновите страницу.",
};

// ---------------------------------------------------------------------------
// Pure helpers (no Vue / no Nuxt) — directly unit-tested, mirroring tournament.ts
// ---------------------------------------------------------------------------

/** "all" | "some" | "none" — drives the category checkbox + indeterminate dash. */
export function categoryStateOf(elementIds: string[], checked: string[]): "all" | "some" | "none" {
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
export function resolvePromptValue(el: WelElement): string {
  return el.override?.content ?? el.prompt?.content ?? "";
}

/** Add a brand id under the hard cap; returns the list unchanged when full. */
export function addBrandCapped(selected: string[], id: string, cap = MAX_WELCOME_BRANDS): string[] {
  if (selected.includes(id) || selected.length >= cap) return selected;
  return [...selected, id];
}

/** Every selectable id of a category — the "Select all" / "X of Y" universe. */
export function allCategoryKeys(cat: WelCategory): string[] {
  return cat.elements.map((e) => e.id);
}

export const useWelcomeStore = defineStore("welcome", () => {
  const categories = ref<WelCategory[]>([]);
  const loaded = ref(false);
  const loading = ref(false);
  const loadError = ref("");

  // Selection state
  const selectedBrandIds = ref<string[]>([]); // ≤ 4
  const checkedIds = ref<string[]>([]); // element ids — no modes in this feature
  const count = ref(1); // global stepper, 1..4
  const aspect = ref<WelAspect>("1:1"); // 1:1 / 9:16 toggle; brand force still wins

  // Run state
  const submitting = ref(false);
  const statusError = ref("");

  const elementById = computed(() => {
    const map = new Map<string, { el: WelElement; cat: WelCategory }>();
    for (const cat of categories.value) for (const el of cat.elements) map.set(el.id, { el, cat });
    return map;
  });

  async function load() {
    if (loading.value) return;
    loading.value = true;
    loadError.value = "";
    try {
      const res = await useApi()<{ categories: WelCategory[] }>("/api/welcome/config");
      categories.value = res.categories;
      // Drop checked ids that are no longer selectable (element removed in the
      // editor) so the "X of Y" counter stays honest.
      const valid = new Set(res.categories.flatMap(allCategoryKeys));
      checkedIds.value = checkedIds.value.filter((id) => valid.has(id));
      loaded.value = true;
    } catch {
      loadError.value = "Не удалось загрузить конфигурацию Welcome packs.";
    } finally {
      loading.value = false;
    }
  }

  // ---- Brand selection (≤4) ----
  const brandLimitReached = computed(() => selectedBrandIds.value.length >= MAX_WELCOME_BRANDS);

  /** Add a brand; silently refuses past the cap (UI disables the option too). */
  function addBrand(id: string) {
    selectedBrandIds.value = addBrandCapped(selectedBrandIds.value, id);
  }
  function removeBrand(id: string) {
    selectedBrandIds.value = selectedBrandIds.value.filter((b) => b !== id);
  }

  // ---- Element checkboxes ----
  function isChecked(elementId: string): boolean {
    return checkedIds.value.includes(elementId);
  }
  function toggleElement(elementId: string) {
    checkedIds.value = checkedIds.value.includes(elementId)
      ? checkedIds.value.filter((id) => id !== elementId)
      : [...checkedIds.value, elementId];
  }

  /** "all" | "some" | "none" — drives the category checkbox. */
  function categoryState(cat: WelCategory): "all" | "some" | "none" {
    return categoryStateOf(allCategoryKeys(cat), checkedIds.value);
  }

  /** Category checkbox: none/some -> select all of it; all -> clear it. */
  function toggleCategory(cat: WelCategory) {
    checkedIds.value = toggleCategoryIds(allCategoryKeys(cat), checkedIds.value);
  }

  // ---- Select all / Clear all + the "X / Y" indicator ----
  const allSelectableKeys = computed(() => new Set(categories.value.flatMap(allCategoryKeys)));
  const totalSelectableCount = computed(() => allSelectableKeys.value.size);
  const selectedCount = computed(
    () => checkedIds.value.filter((id) => allSelectableKeys.value.has(id)).length,
  );
  const allChecked = computed(
    () => totalSelectableCount.value > 0 && selectedCount.value === totalSelectableCount.value,
  );

  /** Header "Select all": every element of every category. */
  function selectAll() {
    checkedIds.value = categories.value.flatMap(allCategoryKeys);
  }
  /** Header "Clear all": drops every element checkbox (brands/count untouched). */
  function clearSelection() {
    checkedIds.value = [];
  }

  // ---- Prompt resolution + overrides ----
  /** What the textarea shows: my override, else the global default. */
  function promptValue(el: WelElement): string {
    return resolvePromptValue(el);
  }
  function isOverridden(el: WelElement): boolean {
    return el.override !== null;
  }
  function defaultChanged(el: WelElement): boolean {
    return el.override?.defaultChanged ?? false;
  }

  /**
   * Persist a local edit. Saving text identical to the default resets the
   * override instead (so "undo by retyping" leaves no stale override row).
   */
  async function saveOverride(el: WelElement, content: string) {
    const trimmed = content.trim();
    const def = el.prompt?.content ?? "";
    if (!trimmed || trimmed === def.trim()) {
      await resetOverride(el);
      return;
    }
    if (el.override?.content === trimmed) return; // no change
    try {
      await useApi()("/api/welcome/overrides", {
        method: "PUT",
        body: { elementId: el.id, content: trimmed },
      });
      el.override = { content: trimmed, defaultChanged: false };
    } catch {
      statusError.value = "Не удалось сохранить промпт.";
    }
  }

  /** "Сбросить к дефолту" — deletes my override, the global default returns. */
  async function resetOverride(el: WelElement) {
    if (!el.override) return;
    try {
      await useApi()(`/api/welcome/overrides?elementId=${el.id}`, { method: "DELETE" });
      el.override = null;
    } catch {
      statusError.value = "Не удалось сбросить промпт.";
    }
  }

  /** "Оставить мой" on the default-changed banner. */
  async function keepMine(el: WelElement) {
    try {
      await useApi()("/api/welcome/overrides/ack", {
        method: "POST",
        body: { elementId: el.id },
      });
      if (el.override) el.override = { ...el.override, defaultChanged: false };
    } catch {
      statusError.value = "Не удалось сохранить выбор.";
    }
  }

  /** "Взять новый дефолт" on the banner — same as reset. */
  async function takeNewDefault(el: WelElement) {
    await resetOverride(el);
  }

  // ---- Generate ----
  const canGenerate = computed(
    () => selectedBrandIds.value.length > 0 && checkedIds.value.length > 0 && !submitting.value,
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
      const selections = checkedIds.value
        .filter((id) => elementById.value.has(id))
        .map((elementId) => ({ elementId }));
      const res = await useApi()<{
        batches: { batchId: string; categoryKey: string; categoryName: string; count: number }[];
      }>("/api/welcome/generate", {
        method: "POST",
        body: {
          brandIds: selectedBrandIds.value,
          count: count.value,
          aspect: aspect.value,
          selections,
        },
      });
      // Register in the generator store: toolbar pills (one per category),
      // per-pill cancel and the global stop all come for free. The label is the
      // category KEY — the toolbar resolves it to a title through this store.
      const gen = useGeneratorStore();
      for (const b of res.batches) gen.addBatch(b.batchId, "welcome", b.categoryKey);
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
    checkedIds,
    count,
    aspect,
    submitting,
    statusError,
    brandLimitReached,
    canGenerate,
    totalSelectableCount,
    selectedCount,
    allChecked,
    load,
    addBrand,
    removeBrand,
    isChecked,
    toggleElement,
    categoryState,
    toggleCategory,
    selectAll,
    clearSelection,
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
