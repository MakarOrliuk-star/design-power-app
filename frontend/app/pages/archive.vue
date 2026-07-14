<script setup lang="ts">
// Archive page (TASK §2 / figma/archive.PNG). Logic lives in the useArchive
// composable (unit-testable); this file binds it to the template + reuses
// TheToolbar. Content-type tabs + time-period filter + brand search + 5-up grid
// + ZIP export.
import { useArchive } from "~/composables/useArchive";
import { stripGender, type GalleryImage } from "~/composables/useResult";

useHead({ title: "Design Power — Archive" });

const config = useRuntimeConfig();
const gen = useGeneratorStore();

function download(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const {
  TABS,
  PERIODS,
  activeTab,
  period,
  search,
  selectTab,
  selectPeriod,
  images,
  total,
  hasMore,
  loading,
  load,
  isSelected,
  toggleSelect,
  allSelected,
  toggleSelectAll,
  selectedImages,
  copyUrl,
  downloadOne,
  copySelected,
  exportZip,
  exporting,
  newReadyCount,
  dismissReady,
} = useArchive({
  api: useApi() as never,
  apiBase: config.public.apiBase,
  download,
  gen,
});

// "Copied!" feedback: the copy icons flip to a checkmark for a moment.
const { copiedKey, markCopied } = useCopied();
function onCopyUrl(img: GalleryImage) {
  copyUrl(img);
  markCopied(img.id);
}
function onCopySelected() {
  if (!selectedImages.value.length) return;
  copySelected();
  markCopied("selected");
}

// ---- Tournament Pack tab (задача 4): read-only просмотр ----
// No selection/copy/export on this tab; a click opens the shared fullscreen
// slider (ImageViewer — the same ←/→/Esc behavior as on Result). The caption
// is the fixed ZIP file name. Switching tabs empties `images`, which closes
// the viewer by itself (its active id disappears from the list).
const isTournament = computed(() => activeTab.value === "tournament");
const viewerId = ref<string | null>(null);
const viewerItems = computed(() =>
  images.value.map((i) => ({
    id: i.id,
    url: i.generatedImageUrl,
    caption: i.tourFileName ?? stripGender(i.brandName),
  })),
);
</script>

<template>
  <div class="archive-page">
    <TheToolbar />

    <div class="board">
      <!-- Content type -->
      <h2 class="section-title">Content type</h2>

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

        <div class="bar__actions">
          <button
            class="iconbtn"
            type="button"
            aria-label="Open Result"
            title="К результатам"
            @click="navigateTo('/result')"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
              <path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8L12 3z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
              <path d="M18 14l.9 2.1L21 17l-2.1.9L18 20l-.9-2.1L15 17l2.1-.9L18 14z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
            </svg>
          </button>
          <button
            v-if="!isTournament"
            :class="['iconbtn', { 'iconbtn--copied': copiedKey === 'selected' }]"
            type="button"
            aria-label="Copy selected"
            :title="copiedKey === 'selected' ? 'Скопировано ✓' : 'Скопировать ссылки выбранных'"
            :disabled="!selectedImages.length"
            @click="onCopySelected"
          >
            <svg v-if="copiedKey === 'selected'" viewBox="0 0 24 24" width="18" height="18" fill="none">
              <path d="M5 12.5l4 4 10-10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <svg v-else viewBox="0 0 24 24" width="18" height="18" fill="none">
              <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.6" />
              <path d="M5 15V6a2 2 0 012-2h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            </svg>
          </button>
          <button
            v-if="!isTournament"
            class="iconbtn"
            type="button"
            aria-label="Export ZIP"
            :title="selectedImages.length ? 'Скачать выбранные (.zip)' : 'Скачать всё по фильтру (.zip)'"
            :disabled="exporting || (!images.length && !selectedImages.length)"
            @click="exportZip"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
              <path d="M12 4v10m0 0l-4-4m4 4l4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
              <path d="M5 19h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            </svg>
          </button>
        </div>
      </div>

      <!-- Time period -->
      <div class="periods" role="tablist" aria-label="Период">
        <button
          v-for="p in PERIODS"
          :key="p.key"
          type="button"
          role="tab"
          :class="['period', { 'period--active': period === p.key }]"
          :aria-selected="period === p.key"
          @click="selectPeriod(p.key)"
        >
          <span v-if="period === p.key" class="period__dot" aria-hidden="true" />
          {{ p.label }}
        </button>
      </div>

      <!-- Archive heading + live status -->
      <div class="board__head">
        <h1 class="board__title">Archive</h1>
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

      <div class="searchbar">
        <div class="search">
          <input
            v-model="search"
            class="search__input"
            type="text"
            placeholder="Search"
            aria-label="Поиск по бренду"
          />
          <span class="search__ic" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
              <circle cx="11" cy="11" r="6.5" stroke="currentColor" stroke-width="1.7" />
              <path d="M20 20l-3.2-3.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
            </svg>
          </span>
        </div>
        <button v-if="!isTournament" class="select-all" type="button" @click="toggleSelectAll">
          {{ allSelected ? "Deselect all" : "Select all" }}
        </button>
      </div>

      <!-- Grid -->
      <div class="lane">
        <p v-if="!images.length && loading" class="lane__state">Загрузка…</p>
        <p v-else-if="!images.length" class="lane__state">
          {{ search.trim() ? "Ничего не найдено по запросу." : "Пока нет изображений за выбранный период." }}
        </p>

        <div v-else class="grid">
          <div
            v-for="img in images"
            :key="img.id"
            :class="['card', { 'card--selected': isSelected(img.id) }]"
          >
            <span class="card__label">{{ isTournament ? (img.tourFileName ?? stripGender(img.brandName)) : stripGender(img.brandName) }}</span>

            <div v-if="!isTournament" class="card__tools">
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
              <button
                type="button"
                :class="['card__tool', { 'card__tool--copied': copiedKey === img.id }]"
                aria-label="Copy"
                :title="copiedKey === img.id ? 'Скопировано ✓' : 'Скопировать ссылку'"
                @click="onCopyUrl(img)"
              >
                <svg v-if="copiedKey === img.id" viewBox="0 0 24 24" width="15" height="15" fill="none">
                  <path d="M5 12.5l4 4 10-10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                <svg v-else viewBox="0 0 24 24" width="15" height="15" fill="none">
                  <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.6" />
                  <path d="M5 15V6a2 2 0 012-2h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                </svg>
              </button>
              <button type="button" class="card__tool" aria-label="Download" @click="downloadOne(img)">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none">
                  <path d="M12 4v10m0 0l-4-4m4 4l4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                  <path d="M5 19h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                </svg>
              </button>
            </div>

            <img
              :class="['card__img', { 'card__img--clickable': isTournament }]"
              :src="img.generatedImageUrl"
              :alt="img.brandName"
              loading="lazy"
              @click="isTournament && (viewerId = img.id)"
            />

            <span class="card__type">
              <span class="card__type-ic" aria-hidden="true">
                <svg v-if="img.contentType === 'Person'" viewBox="0 0 24 24" width="12" height="12" fill="none">
                  <circle cx="12" cy="8" r="3.2" stroke="currentColor" stroke-width="1.6" />
                  <path d="M5.5 19c0-3.2 3-4.8 6.5-4.8s6.5 1.6 6.5 4.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                </svg>
                <svg v-else-if="img.contentType === 'Item'" viewBox="0 0 24 24" width="12" height="12" fill="none">
                  <path d="M7 4h10M8 4v2.5L6 9v9a2 2 0 002 2h8a2 2 0 002-2V9l-2-2.5V4" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
                </svg>
                <svg v-else-if="img.contentType === 'Tournament'" viewBox="0 0 24 24" width="12" height="12" fill="none">
                  <path d="M8 4h8v5a4 4 0 01-8 0V4z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
                  <path d="M8 6H5v1.5A3.5 3.5 0 008.5 11M16 6h3v1.5A3.5 3.5 0 0115.5 11" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
                  <path d="M12 13v4m-3.5 3h7m-5.5-3h4l.8 3H9.7l.8-3z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
                </svg>
                <svg v-else viewBox="0 0 24 24" width="12" height="12" fill="none">
                  <rect x="4" y="5" width="16" height="14" rx="2" stroke="currentColor" stroke-width="1.5" />
                  <path d="M4 15l4.5-4 3.5 3 3-2.5L20 16" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
                </svg>
              </span>
              {{ img.contentType }}
            </span>
          </div>
        </div>

        <div v-if="hasMore" class="lane__more">
          <button class="more-btn" type="button" :disabled="loading" @click="load(false)">
            {{ loading ? "Загрузка…" : "Показать ещё" }}
          </button>
        </div>
      </div>
    </div>

    <!-- Fullscreen slider (Tournament Pack tab) — same behavior as Result -->
    <ImageViewer v-model:active-id="viewerId" :images="viewerItems" />
  </div>
</template>

<style scoped>
.archive-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-20);
  height: 100%;
  min-height: 0;
}

