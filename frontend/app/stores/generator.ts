import { defineStore } from "pinia";
import { BRANDS, formatBrand } from "~/data/brands";

export interface BrandItem {
  id: string;
  name: string;
  categoryIds: string[];
  isFavorite: boolean;
  hasNanoRef: boolean;
}
export interface Category {
  id: string;
  name: string;
  order: number;
}
export interface ThemeItem {
  id: string;
  name: string;
}

export type ContentTab = "PERSON" | "ITEM" | "BACKGROUND";
export type RefMode = "ALL" | "EACH";

export interface PickerItem {
  key: string; // brandId (Person) | style name (Item)
  label: string;
  brand: BrandItem | null; // present for Person (favorites toggle)
}

export interface BatchStatus {
  batch: { id: string; status: string; actionType: string };
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  processing: number;
  progress: number;
  isComplete: boolean;
  generations: {
    id: string;
    brandName: string;
    status: string;
    statusMessage: string | null;
    generatedImageUrl: string | null;
  }[];
}

/** One launched generation, polled independently so runs stay concurrent. */
export interface ActiveBatch {
  id: string;
  kind: "person" | "item";
  createdAt: number;
  status: BatchStatus | null;
}

export const FAVORITES_CATEGORY = "__favorites__";
export const ALL_CATEGORY = "__all__";

const ERROR_MESSAGES: Record<string, string> = {
  person_pipeline_not_configured: "Person-генерация не настроена (нет ключей fal/nano-gpt/Cloudinary).",
  item_pipeline_not_configured: "Item-генерация не настроена (нет ключей nano-gpt/Cloudinary).",
  invalid_theme: "Выберите тему.",
  no_brands: "Выберите хотя бы один бренд.",
  no_styles: "Выберите хотя бы один стиль.",
  nothing_to_generate: "Нечего генерировать.",
};

/**
 * Home generator state + Run flow. Person selects from brands (with categories +
 * favorites); Item selects from item styles (flat list). Both share the prompt /
 * theme / imageCount config and the submit/poll machinery.
 */
