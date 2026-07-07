/**
 * Result page logic, extracted from `result.vue` so it can be unit-tested without
 * the Nuxt runtime (TASK Phase 3). The page's reactive state + effects live in
 * `useResult()`; the pieces with real branching are also exposed as PURE functions
 * (`groupImages`, `buildEditBody`, `stepIndex`, `areAllSelected`, `mergeNewImages`)
 * so tests can assert them with zero mocks.
 */
import {
  ref,
  computed,
  watch,
  onMounted,
  onBeforeUnmount,
  type Ref,
  type ComputedRef,
} from "vue";

export type TabKey = "generated" | "person" | "item" | "background" | "edited";
export type SelectMode = "ALL" | "EACH";
export type ContentType = "Person" | "Item" | "Background";

export const TABS: { key: TabKey; label: string; disabled?: boolean }[] = [
  { key: "generated", label: "Generated" },
  { key: "person", label: "Person" },
  { key: "item", label: "Item" },
  { key: "background", label: "Background", disabled: true }, // no pipeline yet (Phase 0 decision)
  { key: "edited", label: "Edited" },
];

export interface GalleryImage {
  id: string;
  brandName: string;
  contentType: ContentType;
  isEdit: boolean;
  theme: string | null;
  description: string | null;
  generatedImageUrl: string;
  createdAt: string;
}
export interface Group {
  id: string;
  type: ContentType;
  state: "Generated" | "Edited";
  brand: string;
  prompt: string;
  images: GalleryImage[];
}

interface GalleryResponse {
  images: GalleryImage[];
  total: number;
  hasMore: boolean;
}

const LIMIT = 50;

// ---------------------------------------------------------------------------
// Pure helpers (no Vue / no Nuxt) — directly unit-tested.
// ---------------------------------------------------------------------------

/**
 * Drop the gender suffix from a brand name (TASK §2): "Goldzino(Men)" and
 * "Goldzino(Women)" both display as "Goldzino". Display-ONLY — the DB keeps the
 * original brandName; only the shown label is normalized. Other parenthesised
 * variants ((Monkey)/(Duck)/(Panda)) and non-parenthesised names are untouched.
 */
export function stripGender(name: string): string {
  return name.replace(/\s*\((?:men|women)\)\s*$/i, "").trim();
}

/**
 * Group images into labelled rows by content type + brand (style) + prompt
 * (TASK §3 "style indication"). The brand is gender-normalized (TASK §2) so a
 * brand's (Men)/(Women) results merge into one row. State badge is "Edited" for
 * edited images, else "Generated"; the order of first appearance is preserved.
 */
export function groupImages(images: GalleryImage[]): Group[] {
  const map = new Map<string, Group>();
  for (const img of images) {
    const brand = stripGender(img.brandName);
    const key = `${img.contentType}__${brand}__${img.description ?? ""}`;
    let g = map.get(key);
    if (!g) {
      g = {
        id: key,
        type: img.contentType,
        state: img.isEdit ? "Edited" : "Generated",
        brand,
        prompt: img.description ?? "",
        images: [],
      };
      map.set(key, g);
    }
    g.images.push(img);
  }
  return [...map.values()];
}

/**
 * Wrap-around index for the fullscreen viewer. Returns -1 for an empty list or an
 * out-of-range current index (nothing to step from).
 */
export function stepIndex(current: number, delta: number, length: number): number {
  if (length === 0 || current < 0) return -1;
  return (current + delta + length) % length;
}

/** True only when every id is currently selected (and there is at least one). */
export function areAllSelected(ids: string[], selected: Set<string>): boolean {
  return ids.length > 0 && ids.every((id) => selected.has(id));
}

/**
 * Real-time merge (TASK §6): prepend only images whose id isn't already shown.
 * Duplicates are ignored so polling never double-inserts. Returns the (possibly
 * unchanged) list plus how many were genuinely new.
 */
export function mergeNewImages(
  existing: GalleryImage[],
  incoming: GalleryImage[],
): { images: GalleryImage[]; added: number } {
  const have = new Set(existing.map((i) => i.id));
  const added = incoming.filter((i) => !have.has(i.id));
  return { images: added.length ? [...added, ...existing] : existing, added: added.length };
}

