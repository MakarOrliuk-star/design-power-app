<script setup lang="ts">
// Result → Tournament tab body, laid out per figma/tournaments/Frame 110-1:
// a white lane (the ONE scroll area) with the two-level grouping — main
// category ("Tournament (Base)") → subcategory ("Tournament_1_Base") → a
// 6-per-row image grid — and the shared right panel (Edit / Scale / Download),
// like every other Result tab. Batch containers stay (Phase 0, 4а): their
// header row IS the category line, plus date/status/counters/batch export.
// All logic lives in useTournamentPack (unit-tested); this file is the template.
import {
  useTournamentPack,
  groupPackByElement,
  packDisplayName,
  batchStatusLabel,
  batchCategoryLabel,
  visibleGenerations,
  packCounts,
  type PackApi,
} from "~/composables/useTournamentPack";
import { stripGender } from "~/composables/useResult";
import type { SelectMode } from "~/composables/useResult";

const props = withDefaults(defineProps<{ selectMode?: SelectMode }>(), {
  selectMode: "ALL",
});
const emit = defineEmits<{ (e: "edited"): void }>();

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
  batches,
  hasMore,
  loading,
  load,
  toggleSelect,
  isSelected,
  selectedCount,
  selectedImages,
  toggleSelectAll,
  batchState,
  toggleBatch,
  editPrompt,
  perEditPrompts,
  editing,
  editError,
  runEdit,
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
} = useTournamentPack({
  api: useApi() as unknown as PackApi,
  apiBase: config.public.apiBase as string,
  download,
  gen,
  onEdited: () => emit("edited"),
});

// The bar's "Select all" lives in result.vue — it delegates here on this tab.
defineExpose({ toggleSelectAll });

