<script setup lang="ts">
// Assets column (TASK game-manager, Phase 2), per
// figma/game manager page/макаронка 2.0 — Game manager.png.
//
// Live/Slot segment (Q8: wired to state, rules to come), the Style Title card
// with its 78x78 upload square and prompt textarea, and the gradient Generate
// button — which today reports the deliberate "скоро" from the backend (Q18).
const game = useGameStore();
const styleFile = ref<HTMLInputElement | null>(null);
const stylePreview = ref<string | null>(null);

function onStyleFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  // Local preview only: the style reference feeds the future generation
  // pipeline (Q18), so there is nowhere to send it yet.
  if (stylePreview.value) URL.revokeObjectURL(stylePreview.value);
  stylePreview.value = URL.createObjectURL(file);
}

onBeforeUnmount(() => {
  if (stylePreview.value) URL.revokeObjectURL(stylePreview.value);
});
</script>

<template>
  <section class="col">
    <h2 class="col__title">Assets</h2>

    <div class="segment" role="tablist" aria-label="Тип контента">
      <button
        class="segment__btn"
        :class="{ 'segment__btn--on': game.segment === 'LIVE' }"
        type="button"
        role="tab"
        :aria-selected="game.segment === 'LIVE'"
        @click="game.segment = 'LIVE'"
      >
        Live
      </button>
      <button
        class="segment__btn"
        :class="{ 'segment__btn--on': game.segment === 'SLOT' }"
        type="button"
        role="tab"
        :aria-selected="game.segment === 'SLOT'"
        @click="game.segment = 'SLOT'"
      >
        Slot
      </button>
    </div>

    <div class="card">
      <span class="card__label">Style Title</span>

      <button class="drop" type="button" aria-label="Загрузить референс" @click="styleFile?.click()">
        <img v-if="stylePreview" class="drop__img" :src="stylePreview" alt="" />
        <span v-else class="drop__plus" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
            <rect x="3.5" y="3.5" width="17" height="17" rx="5" stroke="currentColor" stroke-width="1.4" />
            <path d="M12 8.5v7M8.5 12h7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
        </span>
      </button>
      <input ref="styleFile" class="hidden-input" type="file" accept="image/*" @change="onStyleFile" />

      <textarea
        v-model="game.stylePrompt"
        class="prompt"
        rows="4"
        placeholder="Example:&#10;Neon casino banner, purple &amp; gold"
      />
    </div>

    <button class="generate" type="button" @click="game.generate('background')">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true">
        <path d="M8 5.5l10 6.5-10 6.5z" fill="currentColor" />
      </svg>
      Generate
    </button>
  </section>
</template>

<style scoped>
/* Metrics sampled from the Figma export (2880x1305 = the 1920 design at 1.5x):
   column 427 wide, segment 36 tall, upload square 78, Generate 37. */
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

.segment {
  display: grid;
  grid-template-columns: 1fr 1fr;
  width: 205px;
  padding: 3px;
  border-radius: var(--radius-pill);
  background: var(--color-window);
  border: 1px solid var(--color-border);
}
.segment__btn {
  height: 30px;
  border: 1px solid transparent;
  border-radius: var(--radius-pill);
  background: transparent;
  font-size: var(--fs-user);
  font-weight: 500;
  color: var(--color-text);
}
.segment__btn--on {
  background: var(--color-white);
  border-color: var(--color-border);
  box-shadow: var(--shadow-card);
}

.card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-window);
}
.card__label {
  font-size: var(--fs-user);
  font-weight: 600;
}
.drop {
  width: 78px;
  height: 78px;
  display: grid;
  place-items: center;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-white);
  color: var(--color-grey);
  overflow: hidden;
  padding: 0;
}
.drop__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.hidden-input {
  display: none;
}
.prompt {
  width: 100%;
  min-height: 90px;
  resize: vertical;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-white);
  color: var(--color-text);
  font: inherit;
  font-size: var(--fs-user);
}
.prompt::placeholder {
  color: var(--color-grey);
}

.generate {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 37px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--gradient-active);
  color: #fff;
  font-size: var(--fs-user);
  font-weight: 600;
}
</style>
