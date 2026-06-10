<script setup lang="ts">
// Top toolbar (the row of white cards from the Figma Home). The progress card
// reflects live generation batches from the store (R3): one bar per launched
// batch, each with its own cancel/dismiss; the stop action cancels all running.
// Metrics sampled from figma/icons/*.svg: cards 71px tall, radius 20,
// 1px #CFCFCF border, ~20px gap; progress bars 190x4, radius 2.
import type { ActiveBatch } from "~/stores/generator";

const gen = useGeneratorStore();
const { theme, toggle: toggleTheme } = useTheme();

// Unified progress: ALWAYS 3 status slots — one per content group
// (Person / Item / Background) — each reflecting the current (running) or last
// generation of that group, in any state. Background has no pipeline yet, so it
// stays idle.
type ProgressKind = "person" | "item" | "background";
const PROGRESS_KINDS: ProgressKind[] = ["person", "item", "background"];

function latestBatch(kind: ProgressKind): ActiveBatch | null {
  if (kind === "background") return null; // no Background pipeline yet
  const list = gen.batches.filter((b) => b.kind === kind);
  if (!list.length) return null;
  return list.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
}

const progressGroups = computed(() =>
  PROGRESS_KINDS.map((kind) => {
    const b = latestBatch(kind);
    const status = b?.status ?? null;
    const total = status?.total ?? 0;
    const completed = status?.completed ?? 0;
    const pct = status?.progress ?? 0;
    const isComplete = status?.isComplete ?? false;
    const running = b !== null && (status === null || !isComplete);
    const label = !b
      ? "No generation"
      : !status
        ? "Queued…"
        : `${completed} of ${total} images completed (${pct}%)`;
    return {
      kind,
      label,
      pct,
      running,
      done: b !== null && isComplete,
      canCancel: running,
      batchId: b?.id ?? "",
    };
  }),
);

// Logged-in user (from the session / auth store).
const auth = useAuthStore();
async function logout() {
  await auth.logout();
  await navigateTo("/login");
}
const userEmail = computed(() => auth.user?.email ?? "");
const userInitials = computed(() => {
  const u = auth.user;
  if (!u) return "";
  const base = (u.name && u.name.trim()) || u.email || "";
  const parts = base.split(/[\s@._-]+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((p) => p[0]).join("");
  return (letters || base.slice(0, 2)).toUpperCase();
});

</script>

<template>
  <div class="toolbar">
    <!-- Logo (click → Home) -->
    <button
      class="card card--logo"
      type="button"
      aria-label="На главную"
      title="На главную"
      @click="navigateTo('/')"
    >
      <span class="logo">
        <span class="logo__letter">m</span>
        <svg
          class="logo__wave"
          width="46"
          height="22"
          viewBox="0 0 46 22"
          fill="none"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id="logoWave" x1="0" y1="11" x2="46" y2="11" gradientUnits="userSpaceOnUse">
              <stop stop-color="#6A72D9" />
              <stop offset="0.51" stop-color="#8151AA" />
              <stop offset="1" stop-color="#DD88ED" />
            </linearGradient>
          </defs>
          <path
            d="M1 11 C 5 1, 11 1, 15 11 S 25 21, 29 11 S 39 1, 45 11"
            stroke="url(#logoWave)"
            stroke-width="3"
            stroke-linecap="round"
            fill="none"
          />
        </svg>
        <span class="logo__letter">k</span>
      </span>
    </button>

    <!-- Unified progress: always 3 status slots (Person / Item / Background),
         each showing the current/last generation of that group. -->
    <div class="card card--progress">
      <div
        v-for="g in progressGroups"
        :key="g.kind"
        :class="['job', { 'job--idle': !g.running && !g.done }]"
      >
        <span class="ic ic--muted" aria-hidden="true">
          <svg v-if="g.kind === 'person'" viewBox="0 0 24 24" width="20" height="20" fill="none">
            <path d="M12 3l1.6 3.6L17.5 7l-2.7 2.7.7 3.9L12 11.8 8.5 13.6l.7-3.9L6.5 7l3.9-.4L12 3z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
          </svg>
          <svg v-else-if="g.kind === 'item'" viewBox="0 0 24 24" width="20" height="20" fill="none">
            <path d="M7 4h10M8 4v2.5L6 9v9a2 2 0 002 2h8a2 2 0 002-2V9l-2-2.5V4" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
            <path d="M6.5 13h11" stroke="currentColor" stroke-width="1.5" />
          </svg>
          <svg v-else viewBox="0 0 24 24" width="20" height="20" fill="none">
            <rect x="3.5" y="5" width="17" height="14" rx="2.5" stroke="currentColor" stroke-width="1.5" />
            <circle cx="8.5" cy="10" r="1.4" stroke="currentColor" stroke-width="1.3" />
            <path d="M5 16l4-3.5 3 2.5 2.5-2L19 15.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>

        <div class="job__body">
          <span class="job__label">{{ g.label }}</span>
          <div class="job__track">
            <div
              class="job__fill"
              :class="{ 'job__fill--done': g.done }"
              :style="{ width: g.pct + '%' }"
            />
          </div>
        </div>

        <button
          v-if="g.canCancel"
          class="job__close"
          type="button"
          aria-label="Cancel job"
          @click="gen.cancelAndDismiss(g.batchId)"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Stop / delete -->
    <div class="card card--actions">
      <button class="act act--stop" type="button" aria-label="Stop all running" @click="gen.stopAllRunning()">
        <span class="act__square" />
      </button>
    </div>

    <!-- Tool icons -->
    <div class="card card--tools">
      <button
        v-if="auth.isAdmin"
        class="tool tool--admin"
        type="button"
        aria-label="Admin"
        title="Админка"
        @click="navigateTo('/admin')"
      >
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
          <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
          <path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <button class="tool" type="button" aria-label="Models">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
          <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
          <path d="M4 7.5l8 4.5 8-4.5M12 12v9" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
        </svg>
      </button>
      <button
        class="tool"
        type="button"
        aria-label="Open Result"
        title="Result"
        @click="navigateTo('/result')"
      >
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
          <path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8L12 3z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
          <path d="M18 14l.9 2.1L21 17l-2.1.9L18 20l-.9-2.1L15 17l2.1-.9L18 14z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
        </svg>
      </button>
      <button
        class="tool"
        type="button"
        aria-label="Images"
        title="Архив"
        @click="navigateTo('/archive')"
      >
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
          <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" stroke="currentColor" stroke-width="1.6" />
          <circle cx="9" cy="10" r="1.6" stroke="currentColor" stroke-width="1.4" />
          <path d="M5 17l4.5-4.5 3.5 3.5 3-3L19 16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <button
        class="tool"
        type="button"
        :aria-label="theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'"
        @click="toggleTheme"
      >
        <svg v-if="theme === 'dark'" viewBox="0 0 24 24" width="22" height="22" fill="none">
          <circle cx="12" cy="12" r="4.5" stroke="currentColor" stroke-width="1.6" />
          <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6L19 19M19 5l-1.4 1.4M6.4 17.6L5 19" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
        <svg v-else viewBox="0 0 24 24" width="22" height="22" fill="none">
          <path d="M20 14.5A8 8 0 119.5 4 6.5 6.5 0 0020 14.5z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
        </svg>
      </button>
    </div>

    <!-- User -->
    <div class="card card--user">
      <span class="user__email">{{ userEmail }}</span>
      <span class="user__avatar">{{ userInitials }}</span>
      <button class="user__logout" type="button" aria-label="Выйти" title="Выйти" @click="logout">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
          <path d="M15 4H7a2 2 0 00-2 2v12a2 2 0 002 2h8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
          <path d="M11 12h9m0 0l-3.5-3.5M20 12l-3.5 3.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: stretch;
  gap: 20px;
  width: 100%;
}

