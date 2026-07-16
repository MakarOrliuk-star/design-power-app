<script setup lang="ts">
// Library (TASK super-designer): all brands created by the current
// super-designer — view, edit (same modal as Create a New Style), delete, plus
// the saved test results per brand. No mock existed — построено в стиле сайта
// (board-карточка как Archive). Access is walled by auth.global.ts.
import type { MyBrand, SavedTest } from "~/stores/superDesigner";

useHead({ title: "Design Power — Library" });

const store = useSuperDesignerStore();

onMounted(() => void store.loadBrands());

// Reload after the edit modal closes (create/update already refresh the list;
// this also covers reference changes made inside the modal).
watch(
  () => store.modalOpen,
  (open, was) => {
    if (was && !open) void store.loadBrands();
  },
);

const categoryName = computed(() => {
  const map = new Map(store.categories.map((c) => [c.id, c.name]));
  return (id: string) => map.get(id) ?? "";
});

// Card cover: a color-palette tile with the brand name (no reference image).
// The palette is picked by hashing the brand id — random-looking but stable
// across reloads.
const PALETTES = [
  "linear-gradient(135deg, #6A72D9 0%, #8151AA 55%, #DD88ED 100%)",
  "linear-gradient(135deg, #F7971E 0%, #FFD200 100%)",
  "linear-gradient(135deg, #11998E 0%, #38EF7D 100%)",
  "linear-gradient(135deg, #FC5C7D 0%, #6A82FB 100%)",
  "linear-gradient(135deg, #FF6A88 0%, #FF99AC 100%)",
  "linear-gradient(135deg, #4568DC 0%, #B06AB3 100%)",
  "linear-gradient(135deg, #0BA360 0%, #3CBA92 100%)",
  "linear-gradient(135deg, #F953C6 0%, #B91D73 100%)",
  "linear-gradient(135deg, #36D1DC 0%, #5B86E5 100%)",
  "linear-gradient(135deg, #F2994A 0%, #F2C94C 100%)",
];

function paletteFor(b: MyBrand): string {
  let h = 0;
  for (let i = 0; i < b.id.length; i++) h = (h * 31 + b.id.charCodeAt(i)) >>> 0;
  return PALETTES[h % PALETTES.length]!;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

// ---- Saved tests (lazy, expandable per brand) ----
const expandedId = ref<string | null>(null);
const tests = ref<SavedTest[]>([]);
const testsLoading = ref(false);

async function toggleTests(b: MyBrand) {
  if (expandedId.value === b.id) {
    expandedId.value = null;
    return;
  }
  expandedId.value = b.id;
  tests.value = [];
  testsLoading.value = true;
  try {
    tests.value = await store.loadTests(b.id);
  } catch {
    tests.value = [];
  } finally {
    testsLoading.value = false;
  }
}

// ---- Delete (two-step inline confirm — no native dialogs) ----
const confirmId = ref<string | null>(null);
const deletingId = ref<string | null>(null);

async function onDelete(b: MyBrand) {
  if (confirmId.value !== b.id) {
    confirmId.value = b.id;
    return;
  }
  confirmId.value = null;
  deletingId.value = b.id;
  try {
    await store.deleteBrand(b.id);
    if (expandedId.value === b.id) expandedId.value = null;
  } finally {
    deletingId.value = null;
  }
}
</script>

<template>
  <div class="library-page">
    <TheToolbar />

    <div class="board">
      <div class="head">
        <h2 class="head__title">Library</h2>
        <span v-if="!store.loading" class="head__count">{{ store.brands.length }}</span>
        <button class="btn btn--primary" type="button" @click="store.openCreate()">
          + Create a New Style
        </button>
      </div>

      <!-- states -->
      <div v-if="store.loading" class="state">Загрузка…</div>
      <div v-else-if="store.loadError" class="state state--error">
        {{ store.loadError }}
        <button class="btn btn--ghost" type="button" @click="store.loadBrands()">Повторить</button>
      </div>
      <div v-else-if="store.brands.length === 0" class="state">
        Пока нет ни одного бренда. Нажмите «Create a New Style», чтобы создать первый.
      </div>

      <!-- grid -->
      <div v-else class="lane">
        <div class="grid">
          <article v-for="b in store.brands" :key="b.id" class="card">
            <div class="card__preview" :style="{ background: paletteFor(b) }">
              <h3 class="card__name" :title="b.name">{{ b.name }}</h3>
            </div>

            <div class="card__body">
              <div class="card__meta">
                <span>{{ formatDate(b.createdAt) }}</span>
                <span v-if="b.forcedAspectRatio" class="pill">9:16</span>
              </div>
              <div v-if="b.categoryIds.length" class="card__cats">
                <span v-for="id in b.categoryIds" :key="id" class="pill">{{ categoryName(id) }}</span>
              </div>

              <div class="card__actions">
                <button class="act" type="button" @click="store.openEdit(b)">Редактировать</button>
                <button
                  :class="['act', { 'act--open': expandedId === b.id }]"
                  type="button"
                  @click="toggleTests(b)"
                >
                  Тесты ({{ b.savedTestCount }})
                </button>
                <button
                  :class="['act', 'act--danger']"
                  type="button"
                  :disabled="deletingId === b.id"
                  @click="onDelete(b)"
                >
                  {{ deletingId === b.id ? "Удаление…" : confirmId === b.id ? "Точно удалить?" : "Удалить" }}
                </button>
              </div>
            </div>

            <!-- saved test results -->
            <div v-if="expandedId === b.id" class="tests">
              <div v-if="testsLoading" class="tests__state">Загрузка тестов…</div>
              <div v-else-if="tests.length === 0" class="tests__state">
                Сохранённых тестов пока нет.
              </div>
              <div v-else class="tests__row">
                <a
                  v-for="t in tests"
                  :key="t.id"
                  class="tests__item"
                  :href="t.generatedImageUrl ?? undefined"
                  target="_blank"
                  rel="noopener"
                  :title="t.description ?? ''"
                >
                  <img :src="t.generatedImageUrl ?? ''" alt="" />
                </a>
              </div>
            </div>
          </article>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.library-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-20);
  height: 100%;
  min-height: 0;
}

