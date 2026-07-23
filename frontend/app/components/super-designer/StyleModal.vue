<script setup lang="ts">
import type { BrandDraft, MyBrand } from "~/stores/superDesigner";

/**
 * Create a New Style modal (TASK super-designer, mock figma/super-designer/new
 * style.png). Left: «Создать бренд» — name, categories, base PERSON prompt,
 * specific style, 9:16 toggle, 3 reference slots (unlocked after creation).
 * Right: «Протестировать бренд» — prompt → one NANO_REF test generation shown
 * inline; «Сохранить» drops it into Results. Edit mode (from Library) opens the
 * same form prefilled.
 */

const store = useSuperDesignerStore();

function emptyDraft(): BrandDraft {
  return {
    name: "",
    categoryIds: [],
    personPrompt: "",
    stylePrompt: "",
    referenceImages: ["", "", ""],
    force916: true, // mock default: «Всегда 9:16» is checked for new brands
  };
}

const draft = ref<BrandDraft>(emptyDraft());
/** Set once the brand exists (created here, or edit mode) — unlocks refs + test. */
const brandId = ref<string | null>(null);
const saving = ref(false);
const formMsg = ref("");

const isEdit = computed(() => store.editing !== null);
const created = computed(() => brandId.value !== null);

// ---- «Edit current style» (TASK download-and-edit-style §2) ----
// Any-brand edit mode: a dropdown picks the brand, extra admin fields appear
// (model override, isActive), refs/prompts stay DRAFT until «Сохранить», and
// the save applies globally (audited + rollback-able on the backend).
const isEditAny = computed(() => store.editAnyMode);
const editableLoading = ref(false);
const canRollback = ref(false);
const rollingBack = ref(false);
const draftIsActive = ref(true);
/** Serialized last-saved state — the dirty check for unsaved-changes guards. */
const savedState = ref("");

function currentPatch() {
  return {
    name: draft.value.name.trim(),
    categoryIds: [...draft.value.categoryIds],
    personPrompt: draft.value.personPrompt,
    stylePrompt: draft.value.stylePrompt,
    referenceImages: draft.value.referenceImages.map((s) => s.trim()).filter(Boolean),
    forcedAspectRatio: draft.value.force916 ? "9:16" : null,
    isActive: draftIsActive.value,
  };
}
const dirty = computed(
  () => isEditAny.value && brandId.value !== null && JSON.stringify(currentPatch()) !== savedState.value,
);

async function selectEditable(id: string) {
  if (!id || id === brandId.value) return;
  if (dirty.value && !confirm("Несохранённые изменения будут потеряны. Продолжить?")) return;
  editableLoading.value = true;
  formMsg.value = "";
  resetTest();
  try {
    const b = await store.loadEditableBrand(id);
    draft.value = {
      name: b.name,
      categoryIds: [...b.categoryIds],
      personPrompt: b.personPrompt,
      stylePrompt: b.stylePrompt,
      referenceImages: padTo3(b.referenceImages),
      force916: b.forcedAspectRatio === "9:16",
    };
    draftIsActive.value = b.isActive;
    canRollback.value = b.canRollback;
    brandId.value = id;
    savedState.value = JSON.stringify(currentPatch());
  } catch {
    formMsg.value = "Не удалось загрузить бренд.";
  } finally {
    editableLoading.value = false;
  }
}

async function rollback() {
  if (!brandId.value || rollingBack.value) return;
  if (!confirm("Вернуть предыдущую версию бренда? Это применится глобально для всех пользователей.")) return;
  rollingBack.value = true;
  formMsg.value = "";
  try {
    await store.rollbackEditable(brandId.value);
    const id = brandId.value;
    brandId.value = null; // force selectEditable to re-fetch the restored state
    await selectEditable(id);
    formMsg.value = "Предыдущая версия восстановлена ✓";
  } catch (e: unknown) {
    const code = (e as { data?: { error?: string } })?.data?.error;
    formMsg.value =
      code === "nothing_to_rollback" ? "Нет версий для отката." : "Не удалось выполнить откат.";
  } finally {
    rollingBack.value = false;
  }
}

function padTo3(arr: string[]): string[] {
  const a = [...arr];
  while (a.length < 3) a.push("");
  return a.slice(0, 3);
}