// ---- Mask/scale editor: the panel's ScalePanel targets the pencil'd card,
// else the single ticked image (panelScaleImage). A card's pencil opens the
// modal on that image via the exposed openEditor().
const scalePanelRef = ref<{ openEditor: () => void } | null>(null);
function openImageEditor(id: string) {
  setScaleTarget(id);
  void nextTick(() => scalePanelRef.value?.openEditor());
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// ---- Fullscreen slider: ←/→ with wrap-around, Esc, "N / M" — over every
// finished image in display order (batch → subcategory → grid).
const viewerId = ref<string | null>(null);
const viewerItems = computed(() =>
  batches.value.flatMap((b) =>
    groupPackByElement(visibleGenerations(b.generations)).flatMap((g) =>
      g.images
        .filter((img) => img.status === "DONE" && !!img.generatedImageUrl)
        .map((img) => ({
          id: img.id,
          url: img.generatedImageUrl!,
          caption: packDisplayName(img),
        })),
    ),
  ),
);
</script>

<template>
  <div class="pack">
    <div class="content">
      <!-- lane: the ONE scroll area (Frame 110-1) -->
      <div class="lane">
        <!-- states -->
        <p v-if="!batches.length && loading" class="lane__state">Загрузка…</p>
        <p v-else-if="!batches.length" class="lane__state">
          Пока нет турнирных генераций — запустите их на странице Tournaments.
        </p>

        <!-- batches, newest first; header row = the main category line -->
        <section v-for="b in batches" :key="b.id" class="batch">
          <div class="batch__head">
            <!-- whole-session checkbox: ticks every finished image of the batch -->
            <button
              :class="['batch__cb', { 'batch__cb--on': batchState(b) !== 'none' }]"
              type="button"
              role="checkbox"
              :aria-checked="batchState(b) === 'all' ? 'true' : batchState(b) === 'some' ? 'mixed' : 'false'"
              :disabled="packCounts(b).done === 0"
              title="Выбрать все картинки батча"
              @click="toggleBatch(b)"
            >
              <svg v-if="batchState(b) === 'all'" viewBox="0 0 12 12" width="10" height="10" fill="none" aria-hidden="true">
                <path d="M2 6.2l2.6 2.6L10 3.6" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <svg v-else-if="batchState(b) === 'some'" viewBox="0 0 12 12" width="10" height="10" fill="none" aria-hidden="true">
                <path d="M2.5 6h7" stroke="#fff" stroke-width="1.8" stroke-linecap="round" />
              </svg>
            </button>
            <span class="batch__cat">{{ batchCategoryLabel(b) }}</span>
            <span class="batch__date">{{ fmtDate(b.createdAt) }}</span>
            <span
              :class="['batch__status', {
                'batch__status--run': b.status === 'IN_PROGRESS',
                'batch__status--bad': b.status === 'FAILED' || b.status === 'PARTIAL_FAILURE',
              }]"
            >{{ batchStatusLabel(b.status) }}</span>
            <span class="batch__count">{{ packCounts(b).done }} of {{ packCounts(b).total }}</span>
            <button
              class="batch__zip"
              type="button"
              :disabled="exporting || packCounts(b).done === 0"
              @click="exportBatch(b.id)"
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true">
                <path d="M12 4v10m0 0l-4-4m4 4l4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                <path d="M5 19h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
              </svg>
              Download batch
            </button>
          </div>

          <!-- subcategories (Frame 110-1: "Tournament_1_Base" → the grid).
               Failed rows are hidden (retried once by the worker; a second
               failure drops the card and the counters read e.g. "7 of 7"). -->
          <div v-for="g in groupPackByElement(visibleGenerations(b.generations))" :key="g.key" class="sub">
            <div class="sub__title">{{ g.title }}</div>
            <div class="grid">
              <div
                v-for="img in g.images"
                :key="img.id"
                :class="['card', { 'card--selected': isSelected(img.id) }]"
              >
                <template v-if="img.status === 'DONE' && img.generatedImageUrl">
                  <button
                    type="button"
                    :class="['card__check', { 'card__check--on': isSelected(img.id) }]"
                    aria-label="Select"
                    @click="toggleSelect(img.id)"
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none">
                      <path d="M5 12.5l4 4 10-10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                  </button>
                  <!-- Mask editor (same three tools as the Person reference) -->
                  <button
                    type="button"
                    class="card__edit"
                    aria-label="Редактировать"
                    title="Редактировать: расширить / двигать / маска"
                    :disabled="scaling"
                    @click="openImageEditor(img.id)"
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none">
                      <path d="M4 20l4-1 10-10-3-3L5 16l-1 4z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
                      <path d="M14 6l3 3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
                    </svg>
                  </button>
                  <img
                    class="card__img card__img--clickable"
                    :src="img.generatedImageUrl"
                    :alt="img.tourFileName ?? ''"
                    loading="lazy"
                    @click="viewerId = img.id"
                  />
                  <!-- Archive-style pill with the ZIP file name (bottom, clear of the buttons) -->
                  <span class="card__label" :title="packDisplayName(img)">{{ packDisplayName(img) }}</span>
                </template>
                <div v-else class="card__pending">
                  <span class="card__spinner" v-if="img.status === 'QUEUED' || img.status === 'PROCESSING'" />
                  <span class="card__status">{{ img.statusMessage || img.status }}</span>
                </div>
                <span
                  v-if="!(img.status === 'DONE' && img.generatedImageUrl)"
                  class="card__name"
                  :title="packDisplayName(img)"
                >{{ packDisplayName(img) }}</span>
              </div>
            </div>
          </div>
          <p v-if="!groupPackByElement(visibleGenerations(b.generations)).length" class="batch__empty">
            Нет готовых изображений в этом батче.
          </p>
        </section>

        <div v-if="hasMore" class="lane__more">
          <button class="more-btn" type="button" :disabled="loading" @click="load(false)">
            {{ loading ? "Загрузка…" : "Показать ещё" }}
          </button>
        </div>
      </div>

      <!-- right panel (Frame 110-1): Edit prompt(s) + Edit + Scale + Download -->
      <aside class="panel">
        <div class="example">
          <span class="example__label">Edit:</span>

          <p v-if="!selectedImages.length" class="example__text example__text--muted">
            Отметьте картинки чек-боксом, чтобы отредактировать их или скачать
            ZIP. Каждое скачивание получает новый номер DES.
          </p>

          <template v-else>
            <p class="edit-count">Выбрано: {{ selectedImages.length }}</p>

            <textarea
              v-if="props.selectMode === 'ALL'"
              v-model="editPrompt"
              class="edit-textarea"
              rows="6"
              placeholder="Опишите изменение для всех выбранных. Например: make the background darker, add neon glow"
            />

            <div v-else class="edit-each">
              <div v-for="img in selectedImages" :key="img.id" class="edit-each__row">
                <img class="edit-each__thumb" :src="img.generatedImageUrl ?? ''" :alt="img.brandName" />
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
        </div>

        <button
          class="edit-btn"
          type="button"
          :disabled="!selectedImages.length || editing"
          @click="runEdit(props.selectMode)"
        >
          <span class="edit-btn__ic" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
              <path d="M4 20l4-1 10-10-3-3L5 16l-1 4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
              <path d="M14 6l3 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            </svg>
          </span>
          {{ editing ? "Отправка…" : "Edit" }}
        </button>

        <!-- Scale/mask editor — panel section + modal; a card's pencil opens
             the same modal on that card (trigger stays "panel"). -->
        <ScalePanel
          ref="scalePanelRef"
          :image="panelScaleImage"
          :busy="scaling"
          :error="scaleError"
          :msg="scaleMsg"
          @scale="runScale"
          @inpaint="runInpaint"
        />

        <!-- DES ZIP export of the ticked images (mock: Download at the bottom) -->
        <button
          class="dl-btn"
          type="button"
          :disabled="!selectedCount || exporting"
          @click="exportSelected"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true">
            <path d="M12 4v10m0 0l-4-4m4 4l4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M5 19h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
          {{ exporting ? "Готовим архив…" : selectedCount ? `Download (${selectedCount})` : "Download" }}
        </button>
      </aside>
    </div>

    <!-- Fullscreen slider: enlarged view with prev/next, same as Result -->
    <ImageViewer v-model:active-id="viewerId" :images="viewerItems" />
  </div>
