<script setup lang="ts">
// Welcome packs (TASK welcome-packs, Phase 5) — the tournaments layout applied
// to the Welcome entity: one white board with the brand search + chips +
// Select/Clear all + aspect toggle + count stepper + Generate on top, and the
// category columns below. NO scroll inside any block: the board grows with its
// content and the page itself is the one scroll area.
//
// Two differences from /tournaments, both from Phase 1: no Base/VIP toggle, and
// nothing is seeded — so the empty state is a first-class screen, worded by role.
useHead({ title: "Design Power — Welcome packs" });

import { MAX_WELCOME_COUNT, type WelAspect } from "~/stores/welcome";
import { formatBrand } from "~/data/brands";

const gen = useGeneratorStore();
const wel = useWelcomeStore();
const auth = useAuthStore();
const packEditor = useWelcomePackEditorStore();

onMounted(() => {
  if (!gen.loaded) void gen.load(); // brand catalog for the search
  if (!wel.loaded) void wel.load();
});

function bumpCount(delta: number) {
  wel.count = Math.min(Math.max(wel.count + delta, 1), MAX_WELCOME_COUNT);
}

const ASPECTS: WelAspect[] = ["1:1", "9:16"];

/** Nothing is seeded — a fresh install legitimately has zero categories. */
const isEmpty = computed(() => wel.loaded && !wel.categories.length);

// Selected brands whose brand-book aspect lock differs from the page toggle —
// the backend keeps their forcedAspectRatio, so warn instead of surprising.
const forcedConflicts = computed(() =>
  wel.selectedBrandIds
    .map((id) => gen.brands.find((b) => b.id === id))
    .filter(
      (b): b is NonNullable<typeof b> =>
        !!b && !!b.forcedAspectRatio && b.forcedAspectRatio !== wel.aspect,
    ),
);
const forcedHint = computed(() => {
  if (!forcedConflicts.value.length) return "";
  const list = forcedConflicts.value
    .map((b) => `${formatBrand(b.name)} (${b.forcedAspectRatio})`)
    .join(", ");
  return `У брендов ${list} формат зафиксирован брендбуком — выбор формата на них не влияет.`;
});
</script>

<template>
  <div class="page">
    <TheToolbar />

    <div class="board">
      <!-- top row: search + chips | Select all | aspect | count stepper | Generate -->
      <div class="top">
        <WelcomeBrandSearchBar class="top__picker" />

        <div class="top__actions">
          <button
            class="selectall"
            type="button"
            :disabled="!wel.selectedCount"
            @click="wel.clearSelection()"
          >Clear all</button>
          <button
            class="selectall"
            type="button"
            :disabled="wel.allChecked"
            @click="wel.selectAll()"
          >Select all</button>
          <span class="selcount" :title="'Выбрано элементов'">
            {{ wel.selectedCount }} / {{ wel.totalSelectableCount }}
          </span>

          <!-- 1:1 / 9:16 (two white cards, exactly one active) -->
          <div class="aspects" role="radiogroup" aria-label="Формат изображений">
            <button
              v-for="a in ASPECTS"
              :key="a"
              :class="['aspect', { 'aspect--on': wel.aspect === a }]"
              type="button"
              role="radio"
              :aria-checked="wel.aspect === a"
              @click="wel.aspect = a"
            >
              <svg v-if="a === '1:1'" viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true">
                <rect x="4.5" y="4.5" width="15" height="15" rx="2.5" stroke="currentColor" stroke-width="1.8" />
              </svg>
              <svg v-else viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true">
                <rect x="7.5" y="3.5" width="9" height="17" rx="2.5" stroke="currentColor" stroke-width="1.8" />
              </svg>
              {{ a }}
            </button>
          </div>

          <div class="stepper">
            <button
              class="stepper__btn"
              type="button"
              aria-label="Меньше"
              :disabled="wel.count <= 1"
              @click="bumpCount(-1)"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none">
                <path d="M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
            </button>
            <span class="stepper__value">{{ wel.count }}</span>
            <button
              class="stepper__btn"
              type="button"
              aria-label="Больше"
              :disabled="wel.count >= MAX_WELCOME_COUNT"
              @click="bumpCount(1)"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none">
                <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
            </button>
          </div>

          <button
            class="run"
            type="button"
            :disabled="!wel.canGenerate"
            :title="wel.canGenerate ? '' : 'Выберите бренд и хотя бы один элемент'"
            @click="wel.generate()"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true">
              <path d="M8 5.8v12.4c0 .8.9 1.3 1.6.9l9.8-6.2c.6-.4.6-1.4 0-1.8L9.6 4.9c-.7-.4-1.6.1-1.6.9z" fill="#fff" />
            </svg>
            Generate
          </button>
        </div>
      </div>

      <p v-if="forcedHint" class="forced">{{ forcedHint }}</p>
      <p v-if="wel.statusError" class="error">{{ wel.statusError }}</p>

      <!-- states -->
      <div v-if="wel.loading && !wel.loaded" class="state">Загрузка…</div>
      <div v-else-if="wel.loadError" class="state">
        {{ wel.loadError }}
        <button class="state__retry" type="button" @click="wel.load()">Повторить</button>
      </div>

      <!-- Empty state: nothing is seeded in this feature, so the wording depends
           on whether the viewer can actually create the content. -->
      <div v-else-if="isEmpty" class="empty">
        <p class="empty__title">Категорий пока нет</p>
        <template v-if="auth.canCreateStyles">
          <p class="empty__text">
            Создайте первую категорию и её элементы в окне «Edit Welcome packs».
          </p>
          <button class="empty__btn" type="button" @click="packEditor.open()">
            Открыть «Edit Welcome packs»
          </button>
        </template>
        <p v-else class="empty__text">
          Категории ещё не настроены — обратитесь к супер-дизайнеру или администратору.
        </p>
      </div>

      <!-- category columns -->
      <div v-else class="cols">
        <WelcomeCategoryColumn v-for="c in wel.categories" :key="c.id" :category="c" />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* The page is the ONE scroll area (no scroll inside any block). The app shell
   is locked to the viewport, so overflow lives here. */