function fromBrand(b: MyBrand): BrandDraft {
  return {
    name: b.name,
    categoryIds: [...b.categoryIds],
    personPrompt: b.personPrompt,
    stylePrompt: b.stylePrompt,
    referenceImages: padTo3(b.referenceImages),
    force916: b.forcedAspectRatio === "9:16",
  };
}

// (Re)initialize whenever the modal opens.
watch(
  () => store.modalOpen,
  (open) => {
    if (!open) return;
    formMsg.value = "";
    resetTest();
    canRollback.value = false;
    draftIsActive.value = true;
    savedState.value = "";
    if (store.editAnyMode) {
      draft.value = emptyDraft();
      brandId.value = null;
      editableLoading.value = true;
      store
        .loadEditable()
        .catch(() => (formMsg.value = "Не удалось загрузить список брендов."))
        .finally(() => (editableLoading.value = false));
      return;
    }
    if (store.editing) {
      draft.value = fromBrand(store.editing);
      brandId.value = store.editing.id;
    } else {
      draft.value = emptyDraft();
      brandId.value = null;
    }
    if (store.categories.length === 0) void store.loadBrands();
  },
  { immediate: true },
);

function toggleCategory(id: string) {
  const arr = draft.value.categoryIds;
  const i = arr.indexOf(id);
  if (i >= 0) arr.splice(i, 1);
  else arr.push(id);
}

async function submitForm() {
  const name = draft.value.name.trim();
  if (!name || saving.value) return;

  if (isEditAny.value) {
    if (!brandId.value) return;
    if (!confirm("Изменения применятся глобально для всех пользователей. Сохранить?")) return;
    saving.value = true;
    formMsg.value = "";
    try {
      await store.updateEditable(brandId.value, currentPatch());
      savedState.value = JSON.stringify(currentPatch());
      canRollback.value = true;
      formMsg.value = "Сохранено — изменения применены для всех ✓";
    } catch (e: unknown) {
      const code = (e as { data?: { error?: string } })?.data?.error;
      formMsg.value =
        code === "already_exists"
          ? "Бренд с таким именем уже существует."
          : "Не удалось сохранить изменения.";
    } finally {
      saving.value = false;
    }
    return;
  }

  saving.value = true;
  formMsg.value = "";
  try {
    if (brandId.value) {
      await store.updateBrand(brandId.value, draft.value);
      formMsg.value = "Изменения сохранены ✓";
    } else {
      const brand = await store.createBrand(draft.value);
      brandId.value = brand.id;
      formMsg.value = "Бренд создан ✓ Теперь можно загрузить референсы и протестировать его.";
    }
  } catch (e: unknown) {
    const code = (e as { data?: { error?: string } })?.data?.error;
    formMsg.value =
      code === "already_exists"
        ? "Бренд с таким именем уже существует."
        : brandId.value
          ? "Не удалось сохранить изменения."
          : "Не удалось создать бренд.";
  } finally {
    saving.value = false;
  }
}

// ---- References (3 slots, active once the brand exists) ----
const refBusy = ref<number | null>(null);

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function persistRefs() {
  // In edit-any mode the refs are part of the DRAFT — they are only written on
  // an explicit «Сохранить» (global, audited), never auto-persisted.
  if (!brandId.value || isEditAny.value) return;
  try {
    await store.updateBrand(brandId.value, draft.value);
  } catch {
    formMsg.value = "Не удалось сохранить референсы.";
  }
}

async function onRefFile(slot: number, e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || !brandId.value) return;
  refBusy.value = slot;
  try {
    const dataUrl = await fileToDataUrl(file);
    draft.value.referenceImages[slot] = await store.uploadRef(dataUrl);
    await persistRefs();
  } catch {
    formMsg.value = "Ошибка загрузки картинки.";
  } finally {
    refBusy.value = null;
  }
}

async function onRefUrlBlur() {
  if (created.value) await persistRefs();
}

function clearRef(slot: number) {
  draft.value.referenceImages[slot] = "";
  void persistRefs();
}

