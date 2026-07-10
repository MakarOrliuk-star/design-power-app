/**
 * Result → "Tournament Pack" tab (Phase 6). The tab shows the user's tournament
 * batch history (newest first), each batch grouped by Brand_Element pack with
 * the fixed file names, and exports a DES-1XXXXX.zip — either the whole batch
 * or the ticked images. Mirrors useArchive: the branching pieces are pure
 * exported helpers, `api`/`apiBase`/`download`/`gen` are injected for tests.
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";

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
  key: string; // "tournament/Bonuskong_Tournament_1"
  categoryKey: string;
  title: string; // "Bonuskong_Tournament_1" (the ZIP pack folder)
  images: PackGeneration[];
}

/** "Bonuskong_Tournament_1_2" -> its pack folder "Bonuskong_Tournament_1". */
export function packFolderOf(fileName: string): string {
  return fileName.replace(/_\d+$/, "");
}

/**
 * Group a batch's generations into the ZIP pack folders (Brand_Element), in
 * order of first appearance — the tab mirrors the archive structure exactly.
 */
export function groupPack(generations: PackGeneration[]): PackGroup[] {
  const map = new Map<string, PackGroup>();
  for (const g of generations) {
    if (!g.tourFileName) continue;
    const title = packFolderOf(g.tourFileName);
    const categoryKey = g.tourCategoryKey ?? "tournament";
    const key = `${categoryKey}/${title}`;
    let group = map.get(key);
    if (!group) {
      group = { key, categoryKey, title, images: [] };
      map.set(key, group);
    }
    group.images.push(g);
  }
  return [...map.values()];
}

/** Human batch status (RU, matching the app's tone). */
export function batchStatusLabel(status: string): string {
  switch (status) {
    case "IN_PROGRESS":
      return "Генерация…";
    case "COMPLETED":
      return "Готово";
    case "PARTIAL_FAILURE":
      return "Готово частично";
    case "FAILED":
      return "Ошибка";
    case "CANCELLED":
      return "Отменено";
    default:
      return status;
  }
}

/** Done/total counters for a batch header ("7 of 8"). */
export function packCounts(batch: PackBatch): { done: number; total: number } {
  const done = batch.generations.filter((g) => g.status === "DONE" && g.generatedImageUrl).length;
  return { done, total: batch.generations.length };
}

/** Ids that CAN be exported (DONE with a stored image). */
export function exportableIds(batches: PackBatch[]): string[] {
  return batches.flatMap((b) =>
    b.generations.filter((g) => g.status === "DONE" && g.generatedImageUrl).map((g) => g.id),
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
}
export interface PackDeps {
  api: PackApi;
  apiBase: string;
  download: (url: string) => void;
  gen: PackGen;
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
      // Selection survives refreshes but drops ids that disappeared.
      const valid = new Set(exportableIds(batches.value));
      selected.value = new Set([...selected.value].filter((id) => valid.has(id)));
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
    exporting,
    exportBatch,
    exportSelected,
    refresh,
    startPolling,
    stopPolling,
  };
}
