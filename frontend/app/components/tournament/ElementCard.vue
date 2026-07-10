<script setup lang="ts">
// One element row of a category column (mock: white card = checkbox + name,
// with the prompt input right under it). The textarea shows override ?? default;
// editing saves the user's local override on blur (DB-backed, Phase 0), the ↺
// button resets to the global default. When an admin changed the default under
// an existing override, a banner offers "оставить мой / взять новый дефолт".
import type { TourCategory, TourElement, TourMode } from "~/stores/tournament";

const props = defineProps<{ element: TourElement; category: TourCategory }>();
const tour = useTournamentStore();

const mode = computed<TourMode>(() => tour.modeOf(props.category));
// Checked state is per element:MODE — the Base tick does not select VIP.
const checked = computed(() => tour.isChecked(props.element.id, mode.value));
const overridden = computed(() => tour.isOverridden(props.element, mode.value));
const changed = computed(() => tour.defaultChanged(props.element, mode.value));

// Draft mirrors the resolved prompt; re-synced when the mode toggles or the
// override state changes elsewhere (reset / take-new-default).
const draft = ref(tour.promptValue(props.element, mode.value));
watch(
  () => tour.promptValue(props.element, mode.value),
  (v) => {
    draft.value = v;
  },
);

function onBlur() {
  void tour.saveOverride(props.element, mode.value, draft.value);
}
</script>

<template>
  <div class="el">
    <div class="el__card">
      <button
        :class="['cb', { 'cb--on': checked }]"
        type="button"
        role="checkbox"
        :aria-checked="checked"
        :aria-label="element.name"
        @click="tour.toggleElement(element.id, mode)"
      >
        <svg v-if="checked" viewBox="0 0 12 12" width="10" height="10" fill="none" aria-hidden="true">
          <path d="M2 6.2l2.6 2.6L10 3.6" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <span class="el__name">{{ element.name }}</span>
      <span v-if="overridden" class="el__badge" title="Промпт изменён локально (виден только вам)">изменено</span>
      <button
        v-if="overridden"
        class="el__reset"
        type="button"
        title="Сбросить к дефолту"
        aria-label="Сбросить к дефолту"
        @click="tour.resetOverride(element, mode)"
      >
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true">
          <path d="M4 10a8 8 0 1 1 2 6.5M4 10V5m0 5h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>

    <div v-if="changed" class="el__banner">
      <span class="el__banner-text">Дефолтный промпт обновлён администратором.</span>
      <button class="el__banner-btn" type="button" @click="tour.keepMine(element, mode)">Оставить мой</button>
      <button class="el__banner-btn el__banner-btn--alt" type="button" @click="tour.takeNewDefault(element, mode)">
        Взять новый
      </button>
    </div>

    <textarea
      v-model="draft"
      :class="['el__prompt', { 'el__prompt--own': overridden }]"
      rows="2"
      spellcheck="false"
      @blur="onBlur"
    />
  </div>
</template>

<style scoped>
.el {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
/* mock: white card 38px, radius 10, 1px #E5E5E5 */
.el__card {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 38px;
  padding: 0 12px;
  background: var(--color-white);
  border: 1px solid var(--color-bubble);
  border-radius: 10px;
}
.el__name {
  font-size: var(--fs-bubble);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.el__badge {
  margin-left: auto;
  flex: none;
  font-size: var(--fs-tag);
  line-height: 1;
  padding: 3px 7px;
  border-radius: var(--radius-pill);
  background: rgba(138, 56, 245, 0.12);
  color: var(--color-accent);
}
.el__reset {
  flex: none;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--color-grey);
}
.el__reset:hover {
  color: var(--color-accent);
}
.el__badge + .el__reset {
  margin-left: 0;
}

/* checkbox (mock: 18px, radius 5, purple fill when on) */
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

/* default-changed banner */
.el__banner {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 6px 10px;
  border-radius: 8px;
  background: rgba(244, 175, 64, 0.14);
  border: 1px solid rgba(244, 175, 64, 0.5);
}
.el__banner-text {
  font-size: var(--fs-desc-sm);
  color: var(--color-text);
}
.el__banner-btn {
  font-size: var(--fs-desc-sm);
  font-weight: 600;
  padding: 3px 9px;
  border: none;
  border-radius: var(--radius-pill);
  background: var(--gradient-active);
  color: #fff;
}
.el__banner-btn--alt {
  background: var(--color-bubble);
  color: var(--color-text);
}

/* prompt input (mock: bordered box, 2 lines of small grey text) */
.el__prompt {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--color-bubble);
  border-radius: 8px;
  background: var(--color-white);
  font-family: inherit;
  font-size: 11px;
  line-height: 1.45;
  color: var(--color-grey);
  resize: vertical;
  min-height: 46px;
  outline: none;
}
.el__prompt:focus {
  border-color: var(--color-accent);
  color: var(--color-text);
}
.el__prompt--own {
  border-color: rgba(138, 56, 245, 0.45);
  color: var(--color-text);
}
</style>
