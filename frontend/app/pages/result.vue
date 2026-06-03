<script setup lang="ts">
// Result page — Phase 2: tabs wired to GET /api/generations. Content type and
// edited-state come from the backend; images are grouped by type + brand + prompt.
// Reuses TheToolbar. (Viewer/edit/real-time land in later phases.)
useHead({ title: "Design Power — Result" });

type TabKey = "generated" | "person" | "item" | "background" | "edited";
type SelectMode = "ALL" | "EACH";
type ContentType = "Person" | "Item" | "Background";

const TABS: { key: TabKey; label: string; disabled?: boolean }[] = [
  { key: "generated", label: "Generated" },
  { key: "person", label: "Person" },
  { key: "item", label: "Item" },
  { key: "background", label: "Background", disabled: true }, // no pipeline yet (Phase 0 decision)
  { key: "edited", label: "Edited" },
];

interface GalleryImage {
  id: string;
  brandName: string;
  contentType: ContentType;
  isEdit: boolean;
  theme: string | null;
  description: string | null;
  generatedImageUrl: string;
  createdAt: string;
}
interface Group {
  id: string;
  type: ContentType;
  state: "Generated" | "Edited";
  brand: string;
  prompt: string;
  images: GalleryImage[];
}

const api = useApi();
const gen = useGeneratorStore();
const activeTab = ref<TabKey>("generated");
const selectMode = ref<SelectMode>("ALL");

const images = ref<GalleryImage[]>([]);
const total = ref(0);
const hasMore = ref(false);
const loading = ref(false);
const LIMIT = 50;

