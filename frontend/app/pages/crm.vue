<script setup lang="ts">
import { ref, computed, onMounted } from "vue";

useHead({ title: "Design Power — CRM Power" });

const auth = useAuthStore();
const crm = useCrmStore();

// Only services with real logic are openable (and favoritable). The "soon"
// tiles are disabled placeholders — see SERVICES below.
type ServiceKey = "calculator" | "bonuscalc" | "auditor";
const activeService = ref<null | ServiceKey>(null);

interface Service {
  key: string;
  title: string;
  desc: string;
  icon: string;
  iconBg: string;
  footer: string;
  soon: boolean;
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
    title: "Unique-Image-Smartico",
    desc: "Генерация уникальных изображений под кампании Smartico без ручной обработки.",
    icon: "🖼️",
    iconBg: "#fdf2f8",
    footer: "Скоро",
    soon: true,
  },
];

const SERVICE_TITLES: Record<ServiceKey, string> = {
  calculator: "Валютный калькулятор",
  bonuscalc: "Калькулятор Бонусов",
  auditor: "Массовый аудит",
};

const displayName = computed(() => auth.user?.name || auth.user?.email || "");

// Favorited services that are still real (soon tiles can't be favorited).
const favoriteServices = computed(() =>
  SERVICES.filter((s) => !s.soon && crm.isFavorite(s.key)),
);

function openService(s: Service) {
  if (s.soon) return; // soon tiles are not clickable
  activeService.value = s.key as ServiceKey;
}

async function logout() {
  await auth.logout();
  await navigateTo("/login");
}

onMounted(() => {
  if (!crm.ready) void crm.fetchFavorites();
});
</script>

<template>
  <div class="crm">
    <header class="bar">
      <button class="bar__logo" type="button" title="К выбору зоны" @click="navigateTo('/login')">
        m<span class="bar__wave">∿∿</span>k
      </button>
      <h1 class="bar__title" @click="activeService = null">
        CRM <span class="bar__power">Power</span>
        <span v-if="activeService" class="bar__breadcrumbs"> / {{ SERVICE_TITLES[activeService] }}</span>
      </h1>
      <div class="bar__user">
        <span class="bar__greeting">Добро пожаловать, <b>{{ displayName }}</b></span>
        <button v-if="!auth.isCrm" class="bar__logout" type="button" @click="logout">Выйти</button>
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

        <section class="services-section">
          <h2 class="services-section__title">Все сервисы</h2>
          <div class="tiles-grid">
            <article
              v-for="s in SERVICES"
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

.bar {
  display: flex;
  align-items: center;
  gap: 20px;
  background: var(--color-white);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  min-height: 71px;
  padding: 0 28px;
}
.bar__logo {
  border: none;
  background: none;
  padding: 0;
  font-size: 26px;
  font-weight: 600;
  color: var(--color-text);
  cursor: pointer;
}
.bar__wave {
  background: var(--gradient-active);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.bar__title {
  flex: 1;
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--color-text);
  cursor: pointer;
}
.bar__power {
  background: var(--gradient-active);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.bar__breadcrumbs {
  font-size: 14px;
  color: var(--color-grey);
  font-weight: normal;
}
.bar__user {
  display: flex;
  align-items: center;
  gap: 16px;
}
.bar__greeting {
  font-size: 14px;
  color: var(--color-grey);
}
.bar__greeting b {
  color: var(--color-text);
  font-weight: 600;
}
.bar__logout {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: var(--color-white);
  padding: 8px 18px;
  font-size: 14px;
  color: var(--color-text);
  cursor: pointer;
}
.bar__logout:hover {
  border-color: var(--color-stop);
  color: var(--color-stop-hover);
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
