<script setup lang="ts">
// Result → Tournament Pack tab body (Phase 6). Batch history newest first;
// inside a batch the images are grouped by their ZIP pack folder
// (Brand_Element) with the fixed file names as captions. Checkboxes drive the
// partial DES export; every batch header has a whole-batch export. All logic
// lives in useTournamentPack (unit-tested); this file is the template.
import {
  useTournamentPack,
  groupPack,
  packDisplayName,
  batchStatusLabel,
  batchCategoryLabel,
  visibleGenerations,
  packCounts,
  type PackApi,
} from "~/composables/useTournamentPack";

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
  clearSelection,
  batchState,
  toggleBatch,
  editPrompt,
  editing,
  editError,
  runEdit,
  scaleImage,
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

// ---- Mask editor (задача 3): a card's pencil opens the shared ScalePanel modal
// (trigger="external") on that image; the result replaces the pack image in place.
const scalePanelRef = ref<{ openEditor: () => void } | null>(null);
function openImageEditor(id: string) {
  setScaleTarget(id);
  void nextTick(() => scalePanelRef.value?.openEditor());
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// ---- Fullscreen slider (задача 4): the shared ImageViewer — ←/→ arrows with
// wrap-around, Esc, "N / M" — over every finished image in display order.
const viewerId = ref<string | null>(null);
const viewerItems = computed(() =>
  batches.value.flatMap((b) =>
    groupPack(visibleGenerations(b.generations)).flatMap((g) =>
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
    <!-- selection bar -->
    <div class="pack__bar">
      <span class="pack__hint">
        Отметьте картинки для частичной выгрузки — или скачайте батч целиком.
        Каждое скачивание получает новый номер DES.
      </span>
      <button
        v-if="selectedCount"
        class="pack__clear"
        type="button"
        @click="clearSelection"
      >Снять выбор</button>
      <button
        class="pack__zip"
        type="button"
        :disabled="!selectedCount || exporting"
        @click="exportSelected"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true">
          <path d="M12 4v10m0 0l-4-4m4 4l4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M5 19h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        </svg>
        {{ exporting ? "Готовим архив…" : `Download ZIP (${selectedCount})` }}
      </button>
    </div>

    <!-- Edit the ticked images — same flow as the other tabs, lands in Edited -->
    <div v-if="selectedCount" class="editbar">
      <input
        v-model="editPrompt"
        class="editbar__input"
        type="text"
        placeholder="Промпт: что изменить в выбранных картинках…"
        @keyup.enter="runEdit"
      />
      <button
        class="editbar__btn"
        type="button"
        :disabled="editing || !editPrompt.trim()"
        @click="runEdit"
      >
        {{ editing ? "Отправка…" : `Edit (${selectedCount})` }}
      </button>
      <span v-if="editError" class="editbar__error">{{ editError }}</span>
    </div>

    <!-- Scale/mask editor feedback (errors are shown inside the modal itself) -->
    <p v-if="scaleMsg" class="pack__scalemsg">{{ scaleMsg }}</p>

    <!-- states -->
    <p v-if="!batches.length && loading" class="pack__state">Загрузка…</p>
    <p v-else-if="!batches.length" class="pack__state">
      Пока нет турнирных генераций — запустите их на странице Tournaments.
    </p>

    <!-- batches, newest first -->
    <div v-for="b in batches" :key="b.id" class="batch">
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

      <!-- Failed rows are hidden (retried once by the worker; a second failure
           drops the card and the counters read e.g. "7 of 7"). -->
      <div v-for="g in groupPack(visibleGenerations(b.generations))" :key="g.key" class="group">
        <!-- brand folder at the ZIP root -->
        <div class="group__title">{{ g.title }}/</div>
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
    </div>

    <div v-if="hasMore" class="pack__more">
      <button class="more-btn" type="button" :disabled="loading" @click="load(false)">
        {{ loading ? "Загрузка…" : "Показать ещё" }}
      </button>
    </div>

    <!-- Mask/scale editor modal — opened from a card's pencil button -->
    <ScalePanel
      ref="scalePanelRef"
      trigger="external"
      :image="scaleImage"
      :busy="scaling"
      :error="scaleError"
      :msg="scaleMsg"
      @scale="runScale"
      @inpaint="runInpaint"
    />

    <!-- Fullscreen slider: enlarged view with prev/next, same as Result -->
    <ImageViewer v-model:active-id="viewerId" :images="viewerItems" />
  </div>
</template>

<style scoped>
.pack {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-20);
  padding-right: 4px;
}
/* thin scrollbar, same as the Result Generated lane */
.pack::-webkit-scrollbar {
  width: 8px;
}
.pack::-webkit-scrollbar-thumb {
  background: var(--color-border);
  border-radius: var(--radius-pill);
}

/* selection / export bar */
.pack__bar {
  display: flex;
  align-items: center;
  gap: var(--space-16);
}
.pack__hint {
  font-size: var(--fs-tab);
  color: var(--color-grey);
}
.pack__clear {
  margin-left: auto;
  border: none;
  background: transparent;
  font-size: var(--fs-tab);
  color: var(--color-grey);
}
.pack__clear:hover {
  color: var(--color-text);
}
.pack__clear + .pack__zip {
  margin-left: 0;
}
.pack__zip {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 20px;
  border: none;
  border-radius: var(--radius-pill);
  background: var(--gradient-active);
  color: #fff;
  font-size: var(--fs-tab);
  font-weight: 600;
}
.pack__clear + .pack__zip,
.pack__hint + .pack__zip {
  margin-left: 0;
}
.pack__bar > .pack__zip:only-of-type {
  margin-left: auto;
}
.pack__zip:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* edit bar (shown when something is ticked) */
.editbar {
  display: flex;
  align-items: center;
  gap: 10px;
}
.editbar__input {
  flex: 1;
  min-width: 0;
  height: 34px;
  padding: 0 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: var(--color-white);
  font-family: inherit;
  font-size: var(--fs-tab);
  color: var(--color-text);
  outline: none;
}
.editbar__input:focus {
  border-color: var(--color-accent);
}
.editbar__btn {
  flex: none;
  height: 34px;
  padding: 0 20px;
  border: none;
  border-radius: var(--radius-pill);
  background: var(--gradient-active);
  color: #fff;
  font-size: var(--fs-tab);
  font-weight: 600;
}
.editbar__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.editbar__error {
  font-size: var(--fs-tab);
  color: var(--color-stop-hover);
}

.pack__state {
  margin: 24px 0;
  text-align: center;
  color: var(--color-grey);
  font-size: var(--fs-user);
}
.pack__scalemsg {
  margin: 0;
  font-size: var(--fs-tab);
  color: var(--color-accent);
}

/* one batch */
.batch {
  border: 1px solid var(--color-bubble);
  border-radius: var(--radius-md);
  background: var(--color-window);
  padding: var(--space-16);
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
.batch__cat {
  font-size: var(--fs-user);
  font-weight: 700;
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

/* pack folder group */
.group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.group__title {
  font-size: var(--fs-tab);
  font-weight: 600;
}
/* 8 per row (заказчик: чуть крупнее, не 10 в строку) */
.grid {
  display: grid;
  grid-template-columns: repeat(8, minmax(0, 1fr));
  gap: 12px;
}
@media (max-width: 1400px) {
  .grid {
    grid-template-columns: repeat(6, minmax(0, 1fr));
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
.card__status--bad {
  color: var(--color-stop-hover);
}
.card__name {
  font-size: var(--fs-desc-sm);
  color: var(--color-grey);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pack__more {
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
</style>
