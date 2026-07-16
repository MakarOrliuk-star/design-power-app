<script setup lang="ts">
// Top toolbar (the row of white cards from the Figma Home). The progress card
// reflects live generation batches from the store (R3): one bar per launched
// batch, each with its own cancel/dismiss; the stop action cancels all running.
// Metrics sampled from figma/правки/макаронка 2.0 — Home.png (design 1920 @1.5x):
// cards 55px tall, radius 20, 1px #CFCFCF border, 16px gap; icons 20px;
// nav icons per figma/правки/Header — Pages — Icons.png — outline normally,
// purple-gradient fill for the active page.
import type { ActiveBatch } from "~/stores/generator";

const gen = useGeneratorStore();
const { theme, toggle: toggleTheme } = useTheme();
const route = useRoute();

// Active page → gradient icon (Header — Pages — Icons reference).
const isHome = computed(() => route.path === "/");
const isResult = computed(() => route.path.startsWith("/result"));
const isArchive = computed(() => route.path.startsWith("/archive"));
const isTournaments = computed(() => route.path.startsWith("/tournaments"));

// Unified progress. Everywhere except /tournaments: ALWAYS 3 status slots —
// one per content group (Person / Item / Background) — each reflecting the
// current (running) or last generation of that group. Background has no
// pipeline yet, so it stays idle. On /tournaments the same card shows the 4
// category pills instead ("0 of 3 Tournament (0%)" per the mock), one per
// tournament batch category, each with its own cancel ×.
type ProgressKind = "person" | "item" | "background";
const PROGRESS_KINDS: ProgressKind[] = ["person", "item", "background"];

const TOUR_SLOTS = [
  { key: "tournament", label: "Tournament" },
  { key: "lotterie", label: "Lotterie" },
  { key: "provider", label: "Provider" },
  { key: "calendar_vip", label: "Calendar" },
] as const;

function newest(list: ActiveBatch[]): ActiveBatch | null {
  if (!list.length) return null;
  return list.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
}

function latestBatch(kind: ProgressKind): ActiveBatch | null {
  if (kind === "background") return null; // no Background pipeline yet
  return newest(gen.batches.filter((b) => b.kind === kind));
}

interface ProgressSlot {
  kind: string; // icon selector
  label: string;
  pct: number;
  running: boolean;
  done: boolean;
  canCancel: boolean;
  batchId: string;
}

function slotOf(kind: string, b: ActiveBatch | null, name?: string): ProgressSlot {
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
      : name
        ? `${completed} of ${total} ${name} (${pct}%)`
        : `${completed} of ${total} images completed (${pct}%)`;
  return { kind, label, pct, running, done: b !== null && isComplete, canCancel: running, batchId: b?.id ?? "" };
}

