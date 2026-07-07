<script setup lang="ts">
// Right "Style" panel (home 2.0 new / Each mockups). The content tabs and the
// All/Each toggle moved up into the board's control row (index.vue):
//   All  -> one flat StyleCard (upload slot + prompt).
//   Each -> a scrollable 2-column grid of bordered cards (prompt + refs each).
// Either way the bottom controls row (1:1 / 9:16, quantity, Generate) is
// shared and bound to the global store state — in Each mode the backend
// falls back per-target → global for aspect and count.
const gen = useGeneratorStore();

const MIN_QTY = 1;
const MAX_QTY = 4;

const ASPECTS = [
  { value: "1:1", icon: "square" },
  { value: "9:16", icon: "portrait" },
] as const;

function setQty(n: number) {
  gen.imageCount = Math.min(MAX_QTY, Math.max(MIN_QTY, n));
}

const example = "Neon casino banner, purple & gold";
</script>

<template>
  <section class="ref">
    <!-- Cards: All = one flat card, Each = one bordered card per style -->
    <div class="ref__content">
      <GeneratorStyleCard
        v-if="gen.refMode === 'ALL'"
        class="ref__single"
        :target-key="null"
        title="Style Title"
        :example="example"
        flat
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

    <!-- shared controls: formats, quantity, Generate (both modes) -->
    <div class="controls">
      <button
        v-for="a in ASPECTS"
        :key="a.value"
        type="button"
        :class="['fmt', { 'fmt--on': gen.aspectRatio === a.value }]"
        :aria-pressed="gen.aspectRatio === a.value"
        @click="gen.aspectRatio = a.value"
      >
        <span class="fmt__ic" aria-hidden="true">
          <svg v-if="a.icon === 'square'" viewBox="0 0 24 24" width="13" height="13" fill="none">
            <rect x="5" y="5" width="14" height="14" rx="2" stroke="currentColor" stroke-width="1.6" />
          </svg>
          <svg v-else viewBox="0 0 24 24" width="13" height="13" fill="none">
            <rect x="7" y="4" width="10" height="16" rx="2" stroke="currentColor" stroke-width="1.6" />
          </svg>
        </span>
        {{ a.value }}
      </button>

      <div class="qty" role="group" aria-label="Quantity of images to generate">
        <button
          class="qty__btn"
          type="button"
          aria-label="Decrease"
          :disabled="gen.imageCount <= MIN_QTY"
          @click="setQty(gen.imageCount - 1)"
        >−</button>
        <span class="qty__val">{{ gen.imageCount }}</span>
        <button
          class="qty__btn"
          type="button"
          aria-label="Increase"
          :disabled="gen.imageCount >= MAX_QTY"
          @click="setQty(gen.imageCount + 1)"
        >+</button>
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
  min-height: 0;
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
  min-height: 0;
}
/* Each: scrollable 2-column grid of cards (home 2.0 Each new.png) —
   absolutely fills the content area so it scrolls within the fixed column
   height instead of growing the board. */
.stack {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  display: grid;
  grid-template-columns: 1fr 1fr;
  align-content: start;
  gap: 16px;
  padding-right: 6px;
}
.stack__empty {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--color-grey);
  font-size: 13px;
}

/* shared controls row */
.controls {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
}
/* mock: 38px light-grey tiles (#F7F7F7), dark content, no visible border */
.fmt {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 16px;
  border-radius: var(--radius-sm);
  background: var(--color-window);
  border: 1px solid transparent;
  font-family: inherit;
  font-size: var(--fs-btn);
  color: var(--color-grey);
  cursor: pointer;
}
.fmt:hover {
  border-color: var(--color-accent);
}
.fmt--on {
  border-color: var(--color-text);
  color: var(--color-text);
}
.fmt__ic {
  display: inline-grid;
  place-items: center;
}

.qty {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  height: 38px;
  flex: 0 1 220px;
  padding: 0 5px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: var(--color-window);
}
.qty__btn {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 50%;
  background: var(--color-bubble);
  color: var(--color-text);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}
.qty__btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.qty__btn:not(:disabled):hover {
  background: var(--color-window);
}
.qty__val {
  min-width: 18px;
  text-align: center;
  font-size: var(--fs-btn);
  color: var(--color-text);
}

.generate {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  height: 38px;
  border: none;
  border-radius: var(--radius-md);
  background: var(--gradient-active);
  color: #ffffff;
  font-family: inherit;
  font-size: 14px;
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
