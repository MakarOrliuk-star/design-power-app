import { defineStore } from "pinia";
import { missingRefFormatsFor } from "~/utils/refGating";
import type { MissingFormat, RefCountsMap, RefFormatMeta } from "~/utils/refGating";

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
  /** "ai" | "layered" | "ai_reference" (TASK ai-reference) — включает в
   *  мастере обязательный выбор вариации и бейджи референсов у брендов. */
  composeMode?: string;
  /** Явный якорь стиля кампании (TASK multiformat-promo, A2-1). */
  styleAnchor?: boolean;
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

/** Composition metadata of an engine-rendered asset (TASK email-composition):
 *  the safe zone the email text lands in, plus how it should be coloured. */
export interface BundleAssetMeta {
  specKey: string;
  specVersion: number;
  /** null — у формата нет safe-зоны (push/pop-up без текста, DI2-4). */
  safeZonePct: { x: number; y: number; w: number; h: number } | null;
  recommendedTextColor: string | null;
  luminance: number | null;
  textContrast: { white: number; dark: number } | null;
  retinaUrl: string | null;
  validator: { passed: boolean; attempts: number } | null;
  /** Приёмка ai_reference (DI-R10): бейдж «лучший из N» + причины отклонения.
   *  healing — итог AI-автокоррекции (TASK safe-zone/auto-heal): сколько
   *  попыток лечения было и стала ли вылеченная версия финальной. */
  qa: {
    passed: boolean;
    attempts: number;
    reasons: string[];
    healing: { attempts: number; used: boolean } | null;
    /** Оценка победителя и порог приёмки (DI2-5). */
    score: number | null;
    threshold: number | null;
  } | null;
}

export interface BundleDetails {
  id: string;
  name: string;
  status: BundleStatusKey;
  plannedSendAt: string | null;
  neuralPrompt: string;
  presetId: string | null;
  presetTitle: string | null;
  brandNames: string[];
  createdAt: string;
  bundleType: { key: string; title: string; assets: BundleTypeAssetMeta[] };
  variants: Array<{
    id: string;
    brandName: string;
    displayName: string;
    approvedCount: number;
    /** Style-profile «казино-дизайнера» (DV-E1): стиль сцены — данные, не
     *  координаты. Редактируется админом; null = профиля нет (фолбэк движка). */
    styleProfile: Record<string, unknown> | null;
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
      meta: BundleAssetMeta | null;
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
    presetId?: string | null;
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
          presetId: form.presetId ?? null,
        },
      });
      await api(`/api/bundles/${created.bundle.id}/generate`, { method: "POST" });
      await fetchList();
      return created.bundle.id;
    } catch (err) {
      const status = (err as { statusCode?: number })?.statusCode;
      // Гейт ai_reference (TASK ai-reference): сервер объясняет, ЧЕГО не
      // хватает — вариации или референсов у конкретных брендов.
      const code = (err as { data?: { error?: string } })?.data?.error;
      launchError.value =
        code === "preset_required" || code === "refs_missing"
          ? code
          : status === 503
            ? "queue_unavailable"
            : "launch_failed";
      // The draft may already exist — refresh so the user sees it either way.
      await fetchList();
      return null;
    } finally {
      launching.value = false;
    }
  }

  // ---- Референсы вариации (TASK ai-reference): бейджи «7/15» в мастере ----
  // TASK multiformat-promo (DI2-2): счётчики вложены по формату, и бренд
  // считается готовым, только если КАЖДЫЙ ai_reference-формат набрал минимум.
  const refCounts = ref<RefCountsMap>({});
  const refFormats = ref<RefFormatMeta[]>([]);
  const refCountsMin = ref(5);
  const refCountsPresetId = ref<string | null>(null);

  async function fetchRefCounts(presetId: string | null) {
    refCountsPresetId.value = presetId;
    if (!presetId) {
      refCounts.value = {};
      return;
    }
    try {
      const res = await api<{
        counts: Record<string, Record<string, number>>;
        formats: Array<{ key: string; label: string; isAnchor: boolean }>;
        min: number;
      }>("/api/bundles/ref-counts", { query: { presetId } });
      // Пользователь мог успеть переключить вариацию, пока летел запрос.
      if (refCountsPresetId.value === presetId) {
        refCounts.value = res.counts;
        refFormats.value = res.formats ?? [];
        refCountsMin.value = res.min;
      }
    } catch {
      if (refCountsPresetId.value === presetId) refCounts.value = {};
    }
  }

  /** Форматы бренда, недобравшие минимум — пусто = бренд готов к генерации. */
  function missingRefFormats(brandKey: string): MissingFormat[] {
    return missingRefFormatsFor(refCounts.value, refFormats.value, refCountsMin.value, brandKey);
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
    refCounts,
    refFormats,
    refCountsMin,
    fetchRefCounts,
    missingRefFormats,
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
