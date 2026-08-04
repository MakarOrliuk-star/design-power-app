<script setup lang="ts">
import {
  draftError,
  draftOf,
  hasProviderRefs,
  modesOf,
  movedIds,
  packErrorMessage,
  patchOf,
  serializeDraft,
} from "~/stores/tournamentPackEditor";
import type { ElementDraft, PackCategory, PackElement } from "~/stores/tournamentPackEditor";

/**
 * «Edit Tournament pack» (TASK tournament-pack): the super-designer's tournament
 * editor, opened from the user menu next to «Edit current style» and built on
 * the same fixed frame as StyleModal.vue.
 *
 * Left = the pack (category picker + its elements + the global system wrapper),
 * right = the selected element. Texts stay a DRAFT until «Сохранить (для всех)»,
 * which writes names, both prompts, provider refs and the active flag in ONE
 * audited call. Position (↑/↓) and deletion apply immediately — they are not
 * text, and drafting them would desync the list from the server.
 */

const store = useTournamentPackEditorStore();

const loading = ref(false);
const saving = ref(false);
const rollingBack = ref(false);
const packMsg = ref(""); // left column
const formMsg = ref(""); // right column

const selectedCategoryId = ref("");
const selectedElementId = ref<string | null>(null);
const draft = ref<ElementDraft | null>(null);
/** Serialized last-saved patch — the dirty check for unsaved-changes guards. */
const savedState = ref("");
/** Rename box for the selected category; re-synced on every (re)load. */
const catName = ref("");
/** Draft of the global system wrapper — saved by its own button, not with the element. */
const systemDraft = ref("");

const category = computed<PackCategory | null>(
  () => store.categories.find((c) => c.id === selectedCategoryId.value) ?? null,
);
const elements = computed<PackElement[]>(() => category.value?.elements ?? []);
const element = computed<PackElement | null>(
  () => elements.value.find((e) => e.id === selectedElementId.value) ?? null,
);
const modes = computed(() => (category.value ? modesOf(category.value) : []));
const showRefs = computed(() => (category.value ? hasProviderRefs(category.value) : false));
const dirty = computed(() =>
  category.value && draft.value
    ? serializeDraft(category.value, draft.value) !== savedState.value
    : false,
);

// ---- Draft plumbing ----

function syncDraft() {
  if (!category.value || !element.value) {
    draft.value = null;
    savedState.value = "";
    return;
  }
  draft.value = draftOf(category.value, element.value);
  savedState.value = serializeDraft(category.value, draft.value);
}

/** Unsaved-changes gate in front of every navigation away from the draft. */
function guard(): boolean {
  return !dirty.value || confirm("Несохранённые изменения будут потеряны. Продолжить?");
}

function errorOf(e: unknown, fallback: string): string {
  return packErrorMessage((e as { data?: { error?: string } })?.data?.error, fallback);
}

async function reload() {
  await store.loadConfig();
  systemDraft.value = store.systemPrompt;
  if (!store.categories.some((c) => c.id === selectedCategoryId.value)) {
    selectedCategoryId.value = store.categories[0]?.id ?? "";
    selectedElementId.value = null;
  }
  if (!elements.value.some((e) => e.id === selectedElementId.value)) {
    selectedElementId.value = null;
  }
  catName.value = category.value?.name ?? "";
  syncDraft();
}

// (Re)initialize whenever the modal opens.
watch(
  () => store.modalOpen,
  async (open) => {
    if (!open) return;
    packMsg.value = "";
    formMsg.value = "";
    selectedElementId.value = null;
    draft.value = null;
    savedState.value = "";
    loading.value = true;
    try {
      await store.loadConfig();
      systemDraft.value = store.systemPrompt;
      selectedCategoryId.value = store.categories[0]?.id ?? "";
      catName.value = category.value?.name ?? "";
    } catch {
      packMsg.value = "Не удалось загрузить турниры.";
    } finally {
      loading.value = false;
    }
  },
  { immediate: true },
);

/**
 * The picker is a real <select>, so a cancelled guard must also put the DOM
 * back — the state never changed, and Vue would not re-patch a value it still
 * believes is current.
 */
