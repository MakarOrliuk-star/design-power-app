<script setup lang="ts">
// Results column (TASK game-manager, Phase 2): the scrollable 6-up grid from
// the mock, with Clear all / Download beneath it — outside the grey box, on the
// board, exactly as drawn.
//
// Q15: the feed is persistent. Q16: Clear all only hides it; the files stay in
// Cloudinary, which is why the button asks first but does not warn about data
// loss it would not cause.
const game = useGameStore();
const config = useRuntimeConfig();

const downloadUrl = computed(() => `${config.public.apiBase}/api/game/results/export.zip`);
</script>

<template>
  <section class="col">
    <h2 class="col__title">Results</h2>

    <div class="box">
      <div v-if="game.results.length" class="grid">
        <a
          v-for="row in game.results"
          :key="row.id"
          class="cell"
          :href="row.url ?? undefined"
          target="_blank"
          rel="noopener"
        >
          <img v-if="row.url" class="cell__img" :src="row.url" alt="" loading="lazy" />
        </a>
      </div>
      <p v-else class="empty">Пока ничего не собрано.</p>
    </div>

    <div class="actions">
      <button
        class="action"
        type="button"
        :disabled="!game.results.length"
        @click="game.clearAll()"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
          <path d="M4.8 6.8h14.4M9.6 6.8V5.2h4.8v1.6M6.6 6.8l.8 11.4a1.6 1.6 0 001.6 1.5h6a1.6 1.6 0 001.6-1.5l.8-11.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M10.4 10.2v5.6M13.6 10.2v5.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
        Clear all
      </button>

      <a
        class="action"
        :class="{ 'action--off': !game.results.length }"
        :href="game.results.length ? downloadUrl : undefined"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
          <path d="M12 4.5v9.5m0 0l-3.2-3.2M12 14l3.2-3.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M5 15.5v2.2a1.8 1.8 0 001.8 1.8h10.4a1.8 1.8 0 001.8-1.8v-2.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
        Download
      </a>
    </div>
  </section>
</template>

<style scoped>
/* Mock metrics: the grey box holds a 6-column grid of 9:16 cards with a 15px
   gutter and scrolls on its own; the two pill actions sit 32px below it. */
.col {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}
.col__title {
  margin: 0;
  font-size: var(--fs-title);
  font-weight: 600;
}
.box {
  flex: 1;
  min-height: 0;
  border-radius: var(--radius-md);
  background: var(--color-window);
  border: 1px solid var(--color-border);
  padding: 15px;
  overflow-y: auto;
}
.grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 15px;
}
.cell {
  display: block;
  aspect-ratio: 9 / 16;
  border-radius: var(--radius-sm);
  background: var(--color-bubble);
  overflow: hidden;
}
.cell__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.empty {
  margin: 0;
  padding: 40px 0;
  text-align: center;
  color: var(--color-grey);
  font-size: var(--fs-user);
}

.actions {
  display: flex;
  justify-content: space-between;
  gap: 16px;
}
.action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-width: 205px;
  height: 37px;
  padding: 0 20px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: var(--color-window);
  color: var(--color-text);
  font-size: var(--fs-user);
  text-decoration: none;
}
.action:disabled,
.action--off {
  opacity: 0.5;
  pointer-events: none;
}

@media (max-width: 1500px) {
  .grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
</style>
