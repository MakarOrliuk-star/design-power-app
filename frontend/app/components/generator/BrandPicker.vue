<script setup lang="ts">
import { ALL_CATEGORY, FAVORITES_CATEGORY } from "~/stores/generator";

const gen = useGeneratorStore();

const tabs = computed(() => [
  { id: FAVORITES_CATEGORY, name: "Favorites" },
  ...gen.categories.map((c) => ({ id: c.id, name: c.name })),
  { id: ALL_CATEGORY, name: "All" },
]);
</script>

<template>
  <section class="panel">
    <div class="search">
      <input v-model="gen.search" type="text" :placeholder="gen.isItem ? 'Search styles' : 'Search'" />
    </div>

    <div class="bar">
      <!-- Category tabs are Person-only; Item styles are a flat list. -->
      <div v-if="!gen.isItem" class="tabs">
        <button
          v-for="t in tabs"
          :key="t.id"
          :class="['tab', { 'tab--active': gen.activeCategoryId === t.id }]"
          @click="gen.activeCategoryId = t.id"
        >
          {{ t.name }}
        </button>
      </div>
      <span v-else class="item-hint">Item-стили</span>

      <button v-if="gen.pickerItems.length" class="select-all" @click="gen.selectAllVisible()">
        Выбрать все
      </button>
    </div>

    <div v-if="gen.pickerItems.length" class="grid">
      <div
        v-for="it in gen.pickerItems"
        :key="it.key"
        :class="['brand', { 'brand--selected': gen.isSelected(it.key) }]"
        @click="gen.toggleTarget(it.key)"
      >
        <span class="brand__name">{{ it.label }}</span>
        <button
          v-if="it.brand"
          class="brand__fav"
          :class="{ 'brand__fav--on': it.brand.isFavorite }"
          title="В избранное"
          @click.stop="gen.toggleFavorite(it.brand)"
        >
          ★
        </button>
      </div>
    </div>

    <p v-else-if="gen.loaded" class="empty">
      {{ gen.isItem ? "Стили не найдены (нужен seed Item-стилей)." : "Бренды не найдены (нужен seed)." }}
    </p>
    <p v-else class="empty">Загрузка…</p>
  </section>
</template>

<style scoped>
.panel {
  background: var(--color-window);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: 20px;
}
.search input {
  width: 100%;
  padding: 10px 14px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-white);
  margin-bottom: 16px;
  font-size: 14px;
}
.bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
.tabs {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  background: var(--color-bubble);
  border-radius: 999px;
  padding: 4px;
}
.tab {
  border: none;
  background: none;
  padding: 6px 14px;
  border-radius: 999px;
  font-size: 13px;
  color: var(--color-grey);
}
.tab--active {
  background: var(--color-white);
  color: var(--color-text);
}
.item-hint {
  color: var(--color-grey);
  font-size: 13px;
  font-weight: 500;
}
.select-all {
  margin-left: auto;
  border: none;
  background: none;
  color: var(--color-grey);
  font-weight: 500;
}
.select-all:hover {
  color: var(--color-text);
}
.grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-white);
  cursor: pointer;
  font-size: 14px;
  user-select: none;
}
.brand--selected {
  background: var(--color-bubble);
  border-color: var(--color-text);
}
.brand__fav {
  border: none;
  background: none;
  color: var(--color-border);
  font-size: 14px;
  line-height: 1;
}
.brand__fav--on {
  color: #f4b73b;
}
.empty {
  color: var(--color-grey);
  font-size: 14px;
}
</style>
