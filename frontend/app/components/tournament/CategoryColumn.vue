<script setup lang="ts">
// One of the 4 category columns (mock): header = category checkbox (with an
// indeterminate dash on partial selection) + title, a Base/VIP segmented
// toggle for moded categories, then the element cards in a grey container.
// The toggles are independent per category and switching keeps the checked
// elements (Phase 0 decision) — only the shown/generated prompt set changes.
import type { TourCategory, TourMode } from "~/stores/tournament";

const props = defineProps<{ category: TourCategory }>();
const tour = useTournamentStore();

const state = computed(() => tour.categoryState(props.category));
const MODES: TourMode[] = ["BASE", "VIP"];
const modeLabel: Record<TourMode, string> = { BASE: "Base", VIP: "VIP" };
</script>

<template>
  <section class="col">
    <div class="col__head">
      <button
        :class="['cb', { 'cb--on': state !== 'none' }]"
        type="button"
        role="checkbox"
        :aria-checked="state === 'all' ? 'true' : state === 'some' ? 'mixed' : 'false'"
        :aria-label="category.name"
        @click="tour.toggleCategory(category)"
      >
        <svg v-if="state === 'all'" viewBox="0 0 12 12" width="10" height="10" fill="none" aria-hidden="true">
          <path d="M2 6.2l2.6 2.6L10 3.6" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <svg v-else-if="state === 'some'" viewBox="0 0 12 12" width="10" height="10" fill="none" aria-hidden="true">
          <path d="M2.5 6h7" stroke="#fff" stroke-width="1.8" stroke-linecap="round" />
        </svg>
      </button>
      <h2 class="col__title">{{ category.name }}</h2>

      <div v-if="category.hasModes" class="seg">
        <button
          v-for="m in MODES"
          :key="m"
          :class="['seg__btn', { 'seg__btn--on': tour.modeOf(category) === m }]"
          type="button"
          @click="tour.setMode(category, m)"
        >
          {{ modeLabel[m] }}
        </button>
      </div>
    </div>

    <div class="col__body">
      <TournamentElementCard
        v-for="el in category.elements"
        :key="el.id"
        :element="el"
        :category="category"
      />
      <p v-if="!category.elements.length" class="col__empty">Элементов нет.</p>
    </div>
  </section>
</template>

<style scoped>
.col {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  min-height: 0;
}
.col__head {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 30px;
}
.col__title {
  margin: 0;
  font-size: var(--fs-title);
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Base/VIP segmented toggle (mock: pill track, active half = white card) */
.seg {
  margin-left: auto;
  flex: none;
  display: flex;
  padding: 3px;
  border-radius: var(--radius-pill);
  background: var(--color-segment);
}
.seg__btn {
  min-width: 64px;
  padding: 4px 14px;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  font-size: var(--fs-tab);
  font-weight: 600;
  color: var(--color-grey);
}
.seg__btn--on {
  background: var(--color-white);
  color: var(--color-text);
  box-shadow: var(--shadow-card);
}

/* category checkbox — same look as the element one */
.cb {
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
.cb--on {
  border-color: transparent;
  background: var(--gradient-active);
}

/* grey container with the element cards; scrolls locally when tall */
.col__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border-radius: var(--radius-md);
  background: var(--color-window);
  border: 1px solid var(--color-bubble);
}
.col__empty {
  margin: 0;
  font-size: var(--fs-tab);
  color: var(--color-grey);
}
</style>