/* unified white content board (same shell as Archive) */
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

.head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.head__title {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  color: var(--color-text);
}
.head__count {
  padding: 2px 10px;
  border-radius: 999px;
  background: var(--color-segment);
  font-size: 13px;
  font-weight: 600;
  color: var(--color-grey);
}
.head .btn {
  margin-left: auto;
}

.state {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 40px 0;
  justify-content: center;
  font-size: 14px;
  color: var(--color-grey);
}
.state--error {
  color: #c0392b;
}

.lane {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: var(--space-16);
}

.card {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  overflow: hidden;
}
/* palette cover: brand name on a per-brand gradient tile */
.card__preview {
  display: grid;
  place-items: center;
  height: 140px;
  padding: 0 16px;
}
.card__name {
  margin: 0;
  max-width: 100%;
  font-size: 20px;
  font-weight: 700;
  color: #fff;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.card__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px 16px;
}
.card__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--color-grey);
}
.card__cats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.pill {
  padding: 3px 10px;
  border-radius: 999px;
  background: var(--color-segment);
  font-size: 12px;
  color: var(--color-text);
}

.card__actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
.act {
  padding: 8px 12px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-segment);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text);
  cursor: pointer;
}
.act:hover:not(:disabled) {
  filter: brightness(0.96);
}
.act--open {
  background: var(--gradient-active);
  border-color: transparent;
  color: #fff;
  font-weight: 600;
}
.act--danger {
  background: rgba(192, 57, 43, 0.08);
  color: #c0392b;
  border-color: rgba(192, 57, 43, 0.35);
}

.tests {
  border-top: 1px solid var(--color-border);
  padding: 12px 16px;
}
.tests__state {
  font-size: 13px;
  color: var(--color-grey);
}
.tests__row {
  display: flex;
  gap: 10px;
  overflow-x: auto;
}
.tests__item {
  flex: 0 0 auto;
}
.tests__item img {
  height: 110px;
  border-radius: 8px;
  display: block;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 11px 20px;
  border: none;
  border-radius: 14px;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
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
</style>