/* unified white content board */
.board {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: var(--color-white);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: var(--space-32);
  display: flex;
  flex-direction: column;
  gap: var(--space-16);
}

.section-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--color-text);
}
.board__head {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 6px 0 0;
}
.board__title {
  margin: 0;
  font-size: 22px;
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

/* ---- content-type tabs + bulk actions ---- */
.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-16);
  flex-wrap: wrap;
}
.tabs {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px;
  background: var(--color-segment);
  border-radius: var(--radius-pill);
}
.tab {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 18px;
  border: 1px solid transparent;
  border-radius: var(--radius-pill);
  background: transparent;
  font-family: inherit;
  font-size: 14px;
  color: var(--color-grey);
}
.tab:hover:not(.tab--disabled):not(.tab--active) {
  color: var(--color-text);
}
.tab--active {
  background: var(--color-white);
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
.bar__actions {
  display: inline-flex;
  gap: 10px;
}
.iconbtn {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-white);
  color: var(--color-text);
}
.iconbtn:hover:not(:disabled) {
  border-color: var(--color-accent);
  color: var(--color-accent);
}
.iconbtn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.iconbtn--copied,
.iconbtn--copied:hover:not(:disabled) {
  border-color: var(--color-accent);
  background: var(--color-accent);
  color: #ffffff;
}

