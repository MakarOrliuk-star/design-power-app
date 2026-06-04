/**
 * Archive page logic (TASK §2), extracted from `archive.vue` so the branching
 * pieces are unit-testable without the Nuxt runtime. Mirrors `useResult` but the
 * Archive is a flat 5-up grid (no brand grouping) with a brand search, a time
 * period filter and a ZIP export. The pure helpers (`buildExportQuery`,
 * `areAllSelected`) are exported for tests.
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, type ComputedRef } from "vue";
import {
  TABS,
  areAllSelected,
  mergeNewImages,
  type TabKey,
  type GalleryImage,
} from "./useResult";

export type Period = "today" | "week" | "month" | "3months";

export const PERIODS: { key: Period; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "week", label: "Week" },
  { key: "month", label: "1 month" },
  { key: "3months", label: "3 months" },
];

interface GalleryResponse {
  images: GalleryImage[];
  total: number;
  hasMore: boolean;
}

const LIMIT = 50;
const SEARCH_DEBOUNCE = 300;

// ---------------------------------------------------------------------------
// Pure helpers (no Vue / no Nuxt) — directly unit-tested.
// ---------------------------------------------------------------------------

/**
 * Query string for GET /api/generations/export.zip. An explicit selection wins
 * over the filters (the backend ignores filters when `ids` is present), so we
 * send ONLY `ids` in that case; otherwise the current tab/period/search.
 */
export function buildExportQuery(p: {
  tab: TabKey;
  period: Period;
  search?: string;
  ids?: string[];
}): string {
  const q = new URLSearchParams();
  if (p.ids && p.ids.length) {
    q.set("ids", p.ids.join(","));
  } else {
    q.set("tab", p.tab);
    q.set("period", p.period);
    const s = (p.search ?? "").trim();
    if (s) q.set("search", s);
  }
  return q.toString();
}

// ---------------------------------------------------------------------------
// Composable — `api`/`apiBase`/`download` are injected so it is testable without
// Nuxt. `download(url)` performs the browser download / clipboard side effects.
// ---------------------------------------------------------------------------

export interface ArchiveApi {
  <T = unknown>(request: string, opts?: Record<string, unknown>): Promise<T>;
}
/** Generator store stand-in — drives the live auto-refresh while batches run. */
export interface ArchiveGen {
  runningCount: number;
}
export interface ArchiveDeps {
  api: ArchiveApi;
  apiBase: string;
  download: (url: string) => void;
  gen: ArchiveGen;
  copy?: (text: string) => void;
}

export function useArchive(deps: ArchiveDeps) {
  const { api, apiBase, download, gen } = deps;
  const copy = deps.copy ?? ((t: string) => void navigator.clipboard?.writeText(t));

  const activeTab = ref<TabKey>("generated");
  const period = ref<Period>("3months");
  const search = ref("");

  const images = ref<GalleryImage[]>([]);
  const total = ref(0);
  const hasMore = ref(false);
  const loading = ref(false);

  async function load(reset = true) {
    loading.value = true;
    try {
      const offset = reset ? 0 : images.value.length;
      const res = await api<GalleryResponse>("/api/generations", {
        query: {
          tab: activeTab.value,
          period: period.value,
          limit: LIMIT,
          offset,
          ...(search.value.trim() ? { search: search.value.trim() } : {}),
        },
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

  function selectTab(key: TabKey) {
    if (activeTab.value === key) return;
    activeTab.value = key;
    selected.value = new Set();
    newReadyCount.value = 0;
    void load();
  }
  function selectPeriod(key: Period) {
    if (period.value === key) return;
    period.value = key;
    selected.value = new Set();
    newReadyCount.value = 0;
    void load();
  }

  // Debounced search — reload the grid shortly after the user stops typing.
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  watch(search, () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      selected.value = new Set();
      newReadyCount.value = 0;
      void load();
    }, SEARCH_DEBOUNCE);
  });

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
  const selectedImages: ComputedRef<GalleryImage[]> = computed(() =>
    images.value.filter((i) => selected.value.has(i.id)),
  );

  // ---- Per-card actions ----
  function copyUrl(img: GalleryImage) {
    copy(img.generatedImageUrl);
  }
  function downloadOne(img: GalleryImage) {
    download(img.generatedImageUrl);
  }
  function copySelected() {
    if (!selectedImages.value.length) return;
    copy(selectedImages.value.map((i) => i.generatedImageUrl).join("\n"));
  }

  // ---- ZIP export (selected, else the whole filtered set) ----
  const exporting = ref(false);
  function exportZip() {
    const ids = selected.value.size ? [...selected.value] : [];
    const qs = buildExportQuery({
      tab: activeTab.value,
      period: period.value,
      search: search.value,
      ids,
    });
    exporting.value = true;
    download(`${apiBase}/api/generations/export.zip?${qs}`);
    // The download is a navigation/anchor; clear the flag on the next tick.
    setTimeout(() => (exporting.value = false), 800);
  }

  // ---- Live auto-refresh (mirrors useResult) ----
  // While any generation batch is in flight, poll the current filter every 3s and
  // prepend freshly-finished images so the grid fills in without a page reload.
  const newReadyCount = ref(0);
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  async function refresh() {
    try {
      const res = await api<GalleryResponse>("/api/generations", {
        query: {
          tab: activeTab.value,
          period: period.value,
          limit: LIMIT,
          offset: 0,
          ...(search.value.trim() ? { search: search.value.trim() } : {}),
        },
      });
      total.value = res.total;
      const { images: merged, added } = mergeNewImages(images.value, res.images);
      if (added) {
        images.value = merged;
        newReadyCount.value += added;
      }
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
    if (gen.runningCount > 0) startPolling();
  });
  onBeforeUnmount(() => stopPolling());

  return {
    // filters
    TABS,
    PERIODS,
    activeTab,
    period,
    search,
    selectTab,
    selectPeriod,
    // grid
    images,
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
    // actions
    copyUrl,
    downloadOne,
    copySelected,
    exportZip,
    exporting,
    // live auto-refresh
    newReadyCount,
    dismissReady,
    refresh,
    startPolling,
    stopPolling,
  };
}
