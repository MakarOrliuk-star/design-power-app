<script setup lang="ts">
// Selected styles box (home 2.0 new.PNG) — just the bubble container; the
// search box and "Clear all" moved up into the board's control row (index.vue).
//
// `currentTargets` = the selected brands/styles (keyed by brandId for Person,
// style name for Item). Removing here also drops the matching Each card.
const gen = useGeneratorStore();
</script>

<template>
  <section class="cur">
    <div class="cur__box">
      <span v-for="s in gen.currentTargets" :key="s.key" class="bubble">
        {{ s.label }}
        <button class="bubble__x" type="button" aria-label="Remove" @click="gen.removeTarget(s.key)">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
          </svg>
        </button>
      </span>
    </div>
  </section>
</template>

<style scoped>
.cur {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

/* bubble container — fills the column; scrolls inside when the selection
   outgrows it (the board itself never scrolls). */
.cur__box {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-white);
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 12px;
}

/* bubbles (pills) */
.bubble {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 8px 0 16px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: var(--color-white);
  font-size: var(--fs-bubble); /* 13px — Bubble Title */
  color: var(--color-text);
  white-space: nowrap;
}
.bubble__x {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 7px;
  background: var(--color-bubble);
  color: var(--color-grey);
}
.bubble__x:hover {
  background: var(--color-stop);
  color: var(--color-white);
}

@media (max-width: 900px) {
  .cur__box {
    min-height: 160px;
  }
}
</style>
