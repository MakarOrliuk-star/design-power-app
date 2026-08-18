import { defineStore } from "pinia";

/**
 * «Edit Welcome packs» (TASK welcome-packs): the super-designer's window, opened
 * from the user menu next to «Edit Tournament pack». It edits the SAME global
 * Welcome data as the admin panel, but through the audited /api/welcome-pack
 * surface — every save is logged and elements can be rolled back.
 *
 * Named *Editor* on purpose: components/result/WelcomePack.vue is a totally
 * different thing (a pack of generated images on the Result page).
 *
 * Like tournamentPackEditor.ts, the store owns the modal flag and the API calls;
 * the draft/dirty bookkeeping lives in the component, on the pure helpers below.
 * Unlike it, an element carries ONE prompt and "own references" is a category
 * flag rather than a hardcoded key.
 */

export interface PackElement {
  id: string;
  name: string;
  order: number;
  isActive: boolean;
  referenceImages: string[];
  prompt: { content: string; updatedAt: string } | null;
}

export interface PackCategory {
  id: string;
  key: string;
  name: string;
  usesOwnReferences: boolean;
  order: number;
  elements: PackElement[];
}

/** What the right column edits until «Сохранить (для всех)» is pressed. */
export interface ElementDraft {
  name: string;
  isActive: boolean;
  referenceImages: string[]; // 2 slots, own-reference categories only
  prompt: string;
}