// ---- «Протестировать бренд» ----
const testPrompt = ref("");
const testAspect = ref<"1:1" | "9:16">("9:16");
const testRunning = ref(false);
const testError = ref("");
const testImageUrl = ref<string | null>(null);
const testGenerationId = ref<string | null>(null);
const testSaved = ref(false);
let pollTimer: ReturnType<typeof setTimeout> | null = null;

function resetTest() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  testPrompt.value = "";
  testAspect.value = "9:16";
  testRunning.value = false;
  testError.value = "";
  testImageUrl.value = null;
  testGenerationId.value = null;
  testSaved.value = false;
}

async function runTest() {
  if (!brandId.value || testRunning.value || !testPrompt.value.trim()) return;
  testRunning.value = true;
  testError.value = "";
  testImageUrl.value = null;
  testGenerationId.value = null;
  testSaved.value = false;
  try {
    // Edit-any mode tests the DRAFT (unsaved) state — prompts/refs/model ride
    // as overrides and nothing is written to the brand until «Сохранить».
    const { batchId, generationId } = isEditAny.value
      ? await store.runDraftTest(brandId.value, {
          prompt: testPrompt.value.trim(),
          aspectRatio: testAspect.value,
          personPrompt: draft.value.personPrompt,
          referenceImages: draft.value.referenceImages.map((s) => s.trim()).filter(Boolean),
        })
      : await store.runTest(brandId.value, testPrompt.value.trim(), testAspect.value);
    testGenerationId.value = generationId;
    pollTest(batchId);
  } catch {
    testRunning.value = false;
    testError.value = "Не удалось запустить генерацию.";
  }
}

function pollTest(batchId: string) {
  pollTimer = setTimeout(async () => {
    try {
      const s = await store.pollTest(batchId);
      const gen = s.generations[0];
      if (!s.isComplete) {
        pollTest(batchId);
        return;
      }
      testRunning.value = false;
      if (gen?.status === "DONE" && gen.generatedImageUrl) {
        testImageUrl.value = gen.generatedImageUrl;
      } else {
        testError.value = gen?.statusMessage || "Генерация не удалась.";
      }
    } catch {
      pollTest(batchId); // transient poll error → keep trying
    }
  }, 3000);
}

async function saveTestResult() {
  if (!brandId.value || !testGenerationId.value || testSaved.value) return;
  try {
    await store.saveTest(brandId.value, testGenerationId.value);
    testSaved.value = true;
  } catch {
    testError.value = "Не удалось сохранить результат.";
  }
}

function close() {
  if (dirty.value && !confirm("Несохранённые изменения будут потеряны. Закрыть?")) return;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  store.close();
}

onBeforeUnmount(() => {
  if (pollTimer) clearTimeout(pollTimer);
});
</script>

