import { defineStore } from "pinia";
import type { TournamentMode } from "~/types/tournament";

/**
 * «Edit Tournament pack» (TASK tournament-pack): the super-designer's window on
 * Home, opened from the user menu next to «Edit current style». It edits the
 * SAME global tournament data as the admin panel, but through the audited
 * /api/tournament-pack surface — every save is logged and elements can be
 * rolled back.
 *
 * Named *Editor* on purpose: components/result/TournamentPack.vue is a totally
 * different thing (a pack of generated images on the Result page).
 *
 * Like superDesigner.ts, the store owns the modal flag and the API calls; the
 * draft/dirty bookkeeping lives in the component, on the pure helpers below.
 */

export interface PackPrompt {
  mode: TournamentMode;
  content: string;
  updatedAt: string;
}

export interface PackElement {
  id: string;
  name: string;
  nameVip: string | null;
  order: number;
  isActive: boolean;
  referenceImages: string[];
  prompts: PackPrompt[];
}

export interface PackCategory {
  id: string;
  key: string;
  name: string;
  hasModes: boolean;
  fixedMode: TournamentMode | null;
  order: number;
  elements: PackElement[];
}

/** What the right column edits until «Сохранить (для всех)» is pressed. */
export interface ElementDraft {
  name: string;
  nameVip: string;
  isActive: boolean;
  referenceImages: string[]; // 2 slots, provider categories only
  prompts: Partial<Record<TournamentMode, string>>;
}

/** The PATCH body — also the value the dirty check serializes. */
export interface ElementPatch {
  name: string;
  nameVip?: string;
  isActive: boolean;
  referenceImages?: string[];
  prompts: { mode: TournamentMode; content: string }[];
}

/** Categories whose elements carry the 2 provider reference images. */
export const PROVIDER_CATEGORY_KEY = "provider";

// ---------------------------------------------------------------------------
// Pure helpers (no Vue / no Nuxt) — directly unit-tested, mirroring tournament.ts
// ---------------------------------------------------------------------------

/** Which prompt modes an element of this category carries (mirrors the backend). */
export function modesOf(cat: Pick<PackCategory, "hasModes" | "fixedMode">): TournamentMode[] {
  return cat.hasModes ? ["BASE", "VIP"] : [cat.fixedMode ?? "BASE"];
}

/** Provider elements always show exactly 2 reference slots, filled or not. */
export function padTo2(arr: string[]): string[] {
  const a = [...arr];
  while (a.length < 2) a.push("");
  return a.slice(0, 2);
}

export function hasProviderRefs(cat: Pick<PackCategory, "key">): boolean {
  return cat.key === PROVIDER_CATEGORY_KEY;
}

/** Element row → editable draft. Missing prompts start empty, never undefined. */
export function draftOf(cat: PackCategory, el: PackElement): ElementDraft {
  const prompts: Partial<Record<TournamentMode, string>> = {};
  for (const mode of modesOf(cat)) {
    prompts[mode] = el.prompts.find((p) => p.mode === mode)?.content ?? "";
  }
  return {
    name: el.name,
    nameVip: el.nameVip ?? "",
    isActive: el.isActive,
    referenceImages: padTo2(el.referenceImages),
    prompts,
  };
}

/**
 * Draft → PATCH body. Keys the category cannot carry are omitted entirely
 * (a VIP name on a fixed-mode category is a 400, provider refs elsewhere are
 * meaningless), so the payload always matches what the backend accepts.
 */
export function patchOf(cat: PackCategory, draft: ElementDraft): ElementPatch {
  const patch: ElementPatch = {
    name: draft.name.trim(),
    isActive: draft.isActive,
    prompts: modesOf(cat)
      .map((mode) => ({ mode, content: (draft.prompts[mode] ?? "").trim() }))
      .filter((p) => p.content.length > 0),
  };
  if (cat.hasModes) patch.nameVip = draft.nameVip.trim();
  if (hasProviderRefs(cat)) {
    patch.referenceImages = draft.referenceImages.map((s) => s.trim()).filter(Boolean);
  }
  return patch;
}

/** Stable string for the unsaved-changes guard. */
export function serializeDraft(cat: PackCategory, draft: ElementDraft): string {
  return JSON.stringify(patchOf(cat, draft));
}

/**
 * Why a draft cannot be saved yet, or "" when it can. Mirrors the backend's
 * own rules so the user gets a message instead of a 400/409.
 */