</template>

<style scoped>
.pack {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* Frame 110-1: lane + 198px right panel, 32px gutter */
.content {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 198px;
  gap: var(--space-32);
  align-items: stretch;
}

/* the ONE scroll area of the tab (mock: white container, thin scrollbar) */
.lane {
  border: 1px solid var(--color-bubble);
  border-radius: var(--radius-md);
  background: var(--color-white);
  padding: 24px;
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
.lane__state {
  margin: 0;
  padding: 32px 8px;
  text-align: center;
  color: var(--color-grey);
  font-size: var(--fs-user);
}
.lane__more {
  display: flex;
  justify-content: center;
}
.more-btn {
  border: 1px solid var(--color-border);
  background: var(--color-white);
  border-radius: var(--radius-pill);
  padding: 8px 22px;
  font-size: var(--fs-tab);
}

/* one batch = one main category block */
.batch {
  display: flex;
  flex-direction: column;
  gap: var(--space-16);
}
.batch__head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.batch__cb {
  flex: none;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 1.5px solid var(--color-border);
  border-radius: 5px;
  background: var(--color-white);
}
.batch__cb--on {
  border-color: transparent;
  background: var(--gradient-active);
}
.batch__cb:disabled {
  opacity: 0.45;
  cursor: default;
}
/* the main category line (mock: "Tournament (Base)", small semibold) */
.batch__cat {
  font-size: var(--fs-bubble);
  font-weight: 600;
}
.batch__date {
  font-size: var(--fs-tab);
  color: var(--color-grey);
}
.batch__status {
  font-size: var(--fs-tag);
  padding: 3px 10px;
  border-radius: var(--radius-pill);
  background: rgba(138, 56, 245, 0.12);
  color: var(--color-accent);
}
.batch__status--run {
  background: rgba(106, 114, 217, 0.14);
  color: #6a72d9;
}
.batch__status--bad {
  background: rgba(244, 115, 115, 0.14);
  color: var(--color-stop-hover);
}
.batch__count {
  font-size: var(--fs-tab);
  color: var(--color-grey);
}
.batch__zip {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  padding: 0 16px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: var(--color-white);
  font-size: var(--fs-tab);
  font-weight: 600;
  color: var(--color-text);
}
.batch__zip:hover:not(:disabled) {
  border-color: var(--color-accent);
  color: var(--color-accent);
}
.batch__zip:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.batch__empty {
  margin: 0;
  font-size: var(--fs-tab);
  color: var(--color-grey);
}

/* subcategory block (mock: "Tournament_1_Base" line, grid 14px under it) */
.sub {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.sub__title {
  font-size: var(--fs-tab);
  color: var(--color-text);
}

/* image grid — Frame 110-1: 6 per row, 8px gaps, square cards */
.grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 8px;
}
@media (max-width: 1400px) {
  .grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

/* image card */
.card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.card__img {
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  border-radius: var(--radius-sm);
  border: 2px solid transparent;
  background: var(--color-bubble);
}
.card--selected .card__img {
  border-color: var(--color-accent);
}
.card__img--clickable {
  cursor: zoom-in;
}

.card__check {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 2;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: 7px;
  background: var(--color-white);
  color: transparent;
}
.card__check--on {
  border-color: transparent;
  background: var(--gradient-active);
  color: #fff;
}
.card__edit {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 2;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: 7px;
  background: var(--color-white);
  color: var(--color-text);
}
.card__edit:hover:not(:disabled) {
  border-color: var(--color-accent);
  color: var(--color-accent);
}
.card__edit:disabled {
  opacity: 0.5;
  cursor: default;
}
/* Archive-style file-name pill, at the bottom so the buttons stay clear */
.card__label {
  position: absolute;
  bottom: 8px;
  left: 8px;
  z-index: 2;
  max-width: calc(100% - 16px);
  padding: 3px 10px;
  border-radius: var(--radius-pill);
  background: var(--color-white);
  border: 1px solid var(--color-border);
  font-size: 11px;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}
.card__pending {
  display: grid;
  place-items: center;
  gap: 6px;
  aspect-ratio: 1;
  border-radius: var(--radius-sm);
  border: 1px dashed var(--color-border);
  background: var(--color-white);
  padding: 8px;
}
.card__spinner {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid var(--color-bubble);
  border-top-color: var(--color-accent);
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.card__status {
  font-size: var(--fs-desc-sm);
  color: var(--color-grey);
  text-align: center;
}
.card__name {
  font-size: var(--fs-desc-sm);
  color: var(--color-grey);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---- right panel (mirrors the other tabs' edit panel, mock width) ---- */
.panel {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-height: 0;
}
.example {
  border: 1px solid var(--color-bubble);
  border-radius: var(--radius-md);
  background: var(--color-window);
  padding: 16px;
  min-height: 220px;
}
.example__label {
  font-size: 13px;
  color: var(--color-grey);
}
.example__text {
  margin: 8px 0 0;
  font-size: 13px;
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
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-white);
  font-family: inherit;
  font-size: 12px;
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
  width: 42px;
  height: 42px;
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
.edit-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 11px 20px;
  border: none;
  border-radius: var(--radius-md);
  background: var(--gradient-active);
  color: var(--color-white);
  font-family: inherit;
  font-size: 14px;
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

/* DES ZIP export — pinned to the panel bottom, as in the mock */
.dl-btn {
  margin-top: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px 20px;
  border: 1px solid var(--color-bubble);
  border-radius: var(--radius-md);
  background: var(--color-white);
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
}
.dl-btn:hover:not(:disabled) {
  border-color: var(--color-accent);
  color: var(--color-accent);
}
.dl-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

@media (max-width: 1000px) {
  .content {
    grid-template-columns: 1fr;
  }
}
</style>
