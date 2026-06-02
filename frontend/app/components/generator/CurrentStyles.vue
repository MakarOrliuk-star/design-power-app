<script setup lang="ts">
// Left column "Current styles" (R1: wired to the generator store).
// Metrics from figma/icons/*.svg: bubbles 36px tall, radius 18 (pill),
// 1px border; container has a small (~4px) radius.
//
// `currentTargets` = the selected brands/styles (keyed by brandId for Person,
// style name for Item). Removing here also drops the matching Each card.
const gen = useGeneratorStore();
</script>

<template>
  <section class="cur">
    <h2 class="cur__title">Current styles</h2>

    <div class="cur__row">
      <div class="search">
        <input
          v-model="gen.search"
          class="search__input"
          type="text"
          placeholder="Search"
        />
        <span class="search__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
            <circle cx="11" cy="11" r="6.5" stroke="currentColor" stroke-width="1.8" />
            <path d="M16 16l4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
        </span>
      </div>
      <button class="cur__clear" type="button" @click="gen.clearAll()">Clear all</button>
    </div>

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
}
.cur__title {
  margin: 0 0 18px;
  font-size: 24px;
  font-weight: 700;
  color: var(--color-text);
}

/* search + clear all row */
.cur__row {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 18px;
}
.search {
  position: relative;
  flex: 0 1 440px;
}
.search__input {
  width: 100%;
  height: 44px;
  padding: 0 44px 0 18px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: var(--color-white);
  font-family: inherit;
  font-size: 14px;
  color: var(--color-text);
  outline: none;
}
.search__input::placeholder {
  color: var(--color-grey);
}
.search__input:focus {
  border-color: var(--color-accent);
}
.search__icon {
  position: absolute;
  right: 16px;
  top: 50%;
  transform: translateY(-50%);
  display: grid;
  place-items: center;
  color: var(--color-grey);
  pointer-events: none;
}
.cur__clear {
  margin-left: auto;
  border: none;
  background: none;
  padding: 0;
  font-family: inherit;
  font-size: 14px;
  color: var(--color-text);
}
.cur__clear:hover {
  color: var(--color-accent);
}

/* bubble container */
.cur__box {
  flex: 1;
  min-height: 360px;
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
  font-size: 14px;
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
</style>