/** Extra pixels to outpaint on each side (in SOURCE-image pixels). */
export interface Pad {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Clamp each side of a pad to [0, dimension] — matches the backend cap (a side
 * may grow by at most 100% of that dimension). Used while dragging the Scale
 * canvas so the preview never promises more than the server will honour.
 */
export function capPad(pad: Pad, natural: { width: number; height: number }): Pad {
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);
  return {
    top: clamp(pad.top, natural.height),
    bottom: clamp(pad.bottom, natural.height),
    left: clamp(pad.left, natural.width),
    right: clamp(pad.right, natural.width),
  };
}

/** Append a cache-busting query param so a replaced image reloads fresh bytes. */
export function bustCache(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}v=${Date.now()}`;
}

/** Free move/zoom outpaint: target canvas + scaled image size + position (source px). */
export interface Placement {
  canvasW: number;
  canvasH: number;
  imgW: number;
  imgH: number;
  imgX: number;
  imgY: number;
}

/** Inpaint request: a painted binary mask (data URL) + what to do with it. */
export interface InpaintPayload {
  maskDataUrl: string;
  mode: "fill" | "erase";
  prompt?: string;
}

/** Map a Scale/Inpaint backend error code to a user-facing message. */
export function mapScaleError(code: string | undefined): string {
  switch (code) {
    case "scale_pipeline_not_configured":
      return "Scale не настроен (нет ключей fal / Cloudinary).";
    case "expand_failed":
      return "Не удалось дорисовать изображение — попробуйте меньшее расширение.";
    case "inpaint_failed":
      return "Не удалось обработать область — попробуйте другую маску.";
    case "empty_prompt":
      return "Введите промпт для дорисовки области.";
    case "prompt_translation_failed":
      return "Не удалось перевести промпт — попробуйте написать его по-английски.";
    case "mask_upload_failed":
    case "upload_failed":
      return "Не удалось сохранить результат.";
    default:
      return "Не удалось выполнить операцию.";
  }
}

export type EditBuildResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Build the POST /api/generate/edit body from the current selection (TASK §5).
 * ALL mode → one shared `prompt`; EACH mode → a `perPrompts` map keyed by image
 * id. Returns a user-facing error string when a required prompt is missing.
 * `no_selection` is a sentinel (the UI guards/disables that case separately).
 */
export function buildEditBody(
  mode: SelectMode,
  selected: GalleryImage[],
  sharedPrompt: string,
  perPrompts: Record<string, string>,
): EditBuildResult {
  if (!selected.length) return { ok: false, error: "no_selection" };
  const generationIds = selected.map((i) => i.id);

  if (mode === "ALL") {
    const prompt = sharedPrompt.trim();
    if (!prompt) return { ok: false, error: "Введите промпт для редактирования." };
    return { ok: true, body: { generationIds, prompt } };
  }

  const resolved: Record<string, string> = {};
  for (const img of selected) {
    const p = (perPrompts[img.id] ?? "").trim();
    if (!p) return { ok: false, error: "Заполните промпт для каждой выбранной картинки." };
    resolved[img.id] = p;
  }
  return { ok: true, body: { generationIds, perPrompts: resolved } };
}

// ---------------------------------------------------------------------------
// Composable — wires the pure helpers into the page's reactive state + effects.
// `api`/`gen` are injected so the composable is testable without Nuxt/Pinia.
// ---------------------------------------------------------------------------

export interface ResultApi {
  <T = unknown>(request: string, opts?: Record<string, unknown>): Promise<T>;
}
export interface ResultGen {
  runningCount: number;
  addBatch(id: string, kind: "person" | "item"): void;
}

export function useResult(deps: { api: ResultApi; gen: ResultGen }) {
  const { api, gen } = deps;

  const activeTab = ref<TabKey>("generated");
  const selectMode = ref<SelectMode>("ALL");

  const images = ref<GalleryImage[]>([]);
  const total = ref(0);
  const hasMore = ref(false);
  const loading = ref(false);

  async function load(reset = true) {
    loading.value = true;
    try {
      const offset = reset ? 0 : images.value.length;
      const res = await api<GalleryResponse>("/api/generations", {
        query: { tab: activeTab.value, limit: LIMIT, offset },
      });
      images.value = reset ? res.images : [...images.value, ...res.images];
      total.value = res.total;
      hasMore.value = res.hasMore;
    } catch {
      if (reset) {
        images.value = [];
        total.value = 0;
        hasMore.value = false;
      }
    } finally {
      loading.value = false;
    }
  }

  const groups: ComputedRef<Group[]> = computed(() => groupImages(images.value));

  function selectTab(key: TabKey) {
    if (activeTab.value === key) return;
    activeTab.value = key;
    selected.value = new Set();
    newReadyCount.value = 0;
    closeViewer();
    void load();
  }

  // ---- Selection ----
  const selected = ref<Set<string>>(new Set());
  function toggleSelect(id: string) {
    const next = new Set(selected.value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selected.value = next;
  }
  function isSelected(id: string) {
    return selected.value.has(id);
  }

  const allImageIds = computed(() => images.value.map((i) => i.id));
  const allSelected = computed(() => areAllSelected(allImageIds.value, selected.value));
  function toggleSelectAll() {
    selected.value = allSelected.value ? new Set() : new Set(allImageIds.value);
  }

  const selectedImages = computed(() => images.value.filter((i) => selected.value.has(i.id)));

  // ---- Edit flow (Phase 4) ----
  const editPrompt = ref(""); // ALL mode: one shared instruction
  const perEditPrompts = ref<Record<string, string>>({}); // EACH mode: per-image
  const editing = ref(false);
  const editError = ref("");
  const editMsg = ref("");

  async function runEdit() {
    if (!selectedImages.value.length) return;
    editError.value = "";
    editMsg.value = "";

    const built = buildEditBody(
      selectMode.value,
      selectedImages.value,
      editPrompt.value,
      perEditPrompts.value,
    );
    if (!built.ok) {
      if (built.error !== "no_selection") editError.value = built.error;
      return;
    }

    editing.value = true;
    try {
      const res = await api<{ batchId: string; count: number }>("/api/generate/edit", {
        method: "POST",
        body: built.body,
      });
      // Track in the generator store → toolbar progress + completion toast + drives
      // the Result-page auto-refresh below (TASK §6).
      gen.addBatch(res.batchId, "item");
      editMsg.value = "Отправлено! Результат появится во вкладке Edited.";
      selected.value = new Set();
      editPrompt.value = "";
      perEditPrompts.value = {};
      activeTab.value = "edited";
      void load();
    } catch (e: unknown) {
      const code = (e as { data?: { error?: string } })?.data?.error;
      editError.value =
        code === "edit_pipeline_not_configured"
          ? "Редактирование не настроено (нет ключей fal / Cloudinary)."
          : "Не удалось запустить редактирование.";
    } finally {
      editing.value = false;
    }
  }

  // ---- Scale editor (TASK §1): outpaint (expand/transform) + inpaint (fill/erase) ----
  // Enabled only when EXACTLY one image is selected. The ScalePanel owns the Konva
  // canvas and hands back either an outpaint payload (`pad` OR `placement`) or an
  // inpaint payload (mask + mode). On success we swap the source image's URL in
  // place (cache-busted) so the gallery shows the result without a reload.
  const scaleTarget = computed(() => (selectedImages.value.length === 1 ? selectedImages.value[0]! : null));
  const canScale = computed(() => selectedImages.value.length === 1);
  const scaling = ref(false);
  const scaleError = ref("");
  const scaleMsg = ref("");

  // Replace the target's URL in place (cache-busted) from a POST result.
  function applyReplacement(res: { generationId: string; generatedImageUrl: string }) {
    const bust = bustCache(res.generatedImageUrl);
    images.value = images.value.map((i) =>
      i.id === res.generationId ? { ...i, generatedImageUrl: bust } : i,
    );
  }

  async function runScale(payload: { pad?: Pad; placement?: Placement; prompt?: string }) {
    const target = scaleTarget.value;
    if (!target || scaling.value) return;
    scaleError.value = "";
    scaleMsg.value = "";
    scaling.value = true;
    try {
      const prompt = payload.prompt?.trim();
      const res = await api<{ generationId: string; generatedImageUrl: string }>("/api/generate/scale", {
        method: "POST",
        body: {
          generationId: target.id,
          ...(payload.pad ? { pad: payload.pad } : {}),
          ...(payload.placement ? { placement: payload.placement } : {}),
          ...(prompt ? { prompt } : {}),
        },
      });
      applyReplacement(res);
      scaleMsg.value = "Готово! Изображение расширено и улучшено.";
    } catch (e: unknown) {
      scaleError.value = mapScaleError((e as { data?: { error?: string } })?.data?.error);
    } finally {
      scaling.value = false;
    }
  }

  async function runInpaint(payload: InpaintPayload) {
    const target = scaleTarget.value;
    if (!target || scaling.value) return;
    scaleError.value = "";
    scaleMsg.value = "";
    scaling.value = true;
    try {
      const prompt = payload.prompt?.trim();
      const res = await api<{ generationId: string; generatedImageUrl: string }>("/api/generate/inpaint", {
        method: "POST",
        body: {
          generationId: target.id,
          maskDataUrl: payload.maskDataUrl,
          mode: payload.mode,
          ...(prompt ? { prompt } : {}),
        },
      });
      applyReplacement(res);
      scaleMsg.value = payload.mode === "erase" ? "Готово! Объект удалён." : "Готово! Область дорисована.";
    } catch (e: unknown) {
      scaleError.value = mapScaleError((e as { data?: { error?: string } })?.data?.error);
    } finally {
      scaling.value = false;
    }
  }

  // ---- Image viewer (Phase 3) ----
  // Navigate in display order (grouped), wrapping with ←/→; Esc closes. Tracked by
  // image id (not index) so auto-refresh prepending new images never makes the open
  // image jump; if the viewed image leaves the list, the modal closes itself.
  const flatImages = computed(() => groups.value.flatMap((g) => g.images));
  const viewerId = ref<string | null>(null);
  const viewerIndex = computed(() =>
    viewerId.value === null ? -1 : flatImages.value.findIndex((i) => i.id === viewerId.value),
  );
  const viewerImage = computed(() => {
    const i = viewerIndex.value;
    return i >= 0 ? flatImages.value[i] ?? null : null;
  });
  const viewerOpen = computed(() => viewerImage.value !== null);

  function openViewer(img: GalleryImage) {
    viewerId.value = img.id;
  }
  function closeViewer() {
    viewerId.value = null;
  }
  function viewerStep(delta: number) {
    const next = stepIndex(viewerIndex.value, delta, flatImages.value.length);
    if (next < 0) return;
    viewerId.value = flatImages.value[next]?.id ?? null;
  }
  function onKey(e: KeyboardEvent) {
    if (!viewerOpen.value) return;
    if (e.key === "Escape") closeViewer();
    else if (e.key === "ArrowLeft") viewerStep(-1);
    else if (e.key === "ArrowRight") viewerStep(1);
  }

  // Lock background scroll while the fullscreen viewer is open.
  watch(viewerOpen, (open) => {
    if (import.meta.client) document.body.style.overflow = open ? "hidden" : "";
  });

  // Clear Scale feedback whenever the target image changes (or is deselected).
  watch(
    () => scaleTarget.value?.id ?? null,
    () => {
      scaleError.value = "";
      scaleMsg.value = "";
    },
  );

  // ---- Real-time auto-refresh (Phase 5, TASK §6) ----
  // While any batch is in flight, poll the current tab and merge freshly-finished
  // images to the front; surface a "Готово" banner with how many newly arrived.
  const newReadyCount = ref(0);
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  async function refresh() {
    try {
      const res = await api<GalleryResponse>("/api/generations", {
        query: { tab: activeTab.value, limit: LIMIT, offset: 0 },
      });
      total.value = res.total;
      const { images: merged, added } = mergeNewImages(images.value, res.images);
      if (added) {
        images.value = merged;
        newReadyCount.value += added;
      }
    } catch {
      /* transient — try again next tick */
    }
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => void refresh(), 3000);
  }
  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }
  function dismissReady() {
    newReadyCount.value = 0;
  }

  watch(
    () => gen.runningCount,
    (n) => {
      if (n > 0) startPolling();
      else {
        stopPolling();
        void refresh(); // final catch-up for the last completions
      }
    },
  );

  onMounted(() => {
    void load();
    window.addEventListener("keydown", onKey);
    if (gen.runningCount > 0) startPolling();
  });
  onBeforeUnmount(() => {
    window.removeEventListener("keydown", onKey);
    stopPolling();
    if (import.meta.client) document.body.style.overflow = "";
  });

  return {
    // tabs + mode
    TABS,
    activeTab,
    selectMode,
    selectTab,
    // gallery
    images,
    groups,
    total,
    hasMore,
    loading,
    load,
    // selection
    selected,
    toggleSelect,
    isSelected,
    allSelected,
    toggleSelectAll,
    selectedImages,
    // edit
    editPrompt,
    perEditPrompts,
    editing,
    editError,
    editMsg,
    runEdit,
    // scale / inpaint editor
    scaleTarget,
    canScale,
    scaling,
    scaleError,
    scaleMsg,
    runScale,
    runInpaint,
    // viewer
    flatImages,
    viewerId,
    viewerIndex,
    viewerImage,
    viewerOpen,
    openViewer,
    closeViewer,
    viewerStep,
    onKey,
    // real-time
    newReadyCount,
    dismissReady,
    refresh,
    startPolling,
    stopPolling,
  };
}