const progressGroups = computed<ProgressSlot[]>(() =>
  isTournaments.value
    ? TOUR_SLOTS.map((s) =>
        slotOf(
          s.key,
          newest(gen.batches.filter((b) => b.kind === "tournament" && b.label === s.key)),
          s.label,
        ),
      )
    : PROGRESS_KINDS.map((kind) => slotOf(kind, latestBatch(kind))),
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

// Super-designer menu (TASK super-designer): click on the user card opens
// Create a New Style / Library — visible to SUPER_DESIGNER/ADMIN/MANAGER only.
const superDesigner = useSuperDesignerStore();
const userMenuOpen = ref(false);
const userCardEl = ref<HTMLElement | null>(null);

function toggleUserMenu() {
  if (!auth.canCreateStyles) return;
  userMenuOpen.value = !userMenuOpen.value;
}
function openCreateStyle() {
  userMenuOpen.value = false;
  superDesigner.openCreate();
}
function goLibrary() {
  userMenuOpen.value = false;
  void navigateTo("/library");
}
function onDocClick(e: MouseEvent) {
  if (userMenuOpen.value && userCardEl.value && !userCardEl.value.contains(e.target as Node)) {
    userMenuOpen.value = false;
  }
}
onMounted(() => document.addEventListener("click", onDocClick));
onBeforeUnmount(() => document.removeEventListener("click", onDocClick));

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
      <img class="logo" src="/logo.png" alt="m∿k" />
    </button>

    <!-- Shared gradient for active nav icons (mock: the brand 3-stop gradient). -->
    <svg width="0" height="0" style="position: absolute" aria-hidden="true">
      <defs>
        <linearGradient id="navGrad" x1="0" y1="12" x2="24" y2="12" gradientUnits="userSpaceOnUse">
          <stop stop-color="#6A72D9" />
          <stop offset="0.51" stop-color="#8151AA" />
          <stop offset="1" stop-color="#DD88ED" />
        </linearGradient>
      </defs>
    </svg>

    <!-- Unified progress: always 3 status slots (Person / Item / Background),
         each showing the current/last generation of that group. -->
    <div class="card card--progress">
      <div
        v-for="g in progressGroups"
        :key="g.kind"
        :class="['job', { 'job--idle': !g.running && !g.done }]"
      >
        <span class="ic ic--group" aria-hidden="true">
          <!-- Solid dark group icons, as in the mock progress card. -->
          <svg v-if="g.kind === 'person'" viewBox="0 0 24 24" width="20" height="20" fill="none">
            <circle cx="12" cy="7.6" r="3.8" fill="currentColor" />
            <path d="M4.6 19.4c.3-3.9 3.5-5.8 7.4-5.8s7.1 1.9 7.4 5.8c0 .3-.2.6-.6.6H5.2c-.4 0-.6-.3-.6-.6z" fill="currentColor" />
          </svg>
          <svg v-else-if="g.kind === 'item'" viewBox="0 0 24 24" width="20" height="20" fill="none">
            <path d="M13.6 4.9l1.5 3.1 3.4.5c.7.1 1 1 .5 1.5l-2.5 2.4.6 3.4c.1.7-.6 1.3-1.3 1l-3-1.6-3 1.6c-.7.3-1.4-.3-1.3-1l.6-3.4-2.5-2.4c-.5-.5-.2-1.4.5-1.5l3.4-.5 1.5-3.1c.3-.7 1.3-.7 1.6 0z" fill="currentColor" />
            <path d="M4.2 6.9c.9-1.3 2.1-2.2 3.4-2.6M3.6 11.7c.7-.6 1.5-1 2.3-1.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
          </svg>
          <svg v-else-if="g.kind === 'tournament'" viewBox="0 0 24 24" width="20" height="20" fill="none">
            <path d="M7 4h10v5a5 5 0 01-10 0V4z" fill="currentColor" />
            <path d="M7 5H4.5v1.5A3.5 3.5 0 008 10M17 5h2.5v1.5A3.5 3.5 0 0116 10" stroke="currentColor" stroke-width="1.6" />
            <path d="M12 14v3M8.5 20h7c0-1.7-1.5-3-3.5-3s-3.5 1.3-3.5 3z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
          </svg>
          <svg v-else-if="g.kind === 'lotterie'" viewBox="0 0 24 24" width="20" height="20" fill="none">
            <path d="M3.5 8.5A2.5 2.5 0 016 6h12a2.5 2.5 0 012.5 2.5v1.2a2.3 2.3 0 000 4.6v1.2A2.5 2.5 0 0118 18H6a2.5 2.5 0 01-2.5-2.5v-1.2a2.3 2.3 0 000-4.6V8.5z" fill="currentColor" />
            <path d="M14 7.5v9" stroke="#fff" stroke-width="1.4" stroke-dasharray="2 2.2" />
          </svg>
          <svg v-else-if="g.kind === 'provider'" viewBox="0 0 24 24" width="20" height="20" fill="none">
            <path d="M7.2 6.5h9.6c2.7 0 4.7 2.6 4.7 5.6 0 2.6-1.4 4.9-3.3 4.9-1 0-1.8-.5-2.5-1.4l-.9-1.1h-5.6l-.9 1.1c-.7.9-1.5 1.4-2.5 1.4-1.9 0-3.3-2.3-3.3-4.9 0-3 2-5.6 4.7-5.6z" fill="currentColor" />
            <path d="M8.4 10v3M6.9 11.5h3" stroke="#fff" stroke-width="1.4" stroke-linecap="round" />
            <circle cx="16" cy="10.6" r="1" fill="#fff" />
            <circle cx="17.8" cy="12.6" r="1" fill="#fff" />
          </svg>
          <svg v-else-if="g.kind === 'calendar_vip'" viewBox="0 0 24 24" width="20" height="20" fill="none">
            <rect x="3.8" y="5" width="16.4" height="15" rx="3.5" fill="currentColor" />
            <path d="M8 3.5v3M16 3.5v3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            <path d="M4.2 9.5h15.6" stroke="#fff" stroke-width="1.4" />
            <path d="M9.4 12.6l1.3 3.8h.2l1.2-3.8m1.6 3.8v-3.8m1.5 3.8v-3.8h1.2c.6 0 1 .4 1 1s-.4 1-1 1h-1.2" stroke="#fff" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <svg v-else viewBox="0 0 24 24" width="20" height="20" fill="none">
            <rect x="3.5" y="5.5" width="17" height="15" rx="4" fill="currentColor" />
            <circle cx="15.8" cy="10" r="1.5" fill="#fff" />
            <path d="M6.8 16.2c1.5-1.8 3-1.8 4.4 0 1.2 1.4 2.7 1 4.9-1" stroke="#fff" stroke-width="1.5" stroke-linecap="round" fill="none" />
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

    <!-- Stop: solid red rounded square, as in the icons reference -->
    <div class="card card--actions">
      <button class="act act--stop" type="button" aria-label="Stop all running" @click="gen.stopAllRunning()" />
    </div>

    <!-- Page nav icons (Header — Pages — Icons): outline, gradient when active -->
    <div class="card card--tools">
      <button
        v-if="auth.canAdminPanel"
        class="tool tool--admin"
        type="button"
        aria-label="Admin"
        title="Админка"
        @click="navigateTo('/admin')"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
          <path d="M12 3.2l6.4 2.7c.4.2.6.5.6.9v4.4c0 4.2-2.8 7.5-6.6 9.4a.9.9 0 01-.8 0C7.8 18.7 5 15.4 5 11.2V6.8c0-.4.2-.7.6-.9L12 3.2z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" />
          <path d="M9.2 11.9l2 2 3.6-3.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <button
        class="tool"
        :class="{ 'tool--on': isHome }"
        type="button"
        aria-label="Home"
        title="Home"
        @click="navigateTo('/')"
      >
        <svg v-if="!isHome" viewBox="0 0 24 24" width="20" height="20" fill="none">
          <path d="M4 16.4v-5.5c0-1 .5-1.9 1.3-2.5l5.5-4.1a2 2 0 012.4 0l5.5 4.1c.8.6 1.3 1.5 1.3 2.5v5.5c0 2.3-1.6 4.1-3.9 4.1H7.9C5.6 20.5 4 18.7 4 16.4z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" />
          <path d="M9.2 15.6c1 .9 4.6.9 5.6 0" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
        </svg>
        <svg v-else viewBox="0 0 24 24" width="20" height="20" fill="none">
          <path d="M3.5 16.4v-5.5c0-1.2.6-2.3 1.5-3L10.5 3.8a2.5 2.5 0 013 0l5.5 4.1c1 .7 1.5 1.8 1.5 3v5.5c0 2.5-1.8 4.6-4.4 4.6H7.9c-2.6 0-4.4-2.1-4.4-4.6z" fill="url(#navGrad)" />
          <path d="M9.2 15.6c1 .9 4.6.9 5.6 0" stroke="#fff" stroke-width="1.7" stroke-linecap="round" />
        </svg>
      </button>
      <button
        class="tool"
        :class="{ 'tool--on': isTournaments }"
        type="button"
        aria-label="Tournaments"
        title="Tournaments"
        @click="navigateTo('/tournaments')"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
          <path
            d="M8 4.2h8v5.3a4 4 0 01-8 0V4.2z"
            :fill="isTournaments ? 'url(#navGrad)' : 'none'"
            :stroke="isTournaments ? 'none' : 'currentColor'"
            stroke-width="1.7"
            stroke-linejoin="round"
          />
          <path
            d="M8 5.5H5v1.6A3.4 3.4 0 008.4 10.5M16 5.5h3v1.6a3.4 3.4 0 01-3.4 3.4"
            :stroke="isTournaments ? 'url(#navGrad)' : 'currentColor'"
            stroke-width="1.7"
            stroke-linecap="round"
          />
          <path
            d="M12 13.8v3M8.8 20h6.4c0-1.6-1.4-2.9-3.2-2.9s-3.2 1.3-3.2 2.9z"
            :stroke="isTournaments ? 'url(#navGrad)' : 'currentColor'"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <button
        class="tool"
        :class="{ 'tool--on': isResult }"
        type="button"
        aria-label="Open Result"
        title="Result"
        @click="navigateTo('/result')"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
          <path d="M13.6 4.9l1.5 3.1 3.4.5c.7.1 1 1 .5 1.5l-2.5 2.4.6 3.4c.1.7-.6 1.3-1.3 1l-3-1.6-3 1.6c-.7.3-1.4-.3-1.3-1l.6-3.4-2.5-2.4c-.5-.5-.2-1.4.5-1.5l3.4-.5 1.5-3.1c.3-.7 1.3-.7 1.6 0z" :fill="isResult ? 'url(#navGrad)' : 'none'" :stroke="isResult ? 'none' : 'currentColor'" stroke-width="1.7" stroke-linejoin="round" />
          <path d="M4.2 6.9c.9-1.3 2.1-2.2 3.4-2.6M3.6 11.7c.7-.6 1.5-1 2.3-1.2" :stroke="isResult ? 'url(#navGrad)' : 'currentColor'" stroke-width="1.7" stroke-linecap="round" />
        </svg>
      </button>
      <button
        class="tool"
        :class="{ 'tool--on': isArchive }"
        type="button"
        aria-label="Images"
        title="Архив"
        @click="navigateTo('/archive')"
      >
        <svg v-if="!isArchive" viewBox="0 0 24 24" width="20" height="20" fill="none">
          <rect x="3.75" y="3.75" width="16.5" height="16.5" rx="5" stroke="currentColor" stroke-width="1.7" />
          <circle cx="15.9" cy="8.1" r="1.5" stroke="currentColor" stroke-width="1.4" />
          <path d="M6.9 15.3c1.6-2 3.2-2 4.7 0 1.3 1.6 2.9 1.1 5.2-1.1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
        </svg>
        <svg v-else viewBox="0 0 24 24" width="20" height="20" fill="none">
          <rect x="3.5" y="3.5" width="17" height="17" rx="5" fill="url(#navGrad)" />
          <circle cx="15.9" cy="8.1" r="1.5" fill="#fff" />
          <path d="M6.9 15.3c1.6-2 3.2-2 4.7 0 1.3 1.6 2.9 1.1 5.2-1.1" stroke="#fff" stroke-width="1.6" stroke-linecap="round" />
        </svg>
      </button>
      <button
        class="tool"
        type="button"
        :aria-label="theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'"
        @click="toggleTheme"
      >
        <svg v-if="theme === 'dark'" viewBox="0 0 24 24" width="20" height="20" fill="none">
          <circle cx="12" cy="12" r="4.3" stroke="currentColor" stroke-width="1.7" />
          <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
        </svg>
        <svg v-else viewBox="0 0 24 24" width="20" height="20" fill="none">
          <path d="M20 14.5A8 8 0 119.5 4a6.5 6.5 0 0010.5 10.5z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" />
        </svg>
      </button>
    </div>

    <!-- User -->
    <div ref="userCardEl" class="user-wrap">
      <div
        :class="['card', 'card--user', { 'card--user-clickable': auth.canCreateStyles }]"
        :role="auth.canCreateStyles ? 'button' : undefined"
        :aria-expanded="auth.canCreateStyles ? userMenuOpen : undefined"
        @click="toggleUserMenu"
      >
        <span class="user__email">{{ userEmail }}</span>
        <span class="user__avatar">{{ userInitials }}</span>
        <button class="user__logout" type="button" aria-label="Выйти" title="Выйти" @click.stop="logout">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
            <path d="M15 4H7a2 2 0 00-2 2v12a2 2 0 002 2h8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
            <path d="M11 12h9m0 0l-3.5-3.5M20 12l-3.5 3.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>

      <!-- Super-designer menu (mock figma/super-designer): Create a New Style / Library -->
      <div v-if="userMenuOpen && auth.canCreateStyles" class="user-menu">
        <button class="user-menu__item" type="button" @click="openCreateStyle">
          Create a New Style
        </button>
        <button class="user-menu__item" type="button" @click="goLibrary">Library</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: stretch;
  gap: var(--space-16);
  width: 100%;
}

