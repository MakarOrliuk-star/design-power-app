<script setup lang="ts">
// Global completion notifications (R4). The store pushes a toast when a batch
// finishes ("Все готово переходите в результат"); each auto-dismisses after a
// delay or on click, and links to the Result gallery. Mounted once in the layout.
const gen = useGeneratorStore();

const TIMEOUT = 8000;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

watch(
  () => gen.toasts,
  (list) => {
    const ids = new Set(list.map((t) => t.id));
    for (const t of list) {
      if (!timers.has(t.id)) {
        timers.set(
          t.id,
          setTimeout(() => gen.dismissToast(t.id), TIMEOUT),
        );
      }
    }
    for (const [id, timer] of timers) {
      if (!ids.has(id)) {
        clearTimeout(timer);
        timers.delete(id);
      }
    }
  },
  { deep: true },
);

onBeforeUnmount(() => {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
});
</script>

<template>
  <div class="toasts" aria-live="polite">
    <TransitionGroup name="toast">
      <div v-for="t in gen.toasts" :key="t.id" class="toast">
        <span class="toast__dot" aria-hidden="true" />
        <span class="toast__msg">{{ t.message }}</span>
        <NuxtLink to="/result" class="toast__link" @click="gen.dismissToast(t.id)">
          Открыть результат
        </NuxtLink>
        <button class="toast__x" type="button" aria-label="Закрыть" @click="gen.dismissToast(t.id)">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  gap: 12px;
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: 420px;
  padding: 14px 16px;
  border-radius: var(--radius-md);
  background: var(--color-white);
  border: 1px solid var(--color-border);
  box-shadow: 0 10px 30px rgba(31, 31, 31, 0.16);
}
.toast__dot {
  flex: 0 0 auto;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--gradient-active);
}
.toast__msg {
  flex: 1;
  font-size: 14px;
  font-weight: 500;
  color: var(--color-text);
}
.toast__link {
  flex: 0 0 auto;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-accent);
  text-decoration: none;
  white-space: nowrap;
}
.toast__link:hover {
  text-decoration: underline;
}
.toast__x {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 7px;
  background: var(--color-bubble);
  color: var(--color-grey);
  cursor: pointer;
}
.toast__x:hover {
  background: var(--color-stop);
  color: var(--color-white);
}

/* enter/leave animation */
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(12px);
}
</style>