function onCategoryChange(e: Event) {
  const select = e.target as HTMLSelectElement;
  const id = select.value;
  if (id === selectedCategoryId.value) return;
  if (!guard()) {
    select.value = selectedCategoryId.value;
    return;
  }
  selectCategory(id);
}

function selectCategory(id: string) {
  selectedCategoryId.value = id;
  selectedElementId.value = null;
  catName.value = category.value?.name ?? "";
  formMsg.value = "";
  syncDraft();
}

function selectElement(id: string) {
  if (id === selectedElementId.value || !guard()) return;
  selectedElementId.value = id;
  formMsg.value = "";
  syncDraft();
}

// ---- Element: the single audited save ----

async function saveElement() {
  if (!category.value || !element.value || !draft.value || saving.value) return;
  const problem = draftError(category.value, draft.value);
  if (problem) {
    formMsg.value = problem;
    return;
  }
  if (
    !confirm(
      "Изменения применятся глобально для всех дизайнеров. " +
        "У тех, кто правил этот промпт локально, появится плашка «дефолт изменился». Сохранить?",
    )
  ) {
    return;
  }
  saving.value = true;
  formMsg.value = "";
  try {
    const changed = await store.saveElement(element.value.id, patchOf(category.value, draft.value));
    await reload();
    formMsg.value = changed ? "Сохранено — применено для всех ✓" : "Изменений не было.";
  } catch (e) {
    formMsg.value = errorOf(e, "Не удалось сохранить элемент.");
  } finally {
    saving.value = false;
  }
}

async function rollback() {
  if (!element.value || rollingBack.value) return;
  if (!confirm("Вернуть предыдущую версию элемента? Это применится для всех дизайнеров.")) return;
  rollingBack.value = true;
  formMsg.value = "";
  try {
    await store.rollbackElement(element.value.id);
    await reload();
    formMsg.value = "Предыдущая версия восстановлена ✓";
  } catch (e) {
    formMsg.value = errorOf(e, "Не удалось выполнить откат.");
  } finally {
    rollingBack.value = false;
  }
}

async function removeElement() {
  if (!element.value) return;
  if (
    !confirm(
      `Удалить элемент «${element.value.name}»?\n` +
        "Он пропадёт со страницы Tournaments у всех дизайнеров. " +
        "История генераций и старые ZIP не пострадают.",
    )
  ) {
    return;
  }
  formMsg.value = "";
  try {
    await store.deleteElement(element.value.id);
    await reload();
    formMsg.value = "Элемент выключен — скрыт у дизайнеров.";
  } catch (e) {
    formMsg.value = errorOf(e, "Не удалось удалить элемент.");
  }
}

/** ↑/↓ — applied immediately, position is owned by the server. */
async function move(id: string, dir: -1 | 1) {
  if (!category.value) return;
  const ids = elements.value.map((e) => e.id);
  const next = movedIds(ids, id, dir);
  if (next === ids) return; // already at the edge
  packMsg.value = "";
  try {
    await store.reorderElements(category.value.id, next);
    await reload();
  } catch (e) {
    packMsg.value = errorOf(e, "Не удалось изменить порядок.");
  }
}

// ---- Add an element ----

const newName = ref("");
const newNameVip = ref("");

async function addElement() {
  if (!category.value || !newName.value.trim()) return;
  if (category.value.hasModes && !newNameVip.value.trim()) {
    packMsg.value = "Укажите название для VIP.";
    return;
  }
  packMsg.value = "";
  try {
    const id = await store.createElement(
      category.value.id,
      newName.value.trim(),
      category.value.hasModes ? newNameVip.value.trim() : undefined,
    );
    newName.value = "";
    newNameVip.value = "";
    await reload();
    selectedElementId.value = id;
    syncDraft();
    packMsg.value = "Элемент добавлен ✓ Заполните промпты справа.";
  } catch (e) {
    packMsg.value = errorOf(e, "Не удалось добавить элемент.");
  }
}

// ---- Categories ----

const newCatName = ref("");
const newCatMode = ref<"BOTH" | "BASE" | "VIP">("BOTH");

async function renameCategory() {
  if (!category.value || !catName.value.trim()) return;
  packMsg.value = "";
  try {
    await store.renameCategory(category.value.id, catName.value.trim());
    await reload();
    packMsg.value = "Категория переименована ✓";
  } catch (e) {
    packMsg.value = errorOf(e, "Не удалось переименовать категорию.");
  }
}

