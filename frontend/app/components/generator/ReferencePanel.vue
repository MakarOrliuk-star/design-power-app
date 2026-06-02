<script setup lang="ts">
// Right column "References & Promt" (spelling matches the Figma).
// All  -> one shared StyleCard. Each -> a scrollable stack, one card per style.
// R1 wires selection / tabs / mode to the generator store; per-card prompt,
// quantity and reference upload (StyleCard internals) land in R2.

const gen = useGeneratorStore();

const tabs = [
  { label: "Person", value: "PERSON" },
  { label: "Item", value: "ITEM" },
  { label: "Background", value: "BACKGROUND" },
] as const;

const modes = [
  { label: "All", value: "ALL" },
  { label: "Each", value: "EACH" },
] as const;

const example = "Neon casino banner, purple & gold";
</script>

<template>
  <section class="ref">
    <header class="ref__head">
      <h2 class="ref__title">References &amp; Promt</h2>
      <div class="seg seg--mode">
        <button
          v-for="m in modes"
          :key="m.value"
          :class="['seg__btn', { 'seg__btn--on': gen.refMode === m.value }]"
          type="button"
          @click="gen.refMode = m.value"
        >
          {{ m.label }}
        </button>
      </div>
    </header>

    <!-- Person / Item / Background -->
    <div class="tabs">
      <button
        v-for="t in tabs"
        :key="t.value"
        :class="['tab', { 'tab--on': gen.activeTab === t.value }]"
        type="button"
        @click="gen.activeTab = t.value"
      >
        <span v-if="t.value === 'PERSON'" class="tab__ic" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
            <circle cx="12" cy="8" r="3.4" stroke="currentColor" stroke-width="1.6" />
            <path d="M5 19c0-3.3 3.1-5 7-5s7 1.7 7 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
          </svg>
        </span>
        {{ t.label }}
      </button>
    </div>

    <!-- Cards: All = one shared card, Each = one per style (scrollable) -->
    <div class="ref__content">
      <GeneratorStyleCard
        v-if="gen.refMode === 'ALL'"
        class="ref__single"
        :target-key="null"
        title="Style Title"
        :example="example"
      />
      <div v-else class="stack">
        <GeneratorStyleCard
          v-for="s in gen.currentTargets"
          :key="s.key"
          :target-key="s.key"
          :title="s.label"
          :example="example"
        />
        <p v-if="!gen.currentTargets.length" class="stack__empty">
          Выберите стили слева — для каждого появится отдельная секция.
        </p>
      </div>
    </div>

    <!-- Footer -->
    <div class="ref__foot">
      <div class="count" aria-live="polite">
        <span>{{ gen.currentTargets.length }} {{ gen.currentTargets.length === 1 ? "style" : "styles" }}</span>
      </div>

      <button
        class="generate"
        type="button"
        :disabled="!gen.canRun"
        @click="gen.submit()"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
          <path d="M8 5l11 7-11 7V5z" fill="currentColor" />
        </svg>
        {{ gen.submitting ? "Starting…" : "Generate" }}
      </button>
    </div>

    <p v-if="gen.statusError" class="ref__error">{{ gen.statusError }}</p>
  </section>
</template>

<style scoped>
.ref {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

/* header */
.ref__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 18px;
}
.ref__title {
  margin: 0;
  font-size: 24px;
  font-weight: 700;
  color: var(--color-text);
}

/* segmented control */
.seg {
  display: inline-flex;
  background: var(--color-segment);
  border-radius: var(--radius-pill);
  padding: 3px;
}
.seg__btn {
  border: none;
  background: none;
  padding: 5px 14px;
  border-radius: var(--radius-pill);
  font-family: inherit;
  font-size: 13px;
  color: var(--color-grey);
}
.seg__btn--on {
  background: var(--color-white);
  color: var(--color-text);
  box-shadow: var(--shadow-card);
}

/* Person / Item / Background tabs */
.tabs {
  display: flex;
  gap: 6px;
  background: var(--color-segment);
  border-radius: var(--radius-pill);
  padding: 5px;
  margin-bottom: 18px;
}
.tab {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: none;
  background: none;
  padding: 10px;
  border-radius: var(--radius-pill);
  font-family: inherit;
  font-size: 14px;
  font-weight: 500;
  color: var(--color-grey);
}
.tab--on {
  background: var(--color-white);
  color: var(--color-text);
  box-shadow: var(--shadow-card);
}
.tab__ic {
  display: inline-grid;
  place-items: center;
}

/* content area */
.ref__content {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
/* All: single card fills the column height */
.ref__single {
  flex: 1;
}
/* Each: scrollable stack — absolutely fills the content area so it scrolls
   within the column height (driven by the left column) instead of growing
   the board, keeping All/Each the same overall height. */
.stack {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding-right: 6px;
}
.stack__empty {
  margin: 0;
  color: var(--color-grey);
  font-size: 13px;
}

/* footer */
.ref__foot {
  display: flex;
  gap: 14px;
  align-items: center;
  margin-top: 18px;
}
.count {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  height: 52px;
  padding: 0 18px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-white);
  font-family: inherit;
  font-size: 14px;
  color: var(--color-text);
  white-space: nowrap;
}
.count svg {
  color: var(--color-grey);
}
.generate {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  height: 52px;
  border: none;
  border-radius: var(--radius-md);
  background: var(--gradient-active);
  color: var(--color-white);
  font-family: inherit;
  font-size: 16px;
  font-weight: 600;
}
.generate:hover {
  filter: brightness(1.03);
}
.generate:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  filter: none;
}
.ref__error {
  margin: 10px 0 0;
  color: var(--color-stop);
  font-size: 13px;
}
</style>