<template>
  <Teleport to="body">
    <div v-if="store.modalOpen" class="overlay" @click.self="close">
      <div class="modal" role="dialog" aria-modal="true" aria-label="Создать бренд">
        <button class="modal__close" type="button" aria-label="Закрыть" @click="close">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
        </button>

        <!-- ==== Left: create / edit ==== -->
        <section class="col">
          <h2 class="col__title">
            {{ isEditAny ? "Редактировать стиль" : isEdit ? "Редактировать бренд" : "Создать бренд" }}
          </h2>
          <p class="col__sub">
            <template v-if="isEditAny">
              Выберите бренд — промпты, референсы и настройки. Сохранение применяется
              глобально для всех пользователей; каждое изменение логируется.
            </template>
            <template v-else>
              Имя бренда, категории, базовый промт (PERSON) и специфичный стиль.
              Реф-картинки можно загрузить ниже после создания.
            </template>
          </p>

          <label v-if="isEditAny" class="field">
            <span class="field__label">Бренд</span>
            <select
              class="input"
              :value="brandId ?? ''"
              :disabled="editableLoading"
              @change="selectEditable(($event.target as HTMLSelectElement).value)"
            >
              <option value="" disabled>
                {{ editableLoading ? "Загрузка…" : "Выберите бренд" }}
              </option>
              <option v-for="b in store.editableBrands" :key="b.id" :value="b.id">
                {{ b.name }}{{ b.isActive ? "" : " (выключен)" }}
              </option>
            </select>
          </label>

          <form
            :class="['form', { 'form--off': isEditAny && !created }]"
            @submit.prevent="submitForm"
          >
            <label class="field">
              <span class="field__label">Название бренда</span>
              <input
                v-model="draft.name"
                class="input"
                type="text"
                placeholder="Например: Spinogambino (Men)"
                maxlength="120"
              />
            </label>

            <div class="field">
              <span class="field__label">Категории</span>
              <div class="cats">
                <label v-for="c in store.categories" :key="c.id" class="cat">
                  <input
                    type="checkbox"
                    :checked="draft.categoryIds.includes(c.id)"
                    @change="toggleCategory(c.id)"
                  />
                  <span>{{ c.name }}</span>
                </label>
              </div>
            </div>

            <label class="field field--grow">
              <span class="field__label">Базовый промт (PERSON)</span>
              <textarea
                v-model="draft.personPrompt"
                class="input input--area"
                placeholder="Системный “prompt writer” для этого бренда (необязательно)"
              />
            </label>

            <label class="field field--grow">
              <span class="field__label">Специфичный стиль</span>
              <textarea
                v-model="draft.stylePrompt"
                class="input input--area"
                placeholder="Стилевое описание бренда (необязательно)"
              />
            </label>

            <div class="field">
              <span class="field__label">Формат генерации</span>
              <label class="check">
                <input v-model="draft.force916" type="checkbox" />
                <span>Всегда 9:16 — генерировать в 9:16, даже если на Home выбран 1:1</span>
              </label>
            </div>

            <div v-if="isEditAny" class="field">
              <span class="field__label">Статус</span>
              <label class="check">
                <input v-model="draftIsActive" type="checkbox" />
                <span>Бренд активен (виден в пикере на Home)</span>
              </label>
            </div>

            <div class="field">
              <span class="field__label">Референсы (до 3)</span>
              <div class="refs">
                <div v-for="(url, i) in draft.referenceImages" :key="i" class="ref">
                  <label :class="['ref__slot', { 'ref__slot--off': !created }]">
                    <img v-if="url" :src="url" alt="" class="ref__img" />
                    <span v-else class="ref__plus">{{ refBusy === i ? "…" : "+" }}</span>
                    <input
                      class="ref__file"
                      type="file"
                      accept="image/*"
                      :disabled="!created || refBusy !== null"
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
                    :disabled="!created"
                    @blur="onRefUrlBlur"
                  />
                </div>
              </div>
            </div>

            <div class="form__foot">
              <span v-if="formMsg" class="form__msg">{{ formMsg }}</span>
              <button
                v-if="isEditAny && canRollback"
                class="btn btn--ghost"
                type="button"
                :disabled="rollingBack || saving"
                @click="rollback"
              >
                {{ rollingBack ? "Откат…" : "Вернуть предыдущую версию" }}
              </button>
              <button class="btn btn--primary" type="submit" :disabled="saving || !draft.name.trim()">
                {{
                  saving
                    ? "Сохранение…"
                    : isEditAny
                      ? "Сохранить (для всех)"
                      : created
                        ? "Сохранить изменения"
                        : "Создать бренд"
                }}
              </button>
            </div>
          </form>
        </section>

        <!-- ==== Right: test the brand ==== -->
        <section :class="['col', 'col--test', { 'col--off': !created }]">
          <h2 class="col__title">Протестировать бренд</h2>
          <p class="col__sub">
            <template v-if="isEditAny">
              Тест использует НЕсохранённые изменения — можно проверить новый
              промпт до того, как он применится для всех.
            </template>
            <template v-else>
              Сгенерируйте тестовое изображение с текущими настройками бренда,
              чтобы оценить качество и соответствие стиля.
            </template>
          </p>

          <label class="field">
            <span class="field__label">Введите промт</span>
            <textarea
              v-model="testPrompt"
              class="input input--area"
              rows="3"
              :disabled="!created"
              placeholder="Например: маленький французский бульдог сидит на облачке и держит в лапах золотую звезду"
            />
          </label>

          <div class="test-row">
            <div class="aspects">
              <button
                :class="['aspect', { 'aspect--on': testAspect === '1:1' }]"
                type="button"
                :disabled="!created"
                @click="testAspect = '1:1'"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none">
                  <rect x="5" y="5" width="14" height="14" rx="2" stroke="currentColor" stroke-width="1.7" />
                </svg>
                1:1
              </button>
              <button
                :class="['aspect', { 'aspect--on': testAspect === '9:16' }]"
                type="button"
                :disabled="!created"
                @click="testAspect = '9:16'"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none">
                  <rect x="7.5" y="4" width="9" height="16" rx="2" stroke="currentColor" stroke-width="1.7" />
                </svg>
                9:16
              </button>
            </div>
            <button
              class="btn btn--primary btn--wide"
              type="button"
              :disabled="!created || testRunning || !testPrompt.trim()"
              @click="runTest"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
                <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
              </svg>
              {{ testRunning ? "Генерация…" : "Сгенерировать" }}
            </button>
          </div>

          <div class="result">
            <div v-if="testRunning" class="result__state">
              <span class="spinner" aria-hidden="true" />
              Генерируем изображение…
            </div>
            <div v-else-if="testError" class="result__state result__state--error">
              {{ testError }}
            </div>
            <img
              v-else-if="testImageUrl"
              :src="testImageUrl"
              alt="Тестовая генерация"
              class="result__img"
            />
            <div v-else class="result__state result__state--empty">
              Результат появится здесь
            </div>
          </div>

          <div class="test-foot">
            <button
              class="btn btn--ghost"
              type="button"
              :disabled="!testImageUrl || testSaved"
              @click="saveTestResult"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
                <path d="M5 5h11l3 3v11H5z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
                <path d="M8 5v5h7V5M8 19v-5h8v5" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
              </svg>
              {{ testSaved ? "Сохранено ✓" : "Сохранить" }}
            </button>
            <span v-if="testSaved" class="test-foot__hint">Картинка добавлена в Results.</span>
          </div>
        </section>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(30, 30, 50, 0.45);
}