async function addCategory() {
  if (!newCatName.value.trim()) return;
  packMsg.value = "";
  try {
    const cat = await store.createCategory(newCatName.value.trim(), newCatMode.value);
    newCatName.value = "";
    await reload();
    selectedCategoryId.value = cat.id;
    selectedElementId.value = null;
    catName.value = category.value?.name ?? "";
    syncDraft();
    packMsg.value = "Категория создана ✓";
  } catch (e) {
    packMsg.value = errorOf(e, "Не удалось создать категорию.");
  }
}

async function removeCategory() {
  if (!category.value) return;
  const n = elements.value.length;
  if (
    !confirm(
      `Удалить категорию «${category.value.name}»${n ? ` вместе с ${n} элемент(ами)` : ""}?\n` +
        "Дефолтные промпты и локальные правки дизайнеров по этим элементам будут УДАЛЕНЫ безвозвратно. " +
        "История генераций и старые ZIP не пострадают.",
    )
  ) {
    return;
  }
  packMsg.value = "";
  try {
    await store.deleteCategory(category.value.id);
    selectedCategoryId.value = "";
    selectedElementId.value = null;
    await reload();
    packMsg.value = "Категория удалена.";
  } catch (e) {
    packMsg.value = errorOf(e, "Не удалось удалить категорию.");
  }
}

// ---- System wrapper (global: affects every tournament generation) ----

const systemOpen = ref(false);
const systemMsg = ref("");
const sysEl = ref<HTMLElement | null>(null);

/** The wrapper sits last in a scrolling column — opening it must also show it. */
function toggleSystem() {
  systemOpen.value = !systemOpen.value;
  if (!systemOpen.value) return;
  void nextTick(() => sysEl.value?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
}

async function saveSystem() {
  if (!systemDraft.value.trim()) {
    systemMsg.value = "Обёртка не может быть пустой.";
    return;
  }
  if (!confirm("Системная обёртка влияет на ВСЕ турнирные генерации. Сохранить?")) return;
  systemMsg.value = "";
  try {
    await store.saveSystemPrompt(systemDraft.value.trim());
    systemMsg.value = "Сохранено ✓";
  } catch (e) {
    systemMsg.value = errorOf(e, "Не удалось сохранить обёртку.");
  }
}

// ---- Provider references (draft until «Сохранить») ----

const refBusy = ref<number | null>(null);

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function onRefFile(slot: number, e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || !draft.value) return;
  refBusy.value = slot;
  try {
    draft.value.referenceImages[slot] = await store.uploadRef(await fileToDataUrl(file));
    formMsg.value = "Картинка загружена — нажмите «Сохранить».";
  } catch (e2) {
    formMsg.value = errorOf(e2, "Ошибка загрузки картинки.");
  } finally {
    refBusy.value = null;
  }
}

function clearRef(slot: number) {
  if (draft.value) draft.value.referenceImages[slot] = "";
}

function close() {
  if (!guard()) return;
  store.close();
}
</script>

