<script setup lang="ts">
// Layer picker (TASK game-manager, Phase 2).
//
// The mock's "Background" and "Item" buttons have to lead somewhere, and the
// designer's ZIP (Q11–Q13) has no control of its own in the mock — so this one
// window does both: it lists the assets of one layer from the current pack and
// carries the upload. Uploading here rather than in a separate corner keeps the
// board exactly as drawn.
import type { GameLayerKind } from "~/types/game";

const props = defineProps<{ kind: GameLayerKind | null }>();
const emit = defineEmits<{ close: [] }>();

const game = useGameStore();
const fileInput = ref<HTMLInputElement | null>(null);

const title = computed(() => (props.kind === "PERSON" ? "Item" : "Background"));
const list = computed(() =>
  props.kind === "PERSON" ? game.persons : props.kind === "BACKGROUND" ? game.backgrounds : [],
);
const selectedId = computed(() =>
  props.kind === "PERSON" ? game.personId : game.backgroundId,
);

const progress = computed(() => {
  const pack = game.pack;
  if (!pack || pack.status !== "PARSING") return "";
  return pack.totalCount
    ? `Разбираем архив: ${pack.assetCount} из ${pack.totalCount}`
    : "Разбираем архив…";
});

function pick(id: string) {
  if (props.kind === "PERSON") game.personId = game.personId === id ? null : id;
  else game.backgroundId = game.backgroundId === id ? null : id;
}

function onFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file) void game.uploadPack(file);
  // Reset so re-picking the same file fires change again.
  if (fileInput.value) fileInput.value.value = "";
}
</script>

<template>
  <Teleport to="body">
    <div v-if="kind" class="overlay" @click.self="emit('close')">
      <div class="modal" role="dialog" aria-modal="true" :aria-label="title">
        <header class="modal__head">
          <h2 class="modal__title">{{ title }}</h2>
          <button class="modal__close" type="button" aria-label="Закрыть" @click="emit('close')">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            </svg>
          </button>
        </header>

        <div class="bar">
          <button class="bar__btn" type="button" :disabled="game.uploading" @click="fileInput?.click()">
            {{ game.uploading ? "Загружаем…" : "Загрузить ZIP" }}
          </button>
          <span v-if="progress" class="bar__note">{{ progress }}</span>
          <span v-else-if="game.pack" class="bar__note">
            {{ game.pack.filename }} — {{ game.assets.length }} ассетов
          </span>
          <span v-else class="bar__note">Архив ещё не загружен</span>
          <input
            ref="fileInput"
            class="bar__input"
            type="file"
            accept=".zip,application/zip"
            @change="onFile"
          />
        </div>

        <p v-if="game.error" class="error">{{ game.error }}</p>

        <div v-if="list.length" class="grid">
          <button
            v-for="asset in list"
            :key="asset.id"
            class="tile"
            :class="{ 'tile--on': asset.id === selectedId }"
            type="button"
            :title="asset.name"
            @click="pick(asset.id)"
          >
            <img class="tile__img" :src="asset.url" :alt="asset.name" loading="lazy" />
            <span class="tile__name">{{ asset.name }}</span>
          </button>
        </div>
        <p v-else class="empty">
          {{ game.parsing ? "Ждём разбор архива…" : "Для этого слоя пока нет ассетов." }}
        </p>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  background: rgba(31, 31, 31, 0.45);
  padding: 24px;
}
.modal {
  width: min(980px, 100%);
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  gap: 16px;
  background: var(--color-white);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: 24px;
  overflow: auto;
}
.modal__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.modal__title {
  margin: 0;
  font-size: var(--fs-title);
  font-weight: 600;
}
.modal__close {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--color-border);
  border-radius: 50%;
  background: var(--color-white);
  color: var(--color-text);
}
.bar {
  display: flex;
  align-items: center;
  gap: 12px;
}
.bar__btn {
  height: 36px;
  padding: 0 18px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: var(--color-window);
  font-size: var(--fs-user);
  color: var(--color-text);
}
.bar__btn:disabled {
  opacity: 0.6;
}
.bar__note {
  font-size: var(--fs-user);
  color: var(--color-grey);
}
.bar__input {
  display: none;
}
.error {
  margin: 0;
  border: 1px solid var(--color-stop);
  border-radius: var(--radius-sm);
  background: rgba(244, 115, 115, 0.12);
  color: var(--color-stop-hover);
  padding: 8px 12px;
  font-size: var(--fs-user);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 14px;
}
.tile {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-window);
  text-align: left;
}
.tile--on {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 1px var(--color-accent);
}
.tile__img {
  width: 100%;
  aspect-ratio: 9 / 16;
  object-fit: contain;
  border-radius: var(--radius-xs);
  background: var(--color-bubble);
}
.tile__name {
  font-size: var(--fs-desc-sm);
  color: var(--color-grey);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.empty {
  margin: 0;
  padding: 32px 0;
  text-align: center;
  color: var(--color-grey);
  font-size: var(--fs-user);
}
</style>
