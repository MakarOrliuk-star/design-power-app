<script setup lang="ts">
// Brand picker of the Tournaments page (mock: "Search Brand" input + gradient
// chips + "Selected N/4"). Typing opens a dropdown over ALL active brands
// (generator store catalog); picking adds a chip, the ✕ removes it. The 4-brand
// cap is hard: options beyond it are disabled (and the store refuses too).
import { formatBrand } from "~/data/brands";
import { MAX_TOURNAMENT_BRANDS } from "~/stores/tournament";

const gen = useGeneratorStore();
const tour = useTournamentStore();

const query = ref("");
const open = ref(false);
const root = ref<HTMLElement | null>(null);

const matches = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return [];
  return gen.brands
    .filter((b) => b.name.toLowerCase().includes(q) && !tour.selectedBrandIds.includes(b.id))
    .slice(0, 8);
});

const chips = computed(() =>
  tour.selectedBrandIds
    .map((id) => gen.brands.find((b) => b.id === id))
    .filter((b): b is NonNullable<typeof b> => b !== undefined),
);

function pick(id: string) {
  tour.addBrand(id);
  query.value = "";
  open.value = false;
}

function onDocClick(e: MouseEvent) {
  if (root.value && !root.value.contains(e.target as Node)) open.value = false;
}
onMounted(() => document.addEventListener("click", onDocClick));
onBeforeUnmount(() => document.removeEventListener("click", onDocClick));
</script>

<template>
  <div ref="root" class="picker">
    <div class="picker__search">
      <div class="search">
        <input
          v-model="query"
          class="search__input"
          type="text"
          placeholder="Search Brand"
          @focus="open = true"
          @input="open = true"
        />
        <span class="search__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
            <circle cx="11" cy="11" r="6.5" stroke="currentColor" stroke-width="1.8" />
            <path d="M16 16l4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
        </span>

        <div v-if="open && matches.length" class="drop">
          <button
            v-for="b in matches"
            :key="b.id"
            class="drop__item"
            type="button"
            :disabled="tour.brandLimitReached"
            @click="pick(b.id)"
          >
            {{ formatBrand(b.name) }}
          </button>
          <p v-if="tour.brandLimitReached" class="drop__note">Максимум 4 бренда — уберите один.</p>
        </div>
      </div>
      <span class="picker__count">Selected {{ tour.selectedBrandIds.length }}/{{ MAX_TOURNAMENT_BRANDS }}</span>
    </div>

    <div v-for="b in chips" :key="b.id" class="chip">
      <span class="chip__label">{{ formatBrand(b.name) }}</span>
      <button class="chip__x" type="button" :aria-label="`Убрать ${b.name}`" @click="tour.removeBrand(b.id)">
        <svg viewBox="0 0 24 24" width="10" height="10" fill="none">
          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.picker {
  display: flex;
  align-items: flex-start;
  gap: var(--space-16);
  min-width: 0;
}
.picker__search {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 0 1 440px;
  min-width: 220px;
}
/* mock: 440×38, pill, magnifier right */
.search {
  position: relative;
}
.search__input {
  width: 100%;
  height: 38px;
  padding: 0 44px 0 18px;
  border: 1px solid var(--color-bubble);
  border-radius: var(--radius-pill);
  background: var(--color-white);
  font-family: inherit;
  font-size: var(--fs-user);
  color: var(--color-text);
  outline: none;
}
.search__input:focus {
  border-color: var(--color-border);
}
.search__icon {
  position: absolute;
  right: 18px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--color-text);
  display: grid;
  place-items: center;
}
.picker__count {
  font-size: var(--fs-tab);
  color: var(--color-grey);
  padding-left: 4px;
}

/* dropdown */
.drop {
  position: absolute;
  z-index: 30;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  max-height: 280px;
  overflow-y: auto;
  background: var(--color-white);
  border: 1px solid var(--color-bubble);
  border-radius: var(--radius-md);
  box-shadow: 0 8px 24px rgba(31, 31, 31, 0.12);
  padding: 6px;
  display: flex;
  flex-direction: column;
}
.drop__item {
  text-align: left;
  padding: 8px 12px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  font-size: var(--fs-user);
  color: var(--color-text);
}
.drop__item:hover:not(:disabled) {
  background: var(--color-window);
}
.drop__item:disabled {
  color: var(--color-grey);
  cursor: not-allowed;
}
.drop__note {
  margin: 4px 12px 6px;
  font-size: var(--fs-tab);
  color: var(--color-grey);
}

/* gradient chip (mock: pill, white label, ✕ in a translucent circle) */
.chip {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  height: 38px;
  padding: 0 8px 0 18px;
  border-radius: var(--radius-pill);
  background: var(--gradient-active);
  color: #fff;
}
.chip__label {
  font-size: var(--fs-user);
  font-weight: 600;
  white-space: nowrap;
}
.chip__x {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.25);
  color: #fff;
}
.chip__x:hover {
  background: rgba(255, 255, 255, 0.4);
}
</style>