/* shared card shell — white, 1px border, 20px radius, 71px tall */
.card {
  display: flex;
  align-items: center;
  min-height: 71px;
  background: var(--color-white);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: 0 18px;
}

/* --- logo --- */
.card--logo {
  flex: 0 0 280px;
  justify-content: center;
  cursor: pointer;
  transition: border-color 0.12s ease, background 0.12s ease;
}
.card--logo:hover {
  border-color: var(--color-accent);
}
.logo {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 30px;
  font-weight: 500;
  letter-spacing: 0.5px;
  color: var(--color-text);
}
.logo__wave {
  display: block;
}

/* --- unified progress (3 group slots) --- */
.card--progress {
  flex: 3 1 580px;
  min-width: 520px;
  gap: 18px;
}
.job {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}
.job--idle {
  opacity: 0.55;
}
.job__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.job__label {
  font-size: 12px;
  color: var(--color-grey);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.job__track {
  height: 4px;
  border-radius: 2px;
  background: var(--color-bubble);
  overflow: hidden;
}
.job__fill {
  height: 100%;
  border-radius: 2px;
  background: var(--gradient-active);
  transition: width 0.3s ease;
}
.job__fill--done {
  background: var(--color-accent);
}
.job__close {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 7px;
  background: var(--color-stop);
  color: var(--color-white);
}
.job__close:hover {
  background: var(--color-stop-hover);
}

/* --- stop / delete --- */
.card--actions {
  flex: 0 0 auto;
  gap: 18px;
}
.act {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border: none;
  background: transparent;
  border-radius: 9px;
  color: var(--color-grey);
}
.act:hover {
  background: var(--color-bubble);
}
.act--stop {
  background: var(--color-stop);
}
.act--stop:hover {
  background: var(--color-stop-hover);
}
.act__square {
  width: 13px;
  height: 13px;
  border-radius: 3px;
  background: var(--color-white);
}

/* --- tool icons --- */
.card--tools {
  flex: 0 0 auto;
  gap: 14px;
}
.tool {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border: none;
  background: transparent;
  border-radius: 9px;
  color: var(--color-accent);
}
.tool:hover {
  background: rgba(138, 56, 245, 0.08);
}

/* --- user --- */
.card--user {
  flex: 0 0 280px;
  justify-content: space-between;
  gap: 12px;
}
.user__email {
  font-size: 14px;
  font-weight: 500;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.user__avatar {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  background: var(--gradient-active);
  color: var(--color-white);
  font-size: 13px;
  font-weight: 700;
}
.user__logout {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 50%;
  background: none;
  color: var(--color-grey);
}
.user__logout:hover {
  background: var(--color-bubble);
  color: var(--color-stop-hover);
}

/* --- shared icon wrapper --- */
.ic {
  display: inline-grid;
  place-items: center;
  flex: 0 0 auto;
}
.ic--muted {
  color: var(--color-grey);
}

/* --- basic responsive (refined in Phase 6) --- */
@media (max-width: 1100px) {
  .toolbar {
    flex-wrap: wrap;
  }
  .card--logo,
  .card--user {
    flex: 1 1 auto;
  }
  .card--progress {
    flex: 1 1 100%;
    min-width: 0;
  }
}
</style>
