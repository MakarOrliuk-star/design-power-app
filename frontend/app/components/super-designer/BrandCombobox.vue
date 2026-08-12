<script setup lang="ts">
// Searchable brand picker (задача 6) — replaces the native <select> in
// «Редактировать стиль», where scrolling a long option list to find one brand
// was the complaint. Type to filter, ↑/↓ + Enter to pick, Esc to close.
// Selection is reported through `select`, never by mutating the model: the host
// runs its unsaved-changes guard first and may refuse the switch.
import { filterBrands, type BrandOption } from "./brandFilter";

const props = withDefaults(
  defineProps<{
    brands: BrandOption[];
    /** Currently selected brand id (null → nothing picked yet). */
    modelValue: string | null;
    loading?: boolean;
    disabled?: boolean;
    placeholder?: string;
  }>(),
  { loading: false, disabled: false, placeholder: "Начните вводить название бренда" },
);
const emit = defineEmits<{ (e: "select", id: string): void }>();

const open = ref(false);
const query = ref("");
const activeIndex = ref(0);
const rootRef = ref<HTMLElement | null>(null);
const inputRef = ref<HTMLInputElement | null>(null);
const listId = useId();

const selectedBrand = computed(() => props.brands.find((b) => b.id === props.modelValue) ?? null);
const matches = computed(() => filterBrands(props.brands, query.value));

/** Closed input shows the picked brand; typing switches it to the live query. */
const inputValue = computed({
  get: () => (open.value ? query.value : (selectedBrand.value?.name ?? "")),
  set: (v: string) => {
    query.value = v;
  },
});

function label(b: BrandOption): string {
  return b.isActive ? b.name : `${b.name} (выключен)`;
}

function openList() {
  if (props.disabled || props.loading) return;
  open.value = true;
  query.value = "";
  activeIndex.value = Math.max(
    0,
    matches.value.findIndex((b) => b.id === props.modelValue),
  );
}
function closeList() {
  open.value = false;
  query.value = "";
}
function pick(b: BrandOption | undefined) {
  if (!b) return;
  closeList();
  inputRef.value?.blur();
  emit("select", b.id);
}

function onInput() {
  open.value = true;
  activeIndex.value = 0;
}
function move(delta: number) {
  const n = matches.value.length;
  if (!n) return;
  if (!open.value) {
    openList();
    return;
  }
  activeIndex.value = (activeIndex.value + delta + n) % n;
}
function onEnter() {
  if (!open.value) {
    openList();
    return;
  }
  pick(matches.value[activeIndex.value]);
}

// Click outside closes the list (and drops the half-typed query).
function onDocClick(e: MouseEvent) {
  if (!open.value) return;
  if (!rootRef.value?.contains(e.target as Node)) closeList();
}
onMounted(() => document.addEventListener("mousedown", onDocClick));
onBeforeUnmount(() => document.removeEventListener("mousedown", onDocClick));
</script>

<template>
  <div ref="rootRef" class="combo">
    <input
      ref="inputRef"
      v-model="inputValue"
      class="input combo__input"
      type="text"
      role="combobox"
      autocomplete="off"
      :aria-expanded="open"
      :aria-controls="listId"
      :disabled="disabled || loading"
      :placeholder="loading ? 'Загрузка…' : placeholder"
      @focus="openList"
      @input="onInput"
      @keydown.down.prevent="move(1)"
      @keydown.up.prevent="move(-1)"
      @keydown.enter.prevent="onEnter"
      @keydown.esc.prevent="closeList"
    />

    <ul v-if="open" :id="listId" class="combo__list" role="listbox">
      <li v-if="!matches.length" class="combo__empty">Ничего не найдено</li>
      <li
        v-for="(b, i) in matches"
        :key="b.id"
        role="option"
        :aria-selected="b.id === modelValue"
        :class="[
          'combo__opt',
          {
            'combo__opt--active': i === activeIndex,
            'combo__opt--current': b.id === modelValue,
            'combo__opt--off': !b.isActive,
          },
        ]"
        @mouseenter="activeIndex = i"
        @mousedown.prevent="pick(b)"
      >
        {{ label(b) }}
      </li>
    </ul>
  </div>
</template>

<style scoped>
.combo {
  position: relative;
}
.combo__input {
  cursor: text;
}
.combo__list {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 10;
  max-height: 240px;
  overflow-y: auto;
  margin: 0;
  padding: 4px;
  list-style: none;
  background: var(--color-white);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  box-shadow: 0 10px 30px rgba(30, 30, 60, 0.12);
}
.combo__opt {
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 14px;
  color: var(--color-text);
  cursor: pointer;
}
.combo__opt--active {
  background: var(--color-segment);
}
.combo__opt--current {
  font-weight: 600;
}
.combo__opt--off {
  color: var(--color-grey);
}
.combo__empty {
  padding: 8px 10px;
  font-size: 13px;
  color: var(--color-grey);
}
</style>