async function load(reset = true) {
  loading.value = true;
  try {
    const offset = reset ? 0 : images.value.length;
    const res = await api<{ images: GalleryImage[]; total: number; hasMore: boolean }>(
      "/api/generations",
      { query: { tab: activeTab.value, limit: LIMIT, offset } },
    );
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

// Group images by content type + brand (style) + prompt — each group becomes one
// labelled row in the lane (TASK §3 "style indication").
const groups = computed<Group[]>(() => {
  const map = new Map<string, Group>();
  for (const img of images.value) {
    const key = `${img.contentType}__${img.brandName}__${img.description ?? ""}`;
    let g = map.get(key);
    if (!g) {
      g = {
        id: key,
        type: img.contentType,
        state: img.isEdit ? "Edited" : "Generated",
        brand: img.brandName,
        prompt: img.description ?? "",
        images: [],
      };
      map.set(key, g);
    }
    g.images.push(img);
  }
  return [...map.values()];
});

function selectTab(key: TabKey) {
  if (activeTab.value === key) return;
  activeTab.value = key;
  selected.value = new Set();
  newReadyCount.value = 0;
  closeViewer();
  void load();
}

// Selection.
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
const allSelected = computed(
  () => allImageIds.value.length > 0 && allImageIds.value.every((id) => selected.value.has(id)),
);
function toggleSelectAll() {
  selected.value = allSelected.value ? new Set() : new Set(allImageIds.value);
}

const selectedImages = computed(() => images.value.filter((i) => selected.value.has(i.id)));

// ---- Edit flow (Phase 4) ----
const editPrompt = ref(""); // All mode: one shared instruction
const perEditPrompts = ref<Record<string, string>>({}); // Each mode: per-image
const editing = ref(false);
const editError = ref("");
const editMsg = ref("");

async function runEdit() {
  if (!selectedImages.value.length) return;
  editError.value = "";
  editMsg.value = "";
  const generationIds = selectedImages.value.map((i) => i.id);

  let body: Record<string, unknown>;
  if (selectMode.value === "ALL") {
    if (!editPrompt.value.trim()) {
      editError.value = "Введите промпт для редактирования.";
      return;
    }
    body = { generationIds, prompt: editPrompt.value.trim() };
  } else {
    const perPrompts: Record<string, string> = {};
    for (const img of selectedImages.value) {
      const p = (perEditPrompts.value[img.id] ?? "").trim();
      if (!p) {
        editError.value = "Заполните промпт для каждой выбранной картинки.";
        return;
      }
      perPrompts[img.id] = p;
    }
    body = { generationIds, perPrompts };
  }

  editing.value = true;
  try {
    const res = await api<{ batchId: string; count: number }>("/api/generate/edit", {
      method: "POST",
      body,
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

// ---- Image viewer (Phase 3) ----
// Navigate in display order (grouped), wrapping around with ←/→; Esc closes.
// Tracked by image id (not index) so the auto-refresh prepending new images
// (Phase 5) never makes the open image jump. If the viewed image leaves the list
// (e.g. tab switch), the modal closes itself.
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
  const n = flatImages.value.length;
  if (n === 0 || viewerIndex.value < 0) return;
  const next = (viewerIndex.value + delta + n) % n;
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

// ---- Real-time auto-refresh (Phase 5, TASK §6) ----
// While any batch is in flight (RUN from Home OR an edit from here), poll the
// current tab and merge freshly-finished images to the front; surface a "Готово"
// banner with how many newly arrived.
const newReadyCount = ref(0);
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function refresh() {
  try {
    const res = await api<{ images: GalleryImage[]; total: number; hasMore: boolean }>(
      "/api/generations",
      { query: { tab: activeTab.value, limit: LIMIT, offset: 0 } },
    );
    total.value = res.total;
    const existing = new Set(images.value.map((i) => i.id));
    const added = res.images.filter((i) => !existing.has(i.id));
    if (added.length) {
      images.value = [...added, ...images.value];
      newReadyCount.value += added.length;
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
</script>

<template>
  <div class="result-page">
    <TheToolbar />

    <div class="board">
      <div class="board__head">
        <h1 class="board__title">Result</h1>

        <!-- Real-time status (Phase 5) -->
        <div class="rt">
          <span v-if="gen.runningCount" class="rt__pill rt__pill--run">
            <span class="rt__dot" aria-hidden="true" />
            Генерация… ({{ gen.runningCount }})
          </span>
          <button
            v-if="newReadyCount"
            type="button"
            class="rt__pill rt__pill--ready"
            @click="dismissReady"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true">
              <path d="M5 12.5l4 4 10-10" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            Готово: +{{ newReadyCount }}
          </button>
        </div>
      </div>

      <!-- Tabs + select controls -->
      <div class="bar">
        <nav class="tabs" role="tablist">
          <button
            v-for="t in TABS"
            :key="t.key"
            type="button"
            role="tab"
            :class="['tab', { 'tab--active': activeTab === t.key, 'tab--disabled': t.disabled }]"
            :aria-selected="activeTab === t.key"
            :disabled="t.disabled"
            @click="selectTab(t.key)"
          >
            <span v-if="t.key === 'generated'" class="tab__ic" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none">
                <path d="M8 5v14l11-7L8 5z" fill="currentColor" />
              </svg>
            </span>
            {{ t.label }}
          </button>
        </nav>

        <div class="bar__right">
          <button class="select-all" type="button" @click="toggleSelectAll">Select all</button>
          <div class="seg" role="group" aria-label="Selection mode">
            <button
              type="button"
              :class="['seg__btn', { 'seg__btn--on': selectMode === 'ALL' }]"
              @click="selectMode = 'ALL'"
            >All</button>
            <button
              type="button"
              :class="['seg__btn', { 'seg__btn--on': selectMode === 'EACH' }]"
              @click="selectMode = 'EACH'"
            >Each</button>
          </div>
        </div>
      </div>

      <!-- Gallery lane + Edit panel -->
      <div class="content">
        <div class="lane">
          <p v-if="!groups.length && loading" class="lane__state">Загрузка…</p>
          <p v-else-if="!groups.length" class="lane__state">
            Пока нет изображений в этой вкладке.
          </p>

          <div v-for="g in groups" :key="g.id" class="group">
            <div class="group__head">
              <input
                class="group__prompt"
                :value="g.prompt ? `Example: ${g.prompt}` : 'Без промпта'"
                readonly
              />
              <div class="pills">
                <span class="pill pill--type">
                  <span class="pill__ic" aria-hidden="true">
                    <svg v-if="g.type === 'Person'" viewBox="0 0 24 24" width="13" height="13" fill="none">
                      <circle cx="12" cy="8" r="3.2" stroke="currentColor" stroke-width="1.6" />
                      <path d="M5.5 19c0-3.2 3-4.8 6.5-4.8s6.5 1.6 6.5 4.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                    </svg>
                    <svg v-else-if="g.type === 'Item'" viewBox="0 0 24 24" width="13" height="13" fill="none">
                      <path d="M7 4h10M8 4v2.5L6 9v9a2 2 0 002 2h8a2 2 0 002-2V9l-2-2.5V4" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
                    </svg>
                    <svg v-else viewBox="0 0 24 24" width="13" height="13" fill="none">
                      <rect x="4" y="5" width="16" height="14" rx="2" stroke="currentColor" stroke-width="1.5" />
                      <path d="M4 15l4.5-4 3.5 3 3-2.5L20 16" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
                    </svg>
                  </span>
                  {{ g.type }}
                </span>
                <span class="pill pill--state">
                  <span class="pill__ic" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none">
                      <path d="M8 5v14l11-7L8 5z" fill="currentColor" />
                    </svg>
                  </span>
                  {{ g.state }}
                </span>
              </div>
            </div>

            <div class="grid">
              <div
                v-for="(img, idx) in g.images"
                :key="img.id"
                :class="['card', { 'card--selected': isSelected(img.id) }]"
              >
                <span v-if="idx === 0 && g.brand" class="card__label">{{ g.brand }}</span>

                <div class="card__tools">
                  <button
                    type="button"
                    :class="['card__tool', { 'card__tool--on': isSelected(img.id) }]"
                    aria-label="Select"
                    @click="toggleSelect(img.id)"
                  >
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none">
                      <path d="M5 12.5l4 4 10-10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                  </button>
                  <button type="button" class="card__tool" aria-label="Copy">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none">
                      <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.6" />
                      <path d="M5 15V6a2 2 0 012-2h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                    </svg>
                  </button>
                  <button type="button" class="card__tool" aria-label="Download">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none">
                      <path d="M12 4v10m0 0l-4-4m4 4l4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                      <path d="M5 19h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    class="card__tool"
                    aria-label="Fullscreen"
                    @click="openViewer(img)"
                  >
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none">
                      <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                  </button>
                </div>

                <img
                  class="card__img"
                  :src="img.generatedImageUrl"
                  :alt="g.brand"
                  loading="lazy"
                  @click="openViewer(img)"
                />
              </div>
            </div>
          </div>

          <div v-if="hasMore" class="lane__more">
            <button class="more-btn" type="button" :disabled="loading" @click="load(false)">
              {{ loading ? "Загрузка…" : "Показать ещё" }}
            </button>
          </div>
        </div>

        <aside class="edit-panel">
          <div class="example">
            <span class="example__label">Edit:</span>

            <p v-if="!selectedImages.length" class="example__text example__text--muted">
              Выберите картинки чек-боксом, чтобы отредактировать их через
              fal nano-banana-2/edit.
            </p>

            <template v-else>
              <p class="edit-count">Выбрано: {{ selectedImages.length }}</p>

              <textarea
                v-if="selectMode === 'ALL'"
                v-model="editPrompt"
                class="edit-textarea"
                rows="6"
                placeholder="Опишите изменение для всех выбранных. Например: make the background darker, add neon glow"
              />

              <div v-else class="edit-each">
                <div v-for="img in selectedImages" :key="img.id" class="edit-each__row">
                  <img class="edit-each__thumb" :src="img.generatedImageUrl" :alt="img.brandName" />
                  <textarea
                    v-model="perEditPrompts[img.id]"
                    class="edit-textarea edit-textarea--sm"
                    rows="2"
                    :placeholder="`Промпт для «${img.brandName}»`"
                  />
                </div>
              </div>
            </template>

            <p v-if="editError" class="edit-feedback edit-feedback--error">{{ editError }}</p>
            <p v-else-if="editMsg" class="edit-feedback edit-feedback--ok">{{ editMsg }}</p>
          </div>

          <button
            class="edit-btn"
            type="button"
            :disabled="!selectedImages.length || editing"
            @click="runEdit"
          >
            <span class="edit-btn__ic" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
                <path d="M4 20l4-1 10-10-3-3L5 16l-1 4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
                <path d="M14 6l3 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
              </svg>
            </span>
            {{ editing ? "Отправка…" : "Edit" }}
          </button>
        </aside>
      </div>
    </div>

    <!-- Fullscreen image viewer (Phase 3) -->
    <Teleport to="body">
      <div v-if="viewerOpen" class="viewer" @click.self="closeViewer">
        <button class="viewer__close" type="button" aria-label="Close" @click="closeViewer">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
        </button>

        <button
          v-if="flatImages.length > 1"
          class="viewer__nav viewer__nav--prev"
          type="button"
          aria-label="Previous"
          @click="viewerStep(-1)"
        >
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none">
            <path d="M15 5l-7 7 7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>

        <figure class="viewer__stage" @click.self="closeViewer">
          <img v-if="viewerImage" class="viewer__img" :src="viewerImage.generatedImageUrl" :alt="viewerImage.brandName" />
          <figcaption v-if="viewerImage" class="viewer__caption">
            <span class="viewer__brand">{{ viewerImage.brandName }}</span>
            <span v-if="viewerImage.description" class="viewer__desc">{{ viewerImage.description }}</span>
            <span class="viewer__count">{{ viewerIndex + 1 }} / {{ flatImages.length }}</span>
          </figcaption>
        </figure>

        <button
          v-if="flatImages.length > 1"
          class="viewer__nav viewer__nav--next"
          type="button"
          aria-label="Next"
          @click="viewerStep(1)"
        >
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none">
            <path d="M9 5l7 7-7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.result-page {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

/* unified white content board (matches Home .board) */
.board {
  background: var(--color-white);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: 32px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.board__head {
  display: flex;
  align-items: center;
  gap: 16px;
}
.board__title {
  margin: 0;
  font-size: 26px;
  font-weight: 700;
  color: var(--color-text);
}
.rt {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}
.rt__pill {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 6px 14px;
  border-radius: var(--radius-pill);
  font-size: 13px;
  font-weight: 500;
  border: 1px solid transparent;
}
.rt__pill--run {
  background: var(--color-segment);
  color: var(--color-grey);
}
.rt__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-accent);
  animation: rt-pulse 1s ease-in-out infinite;
}
@keyframes rt-pulse {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 1;
  }
}
.rt__pill--ready {
  background: rgba(138, 56, 245, 0.12);
  color: var(--color-accent);
  border-color: rgba(138, 56, 245, 0.3);
}
.rt__pill--ready:hover {
  background: rgba(138, 56, 245, 0.2);
}

/* ---- tabs + select controls ---- */
.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  flex-wrap: wrap;
}
.tabs {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.tab {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 9px 20px;
  border: 1px solid transparent;
  border-radius: var(--radius-pill);
  background: transparent;
  font-family: inherit;
  font-size: 15px;
  color: var(--color-grey);
}
.tab:hover:not(.tab--disabled):not(.tab--active) {
  color: var(--color-text);
}
.tab--active {
  background: var(--color-white);
  border-color: var(--color-border);
  color: var(--color-text);
  box-shadow: var(--shadow-card);
}
.tab--active .tab__ic {
  color: var(--color-accent);
}
.tab--disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.tab__ic {
  display: inline-grid;
  place-items: center;
}

.bar__right {
  display: inline-flex;
  align-items: center;
  gap: 18px;
}
.select-all {
  border: none;
  background: transparent;
  font-family: inherit;
  font-size: 15px;
  color: var(--color-text);
}
.select-all:hover {
  color: var(--color-accent);
}
.seg {
  display: inline-flex;
  padding: 3px;
  border-radius: var(--radius-pill);
  background: var(--color-segment);
}
.seg__btn {
  border: none;
  background: transparent;
  padding: 6px 16px;
  border-radius: var(--radius-pill);
  font-family: inherit;
  font-size: 13px;
  color: var(--color-grey);
}
.seg__btn--on {
  background: var(--color-white);
  color: var(--color-text);
  box-shadow: var(--shadow-card);
}

/* ---- content: lane + edit panel ---- */
.content {
  display: grid;
  grid-template-columns: 1fr 320px;
  gap: 24px;
  align-items: start;
}

.lane {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-white);
  padding: 18px;
  max-height: 720px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 28px;
}
.lane::-webkit-scrollbar {
  width: 8px;
}
.lane::-webkit-scrollbar-thumb {
  background: var(--color-border);
  border-radius: var(--radius-pill);
}

.group {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.group__head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.group__prompt {
  flex: 1;
  min-width: 0;
  padding: 10px 16px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: var(--color-white);
  font-family: inherit;
  font-size: 13px;
  font-style: italic;
  color: var(--color-grey);
  outline: none;
}
.pills {
  display: inline-flex;
  gap: 8px;
  flex: 0 0 auto;
}
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: var(--radius-pill);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}
.pill__ic {
  display: inline-grid;
  place-items: center;
}
.pill--type {
  background: var(--color-text);
  color: var(--color-white);
}
.pill--state {
  background: var(--color-white);
  border: 1px solid var(--color-border);
  color: var(--color-text);
}
.pill--state .pill__ic {
  color: var(--color-accent);
}

/* image grid */
.grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
}
.card {
  position: relative;
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.card--selected {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
.card__img {
  display: block;
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  background: var(--color-bubble);
  cursor: pointer;
}
.lane__state {
  margin: 0;
  padding: 32px 8px;
  text-align: center;
  color: var(--color-grey);
  font-size: 14px;
}
.lane__more {
  display: flex;
  justify-content: center;
  padding-top: 4px;
}
.more-btn {
  border: 1px solid var(--color-border);
  background: var(--color-white);
  border-radius: var(--radius-pill);
  padding: 8px 20px;
  font-family: inherit;
  font-size: 13px;
  color: var(--color-text);
}
.more-btn:hover:not(:disabled) {
  border-color: var(--color-accent);
  color: var(--color-accent);
}
.more-btn:disabled {
  opacity: 0.5;
}
.card__label {
  position: absolute;
  top: 10px;
  left: 10px;
  z-index: 2;
  padding: 4px 12px;
  border-radius: var(--radius-pill);
  background: var(--color-white);
  border: 1px solid var(--color-border);
  font-size: 12px;
  color: var(--color-text);
}
.card__tools {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 8px;
  opacity: 0;
  transition: opacity 0.12s ease;
}
.card:hover .card__tools,
.card--selected .card__tools {
  opacity: 1;
}
.card__tool {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-white);
  color: var(--color-text);
}
.card__tool:hover {
  border-color: var(--color-accent);
  color: var(--color-accent);
}
.card__tool--on {
  background: var(--gradient-active);
  border-color: transparent;
  color: var(--color-white);
}

/* ---- edit panel ---- */
.edit-panel {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.example {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-window);
  padding: 18px;
  min-height: 220px;
}
.example__label {
  font-size: 13px;
  color: var(--color-grey);
}
.example__text {
  margin: 8px 0 0;
  font-size: 14px;
  color: var(--color-text);
  line-height: 1.5;
}
.example__text--muted {
  color: var(--color-grey);
}
.edit-count {
  margin: 4px 0 12px;
  font-size: 13px;
  color: var(--color-grey);
}
.edit-textarea {
  width: 100%;
  padding: 12px 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-white);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--color-text);
  resize: vertical;
  outline: none;
}
.edit-textarea:focus {
  border-color: var(--color-accent);
}
.edit-textarea--sm {
  flex: 1;
  min-width: 0;
}
.edit-each {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 340px;
  overflow-y: auto;
}
.edit-each__row {
  display: flex;
  gap: 10px;
  align-items: stretch;
}
.edit-each__thumb {
  flex: 0 0 auto;
  width: 54px;
  height: 54px;
  object-fit: cover;
  border-radius: var(--radius-sm);
  background: var(--color-bubble);
}
.edit-feedback {
  margin: 12px 0 0;
  font-size: 13px;
}
.edit-feedback--error {
  color: var(--color-stop-hover);
}
.edit-feedback--ok {
  color: var(--color-accent);
}
.edit-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 14px 20px;
  border: none;
  border-radius: var(--radius-md);
  background: var(--gradient-active);
  color: var(--color-white);
  font-family: inherit;
  font-size: 15px;
  font-weight: 600;
}
.edit-btn:hover:not(:disabled) {
  filter: brightness(1.04);
}
.edit-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.edit-btn__ic {
  display: inline-grid;
  place-items: center;
}

/* ---- fullscreen viewer (Phase 3) ---- */
.viewer {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 40px;
  background: rgba(15, 15, 18, 0.86);
  backdrop-filter: blur(4px);
}
.viewer__stage {
  margin: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  max-width: 90vw;
  max-height: 90vh;
}
.viewer__img {
  max-width: 100%;
  max-height: 78vh;
  object-fit: contain;
  border-radius: var(--radius-sm);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
}
.viewer__caption {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  justify-content: center;
  color: #f2f2f2;
  font-size: 13px;
}
.viewer__brand {
  font-weight: 600;
}
.viewer__desc {
  color: #b8b8c0;
  max-width: 60vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.viewer__count {
  color: #b8b8c0;
}
.viewer__close {
  position: absolute;
  top: 22px;
  right: 26px;
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
}
.viewer__close:hover {
  background: rgba(255, 255, 255, 0.22);
}
.viewer__nav {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
}
.viewer__nav:hover {
  background: rgba(255, 255, 255, 0.22);
}

/* ---- responsive ---- */
@media (max-width: 1000px) {
  .content {
    grid-template-columns: 1fr;
  }
  .grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