/* Fixed frame per the mock (new style.png, 1920@1.5x → ~1344×750 CSS px):
   both columns fit WITHOUT internal scroll; the modal clips instead. */
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

.form {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  /* edit-any mode adds fields (brand dropdown, status) — when the fixed frame
     runs out of height the form scrolls instead of collapsing the fields. */
  overflow-y: auto;
  overflow-x: hidden;
}
/* edit-any mode before a brand is picked: the form waits for the dropdown */
.form--off {
  opacity: 0.5;
  pointer-events: none;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
/* the two prompt fields absorb the leftover height, but never collapse below
   label + a usable textarea (bug-edit.PNG: fields overlapped at min-height 0) */
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
.input:disabled {
  opacity: 0.55;
}

.cats {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.cat {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  font-size: 12.5px;
  color: var(--color-text);
  cursor: pointer;
}
.check {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--color-grey);
  cursor: pointer;
}

/* mock: three fixed ~125px slots with a URL input under each */
.refs {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 124px));
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
.ref__slot--off {
  cursor: not-allowed;
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
  margin-top: auto; /* pin to the column bottom inside the fixed frame */
}
.form__msg {
  font-size: 13px;
  color: var(--color-grey);
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
  cursor: pointer;
}
.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
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
.btn--wide {
  flex: 1 1 auto;
}

/* --- test column --- */
.test-row {
  display: flex;
  gap: 12px;
  margin-top: 14px;
}
.aspects {
  display: flex;
  gap: 8px;
}
.aspect {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 10px 16px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--color-white);
  font: inherit;
  font-size: 13px;
  color: var(--color-text);
  cursor: pointer;
}
.aspect--on {
  border-color: transparent;
  background: var(--color-segment);
  font-weight: 600;
}

.result {
  flex: 1 1 auto;
  min-height: 0;
  margin-top: 14px;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  display: flex;
  align-items: flex-start;
  overflow: hidden;
}
.result__state {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: auto;
  font-size: 13px;
  color: var(--color-grey);
}
.result__state--error {
  color: #c0392b;
}
/* mock: the image sits top-left inside the result area, scaled to fit */
.result__img {
  max-width: 100%;
  max-height: 100%;
  border-radius: 8px;
  object-fit: contain;
}

.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--color-border);
  border-top-color: var(--color-grey);
  border-radius: 50%;
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.test-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 14px;
}
.test-foot__hint {
  font-size: 13px;
  color: var(--color-grey);
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
