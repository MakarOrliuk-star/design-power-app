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

// ---- «Edit current style» (TASK download-and-edit-style §2) ----
// Any-brand editing, audited on the backend (BrandChangeLog + rollback).

export interface EditableBrandListItem {
  id: string;
  name: string;
  isActive: boolean;
}

export interface ModelOption {
  key: string;
  label: string;
}

/** Full editable state of a brand, as served by GET /editable/:id. */
export interface EditableBrand {
  id: string;
  name: string;
  categoryIds: string[];
  personPrompt: string;
  stylePrompt: string;
  referenceImages: string[];
  forcedAspectRatio: string | null;
  imageModel: string | null;
  isActive: boolean;
  canRollback: boolean;
}

// imageModel is deliberately absent: the model override stays admin-only (the
// «Модель генерации» select was dropped from the edit modal), so the PATCH
// never touches it and the draft test always uses the brand's saved model.
export interface EditablePatch {
  name: string;
  categoryIds: string[];
  personPrompt: string;
  stylePrompt: string;
  referenceImages: string[];
  forcedAspectRatio: string | null;
  isActive: boolean;
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
  /** «Edit current style»: any-brand edit mode (dropdown inside the modal). */
  const editAnyMode = ref(false);

  function openCreate() {
    editing.value = null;
    editAnyMode.value = false;
    modalOpen.value = true;
  }
  function openEdit(brand: MyBrand) {
    editing.value = brand;
    editAnyMode.value = false;
    modalOpen.value = true;
  }
  function openEditCurrent() {
    editing.value = null;
    editAnyMode.value = true;
    modalOpen.value = true;
  }
  function close() {
    modalOpen.value = false;
    editing.value = null;
    editAnyMode.value = false;
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

  // ---- «Edit current style»: any-brand editing (audited on the backend) ----
  const editableBrands = ref<EditableBrandListItem[]>([]);
  const models = ref<ModelOption[]>([]);

  async function loadEditable(): Promise<void> {
    const res = await useApi()<{
      brands: EditableBrandListItem[];
      categories: BrandCategoryOption[];
      models: ModelOption[];
    }>("/api/my-brands/editable");
    editableBrands.value = res.brands;
    categories.value = res.categories;
    models.value = res.models;
  }

  async function loadEditableBrand(id: string): Promise<EditableBrand> {
    return await useApi()<EditableBrand>(`/api/my-brands/editable/${id}`);
  }

  /** «Сохранить»: applies GLOBALLY for every user; logged with before/after. */
  async function updateEditable(id: string, patch: EditablePatch): Promise<EditableBrand | null> {
    const res = await useApi()<{ snapshot: Omit<EditableBrand, "id" | "canRollback"> | null }>(
      `/api/my-brands/editable/${id}`,
      { method: "PATCH", body: patch },
    );
    return res.snapshot ? { ...res.snapshot, id, canRollback: true } : null;
  }

  /** «Вернуть предыдущую версию»: restore the latest change-log `before`. */
  async function rollbackEditable(id: string): Promise<void> {
    await useApi()(`/api/my-brands/editable/${id}/rollback`, { method: "POST" });
  }

  /** Test the DRAFT (unsaved) state — nothing is written to the brand. */
  async function runDraftTest(
    id: string,
    body: {
      prompt: string;
      aspectRatio: "1:1" | "9:16";
      personPrompt: string;
      referenceImages: string[];
    },
  ): Promise<{ batchId: string; generationId: string }> {
    return await useApi()<{ batchId: string; generationId: string }>(
      `/api/my-brands/editable/${id}/test`,
      { method: "POST", body },
    );
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
    editAnyMode,
    openCreate,
    openEdit,
    openEditCurrent,
    close,
    editableBrands,
    models,
    loadEditable,
    loadEditableBrand,
    updateEditable,
    rollbackEditable,
    runDraftTest,
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
