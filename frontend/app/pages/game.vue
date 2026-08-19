<script setup lang="ts">
// Game manager (TASK game-manager, Phase 2) —
// figma/game manager page/макаронка 2.0 — Game manager.png.
//
// One white board, three columns: Assets | Composition | Results. Column widths
// (427 / 658 / 639 with 36px gutters inside 40px board padding) were measured
// off the Figma export at 1920 CSS, not eyeballed — see R-PLAN-game-manager.md
// §2.1 for the full metric list and the two places the mock is internally
// inconsistent (its preview box and result cards are not the 9:16 the module
// actually renders, so those follow the real format).
import type { GameLayerKind } from "~/types/game";
import { SCALE_MAX, SCALE_MIN } from "~/stores/game";

useHead({ title: "Design Power — Game" });

const game = useGameStore();
const picking = ref<GameLayerKind | null>(null);

onMounted(() => {
  if (!game.loaded) void game.load();
});
onBeforeUnmount(() => game.stopPolling());

const scalePercent = computed(() => Math.round(game.scale * 100));
</script>

<template>
  <div class="page">
    <TheToolbar />

    <div class="board">
      <GameAssetsPanel class="board__assets" />

      <section class="board__composition col">
        <h2 class="col__title">Composition</h2>

        <div class="panel">
          <div class="panel__left">
            <GameCompositionCanvas />

            <div class="scale">
              <h3 class="scale__title">Scale image</h3>
              <div class="scale__row">
                <input
                  v-model.number="game.scale"
                  class="scale__range"
                  type="range"
                  :min="SCALE_MIN"
                  :max="SCALE_MAX"
                  step="0.01"
                  aria-label="Масштаб персонажа"
                />
                <span class="scale__value">{{ scalePercent }}%</span>
              </div>
            </div>
          </div>

          <GameLayerControls class="panel__right" @pick="picking = $event" />
        </div>
      </section>

      <GameResultsGrid class="board__results" />
    </div>

    <p v-if="game.notice" class="toast toast--info">{{ game.notice }}</p>
    <p v-else-if="game.error" class="toast toast--error">{{ game.error }}</p>

    <GameAssetPickerModal :kind="picking" @close="picking = null" />
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: var(--container-pad);
  max-width: var(--container-width);
  margin: 0 auto;
  width: 100%;
}

.board {
  display: grid;
  /* measured: 427 / 658 / 639 — kept as ratios so the board breathes */
  grid-template-columns: 427fr 658fr 639fr;
  gap: 36px;
  padding: 40px;
  background: var(--color-white);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
}

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

/* Composition panel: canvas + Scale on the left, the layer buttons on the right */
.panel {
  display: flex;
  gap: 34px;
  padding: 16px;
  border-radius: var(--radius-md);
  background: var(--color-window);
  border: 1px solid var(--color-border);
}
.panel__left {
  display: flex;
  flex-direction: column;
  gap: 20px;
  flex: 0 0 auto;
}
.panel__right {
  min-width: 0;
}

.scale__title {
  margin: 0 0 10px;
  font-size: var(--fs-title);
  font-weight: 600;
}
.scale__row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.scale__range {
  flex: 1;
  accent-color: var(--color-accent);
}
.scale__value {
  width: 44px;
  text-align: right;
  font-size: var(--fs-user);
  color: var(--color-grey);
}

.toast {
  margin: 0;
  border-radius: var(--radius-sm);
  padding: 10px 14px;
  font-size: var(--fs-user);
  text-align: center;
}
.toast--info {
  background: rgba(138, 56, 245, 0.1);
  border: 1px solid var(--color-accent);
  color: var(--color-accent);
}
.toast--error {
  background: rgba(244, 115, 115, 0.12);
  border: 1px solid var(--color-stop);
  color: var(--color-stop-hover);
}

@media (max-width: 1500px) {
  .board {
    grid-template-columns: 1fr 1fr;
  }
  .board__results {
    grid-column: 1 / -1;
  }
}

@media (max-width: 1000px) {
  .board {
    grid-template-columns: 1fr;
    padding: 24px;
    gap: 24px;
  }
  .board__results {
    grid-column: auto;
  }
  .panel {
    flex-direction: column;
  }
}
</style>