.page {
  display: flex;
  flex-direction: column;
  gap: var(--space-20);
  height: 100%;
  min-height: 0;
  overflow-y: auto;
}

/* unified white content board — grows with its content (32px padding) */
.board {
  flex: none;
  background: var(--color-white);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: var(--space-32);
}

.top {
  display: flex;
  align-items: flex-start;
  gap: var(--space-16);
  margin-bottom: 54px;
}
.top__picker {
  flex: 1;
  min-width: 0;
  flex-wrap: wrap;
}
.top__actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-16);
}

.selectall {
  border: none;
  background: transparent;
  font-size: var(--fs-user);
  font-weight: 600;
  color: var(--color-text);
  padding: 8px 4px;
}
.selectall:hover:not(:disabled) {
  color: var(--color-accent);
}
.selectall:disabled {
  color: var(--color-grey);
  cursor: default;
}

/* "selected X of Y" indicator next to Select/Clear all */
.selcount {
  font-size: var(--fs-tab);
  font-weight: 600;
  color: var(--color-grey);
  white-space: nowrap;
}

/* 1:1 / 9:16 toggle (white 38px cards with a square / phone icon) */
.aspects {
  display: flex;
  gap: 8px;
}
.aspect {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 16px;
  border: 1px solid var(--color-bubble);
  border-radius: var(--radius-pill);
  background: var(--color-white);
  font-size: var(--fs-user);
  font-weight: 600;
  color: var(--color-grey);
}
.aspect:hover {
  color: var(--color-text);
}
.aspect--on {
  border-color: var(--color-accent);
  color: var(--color-accent);
}

/* count stepper (white card 38px with − / value / +) */
.stepper {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 38px;
  padding: 0 6px;
  border: 1px solid var(--color-bubble);
  border-radius: var(--radius-pill);
  background: var(--color-white);
}
.stepper__btn {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--color-segment);
  color: var(--color-text);
}
.stepper__btn:disabled {
  color: var(--color-grey);
  cursor: default;
}
.stepper__value {
  min-width: 40px;
  text-align: center;
  font-size: var(--fs-user);
  font-weight: 600;
}

/* Generate (gradient pill with a play icon) */
.run {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  height: 38px;
  padding: 0 28px;
  border: none;
  border-radius: var(--radius-pill);
  background: var(--gradient-active);
  color: #fff;
  font-size: var(--fs-user);
  font-weight: 600;
}
.run:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.error {
  margin: -40px 0 14px;
  font-size: var(--fs-tab);
  color: var(--color-stop-hover);
}

/* brand-book aspect lock notice (shown only on a real conflict) */
.forced {
  margin: -40px 0 14px;
  font-size: var(--fs-tab);
  color: var(--color-grey);
}
/* when both notices show, only the first one climbs into the .top margin */
.forced + .error {
  margin-top: 0;
}

.state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: var(--space-64) 0;
  color: var(--color-grey);
  font-size: var(--fs-user);
}
.state__retry {
  border: 1px solid var(--color-border);
  background: var(--color-white);
  border-radius: var(--radius-pill);
  padding: 6px 16px;
  font-size: var(--fs-tab);
}

/* empty state — the first screen of a fresh install */
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: var(--space-64) 0;
  text-align: center;
}
.empty__title {
  margin: 0;
  font-size: var(--fs-title);
  font-weight: 700;
}
.empty__text {
  margin: 0;
  max-width: 460px;
  font-size: var(--fs-user);
  color: var(--color-grey);
}
.empty__btn {
  margin-top: 6px;
  height: 38px;
  padding: 0 24px;
  border: none;
  border-radius: var(--radius-pill);
  background: var(--gradient-active);
  color: #fff;
  font-size: var(--fs-user);
  font-weight: 600;
}

/* 4 columns per row, 32px gaps; columns grow with their content — no scroll
   anywhere inside the board. Further categories wrap to the next row. */
.cols {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  grid-auto-rows: auto;
  align-items: start;
  gap: var(--space-32);
}

@media (max-width: 1200px) {
  .cols {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