export const useGeneratorStore = defineStore("generator", () => {
  const brands = ref<BrandItem[]>([]);
  const categories = ref<Category[]>([]);
  const themes = ref<ThemeItem[]>([]);
  const itemStyles = ref<string[]>([]);
  const itemStyleFavorites = ref<string[]>([]); // favorited Item style keys (per user)
  const loaded = ref(false);
  const loading = ref(false);

  // Config shared across tabs
  const activeTab = ref<ContentTab>("PERSON");
  const refMode = ref<RefMode>("ALL");
  const activeCategoryId = ref<string>(ALL_CATEGORY);
  const search = ref("");
  const themeId = ref<string>("");
  const prompt = ref("");
  const imageCount = ref(1);
  const refImages = ref<string[]>([]); // base64 data URLs (Person)
  const aspectRatio = ref("1:1"); // fal aspect_ratio, global (ALL)

  // Selections (separate per target kind)
  const selectedBrandIds = ref<string[]>([]); // Person
  const selectedStyles = ref<string[]>([]); // Item
  const perBrandPrompts = ref<Record<string, string>>({}); // Person EACH (by brandId)
  const perStylePrompts = ref<Record<string, string>>({}); // Item EACH (by style)
  const perTargetRefs = ref<Record<string, string[]>>({}); // EACH reference uploads (base64) by key
  const perTargetCounts = ref<Record<string, number>>({}); // EACH per-card quantity by key
  const perTargetAspect = ref<Record<string, string>>({}); // EACH per-card aspect_ratio by key

  // Run / progress — multiple concurrent batches, each polled independently.
  const submitting = ref(false);
  const statusError = ref("");
  const batches = ref<ActiveBatch[]>([]);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // Completion notifications (R4): one toast per batch that finishes.
  const toasts = ref<{ id: string; message: string }[]>([]);

  const isItem = computed(() => activeTab.value === "ITEM");

  const brandById = computed(() => {
    const map = new Map<string, BrandItem>();
    for (const b of brands.value) map.set(b.id, b);
    return map;
  });

  const visibleBrands = computed(() => {
    const q = search.value.trim().toLowerCase();
    return brands.value.filter((b) => {
      if (q && !b.name.toLowerCase().includes(q)) return false;
      if (activeCategoryId.value === ALL_CATEGORY) return true;
      if (activeCategoryId.value === FAVORITES_CATEGORY) return b.isFavorite;
      return b.categoryIds.includes(activeCategoryId.value);
    });
  });

  // Unified picker + selection abstraction.
  const pickerItems = computed<PickerItem[]>(() => {
    if (isItem.value) {
      const q = search.value.trim().toLowerCase();
      return itemStyles.value
        .filter((s) => !q || s.toLowerCase().includes(q))
        // Item only honours the Favorites tab (brand categories don't apply to it).
        .filter((s) =>
          activeCategoryId.value === FAVORITES_CATEGORY ? isStyleFavorite(s) : true,
        )
        .map((s) => ({ key: s, label: s, brand: null }));
    }
    return visibleBrands.value.map((b) => ({ key: b.id, label: formatBrand(b.name), brand: b }));
  });

  function selList(): string[] {
    return isItem.value ? selectedStyles.value : selectedBrandIds.value;
  }

  const currentTargets = computed<{ key: string; label: string }[]>(() => {
    if (isItem.value) return selectedStyles.value.map((s) => ({ key: s, label: s }));
    return selectedBrandIds.value
      .map((id) => brandById.value.get(id))
      .filter((b): b is BrandItem => b !== undefined)
      .map((b) => ({ key: b.id, label: formatBrand(b.name) }));
  });

  const targetPrompts = computed(() => (isItem.value ? perStylePrompts.value : perBrandPrompts.value));

  const runningCount = computed(
    () => batches.value.filter((b) => b.status === null || !b.status.isComplete).length,
  );
  // Non-blocking: launching a run does NOT disable the UI — you can configure and
  // start another generation while earlier ones are still in flight (TASK Phase 2).
  const canRun = computed(
    () => selList().length > 0 && activeTab.value !== "BACKGROUND" && !submitting.value,
  );

  function isSelected(key: string) {
    return selList().includes(key);
  }
  function toggleTarget(key: string) {
    const l = selList();
    const i = l.indexOf(key);
    if (i >= 0) l.splice(i, 1);
    else l.push(key);
  }
  function removeTarget(key: string) {
    const l = selList();
    const i = l.indexOf(key);
    if (i >= 0) l.splice(i, 1);
  }
  function clearAll() {
    if (isItem.value) selectedStyles.value = [];
    else selectedBrandIds.value = [];
  }
  function selectAllVisible() {
    const l = selList();
    for (const it of pickerItems.value) if (!l.includes(it.key)) l.push(it.key);
  }

  // ---- Per-target (EACH) editing: prompt / quantity / reference uploads ----
  function setTargetPrompt(key: string, value: string) {
    (isItem.value ? perStylePrompts : perBrandPrompts).value[key] = value;
  }
  function targetCount(key: string): number {
    return perTargetCounts.value[key] ?? 1;
  }
  function setTargetCount(key: string, value: number) {
    perTargetCounts.value[key] = value;
  }
  function targetRefs(key: string): string[] {
    return perTargetRefs.value[key] ?? [];
  }
  function setTargetRefs(key: string, value: string[]) {
    perTargetRefs.value[key] = value;
  }
  function targetAspect(key: string): string {
    return perTargetAspect.value[key] ?? "1:1";
  }
  function setTargetAspect(key: string, value: string) {
    perTargetAspect.value[key] = value;
  }

  async function load() {
    if (loading.value) return;
    loading.value = true;
    try {
      const res = await useApi()<{
        brands: BrandItem[];
        categories: Category[];
        themes: ThemeItem[];
        itemStyles: string[];
        itemStyleFavorites?: string[];
      }>("/api/catalog/home");
      brands.value = res.brands;
      categories.value = res.categories;
      themes.value = res.themes;
      itemStyles.value = res.itemStyles;
      itemStyleFavorites.value = res.itemStyleFavorites ?? [];
      if (!themeId.value && res.themes[0]) themeId.value = res.themes[0].id;
      loaded.value = true;
    } catch {
      // Graceful offline fallback: the static master brand list so the picker
      // still works when the API is unreachable. Categories/themes/itemStyles
      // stay empty (only the "All" picker tab is meaningful offline).
      if (!loaded.value) loadFallback();
    } finally {
      loading.value = false;
    }
  }

  /** Populate brands from the bundled master list (deduped by name). */
  function loadFallback() {
    const seen = new Set<string>();
    const list: BrandItem[] = [];
    for (const name of BRANDS) {
      if (seen.has(name)) continue;
      seen.add(name);
      list.push({ id: name, name, categoryIds: [], isFavorite: false, hasNanoRef: false });
    }
    brands.value = list;
    activeCategoryId.value = ALL_CATEGORY;
  }

  async function toggleFavorite(brand: BrandItem) {
    const next = !brand.isFavorite;
    brand.isFavorite = next;
    try {
      await useApi()(`/api/catalog/favorites/${brand.id}`, { method: next ? "POST" : "DELETE" });
    } catch {
      brand.isFavorite = !next;
    }
  }

  // ---- Item-style favorites (keyed by style name, separate from brand favorites) ----
  function isStyleFavorite(key: string): boolean {
    return itemStyleFavorites.value.includes(key);
  }
  async function toggleStyleFavorite(key: string) {
    const wasFav = isStyleFavorite(key);
    // Optimistic update; revert on failure.
    itemStyleFavorites.value = wasFav
      ? itemStyleFavorites.value.filter((k) => k !== key)
      : [...itemStyleFavorites.value, key];
    try {
      await useApi()(`/api/catalog/item-favorites/${encodeURIComponent(key)}`, {
        method: wasFav ? "DELETE" : "POST",
      });
    } catch {
      itemStyleFavorites.value = wasFav
        ? [...itemStyleFavorites.value, key]
        : itemStyleFavorites.value.filter((k) => k !== key);
    }
  }

  // ---- Unified favorite API for the picker (dispatches on the active tab) ----
  // Person key = brandId, Item key = style name.
  function isTargetFavorite(key: string): boolean {
    if (isItem.value) return isStyleFavorite(key);
    return brandById.value.get(key)?.isFavorite ?? false;
  }
  function toggleTargetFavorite(key: string) {
    if (isItem.value) {
      void toggleStyleFavorite(key);
      return;
    }
    const brand = brandById.value.get(key);
    if (brand) void toggleFavorite(brand);
  }

  async function submit() {
    statusError.value = "";
    if (activeTab.value === "BACKGROUND") {
      statusError.value = "Background пока не поддерживается.";
      return;
    }
    if (selList().length === 0) {
      statusError.value = isItem.value ? "Выберите стили." : "Выберите бренды.";
      return;
    }
    submitting.value = true;
    const kind: "person" | "item" = isItem.value ? "item" : "person";
    try {
      const body = isItem.value
        ? {
            contentType: "ITEM" as const,
            styles: selectedStyles.value,
            themeId: themeId.value,
            prompt: prompt.value,
            perBrandPrompts: perStylePrompts.value,
            imageCount: imageCount.value,
            referenceImages: refImages.value, // global (ALL) img2img ref
            perBrandRefs: perTargetRefs.value, // per-style (EACH)
            perBrandCounts: perTargetCounts.value, // per-style (EACH)
            aspectRatio: aspectRatio.value, // global (ALL)
            perBrandAspect: perTargetAspect.value, // per-style (EACH)
          }
        : {
            contentType: "PERSON" as const,
            brandIds: selectedBrandIds.value,
            themeId: themeId.value,
            refMode: refMode.value,
            prompt: prompt.value,
            perBrandPrompts: perBrandPrompts.value,
            imageCount: imageCount.value,
            referenceImages: refImages.value, // global (ALL)
            perBrandRefs: perTargetRefs.value, // per-target (EACH)
            perBrandCounts: perTargetCounts.value, // per-target (EACH)
            aspectRatio: aspectRatio.value, // global (ALL)
            perBrandAspect: perTargetAspect.value, // per-target (EACH)
          };
      const res = await useApi()<{ batchId: string; count: number }>("/api/generate", {
        method: "POST",
        body,
      });
      batches.value = [...batches.value, { id: res.batchId, kind, createdAt: Date.now(), status: null }];
      startPolling(res.batchId);
    } catch (e: unknown) {
      const code = (e as { data?: { error?: string } })?.data?.error;
      statusError.value = (code && ERROR_MESSAGES[code]) || "Не удалось запустить генерацию.";
    } finally {
      submitting.value = false;
    }
  }

  function startPolling(id: string) {
    void pollOnce(id);
  }

  /**
   * Register an externally-created batch (e.g. a Result-page edit run) so it shows
   * up in the toolbar progress + completion toast and is polled like a RUN batch.
   */
  function addBatch(id: string, kind: "person" | "item") {
    if (batches.value.some((b) => b.id === id)) return;
    batches.value = [...batches.value, { id, kind, createdAt: Date.now(), status: null }];
    startPolling(id);
  }
  async function pollOnce(id: string) {
    if (!batches.value.some((b) => b.id === id)) return; // dismissed
    try {
      const s = await useApi()<BatchStatus>(`/api/batches/${id}`);
      const entry = batches.value.find((b) => b.id === id);
      if (!entry) return;
      const wasComplete = entry.status?.isComplete ?? false;
      entry.status = s;
      if (!s.isComplete) {
        timers.set(id, setTimeout(() => void pollOnce(id), 3000));
      } else {
        timers.delete(id);
        // Fire the completion toast once, on the QUEUED/PROCESSING → done edge.
        if (!wasComplete) pushToast("Все готово переходите в результат");
      }
    } catch {
      if (batches.value.some((b) => b.id === id))
        timers.set(id, setTimeout(() => void pollOnce(id), 5000));
    }
  }

  /** Best-effort cancel of one batch (queued jobs); keeps it in the list. */
  async function stop(id: string) {
    try {
      await useApi()(`/api/batches/${id}/stop`, { method: "POST" });
      void pollOnce(id);
    } catch {
      /* ignore */
    }
  }

  function pushToast(message: string) {
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    toasts.value = [...toasts.value, { id, message }];
  }
  function dismissToast(id: string) {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }

  /** Remove a batch from the toolbar and stop polling it. */
  function dismiss(id: string) {
    const t = timers.get(id);
    if (t) clearTimeout(t);
    timers.delete(id);
    batches.value = batches.value.filter((b) => b.id !== id);
  }

  /** Toolbar × on a job card: cancel if still running, then remove it. */
  async function cancelAndDismiss(id: string) {
    const entry = batches.value.find((b) => b.id === id);
    if (entry && (entry.status === null || !entry.status.isComplete)) await stop(id);
    dismiss(id);
  }

  /** Toolbar global stop: cancel every still-running batch. */
  async function stopAllRunning() {
    const ids = batches.value
      .filter((b) => b.status === null || !b.status.isComplete)
      .map((b) => b.id);
    await Promise.all(ids.map((id) => stop(id)));
  }

  return {
    brands,
    categories,
    themes,
    itemStyles,
    itemStyleFavorites,
    loaded,
    loading,
    activeTab,
    refMode,
    activeCategoryId,
    search,
    themeId,
    prompt,
    imageCount,
    refImages,
    aspectRatio,
    selectedBrandIds,
    selectedStyles,
    perBrandPrompts,
    perStylePrompts,
    perTargetRefs,
    perTargetCounts,
    perTargetAspect,
    submitting,
    statusError,
    batches,
    toasts,
    isItem,
    visibleBrands,
    pickerItems,
    currentTargets,
    targetPrompts,
    runningCount,
    canRun,
    isSelected,
    toggleTarget,
    removeTarget,
    clearAll,
    selectAllVisible,
    setTargetPrompt,
    targetCount,
    setTargetCount,
    targetRefs,
    setTargetRefs,
    targetAspect,
    setTargetAspect,
    load,
    toggleFavorite,
    isStyleFavorite,
    toggleStyleFavorite,
    isTargetFavorite,
    toggleTargetFavorite,
    submit,
    addBatch,
    stop,
    dismiss,
    cancelAndDismiss,
    stopAllRunning,
    dismissToast,
  };
});
