/**
 * Result → "Tournament Pack" tab (Phase 6). The tab shows the user's tournament
 * batch history (newest first), each batch grouped by Brand_Element pack with
 * the fixed file names, and exports a DES-1XXXXX.zip — either the whole batch
 * or the ticked images. Mirrors useArchive: the branching pieces are pure
 * exported helpers, `api`/`apiBase`/`download`/`gen` are injected for tests.
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import {
  bustCache,
  mapScaleError,
  buildEditBody,
  type SelectMode,
  type Pad,
  type Placement,
  type InpaintPayload,
} from "./useResult";

export type PackMode = "BASE" | "VIP";

export interface PackGeneration {
  id: string;
  status: string; // QUEUED | PROCESSING | DONE | FAILED | CANCELLED | ...
  statusMessage: string | null;
  generatedImageUrl: string | null;
  brandName: string;
  tourCategoryKey: string | null;
  tourElementName: string | null;
  tourMode: PackMode | null;
  tourFileName: string | null; // "Bonuskong_Tournament_1_2"
}

export interface PackBatch {
  id: string;
  status: string; // IN_PROGRESS | COMPLETED | PARTIAL_FAILURE | FAILED | CANCELLED
  createdAt: string;
  generations: PackGeneration[];
}

interface PacksResponse {
  batches: PackBatch[];
  total: number;
  hasMore: boolean;
}

const LIMIT = 10;

// ---------------------------------------------------------------------------
// Pure helpers (no Vue / no Nuxt) — directly unit-tested.
// ---------------------------------------------------------------------------

/**
 * Query string for GET /api/tournament/export.zip. An explicit selection wins
 * over the batch (mirrors the Archive export contract).
 */
export function buildPackExportQuery(p: { batchId?: string; ids?: string[] }): string {
  const q = new URLSearchParams();
  if (p.ids && p.ids.length) q.set("ids", p.ids.join(","));
  else if (p.batchId) q.set("batchId", p.batchId);
  return q.toString();
}

export interface PackGroup {
  key: string; // "Bonuskong" — the brand folder at the ZIP root
  categoryKey: string; // category of the group's first image (informational)
  title: string; // "Bonuskong" (the ZIP brand folder)
  images: PackGeneration[];
}

/** "Bonuskong_Tournament_1_2" -> its pack folder "Bonuskong_Tournament_1". */
export function packFolderOf(fileName: string): string {
  return fileName.replace(/_\d+$/, "");
}

/** Mirror of the backend sanitizeName: parens dropped, spaces -> "_". */
export function sanitizeName(s: string): string {
  return s.replace(/[()]/g, "").trim().replace(/\s+/g, "_");
}

/** Per-brand image index: trailing number of the fixed file name ("…_2" -> "2"). */
export function trailingIndexOf(fileName: string): string {
  const m = /_(\d+)$/.exec(fileName);
  return m ? m[1]! : "1";
}

/**
 * "Spinogambino(Men)" -> { base: "Spinogambino", gender: "men" }: the ZIP keeps
 * ONE folder per brand pair, the gender moves to the file-name suffix. Mirrors
 * the backend splitBrandGender / the gallery's stripGender.
 */
export function splitBrandGender(name: string): { base: string; gender: "" | "men" | "women" } {
  const m = /\s*\((men|women)\)\s*$/i.exec(name);
  if (!m) return { base: name.trim(), gender: "" };
  return {
    base: name.slice(0, m.index).trim(),
    gender: m[1]!.toLowerCase() as "men" | "women",
  };
}

/** The element part of a row's ZIP path ("Tournament_1"), robust to old rows. */
function elementFolderOf(g: PackGeneration): string {
  return sanitizeName(g.tourElementName ?? "") || (g.tourFileName ? packFolderOf(g.tourFileName) : "");
}

/**
 * Card caption: "Bonuskong_Tournament_1_2[_women]" (brand + element + index +
 * gender). The brand moved INTO the caption (Phase 0, 5а) because the tab
 * groups by category → subcategory (Frame 110-1), not by brand folder anymore.
 */