/* ---- time period row ---- */
.periods {
  display: flex;
  align-items: stretch;
  border-bottom: 1px solid var(--color-border);
}
.period {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px 8px;
  border: none;
  background: transparent;
  font-family: inherit;
  font-size: 13px;
  color: var(--color-grey);
  position: relative;
}
.period:hover:not(.period--active) {
  color: var(--color-text);
}
.period--active {
  color: var(--color-text);
  font-weight: 500;
}
.period--active::after {
  content: "";
  position: absolute;
  left: 16px;
  right: 16px;
  bottom: -1px;
  height: 2px;
  border-radius: 2px;
  background: var(--color-accent);
}
.period__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-accent);
}

/* ---- search + select all ---- */
.searchbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
}
.search {
  position: relative;
  flex: 1;
  max-width: 420px;
}
.search__input {
  width: 100%;
  padding: 11px 42px 11px 18px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: var(--color-white);
  font-family: inherit;
  font-size: 14px;
  color: var(--color-text);
  outline: none;
}
.search__input::placeholder {
  color: var(--color-grey);
}
.search__input:focus {
  border-color: var(--color-accent);
}
.search__ic {
  position: absolute;
  right: 14px;
  top: 50%;
  transform: translateY(-50%);
  display: grid;
  place-items: center;
  color: var(--color-grey);
  pointer-events: none;
}
.select-all {
  border: none;
  background: transparent;
  font-family: inherit;
  font-size: 14px;
  color: var(--color-text);
  white-space: nowrap;
}
.select-all:hover {
  color: var(--color-accent);
}

/* ---- grid lane (local scroll) ---- */
.lane {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 16px;
}
.lane::-webkit-scrollbar {
  width: 8px;
}
.lane::-webkit-scrollbar-thumb {
  background: var(--color-border);
  border-radius: var(--radius-pill);
}
.grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 14px;
}
.lane__state {
  margin: 0;
  padding: 48px 8px;
  text-align: center;
  color: var(--color-grey);
  font-size: 14px;
}
.lane__more {
  display: flex;
  justify-content: center;
  padding-top: 16px;
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

/* ---- card ---- */
.card {
  position: relative;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--color-bubble);
  aspect-ratio: 1;
}
.card--selected {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
.card__img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.card__img--clickable {
  cursor: zoom-in;
}
.card__label {
  position: absolute;
  top: 10px;
  left: 10px;
  z-index: 2;
  max-width: calc(100% - 70px);
  padding: 4px 12px;
  border-radius: var(--radius-pill);
  background: var(--color-white);
  border: 1px solid var(--color-border);
  font-size: 12px;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.card__type {
  position: absolute;
  left: 10px;
  bottom: 10px;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 11px;
  border-radius: var(--radius-pill);
  background: var(--color-white);
  border: 1px solid var(--color-border);
  font-size: 12px;
  color: var(--color-text);
}
.card__type-ic {
  display: inline-grid;
  place-items: center;
  color: var(--color-grey);
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
.card__tool--copied,
.card__tool--copied:hover {
  background: var(--color-accent);
  border-color: transparent;
  color: #ffffff;
}

/* ---- responsive ---- */
@media (max-width: 1400px) {
  .grid {
    grid-template-columns: repeat(4, 1fr);
  }
}
@media (max-width: 1100px) {
  .grid {
    grid-template-columns: repeat(3, 1fr);
  }
}
@media (max-width: 760px) {
  .grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