<template>
  <Teleport to="body">
    <div v-if="store.modalOpen" class="overlay" @click.self="close">
      <div class="modal" role="dialog" aria-modal="true" aria-label="Edit Tournament pack">
        <button class="modal__close" type="button" aria-label="Закрыть" @click="close">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
        </button>

        <!-- ==== Left: the pack ==== -->
        <section class="col">
          <h2 class="col__title">Турнирный пак</h2>
          <p class="col__sub">
            Категории, элементы и промпты страницы Tournaments. Всё, что вы здесь
            сохраняете, применяется глобально для всех дизайнеров; у тех, кто правил
            промпт локально, появится плашка «дефолт изменился». Каждое изменение логируется.
          </p>

          <div class="scroll">
            <label class="field">
              <span class="field__label">Категория</span>
              <select
                class="input"
                :value="selectedCategoryId"
                :disabled="loading"
                @change="onCategoryChange"
              >
                <option value="" disabled>
                  {{ loading ? "Загрузка…" : "Выберите категорию" }}
                </option>
                <option v-for="c in store.categories" :key="c.id" :value="c.id">
                  {{ c.name }}
                </option>
              </select>
            </label>

            <template v-if="category">
              <div class="badges">
                <span class="badge">
                  {{ category.hasModes ? "Base + VIP" : category.fixedMode === "VIP" ? "только VIP" : "только Base" }}
                </span>
                <span class="badge" title="Папка в ZIP">{{ category.key }}</span>
              </div>

              <div class="row">
                <input v-model="catName" class="input" type="text" maxlength="120" />
                <button class="btn btn--ghost btn--small" type="button" @click="renameCategory">
                  Переименовать
                </button>
                <button class="btn btn--danger btn--small" type="button" @click="removeCategory">
                  Удалить
                </button>
              </div>
            </template>

            <form class="row row--add" @submit.prevent="addCategory">
              <input
                v-model="newCatName"
                class="input"
                type="text"
                placeholder="Новая категория…"
                maxlength="120"
              />
              <select v-model="newCatMode" class="input input--mode">
                <option value="BOTH">Base + VIP</option>
                <option value="BASE">только Base</option>
                <option value="VIP">только VIP</option>
              </select>
              <button class="btn btn--ghost btn--small" type="submit">Создать</button>
            </form>

            <div v-if="category" class="field">
              <span class="field__label">Элементы ({{ elements.length }})</span>
              <ul class="list">
                <li
                  v-for="(el, i) in elements"
                  :key="el.id"
                  :class="['item', { 'item--on': el.id === selectedElementId, 'item--off': !el.isActive }]"
                >
                  <button class="item__pick" type="button" @click="selectElement(el.id)">
                    <span class="item__name">{{ el.name }}</span>
                    <span v-if="category.hasModes && el.nameVip" class="item__vip">{{ el.nameVip }}</span>
                    <span v-if="!el.isActive" class="item__badge">выключен</span>
                  </button>
                  <span class="item__moves">
                    <button
                      class="move"
                      type="button"
                      aria-label="Выше"
                      :disabled="i === 0"
                      @click="move(el.id, -1)"
                    >
                      ↑
                    </button>
                    <button
                      class="move"
                      type="button"
                      aria-label="Ниже"
                      :disabled="i === elements.length - 1"
                      @click="move(el.id, 1)"
                    >
                      ↓
                    </button>
                  </span>
                </li>
                <li v-if="!elements.length" class="empty">Элементов нет.</li>
              </ul>
            </div>

            <form v-if="category" class="row row--add" @submit.prevent="addElement">
              <input
                v-model="newName"
                class="input"
                type="text"
                :placeholder="category.hasModes ? 'Название для Base…' : 'Новый элемент…'"
                maxlength="120"
              />
              <input
                v-if="category.hasModes"
                v-model="newNameVip"
                class="input"
                type="text"
                placeholder="Название для VIP…"
                maxlength="120"
              />
              <button class="btn btn--ghost btn--small" type="submit">Добавить</button>
            </form>

            <div ref="sysEl" class="sys">
              <button class="sys__head" type="button" @click="toggleSystem">
                <span>Системная обёртка</span>
                <span class="sys__chevron">{{ systemOpen ? "−" : "+" }}</span>
              </button>
              <div v-if="systemOpen" class="sys__body">
                <p class="col__sub">
                  Текстовая добавка к промпту элемента, общая для ВСЕХ турнирных
                  генераций. Пусто = промпт элемента уходит prompt writer'у как есть.
                </p>
                <textarea v-model="systemDraft" class="input input--area" rows="3" />
                <div class="row row--end">
                  <span v-if="systemMsg" class="msg">{{ systemMsg }}</span>
                  <button class="btn btn--ghost btn--small" type="button" @click="saveSystem">
                    Сохранить обёртку
                  </button>
                </div>
              </div>
            </div>
          </div>

          <p v-if="packMsg" class="msg msg--foot">{{ packMsg }}</p>
        </section>

        <!-- ==== Right: the selected element ==== -->
        <section :class="['col', { 'col--off': !draft }]">
          <h2 class="col__title">Элемент</h2>
          <p class="col__sub">
            {{
              draft
                ? "Имена и промпты остаются черновиком, пока вы не нажмёте «Сохранить (для всех)»."
                : "Выберите элемент слева или добавьте новый."
            }}
          </p>

          <form v-if="draft && category" class="form" @submit.prevent="saveElement">
            <label class="field">
              <span class="field__label">{{ category.hasModes ? "Название (Base)" : "Название" }}</span>
              <input v-model="draft.name" class="input" type="text" maxlength="120" />
            </label>

            <label v-if="category.hasModes" class="field">
              <span class="field__label">Название (VIP)</span>
              <input v-model="draft.nameVip" class="input" type="text" maxlength="120" />
            </label>

            <label v-for="mode in modes" :key="mode" class="field field--grow">
              <span class="field__label">
                Промпт {{ category.hasModes ? mode : category.name }}
              </span>
              <textarea
                v-model="draft.prompts[mode]"
                class="input input--area"
                placeholder="Дефолтный промпт элемента — виден всем дизайнерам"
              />
            </label>

            <div v-if="showRefs" class="field">
              <span class="field__label">Референсы провайдера (2)</span>
              <div class="refs">
                <div v-for="(url, i) in draft.referenceImages" :key="i" class="ref">
                  <label class="ref__slot">
                    <img v-if="url" :src="url" alt="" class="ref__img" />
                    <span v-else class="ref__plus">{{ refBusy === i ? "…" : "+" }}</span>
                    <input
                      class="ref__file"
                      type="file"
                      accept="image/*"
                      :disabled="refBusy !== null"
                      @change="onRefFile(i, $event)"
                    />
                    <button
                      v-if="url"
                      class="ref__clear"
                      type="button"
                      aria-label="Убрать референс"
                      @click.prevent="clearRef(i)"
                    >
                      ×
                    </button>
                  </label>
                  <input
                    v-model="draft.referenceImages[i]"
                    class="input input--url"
                    type="text"
                    placeholder="URL:"
                  />
                </div>
              </div>
            </div>

            <div class="field">
              <span class="field__label">Статус</span>
              <label class="check">
                <input v-model="draft.isActive" type="checkbox" />
                <span>Активен (виден на странице Tournaments)</span>
              </label>
            </div>

            <div class="form__foot">
              <span v-if="formMsg" class="msg">{{ formMsg }}</span>
              <button class="btn btn--danger btn--small" type="button" @click="removeElement">
                Удалить
              </button>
              <button
                class="btn btn--ghost"
                type="button"
                :disabled="rollingBack || saving"
                @click="rollback"
              >
                {{ rollingBack ? "Откат…" : "Вернуть предыдущую версию" }}
              </button>
              <button class="btn btn--primary" type="submit" :disabled="saving || !dirty">
                {{ saving ? "Сохранение…" : "Сохранить (для всех)" }}
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* Same frame and tokens as StyleModal.vue — the two windows are one family. */
.overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(30, 30, 50, 0.45);
}