/** The PATCH body — also the value the dirty check serializes. */
export interface ElementPatch {
  name: string;
  isActive: boolean;
  referenceImages?: string[];
  prompt?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (no Vue / no Nuxt) — directly unit-tested, mirroring welcome.ts
// ---------------------------------------------------------------------------

/** Own-reference elements always show exactly 2 slots, filled or not. */
export function padTo2(arr: string[]): string[] {
  const a = [...arr];
  while (a.length < 2) a.push("");
  return a.slice(0, 2);
}

/** Whether this category's elements carry their own reference images. */
export function hasOwnRefs(cat: Pick<PackCategory, "usesOwnReferences">): boolean {
  return cat.usesOwnReferences;
}

/** Element row → editable draft. A missing prompt starts empty, never undefined. */
export function draftOf(_cat: PackCategory, el: PackElement): ElementDraft {
  return {
    name: el.name,
    isActive: el.isActive,
    referenceImages: padTo2(el.referenceImages),
    prompt: el.prompt?.content ?? "",
  };
}

/**
 * Draft → PATCH body. Reference images are omitted entirely for categories that
 * don't use their own (they would be meaningless there), so the payload always
 * matches what the backend accepts.
 */
export function patchOf(cat: PackCategory, draft: ElementDraft): ElementPatch {
  const patch: ElementPatch = {
    name: draft.name.trim(),
    isActive: draft.isActive,
  };
  const prompt = draft.prompt.trim();
  if (prompt) patch.prompt = prompt;
  if (hasOwnRefs(cat)) {
    patch.referenceImages = draft.referenceImages.map((s) => s.trim()).filter(Boolean);
  }
  return patch;
}

/** Stable string for the unsaved-changes guard. */
export function serializeDraft(cat: PackCategory, draft: ElementDraft): string {
  return JSON.stringify(patchOf(cat, draft));
}

/**
 * Why a draft cannot be saved yet, or "" when it can. Mirrors the backend's own
 * rules so the user gets a message instead of a 400/409.
 */
export function draftError(_cat: PackCategory, draft: ElementDraft): string {
  if (!draft.name.trim()) return "Укажите название элемента.";
  if (!draft.prompt.trim()) return "Промпт не может быть пустым.";
  return "";
}

/**
 * The ↑/↓ buttons: the id moved one slot, or the SAME array when it is already
 * at the edge (the caller then skips the request entirely).
 */
export function movedIds(ids: string[], id: string, dir: -1 | 1): string[] {
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return ids;
  const next = [...ids];
  next[i] = ids[j] as string;
  next[j] = id;
  return next;
}

/** Backend error code → what the user reads. */
export function packErrorMessage(code: string | undefined, fallback: string): string {
  const MESSAGES: Record<string, string> = {
    already_exists: "Такое название уже занято в этой категории.",
    nothing_to_rollback: "Нет предыдущей версии для отката.",
    element_not_found: "Элемент не найден — обновите окно.",
    category_not_found: "Категория не найдена — обновите окно.",
    invalid_ids: "Список элементов устарел — обновите окно.",
    file_too_large: "Картинка слишком большая (до 10 МБ).",
    cloudinary_not_configured: "Загрузка картинок не настроена на сервере.",
  };
  return (code && MESSAGES[code]) || fallback;
}

// ---------------------------------------------------------------------------

export const useWelcomePackEditorStore = defineStore("welcomePackEditor", () => {
  const modalOpen = ref(false);
  const categories = ref<PackCategory[]>([]);
  const systemPrompt = ref("");

  function open() {
    modalOpen.value = true;
  }
  function close() {
    modalOpen.value = false;
  }

  /** Reload the whole pack — every mutation below ends with one of these. */
  async function loadConfig(): Promise<void> {
    const res = await useApi()<{ categories: PackCategory[]; systemPrompt: string }>(
      "/api/welcome-pack/config",
    );
    categories.value = res.categories;
    systemPrompt.value = res.systemPrompt;
  }

  // ---- Elements (throw on failure; the modal surfaces the message) ----

  async function createElement(categoryId: string, name: string): Promise<string> {
    const res = await useApi()<{ element: { id: string } }>("/api/welcome-pack/elements", {
      method: "POST",
      body: { categoryId, name },
    });
    return res.element.id;
  }

  /** «Сохранить (для всех)»: one audited write of the entire element. */
  async function saveElement(id: string, patch: ElementPatch): Promise<boolean> {
    const res = await useApi()<{ changed: boolean }>(`/api/welcome-pack/elements/${id}`, {
      method: "PATCH",
      body: patch,
    });
    return res.changed;
  }

  /** Soft delete — the element disappears from /welcome-packs, history keeps it. */
  async function deleteElement(id: string): Promise<void> {
    await useApi()(`/api/welcome-pack/elements/${id}`, { method: "DELETE" });
  }

  async function rollbackElement(id: string): Promise<void> {
    await useApi()(`/api/welcome-pack/elements/${id}/rollback`, { method: "POST" });
  }

  /** Applied immediately (not part of the draft) — position is not text. */
  async function reorderElements(categoryId: string, orderedIds: string[]): Promise<void> {
    await useApi()("/api/welcome-pack/elements/reorder", {
      method: "POST",
      body: { categoryId, orderedIds },
    });
  }

  // ---- Categories ----

  async function createCategory(name: string, usesOwnReferences: boolean): Promise<{ id: string }> {
    const res = await useApi()<{ category: { id: string } }>("/api/welcome-pack/categories", {
      method: "POST",
      body: { name, usesOwnReferences },
    });
    return res.category;
  }

  async function renameCategory(id: string, name: string): Promise<void> {
    await useApi()(`/api/welcome-pack/categories/${id}`, { method: "PATCH", body: { name } });
  }

  /** The own-references checkbox. Uploaded images survive it being turned off. */
  async function setCategoryOwnRefs(id: string, usesOwnReferences: boolean): Promise<void> {
    await useApi()(`/api/welcome-pack/categories/${id}`, {
      method: "PATCH",
      body: { usesOwnReferences },
    });
  }

  /** HARD delete: elements, default prompts and every designer's local edits. */
  async function deleteCategory(id: string): Promise<void> {
    await useApi()(`/api/welcome-pack/categories/${id}`, { method: "DELETE" });
  }

  async function reorderCategories(orderedIds: string[]): Promise<void> {
    await useApi()("/api/welcome-pack/categories/reorder", {
      method: "POST",
      body: { orderedIds },
    });
  }

  // ---- System wrapper + uploads ----

  async function saveSystemPrompt(content: string): Promise<void> {
    const res = await useApi()<{ systemPrompt: string }>("/api/welcome-pack/system-prompt", {
      method: "PUT",
      body: { content },
    });
    systemPrompt.value = res.systemPrompt;
  }

  async function uploadRef(dataUrl: string): Promise<string> {
    const res = await useApi()<{ secure_url: string }>("/api/welcome-pack/upload", {
      method: "POST",
      body: { dataUrl },
    });
    return res.secure_url;
  }

  return {
    modalOpen,
    categories,
    systemPrompt,
    open,
    close,
    loadConfig,
    createElement,
    saveElement,
    deleteElement,
    rollbackElement,
    reorderElements,
    createCategory,
    renameCategory,
    setCategoryOwnRefs,
    deleteCategory,
    reorderCategories,
    saveSystemPrompt,
    uploadRef,
  };
});
