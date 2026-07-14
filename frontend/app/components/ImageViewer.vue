<script setup lang="ts">
/**
 * Shared fullscreen viewer — the Result "slider" (задача 4), extracted so the
 * Result gallery, the Tournament Pack tab and the Archive tournament tab show
 * the SAME behavior: ←/→ arrows with wrap-around, Esc, an "N / M" counter.
 *
 * Fully controlled: the host owns the list and the active id
 * (v-model:activeId, null = closed) — navigation reuses the id-tracked
 * `stepIndex` math so list refreshes never make the open image jump. Hosts
 * that already run their own keydown handling (useResult) pass
 * :keyboard="false" to avoid double-stepping.
 */
import { computed, watch, onBeforeUnmount } from "vue";
import { stepIndex } from "~/composables/useResult";

export interface ViewerItem {
  id: string;
  url: string;
  /** Bold left part of the caption (brand / file name). */
  caption?: string;
  /** Muted right part (prompt / description). */
  sub?: string;
}

const props = withDefaults(
  defineProps<{
    images: ViewerItem[];
    activeId: string | null;
    keyboard?: boolean;
  }>(),
  { keyboard: true },
);
const emit = defineEmits<{ (e: "update:activeId", id: string | null): void }>();

const index = computed(() =>
  props.activeId === null ? -1 : props.images.findIndex((i) => i.id === props.activeId),
);
const item = computed(() => (index.value >= 0 ? props.images[index.value] ?? null : null));
const open = computed(() => item.value !== null);

function close() {
  emit("update:activeId", null);
}
function step(delta: number) {
  const next = stepIndex(index.value, delta, props.images.length);
  if (next < 0) return;
  emit("update:activeId", props.images[next]?.id ?? null);
}

function onKey(e: KeyboardEvent) {
  if (!open.value) return;
  if (e.key === "Escape") close();
  else if (e.key === "ArrowLeft") step(-1);
  else if (e.key === "ArrowRight") step(1);
}
watch(
  () => props.keyboard && open.value,
  (on) => {
    if (!import.meta.client) return;
    if (on) window.addEventListener("keydown", onKey);
    else window.removeEventListener("keydown", onKey);
  },
  { immediate: true },
);

// Lock background scroll while open (idempotent with hosts that do the same).
watch(open, (o) => {
  if (import.meta.client) document.body.style.overflow = o ? "hidden" : "";
});
onBeforeUnmount(() => {
  if (!import.meta.client) return;
  window.removeEventListener("keydown", onKey);
  if (open.value) document.body.style.overflow = "";
});
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="viewer" @click.self="close">
      <button class="viewer__close" type="button" aria-label="Close" @click="close">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
      </button>

      <button
        v-if="images.length > 1"
        class="viewer__nav viewer__nav--prev"
        type="button"
        aria-label="Previous"
        @click="step(-1)"
      >
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none">
          <path d="M15 5l-7 7 7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>

      <figure class="viewer__stage" @click.self="close">
        <img v-if="item" class="viewer__img" :src="item.url" :alt="item.caption || ''" />
        <figcaption v-if="item" class="viewer__caption">
          <span v-if="item.caption" class="viewer__brand">{{ item.caption }}</span>
          <span v-if="item.sub" class="viewer__desc">{{ item.sub }}</span>
          <span class="viewer__count">{{ index + 1 }} / {{ images.length }}</span>
        </figcaption>
      </figure>

      <button
        v-if="images.length > 1"
        class="viewer__nav viewer__nav--next"
        type="button"
        aria-label="Next"
        @click="step(1)"
      >
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none">
          <path d="M9 5l7 7-7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
/* Styles lifted verbatim from result.vue's Phase 3 viewer. */
.viewer {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 40px;
  background: rgba(15, 15, 18, 0.86);
  backdrop-filter: blur(4px);
}
.viewer__stage {
  margin: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  max-width: 90vw;
  max-height: 90vh;
}
.viewer__img {
  max-width: 100%;
  max-height: 78vh;
  object-fit: contain;
  border-radius: var(--radius-sm);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
}
.viewer__caption {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  justify-content: center;
  color: #f2f2f2;
  font-size: 13px;
}
.viewer__brand {
  font-weight: 600;
}
.viewer__desc {
  color: #b8b8c0;
  max-width: 60vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.viewer__count {
  color: #b8b8c0;
}
.viewer__close {
  position: absolute;
  top: 22px;
  right: 26px;
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
}
.viewer__close:hover {
  background: rgba(255, 255, 255, 0.22);
}
.viewer__nav {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
}
.viewer__nav:hover {
  background: rgba(255, 255, 255, 0.22);
}
</style>