.modal {
  position: relative;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 40px;
  width: min(1344px, 100%);
  height: min(760px, calc(100dvh - 48px));
  padding: 32px 40px;
  background: var(--color-white);
  border-radius: 24px;
  overflow: hidden;
}

.modal__close {
  position: absolute;
  top: 16px;
  right: 16px;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--color-border);
  border-radius: 50%;
  background: none;
  color: var(--color-grey);
  cursor: pointer;
}
.modal__close:hover {
  color: var(--color-text);
}

.col {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.col--off {
  opacity: 0.5;
  pointer-events: none;
}
.col__title {
  margin: 0 0 6px;
  font-size: 22px;
  font-weight: 600;
  color: var(--color-text);
}
.col__sub {
  margin: 0 0 14px;
  font-size: 13px;
  line-height: 1.4;
  color: var(--color-grey);
}

/* The pack column holds a lot (category + list + wrapper) — it scrolls inside
   the fixed frame rather than squeezing the fields. */
.scroll {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 4px;
  padding-bottom: 4px;
}
/* Flex children shrink by default, so the element list and the system wrapper
   were squeezed (and clipped) instead of letting the column scroll. Pinning
   them to their natural height is what actually turns on the scrollbar. */
.scroll > * {
  flex: 0 0 auto;
}

.form {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
  overflow-x: hidden;
}
/* Same rule as the pack column, minus the prompt fields — those are SUPPOSED to
   absorb the leftover height. Everything else (names, provider refs, footer)
   keeps its natural size and the column scrolls instead of squashing them. */
.form > *:not(.field--grow) {
  flex: 0 0 auto;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
/* the prompt fields absorb the leftover height but never collapse */
.field--grow {
  flex: 1 1 0;
  min-height: 84px;
}
.field--grow .input--area {
  flex: 1;
  min-height: 52px;
  height: auto;
}
.field__label {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text);
}
.input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--color-white);
  font: inherit;
  font-size: 14px;
  color: var(--color-text);
}
.input::placeholder {
  color: var(--color-grey);
}
.input--area {
  resize: none;
  min-height: 52px;
}
.input--url {
  padding: 8px 10px;
  font-size: 12px;
}
.input--mode {
  flex: 0 0 140px;
}
.input:disabled {
  opacity: 0.55;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.row--add {
  margin-top: 2px;
}
.row--end {
  justify-content: flex-end;
  margin-top: 8px;
}

.badges {
  display: flex;
  gap: 8px;
}
.badge {
  padding: 4px 10px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  font-size: 12px;
  color: var(--color-grey);
}

.list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 6px;
  list-style: none;
  border: 1px solid var(--color-border);
  border-radius: 12px;
}
.item {
  display: flex;
  align-items: center;
  gap: 6px;
  border-radius: 10px;
}
.item--on {
  background: var(--color-segment);
}
.item--off .item__name {
  text-decoration: line-through;
}
.item__pick {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 9px 10px;
  border: none;
  background: none;
  font: inherit;
  font-size: 13.5px;
  text-align: left;
  color: var(--color-text);
  cursor: pointer;
}
.item__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item__vip,
.item__badge {
  flex: 0 0 auto;
  font-size: 11.5px;
  color: var(--color-grey);
}
.item__moves {
  display: flex;
  gap: 2px;
  padding-right: 6px;
}
.move {
  width: 22px;
  height: 22px;
  border: 1px solid var(--color-border);
  border-radius: 7px;
  background: var(--color-white);
  font-size: 12px;
  line-height: 1;
  color: var(--color-text);
  cursor: pointer;
}
.move:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.empty {
  padding: 8px 10px;
  font-size: 13px;
  color: var(--color-grey);
}