/* shared card shell — white, 1px border, 20px radius, 55px tall (mock) */
.card {
  display: flex;
  align-items: center;
  min-height: 55px;
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
/* логотип.png content, trimmed to the glyph (126×28 → 24px tall in the mock) */
.logo {
  display: block;
  height: 24px;
  width: auto;
}
/* Dark theme: the PNG letters are near-black — invert lifts them to white;
   hue-rotate(180deg) restores the wave gradient hues after inversion. */
html[data-theme="dark"] .logo {
  filter: invert(1) hue-rotate(180deg);
}

/* --- unified progress (3 group slots) --- */
.card--progress {
  flex: 3 1 580px;
  min-width: 520px;
  gap: var(--space-16);
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
  font-size: var(--fs-btn); /* mock: 12px, primary text color */
  color: var(--color-text);
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
  width: 14px;
  height: 14px;
  border: none;
  border-radius: 4px;
  padding: 0;
  background: var(--color-stop);
  color: #fff;
}
.job__close svg {
  width: 8px;
  height: 8px;
}
.job__close:hover {
  background: var(--color-stop-hover);
}

/* --- stop / delete --- */
.card--actions {
  flex: 0 0 auto;
  gap: var(--space-16);
}
/* solid red rounded square (icons reference), 20px in the mock */
.act {
  display: grid;
  place-items: center;
  border: none;
  padding: 0;
}
.act--stop {
  width: 22px;
  height: 22px;
  border-radius: 7px;
  background: var(--color-stop);
}
.act--stop:hover {
  background: var(--color-stop-hover);
}

/* --- page nav icons: dark outline, gradient fill when active (reference) --- */
.card--tools {
  flex: 0 0 auto;
  gap: 10px;
  padding: 0 22px;
}
.tool {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: none;
  background: transparent;
  border-radius: 9px;
  color: var(--color-text);
}
.tool:hover {
  background: var(--color-segment);
}
.tool--on:hover {
  background: transparent;
}

/* --- user --- */
.user-wrap {
  position: relative;
  flex: 0 0 280px;
  display: flex;
}
.card--user {
  flex: 1 1 auto;
  justify-content: space-between;
  gap: 12px;
}
.card--user-clickable {
  cursor: pointer;
}

/* dropdown per the super-designer mock: white card under the user card */
.user-menu {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 60;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 250px;
  padding: 8px;
  background: var(--color-white);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: 0 10px 30px rgba(30, 30, 60, 0.12);
}
.user-menu__item {
  padding: 12px 16px;
  border: none;
  border-radius: 12px;
  background: none;
  text-align: right;
  font-size: var(--fs-user);
  font-weight: 500;
  color: var(--color-text);
  cursor: pointer;
}
.user-menu__item:hover {
  background: var(--color-segment);
}
.user__email {
  font-size: var(--fs-user); /* 14px — User Title */
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
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--gradient-active);
  color: #fff;
  font-size: var(--fs-desc-sm);
  font-weight: 700;
}
.user__logout {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
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
.ic--group {
  color: var(--color-text); /* solid dark group icons, as in the mock */
}

/* --- basic responsive (refined in Phase 6) --- */
@media (max-width: 1100px) {
  .toolbar {
    flex-wrap: wrap;
  }
  .card--logo,
  .user-wrap {
    flex: 1 1 auto;
  }
  .card--progress {
    flex: 1 1 100%;
    min-width: 0;
  }
}
</style>
