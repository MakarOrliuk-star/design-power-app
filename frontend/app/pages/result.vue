<script setup lang="ts">
// Result page. All logic lives in the `useResult` composable so it can be
// unit-tested without the Nuxt runtime (see app/composables/useResult.ts). This
// file only binds the composable to the template + reuses TheToolbar.
import { useResult, stripGender, type ResultApi } from "~/composables/useResult";

useHead({ title: "Design Power — Result" });

const gen = useGeneratorStore();
const {
  TABS,
  activeTab,
  selectMode,
  selectTab,
  groups,
  hasMore,
  loading,
  load,
  toggleSelect,
  isSelected,
  toggleSelectAll,
  selectedImages,
  editPrompt,
  perEditPrompts,
  editing,
  editError,
  editMsg,
  runEdit,
  scaleTarget,
  scaling,
  scaleError,
  scaleMsg,
  runScale,
  runInpaint,
  flatImages,
  viewerId,
  openViewer,
  newReadyCount,
  dismissReady,
} = useResult({ api: useApi() as unknown as ResultApi, gen });

// Per-card copy-link with "copied!" feedback (icon flips to a checkmark).
const { copiedKey, markCopied } = useCopied();
function copyImage(img: { id: string; generatedImageUrl: string }) {
  void navigator.clipboard?.writeText(img.generatedImageUrl);
  markCopied(img.id);
}

// Fullscreen slider — the shared ImageViewer; keyboard stays with useResult's
// own handler (:keyboard="false"), so behavior is identical to before.
const viewerItems = computed(() =>
  flatImages.value.map((i) => ({
    id: i.id,
    url: i.generatedImageUrl,
    caption: stripGender(i.brandName),
    ...(i.description ? { sub: i.description } : {}),
  })),
);
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

        <div v-if="activeTab !== 'tournament'" class="bar__right">
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

      <!-- Tournament Pack (Phase 6): its own batch-grouped body + DES ZIP export.
           An edit batch queued from the tab jumps to Edited, like everywhere. -->
      <ResultTournamentPack v-if="activeTab === 'tournament'" @edited="selectTab('edited')" />

      <!-- Gallery lane + Edit panel -->
      <div v-else class="content">
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
                  <button
                    type="button"
                    :class="['card__tool', { 'card__tool--copied': copiedKey === img.id }]"
                    aria-label="Copy"
                    :title="copiedKey === img.id ? 'Скопировано ✓' : 'Скопировать ссылку'"
                    @click="copyImage(img)"
                  >
                    <svg v-if="copiedKey === img.id" viewBox="0 0 24 24" width="15" height="15" fill="none">
                      <path d="M5 12.5l4 4 10-10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                    <svg v-else viewBox="0 0 24 24" width="15" height="15" fill="none">
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
                    :placeholder="`Промпт для «${stripGender(img.brandName)}»`"
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

          <ScalePanel
            :image="scaleTarget"
            :busy="scaling"
            :error="scaleError"
            :msg="scaleMsg"
            @scale="runScale"
            @inpaint="runInpaint"
          />
        </aside>
      </div>
    </div>

    <!-- Fullscreen image viewer (Phase 3) — shared slider component -->
    <ImageViewer v-model:active-id="viewerId" :images="viewerItems" :keyboard="false" />
  </div>
</template>

<style scoped>
.result-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-20);
  height: 100%;
  min-height: 0;
}

/* unified white content board (matches Home .board) — fills the screen; the
   gallery lane is the local scroll container, the board itself doesn't scroll. */
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
  gap: var(--space-20);
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
  gap: var(--space-16);
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
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 320px;
  gap: var(--space-32);
  align-items: stretch;
}

.lane {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-white);
  padding: 18px;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-32);
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
  grid-template-columns: repeat(4, 1fr);
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
  height: auto;
  object-fit: contain;
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
.card__tool--copied,
.card__tool--copied:hover {
  background: var(--color-accent);
  border-color: transparent;
  color: #ffffff;
}

/* ---- edit panel ---- */
.edit-panel {
  display: flex;
  flex-direction: column;
  gap: 18px;
  align-self: start;
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

/* ---- responsive ---- */
@media (max-width: 1400px) {
  .grid {
    grid-template-columns: repeat(3, 1fr);
  }
}
@media (max-width: 1000px) {
  .content {
    grid-template-columns: 1fr;
  }
  .grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
