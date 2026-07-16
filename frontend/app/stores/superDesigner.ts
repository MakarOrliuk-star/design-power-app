import { defineStore } from "pinia";

/**
 * Super-designer surface (TASK super-designer): the Create a New Style modal +
 * the Library page, backed by /api/my-brands. Ownership is enforced by the
 * backend; this store only ever sees the caller's own brands.
 */

export interface MyBrand {
  id: string;
  name: string;
  isActive: boolean;
  forcedAspectRatio: string | null;
  createdAt: string;
  categoryIds: string[];
  referenceImages: string[];
  stylePrompt: string;
  personPrompt: string;
  savedTestCount: number;
}

export interface BrandCategoryOption {
  id: string;
  name: string;
}

export interface SavedTest {
  id: string;
  description: string | null;
  generatedImageUrl: string | null;
  createdAt: string;
}

export interface BrandDraft {
  name: string;
  categoryIds: string[];
  personPrompt: string;
  stylePrompt: string;
  referenceImages: string[]; // 3 slots (Cloudinary URLs), "" = empty
  force916: boolean;
}

interface BatchStatusLite {
  isComplete: boolean;
  generations: {
    id: string;
    status: string;
    statusMessage: string | null;
    generatedImageUrl: string | null;
  }[];
}

export const useSuperDesignerStore = defineStore("superDesigner", () => {
  // ---- Modal state (Create a New Style / edit from Library) ----
  const modalOpen = ref(false);
  /** Brand being edited; null → create mode. */
  const editing = ref<MyBrand | null>(null);

  function openCreate() {
    editing.value = null;
    modalOpen.value = true;
  }
  function openEdit(brand: MyBrand) {
    editing.value = brand;
    modalOpen.value = true;
  }
  function close() {
    modalOpen.value = false;
    editing.value = null;
  }

  // ---- Library data ----
  const brands = ref<MyBrand[]>([]);
  const categories = ref<BrandCategoryOption[]>([]);
  const loading = ref(false);
  const loadError = ref("");

  async function loadBrands() {
    loading.value = true;
    loadError.value = "";
    try {
      const res = await useApi()<{ brands: MyBrand[]; categories: BrandCategoryOption[] }>(
        "/api/my-brands",
      );
      brands.value = res.brands;
      categories.value = res.categories;
    } catch {
      loadError.value = "Не удалось загрузить бренды.";
    } finally {
      loading.value = false;
    }
  }

  // ---- Brand CRUD (throws on failure; callers surface the message) ----
  async function createBrand(draft: BrandDraft): Promise<{ id: string; name: string }> {
    const res = await useApi()<{ brand: { id: string; name: string } }>("/api/my-brands", {
      method: "POST",
      body: {
        name: draft.name,
        categoryIds: draft.categoryIds,
        personPrompt: draft.personPrompt,
        stylePrompt: draft.stylePrompt,
        referenceImages: draft.referenceImages.map((s) => s.trim()).filter(Boolean),
        forcedAspectRatio: draft.force916 ? "9:16" : null,
      },
    });
    void loadBrands();
    return res.brand;
  }

  async function updateBrand(id: string, draft: BrandDraft): Promise<void> {
    await useApi()(`/api/my-brands/${id}`, {
      method: "PATCH",
      body: {
        name: draft.name,
        categoryIds: draft.categoryIds,
        personPrompt: draft.personPrompt,
        stylePrompt: draft.stylePrompt,
        referenceImages: draft.referenceImages.map((s) => s.trim()).filter(Boolean),
        forcedAspectRatio: draft.force916 ? "9:16" : null,
      },
    });
    void loadBrands();
  }

  async function deleteBrand(id: string): Promise<void> {
    await useApi()(`/api/my-brands/${id}`, { method: "DELETE" });
    brands.value = brands.value.filter((b) => b.id !== id);
  }

  /** Upload one reference image (base64 data URL) → Cloudinary secure_url. */
  async function uploadRef(dataUrl: string): Promise<string> {
    const res = await useApi()<{ secure_url: string }>("/api/my-brands/upload", {
      method: "POST",
      body: { dataUrl },
    });
    return res.secure_url;
  }

  // ---- «Протестировать бренд» ----
  async function runTest(
    brandId: string,
    prompt: string,
    aspectRatio: "1:1" | "9:16",
  ): Promise<{ batchId: string; generationId: string }> {
    return await useApi()<{ batchId: string; generationId: string }>(
      `/api/my-brands/${brandId}/test`,
      { method: "POST", body: { prompt, aspectRatio } },
    );
  }

  /** One poll tick of the test batch; the modal loops on it every ~3s. */
  async function pollTest(batchId: string): Promise<BatchStatusLite> {
    return await useApi()<BatchStatusLite>(`/api/batches/${batchId}`);
  }

  /** «Сохранить»: the test image lands in Results (isTest → false). */
  async function saveTest(brandId: string, generationId: string): Promise<void> {
    await useApi()(`/api/my-brands/${brandId}/test/${generationId}/save`, { method: "POST" });
  }

  async function loadTests(brandId: string): Promise<SavedTest[]> {
    const res = await useApi()<{ tests: SavedTest[] }>(`/api/my-brands/${brandId}/tests`);
    return res.tests;
  }

  return {
    modalOpen,
    editing,
    openCreate,
    openEdit,
    close,
    brands,
    categories,
    loading,
    loadError,
    loadBrands,
    createBrand,
    updateBrand,
    deleteBrand,
    uploadRef,
    runTest,
    pollTest,
    saveTest,
    loadTests,
  };
});
