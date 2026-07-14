<script setup lang="ts">
// Tournaments (Phase 5) — laid out per figma/tournaments/tournament page.png
// (design 1920 @1.5x, desktop only): a single white board with the brand
// search + chips + Select all + global count stepper + Generate on top, and
// the 4 category columns below. The board is locked to the screen; each
// column's element list scrolls locally.
useHead({ title: "Design Power — Tournaments" });

import { MAX_TOURNAMENT_COUNT } from "~/stores/tournament";

const gen = useGeneratorStore();
const tour = useTournamentStore();

onMounted(() => {
  if (!gen.loaded) void gen.load(); // brand catalog for the search
  if (!tour.loaded) void tour.load();
});

function bumpCount(delta: number) {
  tour.count = Math.min(Math.max(tour.count + delta, 1), MAX_TOURNAMENT_COUNT);
}
</script>

<template>
  <div class="page">
    <TheToolbar />

    <div class="board">
      <!-- top row: search + chips | Select all | count stepper | Generate -->
      <div class="top">
        <TournamentBrandSearchBar class="top__picker" />

        <div class="top__actions">
          <button
            class="selectall"
            type="button"
            :disabled="tour.allChecked"
            @click="tour.selectAll()"
          >Select all</button>
          <button
            class="selectall"
            type="button"
            :disabled="!tour.selectedCount"
            @click="tour.clearSelection()"
          >Clean all</button>
          <span class="selcount" :title="'Выбрано элементов (Base + VIP)'">
            {{ tour.selectedCount }} / {{ tour.totalSelectableCount }}
          </span>

          <div class="stepper">
            <button
              class="stepper__btn"
              type="button"
              aria-label="Меньше"
              :disabled="tour.count <= 1"
              @click="bumpCount(-1)"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none">
                <path d="M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
            </button>
            <span class="stepper__value">{{ tour.count }}</span>
            <button
              class="stepper__btn"
              type="button"
              aria-label="Больше"
              :disabled="tour.count >= MAX_TOURNAMENT_COUNT"
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
            :disabled="!tour.canGenerate"
            :title="tour.canGenerate ? '' : 'Выберите бренд и хотя бы один элемент'"
            @click="tour.generate()"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true">
              <path d="M8 5.8v12.4c0 .8.9 1.3 1.6.9l9.8-6.2c.6-.4.6-1.4 0-1.8L9.6 4.9c-.7-.4-1.6.1-1.6.9z" fill="#fff" />
            </svg>
            Generate
          </button>
        </div>
      </div>

      <p v-if="tour.statusError" class="error">{{ tour.statusError }}</p>

      <!-- states -->
      <div v-if="tour.loading && !tour.loaded" class="state">Загрузка…</div>
      <div v-else-if="tour.loadError" class="state">
        {{ tour.loadError }}
        <button class="state__retry" type="button" @click="tour.load()">Повторить</button>
      </div>

      <!-- 4 category columns -->
      <div v-else class="cols">
        <TournamentCategoryColumn v-for="c in tour.categories" :key="c.id" :category="c" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: var(--space-20);
  height: 100%;
  min-height: 0;
}

/* unified white content board, as on Home — locked to the screen */
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

.top {
  display: flex;
  align-items: flex-start;
  gap: var(--space-16);
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

/* "selected X of Y" indicator next to Select/Clean all */
.selcount {
  font-size: var(--fs-tab);
  font-weight: 600;
  color: var(--color-grey);
  white-space: nowrap;
}

/* count stepper (mock: white card 38px with − / value / +) */
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

/* Generate (mock: gradient pill with a play icon) */
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
  margin: 0;
  font-size: var(--fs-tab);
  color: var(--color-stop-hover);
}

.state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
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

/* 4 columns per row; each column's grey body scrolls locally. With more than
   4 admin-created categories the extra ones wrap to a second row and the
   whole grid scrolls vertically (with exactly 4 nothing changes). */
.cols {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  grid-auto-rows: minmax(340px, 1fr);
  gap: var(--space-20);
  overflow-y: auto;
}

@media (max-width: 1200px) {
  .cols {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    overflow-y: auto;
  }
}
</style>
