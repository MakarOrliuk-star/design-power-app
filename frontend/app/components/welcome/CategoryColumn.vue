<script setup lang="ts">
// One category column of the Welcome packs page: header = category checkbox
// (with an indeterminate dash on partial selection) + title, then the element
// cards in a grey container. No Base/VIP toggle — Welcome elements carry one
// prompt each. Categories that bring their own reference images are marked, so
// a designer can see why the brand's images are not used there.
import type { WelCategory } from "~/types/welcome";

const props = defineProps<{ category: WelCategory }>();
const wel = useWelcomeStore();

const state = computed(() => wel.categoryState(props.category));
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
        @click="wel.toggleCategory(category)"
      >
        <svg v-if="state === 'all'" viewBox="0 0 12 12" width="10" height="10" fill="none" aria-hidden="true">
          <path d="M2 6.2l2.6 2.6L10 3.6" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <svg v-else-if="state === 'some'" viewBox="0 0 12 12" width="10" height="10" fill="none" aria-hidden="true">
          <path d="M2.5 6h7" stroke="#fff" stroke-width="1.8" stroke-linecap="round" />
        </svg>
      </button>
      <h2 class="col__title">{{ category.name }}</h2>

      <span
        v-if="category.usesOwnReferences"
        class="col__flag"
        title="У элементов этой категории свои референсы — изображения бренда не подмешиваются"
      >свои рефы</span>
    </div>

    <div class="col__body">
      <WelcomeElementCard
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
/* Same metrics as the tournaments column: header row, 20px to the grey body. */
.col {
  display: flex;
  flex-direction: column;
  gap: 20px;
  min-width: 0;
}
.col__head {
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 24px;
}
.col__title {
  margin: 0;
  font-size: var(--fs-title);
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* own-references marker — takes the place of the tournaments' Base/VIP toggle */
.col__flag {
  margin-left: auto;
  flex: none;
  font-size: var(--fs-tag);
  line-height: 1;
  padding: 4px 9px;
  border-radius: var(--radius-pill);
  background: rgba(138, 56, 245, 0.12);
  color: var(--color-accent);
  white-space: nowrap;
}

/* category checkbox (20px) */
.cb {
  flex: none;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1.5px solid var(--color-border);
  border-radius: 5px;
  background: var(--color-white);
}
.cb--on {
  border-color: transparent;
  background: var(--gradient-active);
}

/* grey container with the elements; grows with its content — NO local scroll. */
.col__body {
  min-height: 120px; /* an empty category still reads as a card */
  display: flex;
  flex-direction: column;
  gap: 22px;
  padding: 8px;
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
