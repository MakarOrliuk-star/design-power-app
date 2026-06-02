<script setup lang="ts">
// Phase 5 — brand picker: category tab bar + "Add all", and an alphabetical,
// scrollable list of brand bubbles. Clicking a bubble selects it (shows up in
// Current styles + Each cards via the shared composable).
//
// Brands come from the master list (app/data/brands.ts = the `brand` table), so
// new brands appear automatically. Phase 7 swaps the static import for a backend
// load (GET /brands); grouping stays the same. Item has its own list (TODO).
import { BRANDS, groupBrands } from "~/data/brands";

const { toggle, addMany, isSelected } = useSelectedStyles();

const categories = [
  "Favorites",
  "All Aramuz",
  "Oscar, Corgi, Spinjoys",
  "DJslot and Vinci",
  "Korea",
  "Sport",
];
const activeCategory = ref("All Aramuz");

// Category filtering needs a brand->category map (from the table) — wired in
// Phase 7. For now every category shows the full alphabetical list.
const groups = computed(() => groupBrands(BRANDS));

function addAll() {
  addMany(groups.value.flatMap((g) => g.brands.map((b) => b.label)));
}
</script>

<template>
  <section class="picker">
    <div class="picker__bar">
      <div class="cats">
        <button
          v-for="c in categories"
          :key="c"
          :class="['cat', { 'cat--on': activeCategory === c }]"
          type="button"
          @click="activeCategory = c"
        >
          {{ c }}
        </button>
      </div>
      <button class="addall" type="button" @click="addAll">Add all</button>
    </div>

    <div class="list">
      <div v-for="g in groups" :key="g.letter" class="group">
        <span class="group__letter">{{ g.letter }}</span>
        <div class="group__brands">
          <button
            v-for="b in g.brands"
            :key="b.id"
            :class="['brand', { 'brand--on': isSelected(b.label) }]"
            type="button"
            @click="toggle(b.label)"
          >
            {{ b.label }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.picker {
  display: flex;
  flex-direction: column;
  gap: 22px;
}

/* category bar */
.picker__bar {
  display: flex;
  align-items: center;
  gap: 20px;
}
.cats {
  display: flex;
  flex: 1;
  gap: 4px;
  background: var(--color-window);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  padding: 5px;
}
.cat {
  border: none;
  background: none;
  padding: 9px 18px;
  border-radius: var(--radius-pill);
  font-family: inherit;
  font-size: 14px;
  color: var(--color-grey);
  white-space: nowrap;
}
.cat--on {
  background: var(--color-white);
  color: var(--color-text);
  box-shadow: var(--shadow-card);
}
.addall {
  flex: 0 0 auto;
  border: none;
  background: none;
  padding: 0;
  font-family: inherit;
  font-size: 14px;
  color: var(--color-text);
}
.addall:hover {
  color: var(--color-accent);
}

/* alphabetical list */
.list {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: 4px 20px;
  max-height: 300px;
  overflow-y: auto;
}
.group {
  display: flex;
  align-items: flex-start;
  gap: 28px;
  padding: 18px 0;
  border-bottom: 1px solid var(--color-bubble);
}
.group:last-child {
  border-bottom: none;
}
.group__letter {
  flex: 0 0 32px;
  font-size: 26px;
  font-weight: 400;
  line-height: 40px;
  color: #c4c4c4;
}
.group__brands {
  flex: 1;
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

/* brand bubbles */
.brand {
  height: 40px;
  padding: 0 20px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: var(--color-white);
  font-family: inherit;
  font-size: 14px;
  color: var(--color-text);
  white-space: nowrap;
}
.brand:hover {
  border-color: var(--color-accent);
}
.brand--on {
  background: var(--color-bubble);
  border-color: var(--color-text);
}
</style>
