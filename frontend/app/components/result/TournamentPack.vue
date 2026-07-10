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

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// ---- Lightbox: click a thumbnail -> the image opens larger (Esc/click closes) ----
const viewer = ref<{ url: string; name: string } | null>(null);
function openViewer(url: string, name: string) {
  viewer.value = { url, name };
}
function closeViewer() {
  viewer.value = null;
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") closeViewer();
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
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

      <div v-for="g in groupPack(b.generations)" :key="g.key" class="group">
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
              <img
                class="card__img card__img--clickable"
                :src="img.generatedImageUrl"
                :alt="img.tourFileName ?? ''"
                loading="lazy"
                @click="openViewer(img.generatedImageUrl, packDisplayName(img))"
              />
            </template>
            <div v-else class="card__pending">
              <span class="card__spinner" v-if="img.status === 'QUEUED' || img.status === 'PROCESSING'" />
              <span :class="['card__status', { 'card__status--bad': img.status === 'FAILED' }]">
                {{ img.statusMessage || img.status }}
              </span>
            </div>
            <span class="card__name" :title="packDisplayName(img)">{{ packDisplayName(img) }}</span>
          </div>
        </div>
      </div>
    </div>

    <div v-if="hasMore" class="pack__more">
      <button class="more-btn" type="button" :disabled="loading" @click="load(false)">
        {{ loading ? "Загрузка…" : "Показать ещё" }}
      </button>
    </div>

    <!-- Lightbox: enlarged view of a clicked result -->
    <Teleport to="body">
      <div v-if="viewer" class="lb" @click="closeViewer">
        <img class="lb__img" :src="viewer.url" :alt="viewer.name" @click.stop />
        <span class="lb__name">{{ viewer.name }}</span>
        <button class="lb__close" type="button" aria-label="Закрыть" @click="closeViewer">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    </Teleport>
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
.batch__date {
  font-size: var(--fs-user);
  font-weight: 700;
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
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 12px;
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

/* lightbox */
.lb {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 40px;
  background: rgba(15, 15, 18, 0.78);
  backdrop-filter: blur(4px);
  cursor: zoom-out;
}
.lb__img {
  max-width: min(900px, 88vw);
  max-height: 78vh;
  object-fit: contain;
  border-radius: var(--radius-md);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
  cursor: default;
}
.lb__name {
  font-size: var(--fs-tab);
  color: #fff;
  opacity: 0.85;
}
.lb__close {
  position: absolute;
  top: 20px;
  right: 20px;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.14);
  color: #fff;
}
.lb__close:hover {
  background: rgba(255, 255, 255, 0.26);
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