export function packDisplayName(g: PackGeneration): string {
  if (!g.tourFileName) return "";
  const { base, gender } = splitBrandGender(g.brandName);
  const brand = sanitizeName(base);
  return `${brand ? `${brand}_` : ""}${elementFolderOf(g)}_${trailingIndexOf(g.tourFileName)}${gender ? `_${gender}` : ""}`;
}

/** "BASE" | "VIP" -> the human label used in titles ("Base" / "VIP"). */
export function modeLabel(mode: PackMode | null): string {
  return mode === "VIP" ? "VIP" : "Base";
}

export interface PackSubgroup {
  key: string; // "Tournament_1:BASE"
  title: string; // "Tournament_1_Base" (mock: the subcategory line)
  images: PackGeneration[];
}

/**
 * Second grouping level (Frame 110-1): inside a batch (= one main category)
 * the images are grouped by SUBCATEGORY — the element under its mode
 * ("Tournament_1_Base"), in first-appearance order.
 */
export function groupPackByElement(generations: PackGeneration[]): PackSubgroup[] {
  const map = new Map<string, PackSubgroup>();
  for (const g of generations) {
    if (!g.tourFileName) continue;
    const el = elementFolderOf(g) || "Unknown";
    const key = `${el}:${g.tourMode ?? "BASE"}`;
    let group = map.get(key);
    if (!group) {
      group = { key, title: `${el}_${modeLabel(g.tourMode)}`, images: [] };
      map.set(key, group);
    }
    group.images.push(g);
  }
  return [...map.values()];
}

/**
 * Group a batch's generations by BRAND — the ZIP layout is flat
 * {Brand}/{Element}_N[_gender].png, so the tab shows one brand folder per
 * group (the (Men)/(Women) pair merges into one), in first-appearance order.
 */
export function groupPack(generations: PackGeneration[]): PackGroup[] {
  const map = new Map<string, PackGroup>();
  for (const g of generations) {
    if (!g.tourFileName) continue;
    const title = sanitizeName(splitBrandGender(g.brandName).base) || "Unknown";
    let group = map.get(title);
    if (!group) {
      group = { key: title, categoryKey: g.tourCategoryKey ?? "tournament", title, images: [] };
      map.set(title, group);
    }
    group.images.push(g);
  }
  return [...map.values()];
}

/**
 * Human batch status (RU, matching the app's tone). PARTIAL_FAILURE reads as
 * "Готово" — failed rows are hidden from the tab and excluded from the
 * counters (заказчик: content-checker fails must be invisible), so to the
 * user the batch IS complete.
 */
export function batchStatusLabel(status: string): string {
  switch (status) {
    case "IN_PROGRESS":
      return "Генерация…";
    case "COMPLETED":
    case "PARTIAL_FAILURE":
      return "Готово";
    case "FAILED":
      return "Ошибка";
    case "CANCELLED":
      return "Отменено";
    default:
      return status;
  }
}

/** Rows the tab shows: failed/cancelled ones are hidden entirely. */
export function visibleGenerations(generations: PackGeneration[]): PackGeneration[] {
  return generations.filter((g) => g.status !== "FAILED" && g.status !== "CANCELLED");
}

/**
 * Done/total counters for a batch header. Failed/cancelled rows don't count
 * toward the total — a batch with one hidden failure reads "7 of 7", not
 * "7 of 8" (they were retried once by the worker before being hidden).
 */
export function packCounts(batch: PackBatch): { done: number; total: number } {
  const visible = visibleGenerations(batch.generations);
  const done = visible.filter((g) => g.status === "DONE" && g.generatedImageUrl).length;
  return { done, total: visible.length };
}