export function draftError(cat: PackCategory, draft: ElementDraft): string {
  if (!draft.name.trim()) return "Укажите название элемента.";
  if (cat.hasModes && !draft.nameVip.trim()) return "Укажите название для VIP.";
  const empty = modesOf(cat).filter((mode) => !(draft.prompts[mode] ?? "").trim());
  if (empty.length) {
    return cat.hasModes
      ? `Промпт ${empty.join(" и ")} не может быть пустым.`
      : "Промпт не может быть пустым.";
  }
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
    vip_name_required: "Укажите название для VIP.",
    vip_not_applicable: "У этой категории нет VIP-названий.",
    invalid_mode: "Этот режим промпта недоступен для категории.",
    nothing_to_rollback: "Нет предыдущей версии для отката.",
    element_not_found: "Элемент не найден — обновите окно.",
    category_not_found: "Категория не найдена — обновите окно.",
    invalid_mode_config: "Выберите режим категории (Base / VIP).",
    invalid_ids: "Список элементов устарел — обновите окно.",
    file_too_large: "Картинка слишком большая (до 10 МБ).",
    cloudinary_not_configured: "Загрузка картинок не настроена на сервере.",
  };
  return (code && MESSAGES[code]) || fallback;
}

// ---------------------------------------------------------------------------

export const useTournamentPackEditorStore = defineStore("tournamentPackEditor", () => {
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
      "/api/tournament-pack/config",
    );
    categories.value = res.categories;
    systemPrompt.value = res.systemPrompt;
  }

  // ---- Elements (throw on failure; the modal surfaces the message) ----

  async function createElement(
    categoryId: string,
    name: string,
    nameVip?: string,
  ): Promise<string> {
    const res = await useApi()<{ element: { id: string } }>("/api/tournament-pack/elements", {
      method: "POST",
      body: { categoryId, name, ...(nameVip ? { nameVip } : {}) },
    });
    return res.element.id;
  }

  /** «Сохранить (для всех)»: one audited write of the entire element. */
  async function saveElement(id: string, patch: ElementPatch): Promise<boolean> {
    const res = await useApi()<{ changed: boolean }>(`/api/tournament-pack/elements/${id}`, {
      method: "PATCH",
      body: patch,
    });
    return res.changed;
  }

  /** Soft delete — the element disappears from /tournaments, history keeps it. */
  async function deleteElement(id: string): Promise<void> {
    await useApi()(`/api/tournament-pack/elements/${id}`, { method: "DELETE" });
  }

  async function rollbackElement(id: string): Promise<void> {
    await useApi()(`/api/tournament-pack/elements/${id}/rollback`, { method: "POST" });
  }

  /** Applied immediately (not part of the draft) — position is not text. */
  async function reorderElements(categoryId: string, orderedIds: string[]): Promise<void> {
    await useApi()("/api/tournament-pack/elements/reorder", {
      method: "POST",
      body: { categoryId, orderedIds },
    });
  }

  // ---- Categories ----

  async function createCategory(
    name: string,
    mode: "BOTH" | "BASE" | "VIP",
  ): Promise<{ id: string }> {
    const res = await useApi()<{ category: { id: string } }>("/api/tournament-pack/categories", {
      method: "POST",
      body: { name, hasModes: mode === "BOTH", fixedMode: mode === "BOTH" ? null : mode },
    });
    return res.category;
  }

  async function renameCategory(id: string, name: string): Promise<void> {
    await useApi()(`/api/tournament-pack/categories/${id}`, { method: "PATCH", body: { name } });
  }

  /** HARD delete: elements, default prompts and every designer's local edits. */
  async function deleteCategory(id: string): Promise<void> {
    await useApi()(`/api/tournament-pack/categories/${id}`, { method: "DELETE" });
  }

  async function reorderCategories(orderedIds: string[]): Promise<void> {
    await useApi()("/api/tournament-pack/categories/reorder", {
      method: "POST",
      body: { orderedIds },
    });
  }

  // ---- System wrapper + uploads ----

  async function saveSystemPrompt(content: string): Promise<void> {
    const res = await useApi()<{ systemPrompt: string }>("/api/tournament-pack/system-prompt", {
      method: "PUT",
      body: { content },
    });
    systemPrompt.value = res.systemPrompt;
  }

  async function uploadRef(dataUrl: string): Promise<string> {
    const res = await useApi()<{ secure_url: string }>("/api/tournament-pack/upload", {
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
    deleteCategory,
    reorderCategories,
    saveSystemPrompt,
    uploadRef,
  };
});
