<script setup lang="ts">
import { ref, computed, onMounted } from "vue";

const config = useRuntimeConfig();


useHead({ title: "Design Power — CRM Power" });

const auth = useAuthStore();
const crm = useCrmStore();
const { theme, toggle: toggleTheme } = useTheme();

// Only services with real logic are openable (and favoritable). The "soon"
// tiles are disabled placeholders — see SERVICES below.
type ServiceKey = "calculator" | "bonuscalc" | "auditor" | "smartico";
const activeService = ref<null | ServiceKey>(null);

interface Service {
  key: string;
  title: string;
  desc: string;
  icon: string;
  iconBg: string;
  footer: string;
  soon: boolean;
  externalUrl?: string;
}

const SERVICES: Service[] = [
  {
    key: "calculator",
    title: "Валютный калькулятор",
    desc: "Автоматический расчёт и конвертация EUR во все фиатные валюты и крипту с кэшированием через Redis.",
    icon: "💶",
    iconBg: "#ecfdf5",
    footer: "Запустить сервис →",
    soon: false,
  },
  {
    key: "bonuscalc",
    title: "Калькулятор Бонусов",
    desc: "Расчёт костов, вейджеров и комиссий для Free Spins, Deposit Bonus и Hybrid.",
    icon: "🎯",
    iconBg: "#fef3c7",
    footer: "Запустить сервис →",
    soon: false,
  },
  {
    key: "auditor",
    title: "Массовый аудит",
    desc: "Сканирование маркетинговых кампаний Smartico, генерация Flow Map и выгрузка интерактивных HTML-отчётов.",
    icon: "🔎",
    iconBg: "#eff6ff",
    footer: "Запустить сервис →",
    soon: false,
  },
  {
    key: "rebrandly",
    title: "CRM-Rebrandly",
    desc: "Массовое создание и управление брендированными короткими ссылками Rebrandly прямо из CRM.",
    icon: "🔗",
    iconBg: "#f5f3ff",
    footer: "Скоро",
    soon: true,
  },
  {
    key: "smartico",
    title: "Unique Image Smartico",
    desc: "Генерация уникальных изображений под кампании Smartico без ручной обработки.",
    icon: "🖼️",
    iconBg: "#fdf2f8",
    footer: "Запустить сервис →",
    soon: false,
  },
  {
    key: "chrome_extensions",
    title: "Расширения Chrome",
    desc: "Google Drive со всеми Chrome-расширениями для автоматизации",
    icon: "🧩",
    iconBg: "#f5f3ff", 
    footer: "Открыть папку →",
    soon: false,
    externalUrl: config.public.googleDriveUrl as string, 
  },
];

const SERVICE_TITLES: Record<ServiceKey, string> = {
  calculator: "Валютный калькулятор",
  bonuscalc: "Калькулятор Бонусов",
  auditor: "Массовый аудит",
  smartico: "Unique Image Smartico",
};

const displayName = computed(() => auth.user?.name || auth.user?.email || "");

// Favorited services that are still real (soon tiles can't be favorited).
const favoriteServices = computed(() =>
  SERVICES.filter((s) => !s.soon && crm.isFavorite(s.key)),
);

// "Все сервисы" excludes whatever is already pinned to Избранное, so a
// favorited service isn't shown twice on the page.
const otherServices = computed(() =>
  SERVICES.filter((s) => !(!s.soon && crm.isFavorite(s.key))),
);

function openService(s: Service) {
  if (s.soon) return; // soon tiles are not clickable
  if (s.externalUrl) {
    window.open(s.externalUrl, "_blank", "noopener,noreferrer");
    return;
  }
  activeService.value = s.key as ServiceKey;
}

async function logout() {
  await auth.logout();
  await navigateTo("/login");
}

onMounted(() => {
  if (!crm.ready) void crm.fetchFavorites();
  // Returning from the Google Drive consent flow (/crm?drive=...) — drop the user
  // straight back into the Smartico service, which reads the status itself.
  if (useRoute().query.drive) activeService.value = "smartico";
});
</script>

