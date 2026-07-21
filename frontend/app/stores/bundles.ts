import { defineStore } from "pinia";

// Image Bundles store (TASK crm-bundle Phase 3): project list + wizard meta +
// create/launch. Talks to /api/bundles (guarded by requireCrmSuper on the BE).

export type BundleStatusKey = "draft" | "generating" | "completed" | "failed";
export type StatusFilter = "all" | BundleStatusKey;

export interface BundleListItem {
  id: string;
  name: string;
  status: BundleStatusKey;
  plannedSendAt: string | null;
  createdAt: string;
  brandLabels: string[];
}

export interface BundleTypeAssetMeta {
  key: string;
  label: string;
  width: number;
  height: number;
}

export interface BundleTypeMeta {
  id: string;
  key: string;
  title: string;
  description: string | null;
  assets: BundleTypeAssetMeta[];
}

export interface PromptPreset {
  id: string;
  title: string;
  text: string;
}

export interface BrandGroup {
  key: string; // base name (one toggle = both tone variants, D3/D7)
  displayName: string;
  variants: Array<{ name: string; displayName: string }>;
}

export interface BundleDetails {
  id: string;
  name: string;
  status: BundleStatusKey;
  plannedSendAt: string | null;
  neuralPrompt: string;
  brandNames: string[];
  createdAt: string;
  bundleType: { key: string; title: string; assets: BundleTypeAssetMeta[] };
  variants: Array<{
    id: string;
    brandName: string;
    displayName: string;
    approvedCount: number;
    assets: Array<{
      id: string;
      assetKey: string;
      label: string;
      width: number;
      height: number;
      imageUrl: string | null;
      status: "pending" | "generating" | "done" | "failed";
      approved: boolean;
      errorMessage: string | null;
    }>;
  }>;
  summary: { variantCount: number; assetTotal: number; assetDone: number; approvedCount: number };
}

interface ListResponse {
  bundles: BundleListItem[];
  total: number;
  page: number;
  pageSize: number;
  counts: Record<StatusFilter, number>;
}

export interface SmarticoOutput {
  title: string;
  code: string;
  kind: "function" | "label";
}

export interface SmarticoSendStats {
  total: number;
  uploaded: number;
  reused: number;
  failed: number;
  failedItems: string[];
  suspicious: string[];
  skipped: string[];
}

