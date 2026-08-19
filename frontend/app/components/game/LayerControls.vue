<script setup lang="ts">
// Composition controls (TASK game-manager, Phase 2): the right-hand column of
// the Composition panel — Background / Regenerate, the Blur checkbox, Item /
// Regenerate, and Save.
//
// Q10: the mock draws a checkbox only; the customer asked for the radius on a
// slider, so the slider appears under the checkbox once blur is on.
import { BLUR_MAX, BLUR_MIN } from "~/stores/game";
import type { GameLayerKind } from "~/types/game";

const emit = defineEmits<{ pick: [GameLayerKind] }>();
const game = useGameStore();
</script>

<template>
  <div class="controls">
    <button class="btn" type="button" @click="emit('pick', 'BACKGROUND')">
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true">
        <rect x="3.3" y="5.6" width="17.4" height="13" rx="3.6" stroke="currentColor" stroke-width="1.6" />
        <circle cx="9" cy="10.4" r="1.5" stroke="currentColor" stroke-width="1.4" />
        <path d="M4.6 16.4c2.2-2.8 4.4-2.8 6.5 0 1.8 2.2 4 1.5 7.2-1.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      </svg>
      <span>Background</span>
      <span v-if="game.background" class="btn__tag">{{ game.background.name }}</span>
    </button>

    <button class="btn" type="button" @click="game.generate('background')">
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true">
        <rect x="3.5" y="3.5" width="17" height="17" rx="5" stroke="currentColor" stroke-width="1.6" />
        <path d="M8 12a4 4 0 016.6-3M16 12a4 4 0 01-6.6 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        <path d="M14.8 6.6v2.6h-2.6M9.2 17.4v-2.6h2.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span>Regenerate</span>
    </button>

    <label class="check">
      <input v-model="game.blur" type="checkbox" class="check__box" />
      <span>Blur background</span>
    </label>

    <!-- Q10: radius on a slider -->
    <div v-if="game.blur" class="blur">
      <input
        v-model.number="game.blurSigma"
        class="blur__range"
        type="range"
        :min="BLUR_MIN"
        :max="BLUR_MAX"
        step="1"
        aria-label="Радиус размытия"
      />
      <span class="blur__value">{{ game.blurSigma }}</span>
    </div>

    <div class="spacer" />

    <button class="btn" type="button" @click="emit('pick', 'PERSON')">
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true">
        <path
          d="M12 3.8l2.3 3.3 3.9.6c.8.1 1.1 1.1.5 1.7l-2.9 2.7.7 3.9c.1.8-.7 1.4-1.4 1l-3.1-1.8-3.1 1.8c-.7.4-1.5-.2-1.4-1l.7-3.9-2.9-2.7c-.6-.6-.3-1.6.5-1.7l3.9-.6z"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linejoin="round"
        />
      </svg>
      <span>Item</span>
      <span v-if="game.person" class="btn__tag">{{ game.person.name }}</span>
    </button>

    <button class="btn" type="button" @click="game.generate('person')">
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" aria-hidden="true">
        <rect x="3.5" y="3.5" width="17" height="17" rx="5" stroke="currentColor" stroke-width="1.6" />
        <path d="M8 12a4 4 0 016.6-3M16 12a4 4 0 01-6.6 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        <path d="M14.8 6.6v2.6h-2.6M9.2 17.4v-2.6h2.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span>Regenerate</span>
    </button>

    <div class="spacer spacer--tall" />

    <button class="save" type="button" :disabled="!game.canSave" @click="game.save()">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
        <path
          d="M5.5 4.5h9.4l4.6 4.6v9.4a1 1 0 01-1 1h-13a1 1 0 01-1-1v-13a1 1 0 011-1z"
          fill="currentColor"
        />
        <path d="M8.6 4.5h6v4h-6zM7.4 19.5v-5.2h9.2v5.2" fill="#fff" />
      </svg>
      {{ game.saving ? "Сохраняем…" : "Save" }}
    </button>
  </div>
</template>

<style scoped>
/* Mock metrics: buttons 36 tall with a 16 gap, Save 37, all inside the 16px
   padding of the Composition panel. */
.controls {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
  flex: 1;
}
.btn {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  height: 36px;
  padding: 0 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-white);
  color: var(--color-text);
  font-size: var(--fs-user);
  font-weight: 500;
}
.btn:hover {
  border-color: var(--color-grey);
}
/* The chosen asset's name, so the button says what is actually on the canvas. */
.btn__tag {
  position: absolute;
  right: 12px;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-desc-sm);
  font-weight: 400;
  color: var(--color-grey);
}

.check {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: var(--fs-user);
  cursor: pointer;
}
.check__box {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  accent-color: var(--color-accent);
}

.blur {
  display: flex;
  align-items: center;
  gap: 10px;
}
.blur__range {
  flex: 1;
  accent-color: var(--color-accent);
}
.blur__value {
  width: 26px;
  text-align: right;
  font-size: var(--fs-desc-sm);
  color: var(--color-grey);
}

.spacer {
  flex: 1 1 0;
  min-height: 0;
}
.spacer--tall {
  flex: 2 1 0;
}

.save {
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
.save:disabled {
  opacity: 0.55;
}
</style>
