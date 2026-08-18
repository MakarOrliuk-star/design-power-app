<script setup lang="ts">
// One element row of a Welcome category: checkbox + name, with the prompt input
// right under it. The textarea shows override ?? default; editing saves the
// user's local override on blur (DB-backed), the ↺ button resets to the global
// default. When the default changed under an existing override, a banner offers
// "оставить мой / взять новый дефолт".
//
// Unlike the tournaments card there is no mode: an element has ONE prompt. An
// element whose default prompt was never written shows an explicit hint instead
// of an empty box — Welcome content is created by hand, so this state is real.
import type { WelCategory, WelElement } from "~/types/welcome";

const props = defineProps<{ element: WelElement; category: WelCategory }>();
const wel = useWelcomeStore();

const checked = computed(() => wel.isChecked(props.element.id));
const overridden = computed(() => wel.isOverridden(props.element));
const changed = computed(() => wel.defaultChanged(props.element));
const missingPrompt = computed(() => !props.element.prompt && !props.element.override);

// Draft mirrors the resolved prompt; re-synced when the override state changes
// elsewhere (reset / take-new-default).
const draft = ref(wel.promptValue(props.element));
watch(
  () => wel.promptValue(props.element),
  (v) => {
    draft.value = v;
  },
);

function onBlur() {
  void wel.saveOverride(props.element, draft.value);
}

// The prompt box auto-grows to its content (no scroll inside the box).
// +2 covers the borders.
const ta = ref<HTMLTextAreaElement | null>(null);
function autosize() {
  const el = ta.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight + 2}px`;
}
onMounted(autosize);
watch(draft, () => void nextTick(autosize));
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
        @click="wel.toggleElement(element.id)"
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
        @click="wel.resetOverride(element)"
      >
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true">
          <path d="M4 10a8 8 0 1 1 2 6.5M4 10V5m0 5h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>

    <div v-if="changed" class="el__banner">
      <span class="el__banner-text">Дефолтный промпт обновлён.</span>
      <button class="el__banner-btn" type="button" @click="wel.keepMine(element)">Оставить мой</button>
      <button class="el__banner-btn el__banner-btn--alt" type="button" @click="wel.takeNewDefault(element)">
        Взять новый
      </button>
    </div>

    <p v-if="missingPrompt" class="el__hint">
      Промпт ещё не задан — впишите свой или попросите добавить его в «Edit Welcome packs».
    </p>

    <textarea
      ref="ta"
      v-model="draft"
      :class="['el__prompt', { 'el__prompt--own': overridden }]"
      rows="2"
      spellcheck="false"
      @blur="onBlur"
    />
  </div>
</template>

<style scoped>
/* The checkbox + name row sits straight on the grey container (no white card),
   the prompt box follows 9px below — same metrics as the tournaments card. */
.el {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.el__card {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 14px;
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

/* checkbox (14px, radius 4, purple fill when on) */
.cb {
  flex: none;
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  padding: 0;
  border: 1.5px solid var(--color-border);
  border-radius: 4px;
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

/* "no default prompt yet" hint — a real state here, nothing is seeded */
.el__hint {
  margin: 0;
  font-size: var(--fs-desc-sm);
  color: var(--color-grey);
}

/* prompt input: compact white box, auto-grown from JS to fit ALL of its text. */
.el__prompt {
  width: 100%;
  padding: 4px 8px;
  border: 1px solid var(--color-bubble);
  border-radius: 8px;
  background: var(--color-white);
  font-family: inherit;
  font-size: 10px;
  line-height: 1.3;
  color: var(--color-grey);
  resize: none;
  overflow: hidden;
  min-height: 31px;
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