.sys {
  margin-top: 4px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  overflow: hidden;
}
.sys__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 10px 12px;
  border: none;
  background: none;
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text);
  cursor: pointer;
}
.sys__chevron {
  color: var(--color-grey);
}
.sys__body {
  padding: 0 12px 12px;
}
.sys__body .col__sub {
  margin-bottom: 8px;
}

.check {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--color-grey);
  cursor: pointer;
}

.refs {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 124px));
  gap: 16px;
}
.ref {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ref__slot {
  position: relative;
  display: grid;
  place-items: center;
  aspect-ratio: 1 / 1.2;
  border: 1px dashed var(--color-border);
  border-radius: 12px;
  overflow: hidden;
  cursor: pointer;
}
.ref__img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.ref__plus {
  font-size: 20px;
  color: var(--color-grey);
}
.ref__file {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: inherit;
}
.ref__clear {
  position: absolute;
  top: 6px;
  right: 6px;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 14px;
  cursor: pointer;
}

.form__foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  margin-top: auto;
  padding-top: 10px;
}
.msg {
  font-size: 13px;
  color: var(--color-grey);
}
.msg--foot {
  margin: 8px 0 0;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px 22px;
  border: none;
  border-radius: 14px;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}
.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.btn--small {
  padding: 9px 14px;
  font-size: 13px;
  font-weight: 500;
}
.btn--primary {
  background: var(--gradient-active);
  color: #fff;
}
.btn--ghost {
  border: 1px solid var(--color-border);
  background: var(--color-white);
  color: var(--color-text);
}
.btn--ghost:hover:not(:disabled) {
  background: var(--color-segment);
}
.btn--danger {
  border: 1px solid var(--color-border);
  background: var(--color-white);
  color: var(--color-stop);
}
.btn--danger:hover:not(:disabled) {
  background: var(--color-bubble);
}

/* small screens: the fixed frame can't fit — fall back to a scrollable stack */
@media (max-width: 980px) {
  .modal {
    grid-template-columns: 1fr;
    height: auto;
    max-height: calc(100dvh - 48px);
    padding: 24px;
    overflow: auto;
  }
}
</style>
