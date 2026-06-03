<script setup lang="ts">
// Brand picker (R1: wired to the generator store): category tab bar + "Add all",
// and an alphabetical, scrollable list of brand/style bubbles. The list comes
// from gen.pickerItems (already filtered by the search box + active category);
// clicking a bubble toggles it into the selection (Current styles + Each cards).
import { FAVORITES_CATEGORY, ALL_CATEGORY } from "~/stores/generator";

const gen = useGeneratorStore();

// Favorites + All are always present; the rest come from the catalog.
const tabs = computed(() => [
  { id: FAVORITES_CATEGORY, name: "Favorites" },
  { id: ALL_CATEGORY, name: "All" },
  ...gen.categories.map((c) => ({ id: c.id, name: c.name })),
]);

// Bucket the (already filtered) picker items alphabetically for the A–Z list.
const groups = computed(() => {
  const map = new Map<string, { key: string; label: string }[]>();
  for (const it of gen.pickerItems) {
    const letter = (it.label[0] ?? "#").toUpperCase();
    if (!map.has(letter)) map.set(letter, []);
    map.get(letter)!.push({ key: it.key, label: it.label });
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([letter, items]) => ({ letter, items }));
});
</script>

<template>
  <section class="picker">
    <div class="picker__bar">
      <div class="cats">
        <button
          v-for="c in tabs"
          :key="c.id"
          :class="['cat', { 'cat--on': gen.activeCategoryId === c.id }]"
          type="button"
          @click="gen.activeCategoryId = c.id"
        >
          {{ c.name }}
        </button>
      </div>
      <button class="addall" type="button" @click="gen.selectAllVisible()">Add all</button>
    </div>

    <div class="list">
      <div v-for="g in groups" :key="g.letter" class="group">
        <span class="group__letter">{{ g.letter }}</span>
        <div class="group__brands">
          <div
            v-for="b in g.items"
            :key="b.key"
            :class="['brand', { 'brand--on': gen.isSelected(b.key) }]"
          >
            <button
              type="button"
              :class="['brand__fav', { 'brand__fav--on': gen.isTargetFavorite(b.key) }]"
              :aria-label="gen.isTargetFavorite(b.key) ? 'Убрать из Favorites' : 'В Favorites'"
              :aria-pressed="gen.isTargetFavorite(b.key)"
              @click="gen.toggleTargetFavorite(b.key)"
            >
              <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
                <path
                  d="M12 3.6l2.55 5.17 5.7.83-4.13 4.02.98 5.68L12 16.99l-5.1 2.31.98-5.68L3.75 9.6l5.7-.83L12 3.6z"
                  stroke="currentColor"
                  stroke-width="1.4"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
            <button class="brand__label" type="button" @click="gen.toggleTarget(b.key)">
              {{ b.label }}
            </button>
          </div>
        </div>
      </div>
      <p v-if="!groups.length" class="empty">Ничего не найдено.</p>
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
.empty {
  margin: 0;
  padding: 18px 0;
  color: var(--color-grey);
  font-size: 13px;
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
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 40px;
  padding: 0 16px 0 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: var(--color-white);
  white-space: nowrap;
}
.brand:hover {
  border-color: var(--color-accent);
}
.brand--on {
  background: var(--color-bubble);
  border-color: var(--color-text);
}

/* favorite star (always visible; filled when favorited) */
.brand__fav {
  display: inline-grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--color-grey);
  cursor: pointer;
}
.brand__fav svg {
  fill: none;
}
.brand__fav:hover {
  color: var(--color-accent);
}
.brand__fav--on {
  color: var(--color-accent);
}
.brand__fav--on svg {
  fill: currentColor;
}

/* label toggles selection */
.brand__label {
  border: none;
  background: transparent;
  padding: 0;
  font-family: inherit;
  font-size: 14px;
  color: var(--color-text);
  cursor: pointer;
  white-space: nowrap;
}
</style>