<template>
  <div class="crm">
    <header class="bar">
      <!-- Brand icon (left) → back to the CRM dashboard home -->
      <button
        class="card card--logo"
        type="button"
        aria-label="На главную CRM"
        title="На главную CRM"
        @click="activeService = null"
      >
        <span class="logo">
          <span class="logo__letter">m</span>
          <svg class="logo__wave" width="46" height="22" viewBox="0 0 46 22" fill="none" aria-hidden="true">
            <defs>
              <linearGradient id="crmWave" x1="0" y1="11" x2="46" y2="11" gradientUnits="userSpaceOnUse">
                <stop stop-color="#6A72D9" />
                <stop offset="0.51" stop-color="#8151AA" />
                <stop offset="1" stop-color="#DD88ED" />
              </linearGradient>
            </defs>
            <path d="M1 11 C 5 1, 11 1, 15 11 S 25 21, 29 11 S 39 1, 45 11" stroke="url(#crmWave)" stroke-width="3" stroke-linecap="round" fill="none" />
          </svg>
          <span class="logo__letter">k</span>
        </span>
      </button>

      <!-- Tools (night theme) -->
      <div class="card card--tools">
        <button
          class="tool"
          type="button"
          :aria-label="theme === 'dark' ? 'Светлая тема' : 'Ночная тема'"
          :title="theme === 'dark' ? 'Светлая тема' : 'Ночная тема'"
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

      <!-- Centered title -->
      <div class="card card--title">
        <h1 class="bar__title">
          CRM <span class="bar__power">Power</span> <span class="bar__brand">Makaronka AI</span>
          <span v-if="activeService" class="bar__breadcrumbs"> / {{ SERVICE_TITLES[activeService] }}</span>
        </h1>
      </div>

      <!-- Greeting + logout (right) -->
      <div class="card card--user">
        <span class="bar__greeting">Добро пожаловать, <b>{{ displayName }}</b></span>
        <button
          v-if="!auth.isCrm"
          class="user__logout"
          type="button"
          aria-label="Выйти"
          title="Выйти"
          @click="logout"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
            <path d="M15 4H7a2 2 0 00-2 2v12a2 2 0 002 2h8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
            <path d="M11 12h9m0 0l-3.5-3.5M20 12l-3.5 3.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
    </header>

    <div class="workspace">
      <div v-if="activeService === null" class="animate-fade">
        <!-- Избранное — отдельный ряд сверху, появляется при наличии избранного -->
        <section v-if="favoriteServices.length" class="services-section">
          <h2 class="services-section__title">⭐ Избранное</h2>
          <div class="tiles-grid">
            <article
              v-for="s in favoriteServices"
              :key="s.key"
              class="tile-card"
              @click="openService(s)"
            >
              <button
                class="tile-card__star tile-card__star--active"
                type="button"
                title="Убрать из избранного"
                @click.stop="crm.toggleFavorite(s.key)"
              >★</button>
              <div class="tile-card__icon-wrapper" :style="{ backgroundColor: s.iconBg }">
                <span class="tile-card__icon">{{ s.icon }}</span>
              </div>
              <h3 class="tile-card__title">{{ s.title }}</h3>
              <p class="tile-card__desc">{{ s.desc }}</p>
              <div class="tile-card__footer">{{ s.footer }}</div>
            </article>
          </div>
        </section>

        <section v-if="otherServices.length" class="services-section">
          <h2 class="services-section__title">Все сервисы</h2>
          <div class="tiles-grid">
            <article
              v-for="s in otherServices"
              :key="s.key"
              class="tile-card"
              :class="{ 'tile-card--soon': s.soon }"
              @click="openService(s)"
            >
              <!-- Звёздочка выбора любимого сервиса (только у рабочих сервисов) -->
              <button
                v-if="!s.soon"
                class="tile-card__star"
                :class="{ 'tile-card__star--active': crm.isFavorite(s.key) }"
                type="button"
                :title="crm.isFavorite(s.key) ? 'Убрать из избранного' : 'Добавить в избранное'"
                @click.stop="crm.toggleFavorite(s.key)"
              >★</button>
              <span v-else class="tile-card__badge">soon</span>

              <div class="tile-card__icon-wrapper" :style="{ backgroundColor: s.iconBg }">
                <span class="tile-card__icon">{{ s.icon }}</span>
              </div>
              <h3 class="tile-card__title">{{ s.title }}</h3>
              <p class="tile-card__desc">{{ s.desc }}</p>
              <div class="tile-card__footer">{{ s.footer }}</div>
            </article>
          </div>
        </section>
      </div>

      <div v-else class="service-layout animate-fade">
        <div class="service-header">
          <button class="btn-back" type="button" @click="activeService = null">
            ← Назад в меню CRM
          </button>
        </div>

        <div class="service-body">
          <CrmCalculator v-if="activeService === 'calculator'" />
          <CrmBonusCalculator v-else-if="activeService === 'bonuscalc'" />
          <CrmAuditor v-else-if="activeService === 'auditor'" />
          <CrmSmartico v-else-if="activeService === 'smartico'" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.crm {
  display: flex;
  flex-direction: column;
  gap: 24px;
  height: 100%;
  min-height: 0;
}