export const useBundlesStore = defineStore("bundles", () => {
  const api = useApi();

  // ---- Project list (left panel) ----
  const bundles = ref<BundleListItem[]>([]);
  const total = ref(0);
  const page = ref(1);
  const pageSize = ref(8);
  const counts = ref<Record<StatusFilter, number>>({
    all: 0,
    draft: 0,
    generating: 0,
    completed: 0,
    failed: 0,
  });
  const statusFilter = ref<StatusFilter>("all");
  const search = ref("");
  const listLoading = ref(false);
  const listError = ref(false);

  const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));

  async function fetchList() {
    listLoading.value = true;
    listError.value = false;
    try {
      const res = await api<ListResponse>("/api/bundles", {
        query: {
          status: statusFilter.value,
          ...(search.value.trim() ? { search: search.value.trim() } : {}),
          page: page.value,
        },
      });
      bundles.value = res.bundles;
      total.value = res.total;
      pageSize.value = res.pageSize;
      counts.value = res.counts;
      // A deleted last page leaves us past the end — snap back once.
      if (page.value > 1 && res.bundles.length === 0 && res.total > 0) {
        page.value = Math.max(1, Math.ceil(res.total / res.pageSize));
        await fetchList();
      }
    } catch {
      listError.value = true;
    } finally {
      listLoading.value = false;
    }
  }

  function setFilter(next: StatusFilter) {
    statusFilter.value = next;
    page.value = 1;
    void fetchList();
  }

  function setSearch(next: string) {
    search.value = next;
    page.value = 1;
    void fetchList();
  }

  function setPage(next: number) {
    page.value = Math.min(Math.max(1, next), totalPages.value);
    void fetchList();
  }

  // ---- Wizard meta ----
  const bundleTypes = ref<BundleTypeMeta[]>([]);
  const presets = ref<PromptPreset[]>([]);
  const brands = ref<BrandGroup[]>([]);
  const metaReady = ref(false);
  const metaError = ref(false);

  async function fetchMeta() {
    metaError.value = false;
    try {
      const res = await api<{ bundleTypes: BundleTypeMeta[]; presets: PromptPreset[]; brands: BrandGroup[] }>(
        "/api/bundles/meta",
      );
      bundleTypes.value = res.bundleTypes;
      presets.value = res.presets;
      brands.value = res.brands;
      metaReady.value = true;
    } catch {
      metaError.value = true;
    }
  }

  // ---- Create + launch (wizard "Generate bundle") ----
  const launching = ref(false);
  const launchError = ref<string | null>(null);

  async function createAndGenerate(form: {
    name: string;
    plannedSendAt: string | null;
    neuralPrompt: string;
    brandNames: string[];
    bundleTypeKey: string;
  }): Promise<string | null> {
    launching.value = true;
    launchError.value = null;
    try {
      const created = await api<{ bundle: { id: string } }>("/api/bundles", {
        method: "POST",
        body: {
          name: form.name,
          plannedSendAt: form.plannedSendAt,
          neuralPrompt: form.neuralPrompt,
          brandNames: form.brandNames,
          bundleTypeKey: form.bundleTypeKey,
        },
      });
      await api(`/api/bundles/${created.bundle.id}/generate`, { method: "POST" });
      await fetchList();
      return created.bundle.id;
    } catch (err) {
      const status = (err as { statusCode?: number })?.statusCode;
      launchError.value = status === 503 ? "queue_unavailable" : "launch_failed";
      // The draft may already exist — refresh so the user sees it either way.
      await fetchList();
      return null;
    } finally {
      launching.value = false;
    }
  }

  // ---- Selected bundle (Result screen, Phase 5) ----
  const selected = ref<BundleDetails | null>(null);
  const selectedLoading = ref(false);
  const actionError = ref<string | null>(null);

  async function fetchDetails(id: string) {
    selectedLoading.value = true;
    try {
      const res = await api<{ bundle: BundleDetails }>(`/api/bundles/${id}`);
      selected.value = res.bundle;
    } catch {
      selected.value = null;
    } finally {
      selectedLoading.value = false;
    }
  }

  function clearSelected() {
    selected.value = null;
    selectedAssetIds.value = new Set();
  }

  // ---- Result screen actions (approve / regenerate / edit / project edit) ----

  // Asset selection for the batch "Approve selected (N)" button — shared
  // between the accordion cards and the summary panel.
  const selectedAssetIds = ref<Set<string>>(new Set());

  function toggleAssetSelection(assetId: string) {
    const next = new Set(selectedAssetIds.value);
    if (next.has(assetId)) next.delete(assetId);
    else next.add(assetId);
    selectedAssetIds.value = next;
  }

  async function refreshSelected() {
    if (selected.value) await fetchDetails(selected.value.id);
    await fetchList();
  }

  async function runAction(action: () => Promise<unknown>, errorLabel: string): Promise<boolean> {
    actionError.value = null;
    try {
      await action();
      await refreshSelected();
      return true;
    } catch (err) {
      const status = (err as { statusCode?: number })?.statusCode;
      actionError.value = status === 503 ? "queue_unavailable" : errorLabel;
      await refreshSelected();
      return false;
    }
  }

  async function approveAssets(assetIds: string[], approved = true): Promise<boolean> {
    if (!selected.value || assetIds.length === 0) return false;
    const id = selected.value.id;
    const ok = await runAction(
      () => api(`/api/bundles/${id}/assets/approve`, { method: "POST", body: { assetIds, approved } }),
      "approve_failed",
    );
    if (ok) selectedAssetIds.value = new Set();
    return ok;
  }

  async function regenerateAsset(assetId: string): Promise<boolean> {
    if (!selected.value) return false;
    const id = selected.value.id;
    return runAction(
      () => api(`/api/bundles/${id}/assets/${assetId}/regenerate`, { method: "POST" }),
      "regenerate_failed",
    );
  }

  async function regenerateAll(): Promise<boolean> {
    if (!selected.value) return false;
    const id = selected.value.id;
    return runAction(() => api(`/api/bundles/${id}/regenerate-all`, { method: "POST" }), "regenerate_failed");
  }

  async function editAsset(assetId: string, prompt: string): Promise<boolean> {
    if (!selected.value) return false;
    const id = selected.value.id;
    return runAction(
      () => api(`/api/bundles/${id}/assets/${assetId}/edit`, { method: "POST", body: { prompt } }),
      "edit_failed",
    );
  }

  async function updateBundle(patch: {
    name?: string;
    plannedSendAt?: string | null;
    neuralPrompt?: string;
  }): Promise<boolean> {
    if (!selected.value) return false;
    const id = selected.value.id;
    return runAction(() => api(`/api/bundles/${id}`, { method: "PATCH", body: patch }), "update_failed");
  }

  // Send to Smartico (Phase 6, D6): approved assets → Cloudinary + paste-ready
  // JS snippets (Unique Smartico contract), grouped into Men/Women buckets.
  const sendState = ref<"idle" | "sending" | "no_approved" | "error">("idle");
  const sendResult = ref<{ outputs: SmarticoOutput[]; stats: SmarticoSendStats } | null>(null);

  async function sendToSmartico() {
    if (!selected.value) return;
    sendState.value = "sending";
    sendResult.value = null;
    try {
      const res = await api<{ outputs: SmarticoOutput[]; stats: SmarticoSendStats }>(
        `/api/bundles/${selected.value.id}/send-smartico`,
        { method: "POST" },
      );
      sendResult.value = { outputs: res.outputs, stats: res.stats };
      sendState.value = "idle";
    } catch (err) {
      const status = (err as { statusCode?: number })?.statusCode;
      sendState.value = status === 400 ? "no_approved" : "error";
    }
  }

  function clearSendResult() {
    sendResult.value = null;
  }

  // ---- Polling while anything is generating (Result renders dynamically) ----
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const hasGenerating = computed(
    () =>
      counts.value.generating > 0 ||
      bundles.value.some((b) => b.status === "generating") ||
      selected.value?.status === "generating",
  );

  function ensurePolling() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      if (!hasGenerating.value) {
        stopPolling();
        return;
      }
      await fetchList();
      if (selected.value) await fetchDetails(selected.value.id);
    }, 4000);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  watch(hasGenerating, (generating) => {
    if (generating) ensurePolling();
  });

  return {
    bundles,
    total,
    page,
    pageSize,
    counts,
    statusFilter,
    search,
    listLoading,
    listError,
    totalPages,
    fetchList,
    setFilter,
    setSearch,
    setPage,
    bundleTypes,
    presets,
    brands,
    metaReady,
    metaError,
    fetchMeta,
    launching,
    launchError,
    createAndGenerate,
    selected,
    selectedLoading,
    fetchDetails,
    clearSelected,
    actionError,
    selectedAssetIds,
    toggleAssetSelection,
    approveAssets,
    regenerateAsset,
    regenerateAll,
    editAsset,
    updateBundle,
    sendState,
    sendResult,
    sendToSmartico,
    clearSendResult,
    ensurePolling,
    stopPolling,
    hasGenerating,
  };
});
