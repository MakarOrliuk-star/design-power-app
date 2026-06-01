import { defineStore } from "pinia";

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
  const loaded = ref(false);
  const loading = ref(false);

  // Config shared across tabs
  const activeTab = ref<ContentTab>("PERSON");
  const refMode = ref<RefMode>("ALL");
  const activeCategoryId = ref<string>(FAVORITES_CATEGORY);
  const search = ref("");
  const themeId = ref<string>("");
  const prompt = ref("");
  const imageCount = ref(1);
  const refImages = ref<string[]>([]); // base64 data URLs (Person)

  // Selections (separate per target kind)
  const selectedBrandIds = ref<string[]>([]); // Person
  const selectedStyles = ref<string[]>([]); // Item
  const perBrandPrompts = ref<Record<string, string>>({}); // Person EACH (by brandId)
  const perStylePrompts = ref<Record<string, string>>({}); // Item EACH (by style)

  // Run / progress
  const submitting = ref(false);
  const statusError = ref("");
  const batchId = ref<string | null>(null);
  const batchStatus = ref<BatchStatus | null>(null);
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

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
        .map((s) => ({ key: s, label: s, brand: null }));
    }
    return visibleBrands.value.map((b) => ({ key: b.id, label: b.name, brand: b }));
  });

  function selList(): string[] {
    return isItem.value ? selectedStyles.value : selectedBrandIds.value;
  }

  const currentTargets = computed<{ key: string; label: string }[]>(() => {
    if (isItem.value) return selectedStyles.value.map((s) => ({ key: s, label: s }));
    return selectedBrandIds.value
      .map((id) => brandById.value.get(id))
      .filter((b): b is BrandItem => b !== undefined)
      .map((b) => ({ key: b.id, label: b.name }));
  });

  const targetPrompts = computed(() => (isItem.value ? perStylePrompts.value : perBrandPrompts.value));

  const isRunning = computed(() => batchStatus.value !== null && !batchStatus.value.isComplete);
  const canRun = computed(
    () =>
      selList().length > 0 &&
      Boolean(themeId.value) &&
      activeTab.value !== "BACKGROUND" &&
      !submitting.value &&
      !isRunning.value,
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

  async function load() {
    if (loading.value) return;
    loading.value = true;
    try {
      const res = await useApi()<{
        brands: BrandItem[];
        categories: Category[];
        themes: ThemeItem[];
        itemStyles: string[];
      }>("/api/catalog/home");
      brands.value = res.brands;
      categories.value = res.categories;
      themes.value = res.themes;
      itemStyles.value = res.itemStyles;
      if (!themeId.value && res.themes[0]) themeId.value = res.themes[0].id;
      loaded.value = true;
    } finally {
      loading.value = false;
    }
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

  async function submit() {
    statusError.value = "";
    if (activeTab.value === "BACKGROUND") {
      statusError.value = "Background пока не поддерживается.";
      return;
    }
    if (selList().length === 0 || !themeId.value) {
      statusError.value = isItem.value ? "Выберите стили и тему." : "Выберите бренды и тему.";
      return;
    }
    submitting.value = true;
    try {
      const body = isItem.value
        ? {
            contentType: "ITEM" as const,
            styles: selectedStyles.value,
            themeId: themeId.value,
            prompt: prompt.value,
            perBrandPrompts: perStylePrompts.value,
            imageCount: imageCount.value,
          }
        : {
            contentType: "PERSON" as const,
            brandIds: selectedBrandIds.value,
            themeId: themeId.value,
            refMode: refMode.value,
            prompt: prompt.value,
            perBrandPrompts: perBrandPrompts.value,
            imageCount: imageCount.value,
            referenceImages: refImages.value,
          };
      const res = await useApi()<{ batchId: string; count: number }>("/api/generate", {
        method: "POST",
        body,
      });
      batchId.value = res.batchId;
      startPolling(res.batchId);
    } catch (e: unknown) {
      const code = (e as { data?: { error?: string } })?.data?.error;
      statusError.value = (code && ERROR_MESSAGES[code]) || "Не удалось запустить генерацию.";
    } finally {
      submitting.value = false;
    }
  }

  function startPolling(id: string) {
    if (pollTimer) clearTimeout(pollTimer);
    batchStatus.value = null;
    void pollOnce(id);
  }
  async function pollOnce(id: string) {
    try {
      const s = await useApi()<BatchStatus>(`/api/batches/${id}`);
      batchStatus.value = s;
      if (!s.isComplete) pollTimer = setTimeout(() => void pollOnce(id), 3000);
    } catch {
      pollTimer = setTimeout(() => void pollOnce(id), 5000);
    }
  }
  async function stop() {
    if (!batchId.value) return;
    try {
      await useApi()(`/api/batches/${batchId.value}/stop`, { method: "POST" });
      void pollOnce(batchId.value);
    } catch {
      /* ignore */
    }
  }

  return {
    brands,
    categories,
    themes,
    itemStyles,
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
    selectedBrandIds,
    selectedStyles,
    perBrandPrompts,
    perStylePrompts,
    submitting,
    statusError,
    batchId,
    batchStatus,
    isItem,
    visibleBrands,
    pickerItems,
    currentTargets,
    targetPrompts,
    isRunning,
    canRun,
    isSelected,
    toggleTarget,
    removeTarget,
    clearAll,
    selectAllVisible,
    load,
    toggleFavorite,
    submit,
    stop,
  };
});