/* Card-based header, matching the Design toolbar (TheToolbar.vue). */
.bar {
  display: flex;
  align-items: stretch;
  gap: 20px;
}
.card {
  display: flex;
  align-items: center;
  min-height: 71px;
  background: var(--color-white);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  padding: 0 22px;
}

/* greeting + logout (right) */
.card--user {
  flex: 0 0 auto;
  gap: 14px;
}
.bar__greeting {
  font-size: 14px;
  color: var(--color-grey);
  white-space: nowrap;
}
.bar__greeting b {
  color: var(--color-text);
  font-weight: 600;
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
  cursor: pointer;
}
.user__logout:hover {
  background: var(--color-bubble);
  color: var(--color-stop-hover);
}

/* centered title */
.card--title {
  flex: 1;
  justify-content: center;
  min-width: 0;
}
.bar__title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--color-text);
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bar__power {
  background: var(--gradient-active);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.bar__brand {
  color: var(--color-grey);
  font-weight: 500;
}
.bar__breadcrumbs {
  font-size: 14px;
  color: var(--color-grey);
  font-weight: normal;
}

/* tools (night theme) */
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
  cursor: pointer;
}
.tool:hover {
  background: rgba(138, 56, 245, 0.08);
}

/* brand icon (left) → CRM home */
.card--logo {
  flex: 0 0 auto;
  justify-content: center;
  cursor: pointer;
  transition: border-color 0.12s ease;
}
.card--logo:hover {
  border-color: var(--color-accent);
}
.logo {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.logo__letter {
  font-size: 26px;
  font-weight: 600;
  line-height: 1;
  color: var(--color-text);
}
.logo__wave {
  display: block;
}

.workspace {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-top: 4px;
  padding-bottom: 24px;
}

.services-section {
  margin-bottom: 28px;
}
.services-section:last-child {
  margin-bottom: 0;
}
.services-section__title {
  margin: 0 0 14px;
  font-size: 15px;
  font-weight: 600;
  color: var(--color-grey);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.tiles-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 20px;
}

.tile-card {
  background: var(--color-white);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: 28px;
  cursor: pointer;
  box-shadow: var(--shadow-card);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  position: relative;
  transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1), border-color 0.2s ease;
}
.tile-card:hover {
  transform: translateY(-3px);
  border-color: var(--color-grey);
  z-index: 5;
}

/* Soon placeholders: visible but inert. */
.tile-card--soon {
  cursor: not-allowed;
  opacity: 0.62;
  background: var(--color-bg);
}
.tile-card--soon:hover {
  transform: none;
  border-color: var(--color-border);
}

.tile-card__star {
  position: absolute;
  top: 16px;
  right: 16px;
  border: none;
  background: none;
  padding: 0;
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  color: var(--color-border);
  transition: color 0.15s ease, transform 0.15s ease;
}
.tile-card__star:hover {
  color: #f59e0b;
  transform: scale(1.15);
}
.tile-card__star--active {
  color: #f59e0b;
}

.tile-card__badge {
  position: absolute;
  top: 16px;
  right: 16px;
  text-transform: uppercase;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.5px;
  color: var(--color-grey);
  background: var(--color-white);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  padding: 3px 10px;
}

.tile-card__icon-wrapper {
  padding: 12px;
  border-radius: var(--radius-lg);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
}

.tile-card__title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  color: var(--color-text);
}
.tile-card__desc {
  margin: 0;
  font-size: 14px;
  color: var(--color-grey);
  line-height: 1.5;
  flex-grow: 1;
}
.tile-card__footer {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
  margin-top: 8px;
}

.service-layout {
  display: flex;
  flex-direction: column;
  gap: 16px;
  background: var(--color-white);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: 28px;
  box-shadow: var(--shadow-card);
  min-height: 500px;
}
.service-header {
  border-bottom: 1px solid var(--color-border);
  padding-bottom: 14px;
  margin-bottom: 8px;
}
.btn-back {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: var(--color-white);
  padding: 6px 14px;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-grey);
  cursor: pointer;
  transition: all 0.15s ease;
}
.btn-back:hover {
  color: var(--color-text);
  border-color: var(--color-grey);
}

.service-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.animate-fade {
  animation: fadeIn 0.22s cubic-bezier(0.4, 0, 0.2, 1);
}
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
