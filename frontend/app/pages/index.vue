<script setup lang="ts">
// Home — the generator. Toolbar + unified white board holding the two columns
// and the brand picker, with a floating "Assets" button. Wired to the generator
// store (R1): catalog loads on mount, with a static fallback when the API is down.
useHead({ title: "Design Power — Home" });

const gen = useGeneratorStore();
onMounted(() => {
  if (!gen.loaded) void gen.load();
});
</script>

<template>
  <div class="home">
    <TheToolbar />

    <div class="board">
      <div class="board__cols">
        <GeneratorCurrentStyles />
        <GeneratorReferencePanel />
      </div>
      <GeneratorBrandPicker />

      <button class="assets" type="button">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
          <path d="M4 12a8 8 0 0113.7-5.7L20 8M20 4v4h-4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M20 12a8 8 0 01-13.7 5.7L4 16M4 20v-4h4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        Assets
      </button>
    </div>
  </div>
</template>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

/* unified white content board (home.png) */
.board {
  position: relative;
  background: var(--color-white);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: 32px;
  display: flex;
  flex-direction: column;
  gap: 32px;
}

.board__cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 48px;
}

/* floating Assets button (bottom-right of the board) */
.assets {
  position: absolute;
  right: 24px;
  bottom: 18px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 18px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: var(--color-white);
  box-shadow: 0 4px 14px rgba(31, 31, 31, 0.08);
  font-family: inherit;
  font-size: 14px;
  font-weight: 500;
  color: var(--color-text);
}
.assets svg {
  color: var(--color-grey);
}
.assets:hover {
  border-color: var(--color-accent);
}

@media (max-width: 900px) {
  .board__cols {
    grid-template-columns: 1fr;
    gap: 32px;
  }
}
</style>
