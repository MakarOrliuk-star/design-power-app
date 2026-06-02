<script setup lang="ts">
// Top toolbar (the row of white cards from the Figma Home). The progress card
// reflects live generation batches from the store (R3): one bar per launched
// batch, each with its own cancel/dismiss; the stop action cancels all running.
// Metrics sampled from figma/icons/*.svg: cards 71px tall, radius 20,
// 1px #CFCFCF border, ~20px gap; progress bars 190x4, radius 2.
import type { ActiveBatch } from "~/stores/generator";

const gen = useGeneratorStore();

const promptName = ""; // empty -> shows the "Empty" placeholder

const user = { email: "aperchenko@cortexu.io", initials: "Ag" };

const pct = (b: ActiveBatch) => b.status?.progress ?? 0;
const done = (b: ActiveBatch) => b.status?.completed ?? 0;
const total = (b: ActiveBatch) => b.status?.total ?? 0;
</script>

<template>
  <div class="toolbar">
    <!-- Logo -->
    <div class="card card--logo">
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
    </div>

    <!-- Empty / prompt name -->
    <div class="card card--empty">
      <span class="ic ic--muted" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
          <circle cx="12" cy="8" r="3.4" stroke="currentColor" stroke-width="1.6" />
          <path d="M5 19c0-3.3 3.1-5 7-5s7 1.7 7 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
      </span>
      <input
        class="empty__input"
        type="text"
        :value="promptName"
        placeholder="Empty"
        readonly
      />
    </div>

    <!-- Progress jobs -->
    <div class="card card--progress">
      <template v-if="gen.batches.length">
        <div v-for="b in gen.batches" :key="b.id" class="job">
          <span class="ic ic--muted" aria-hidden="true">
            <svg v-if="b.kind === 'person'" viewBox="0 0 24 24" width="20" height="20" fill="none">
              <path d="M12 3l1.6 3.6L17.5 7l-2.7 2.7.7 3.9L12 11.8 8.5 13.6l.7-3.9L6.5 7l3.9-.4L12 3z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
            </svg>
            <svg v-else viewBox="0 0 24 24" width="20" height="20" fill="none">
              <path d="M7 4h10M8 4v2.5L6 9v9a2 2 0 002 2h8a2 2 0 002-2V9l-2-2.5V4" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
              <path d="M6.5 13h11" stroke="currentColor" stroke-width="1.5" />
            </svg>
          </span>

          <div class="job__body">
            <span v-if="b.status" class="job__label">{{ done(b) }} of {{ total(b) }} images completed ({{ pct(b) }}%)</span>
            <span v-else class="job__label">Queued…</span>
            <div class="job__track">
              <div class="job__fill" :style="{ width: pct(b) + '%' }" />
            </div>
          </div>

          <button class="job__close" type="button" aria-label="Cancel job" @click="gen.cancelAndDismiss(b.id)">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            </svg>
          </button>
        </div>
      </template>
      <span v-else class="progress__empty">No active generations</span>
    </div>

    <!-- Stop / delete -->
    <div class="card card--actions">
      <button class="act act--stop" type="button" aria-label="Stop all running" @click="gen.stopAllRunning()">
        <span class="act__square" />
      </button>
      <button class="act" type="button" aria-label="Delete">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
          <path d="M4 7h16M9 7V5h6v2M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M10 11v6M14 11v6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
      </button>
    </div>

    <!-- Tool icons -->
    <div class="card card--tools">
      <button class="tool" type="button" aria-label="Models">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
          <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
          <path d="M4 7.5l8 4.5 8-4.5M12 12v9" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
        </svg>
      </button>
      <button class="tool" type="button" aria-label="Enhance">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
          <path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8L12 3z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
          <path d="M18 14l.9 2.1L21 17l-2.1.9L18 20l-.9-2.1L15 17l2.1-.9L18 14z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
        </svg>
      </button>
      <button class="tool" type="button" aria-label="Images">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
          <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" stroke="currentColor" stroke-width="1.6" />
          <circle cx="9" cy="10" r="1.6" stroke="currentColor" stroke-width="1.4" />
          <path d="M5 17l4.5-4.5 3.5 3.5 3-3L19 16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>

    <!-- User -->
    <div class="card card--user">
      <span class="user__email">{{ user.email }}</span>
      <span class="user__avatar">{{ user.initials }}</span>
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

/* --- empty / prompt --- */
.card--empty {
  flex: 0.7 1 200px;
  min-width: 190px;
  gap: 12px;
}
.empty__input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-family: inherit;
  font-size: 15px;
  color: var(--color-text);
}
.empty__input::placeholder {
  color: var(--color-grey);
}

/* --- progress --- */
.card--progress {
  flex: 2.2 1 420px;
  min-width: 400px;
  gap: 16px;
}
.progress__empty {
  font-size: 13px;
  color: var(--color-grey);
}
.job {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
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
  .card--empty,
  .card--progress {
    flex: 1 1 100%;
  }
}
</style>