/** "tournament" / "calendar_vip" -> "Tournament" / "Calendar VIP". */
export function prettifyCategoryKey(key: string): string {
  return key
    .split("_")
    .filter(Boolean)
    .map((w) => (w === "vip" ? "VIP" : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/**
 * Batch header title — the MAIN category line of the mock ("Tournament (Base)"):
 * category name from the rows' denormalized keys + the mode(s) the batch
 * generated. Batches are created one per category, but distinct keys/modes are
 * joined just in case ("Tournament (Base + VIP)").
 */
export function batchCategoryLabel(batch: PackBatch): string {
  const keys = [...new Set(batch.generations.map((g) => g.tourCategoryKey).filter(Boolean))];
  const name = keys.map((k) => prettifyCategoryKey(k!)).join(" + ") || "Tournament";
  const modes = [...new Set(batch.generations.map((g) => g.tourMode).filter(Boolean))] as PackMode[];
  return modes.length ? `${name} (${modes.map(modeLabel).join(" + ")})` : name;
}

/** Ids that CAN be exported (DONE with a stored image). */
export function exportableIds(batches: PackBatch[]): string[] {
  return batches.flatMap((b) =>
    b.generations.filter((g) => g.status === "DONE" && g.generatedImageUrl).map((g) => g.id),
  );
}

/**
 * Swap one generation's image URL in place (after a successful Scale/Inpaint —
 * the backend already overwrote the stored image, so the next ZIP export picks
 * the edited version up automatically). Untouched batches keep their identity.
 */
export function replacePackImage(
  batches: PackBatch[],
  generationId: string,
  url: string,
): PackBatch[] {
  return batches.map((b) =>
    b.generations.some((g) => g.id === generationId)
      ? {
          ...b,
          generations: b.generations.map((g) =>
            g.id === generationId ? { ...g, generatedImageUrl: url } : g,
          ),
        }
      : b,
  );
}

// ---------------------------------------------------------------------------
// Composable
// ---------------------------------------------------------------------------

export interface PackApi {
  <T = unknown>(request: string, opts?: Record<string, unknown>): Promise<T>;
}
export interface PackGen {
  runningCount: number;
  addBatch(id: string, kind: "person" | "item"): void;
}
export interface PackDeps {
  api: PackApi;
  apiBase: string;
  download: (url: string) => void;
  gen: PackGen;
  /** Called after an edit batch is queued (the page switches to Edited). */
  onEdited?: () => void;
}

export function useTournamentPack(deps: PackDeps) {
  const { api, apiBase, download, gen } = deps;

  const batches = ref<PackBatch[]>([]);
  const total = ref(0);
  const hasMore = ref(false);
  const loading = ref(false);

  async function load(reset = true) {
    loading.value = true;
    try {
      const offset = reset ? 0 : batches.value.length;
      const res = await api<PacksResponse>("/api/tournament/packs", {
        query: { limit: LIMIT, offset },
      });
      batches.value = reset ? res.batches : [...batches.value, ...res.batches];
      total.value = res.total;
      hasMore.value = res.hasMore;
      // Selection survives refreshes but drops ids that disappeared. Keep the
      // Set's identity when nothing was dropped: reassigning fires the sync
      // `selected` watch, which would clear an active pencil scale target (and
      // close the open editor) on every reload.
      const valid = new Set(exportableIds(batches.value));
      const kept = [...selected.value].filter((id) => valid.has(id));
      if (kept.length !== selected.value.size) selected.value = new Set(kept);
    } catch {
      if (reset) {
        batches.value = [];
        total.value = 0;
        hasMore.value = false;
      }
    } finally {
      loading.value = false;
    }
  }

  // ---- Selection (export-eligible images only) ----
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
  const selectedCount = computed(() => selected.value.size);
  function clearSelection() {
    selected.value = new Set();
  }
  /** The live rows behind the ticks (drives the Edit panel + Scale target). */
  const selectedImages = computed(() =>
    batches.value.flatMap((b) =>
      b.generations.filter(
        (g) => selected.value.has(g.id) && g.status === "DONE" && !!g.generatedImageUrl,
      ),
    ),
  );
  /** Bar's "Select all" (result.vue delegates here on the Tournament tab). */
  function toggleSelectAll() {
    const ids = exportableIds(batches.value);
    const all = ids.length > 0 && ids.every((id) => selected.value.has(id));
    selected.value = all ? new Set() : new Set(ids);
  }

  // ---- Whole-batch (session) checkbox ----
  function batchState(b: PackBatch): "all" | "some" | "none" {
    const ids = exportableIds([b]);
    if (!ids.length) return "none";
    const n = ids.filter((id) => selected.value.has(id)).length;
    return n === 0 ? "none" : n === ids.length ? "all" : "some";
  }
  /** Tick/untick every exportable image of the batch at once. */
  function toggleBatch(b: PackBatch) {
    const ids = exportableIds([b]);
    const next = new Set(selected.value);
    if (batchState(b) === "all") for (const id of ids) next.delete(id);
    else for (const id of ids) next.add(id);
    selected.value = next;
  }

  // ---- Edit the ticked images (same /api/generate/edit as the other tabs; the
  // results land in the Edited tab as a regular edit batch). ALL mode shares
  // one prompt, EACH mode sends a per-image map — same contract as useResult.
  const editPrompt = ref("");
  const perEditPrompts = ref<Record<string, string>>({});
  const editing = ref(false);
  const editError = ref("");
  async function runEdit(mode: SelectMode = "ALL") {
    if (editing.value) return;
    const built = buildEditBody(mode, selectedImages.value, editPrompt.value, perEditPrompts.value);
    if (!built.ok) {
      if (built.error !== "no_selection") editError.value = built.error;
      return;
    }
    editError.value = "";
    editing.value = true;
    try {
      const res = await api<{ batchId: string; count: number }>("/api/generate/edit", {
        method: "POST",
        body: built.body,
      });
      // Toolbar progress + completion toast, like every other edit.
      gen.addBatch(res.batchId, "item");
      editPrompt.value = "";
      perEditPrompts.value = {};
      clearSelection();
      deps.onEdited?.();
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

  // ---- Scale/Inpaint editor (задача 3: same pipeline as the Person reference) ----
  // One image at a time: a card's "Редактировать" button sets the target and the
  // host opens ScalePanel's modal (trigger="external"). POST /generate/scale и
  // /generate/inpaint не фильтруют actionType, so tournament rows work as-is;
  // the result REPLACES the stored image (and thus the next ZIP export).
  const scaleTargetId = ref<string | null>(null);
  const scaling = ref(false);
  const scaleError = ref("");
  const scaleMsg = ref("");

  /** The live row for the target id (survives polling refreshes of `batches`). */
  const scaleImage = computed(() => {
    if (!scaleTargetId.value) return null;
    for (const b of batches.value)
      for (const g of b.generations)
        if (g.id === scaleTargetId.value && g.status === "DONE" && g.generatedImageUrl)
          return { id: g.id, generatedImageUrl: g.generatedImageUrl, brandName: g.brandName };
    return null;
  });

  function setScaleTarget(id: string | null) {
    scaleTargetId.value = id;
    scaleError.value = "";
    scaleMsg.value = "";
  }

  /**
   * What the right panel's ScalePanel edits: the card whose pencil was clicked,
   * else the single ticked image (mirrors useResult's scaleTarget). A selection
   * change drops a stale pencil target so the panel follows the ticks again.
   */
  const panelScaleImage = computed(() => {
    if (scaleImage.value) return scaleImage.value;
    const sel = selectedImages.value;
    if (sel.length !== 1) return null;
    const g = sel[0]!;
    return { id: g.id, generatedImageUrl: g.generatedImageUrl!, brandName: g.brandName };
  });
  watch(
    selected,
    () => {
      scaleTargetId.value = null;
    },
    { flush: "sync" },
  );

  /** Swap the edited image's URL in place (cache-busted, mirrors useResult). */
  function applyReplacement(res: { generationId: string; generatedImageUrl: string }) {
    batches.value = replacePackImage(batches.value, res.generationId, bustCache(res.generatedImageUrl));
  }

  async function runScale(payload: { pad?: Pad; placement?: Placement; prompt?: string }) {
    const target = scaleImage.value;
    if (!target || scaling.value) return;
    scaleError.value = "";
    scaleMsg.value = "";
    scaling.value = true;
    try {
      const prompt = payload.prompt?.trim();
      const res = await api<{ generationId: string; generatedImageUrl: string }>(
        "/api/generate/scale",
        {
          method: "POST",
          body: {
            generationId: target.id,
            ...(payload.pad ? { pad: payload.pad } : {}),
            ...(payload.placement ? { placement: payload.placement } : {}),
            ...(prompt ? { prompt } : {}),
          },
        },
      );
      applyReplacement(res);
      scaleMsg.value = "Готово! Изображение расширено и улучшено.";
    } catch (e: unknown) {
      scaleError.value = mapScaleError((e as { data?: { error?: string } })?.data?.error);
    } finally {
      scaling.value = false;
    }
  }

  async function runInpaint(payload: InpaintPayload) {
    const target = scaleImage.value;
    if (!target || scaling.value) return;
    scaleError.value = "";
    scaleMsg.value = "";
    scaling.value = true;
    try {
      const prompt = payload.prompt?.trim();
      const res = await api<{ generationId: string; generatedImageUrl: string }>(
        "/api/generate/inpaint",
        {
          method: "POST",
          body: {
            generationId: target.id,
            maskDataUrl: payload.maskDataUrl,
            mode: payload.mode,
            ...(prompt ? { prompt } : {}),
          },
        },
      );
      applyReplacement(res);
      scaleMsg.value = payload.mode === "erase" ? "Готово! Объект удалён." : "Готово! Область дорисована.";
    } catch (e: unknown) {
      scaleError.value = mapScaleError((e as { data?: { error?: string } })?.data?.error);
    } finally {
      scaling.value = false;
    }
  }

  // ---- ZIP export (a NEW DES number is issued on every download) ----
  const exporting = ref(false);
  function trigger(qs: string) {
    exporting.value = true;
    download(`${apiBase}/api/tournament/export.zip?${qs}`);
    // The download is a navigation/anchor; clear the flag on the next tick.
    setTimeout(() => (exporting.value = false), 800);
  }
  /** Whole-batch export ("выгрузить всю генерацию полностью"). */
  function exportBatch(batchId: string) {
    trigger(buildPackExportQuery({ batchId }));
  }
  /** Ticked-images export ("частичная выгрузка"). */
  function exportSelected() {
    if (!selected.value.size) return;
    trigger(buildPackExportQuery({ ids: [...selected.value] }));
  }

  // ---- Live auto-refresh (mirrors useArchive): poll while batches run ----
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  async function refresh() {
    try {
      const res = await api<PacksResponse>("/api/tournament/packs", {
        query: { limit: Math.max(batches.value.length, LIMIT), offset: 0 },
      });
      batches.value = res.batches;
      total.value = res.total;
      hasMore.value = res.hasMore;
    } catch {
      /* transient — retry next tick */
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
    if (gen.runningCount > 0) startPolling();
  });
  onBeforeUnmount(() => stopPolling());

  return {
    batches,
    total,
    hasMore,
    loading,
    load,
    selected,
    toggleSelect,
    isSelected,
    selectedCount,
    clearSelection,
    selectedImages,
    toggleSelectAll,
    batchState,
    toggleBatch,
    editPrompt,
    perEditPrompts,
    editing,
    editError,
    runEdit,
    scaleImage,
    panelScaleImage,
    setScaleTarget,
    scaling,
    scaleError,
    scaleMsg,
    runScale,
    runInpaint,
    exporting,
    exportBatch,
    exportSelected,
    refresh,
    startPolling,
    stopPolling,
  };
}
