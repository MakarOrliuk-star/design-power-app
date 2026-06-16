<script setup lang="ts">
// Start page (figma/login page/login page1.png): header cards + two video
// zones, Design and CRM. Serves both as the login screen and as the portal —
// an authenticated user clicks a zone and goes straight in; an anonymous one
// is sent through the existing Google OAuth with the target carried in ?next=
// (validated server-side, see backend routes/auth.ts).
definePageMeta({ layout: false });
useHead({ title: "Design Power — Вход" });

const config = useRuntimeConfig();
const route = useRoute();
const auth = useAuthStore();

const ERROR_MESSAGES: Record<string, string> = {
  not_allowed: "Ваш email не в белом списке. Обратитесь к администратору.",
  deactivated: "Ваш аккаунт деактивирован.",
  email_unverified: "Email не подтверждён в Google.",
  state: "Сессия входа истекла. Попробуйте ещё раз.",
  oauth: "Вход через Google отменён.",
  server: "Ошибка сервера при входе. Попробуйте ещё раз.",
};

const errorMessage = computed(() => {
  const code = route.query.error;
  return typeof code === "string" ? (ERROR_MESSAGES[code] ?? "Не удалось войти.") : "";
});

const ZONES = [
  { id: "design", title: "Design", next: "/", video: "/login/design.mp4" },
  { id: "crm", title: "CRM", next: "/crm", video: "/login/crm.mp4" },
] as const;

// Anonymous visitors see both zones (role is unknown until they log in).
// Authenticated users only see the zone(s) their role can reach — ADMIN both,
// DESIGNER only Design, CRM only CRM.
const visibleZones = computed(() => {
  if (!auth.isAuthenticated) return ZONES;
  return ZONES.filter((z) =>
    z.id === "crm" ? auth.canCrm : auth.canDesign,
  );
});

function enter(next: string) {
  if (auth.isAuthenticated) {
    void navigateTo(next);
    return;
  }
  window.location.href = `${config.public.apiBase}/auth/google?next=${encodeURIComponent(next)}`;
}
</script>

<template>
  <div class="start">
    <header class="head">
      <div class="card card--logo">
        <span class="logo">
          <span class="logo__letter">m</span>
          <svg class="logo__wave" width="46" height="22" viewBox="0 0 46 22" fill="none" aria-hidden="true">
            <defs>
              <linearGradient id="startWave" x1="0" y1="11" x2="46" y2="11" gradientUnits="userSpaceOnUse">
                <stop stop-color="#6A72D9" />
                <stop offset="0.51" stop-color="#8151AA" />
                <stop offset="1" stop-color="#DD88ED" />
              </linearGradient>
            </defs>
            <path
              d="M1 11 C 5 1, 11 1, 15 11 S 25 21, 29 11 S 39 1, 45 11"
              stroke="url(#startWave)"
              stroke-width="3"
              stroke-linecap="round"
              fill="none"
            />
          </svg>
          <span class="logo__letter">k</span>
        </span>
      </div>

      <div class="card card--title">
        <span class="title">
          <svg class="title__wave" width="34" height="12" viewBox="0 0 34 12" fill="none" aria-hidden="true">
            <path
              d="M1 6 C 4 1, 8 1, 11 6 S 18 11, 21 6 S 28 1, 33 6"
              stroke="url(#startWave)"
              stroke-width="2.4"
              stroke-linecap="round"
              fill="none"
            />
          </svg>
          макаронка
        </span>
      </div>

      <div v-if="auth.isAuthenticated" class="card card--user">
        <span class="user__email">{{ auth.user?.email }}</span>
        <img v-if="auth.user?.avatarUrl" class="user__avatar" :src="auth.user.avatarUrl" alt="" />
      </div>
    </header>

    <p v-if="errorMessage" class="error">{{ errorMessage }}</p>

    <div class="zones" :class="{ 'zones--single': visibleZones.length === 1 }">
      <button
        v-for="z in visibleZones"
        :key="z.id"
        class="zone"
        type="button"
        @click="enter(z.next)"
      >
        <video class="zone__video" :src="z.video" autoplay muted loop playsinline preload="auto" />
        <span class="zone__title">{{ z.title }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.start {
  height: 100dvh;
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: var(--container-pad);
  max-width: var(--container-width);
  margin: 0 auto;
  background: var(--color-bg);
  overflow: hidden;
}

/* header — same white 71px cards as TheToolbar (figma/icons metrics) */
.head {
  display: flex;
  align-items: stretch;
  gap: 20px;
  min-height: 71px;
}
.card {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-white);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  padding: 0 28px;
}
.card--logo {
  flex: 0 0 auto;
  min-width: 200px;
}
.card--title {
  flex: 1;
}
.card--user {
  flex: 0 0 auto;
  gap: 12px;
}

.logo {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.logo__letter {
  font-size: 30px;
  font-weight: 600;
  line-height: 1;
}
.logo__wave {
  display: block;
}

.title {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  font-size: 19px;
  font-weight: 600;
  letter-spacing: 0.4px;
}
.title__wave {
  display: block;
}

.user__email {
  font-size: 14px;
  color: var(--color-text);
}
.user__avatar {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  object-fit: cover;
}

.error {
  margin: 0;
  background: rgba(244, 115, 115, 0.12);
  color: var(--color-stop-hover);
  border: 1px solid var(--color-stop);
  border-radius: var(--radius-sm);
  padding: 10px 14px;
  font-size: 14px;
  text-align: center;
}

/* the two clickable zones — fill the rest of the screen */
.zones {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
}
/* Single accessible zone (e.g. a CRM-only or Designer-only user) — don't
   stretch the lone tile across the full width. */
.zones--single {
  grid-template-columns: minmax(0, 720px);
  justify-content: center;
}
.zone {
  position: relative;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: 0;
  overflow: hidden;
  background: var(--color-white);
  box-shadow: var(--shadow-card);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.zone:hover {
  transform: translateY(-2px);
  box-shadow: 0 10px 30px rgba(31, 31, 31, 0.12);
}
.zone:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
.zone__video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.zone__title {
  position: absolute;
  top: 24px;
  left: 28px;
  font-size: 32px;
  font-weight: 600;
  color: #1f1f1f; /* on the light video background, both themes */
  line-height: 1;
}

@media (max-width: 760px) {
  .zones {
    grid-template-columns: 1fr;
  }
  .card--title {
    display: none;
  }
  .zone__title {
    font-size: 24px;
  }
}
</style>
