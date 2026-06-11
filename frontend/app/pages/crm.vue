<script setup lang="ts">
import { ref } from "vue";

// CrmCalculator и useAuthStore подтягиваются автоматически магией Nuxt!

useHead({ title: "Design Power — CRM Dashboard" });

const auth = useAuthStore();

// Состояние текущего экрана: null — главное меню, 'calculator' или 'auditor' — запущенный сервис
const activeService = ref<null | 'calculator' | 'auditor'>(null);

async function logout() {
  await auth.logout();
  await navigateTo("/login");
}
</script>

<template>
  <div class="crm">
    <header class="bar">
      <button class="bar__logo" type="button" title="К выбору зоны" @click="navigateTo('/login')">
        m<span class="bar__wave">∿∿</span>k
      </button>
      <h1 class="bar__title" @click="activeService = null" style="cursor: pointer;">
        CRM 
        <span v-if="activeService" class="bar__breadcrumbs"> 
          / {{ activeService === 'calculator' ? 'Валютный калькулятор' : 'Массовый аудит' }}
        </span>
      </h1>
      <div class="bar__user">
        <span class="bar__email">{{ auth.user?.email }}</span>
        <button class="bar__logout" type="button" @click="logout">Выйти</button>
      </div>
    </header>

    <div class="workspace">
      
      <div v-if="activeService === null" class="tiles-grid animate-fade">
        
        <div class="tile-card" @click="activeService = 'calculator'">
          <div class="tile-card__icon-wrapper tile-card__icon-wrapper--euro">
            <span class="tile-card__icon">💶</span>
          </div>
          <h2 class="tile-card__title">Валютный калькулятор</h2>
          <p class="tile-card__desc">
            Автоматический расчет и конвертация EUR во все фиатные валюты и крипту с кэшированием через Redis.
          </p>
          <div class="tile-card__footer">Запустить сервис →</div>
        </div>

        <div class="tile-card" @click="activeService = 'auditor'">
          <div class="tile-card__icon-wrapper tile-card__icon-wrapper--search">
            <span class="tile-card__icon">🔎</span>
          </div>
          <h2 class="tile-card__title">Массовый аудит</h2>
          <p class="tile-card__desc">
            Сканирование маркетинговых кампаний Smartico, генерация Flow Map и выгрузка интерактивных HTML-отчетов.
          </p>
          <div class="tile-card__footer">В разработке...</div>
        </div>

      </div>

      <div v-else class="service-layout animate-fade">
        <div class="service-header">
          <button class="btn-back" type="button" @click="activeService = null">
            ← Назад в меню CRM
          </button>
        </div>
        
        <div class="service-body">
          <CrmCalculator v-if="activeService === 'calculator'" />

          <div v-else-if="activeService === 'auditor'" class="stub">
            <p class="stub__title">Аудит Smartico скоро здесь</p>
            <p class="stub__hint">Логика фонового Playwright-воркера будет добавлена в следующей фазе.</p>
          </div>
        </div>
      </div>

    </div>
  </div>
</template>

<style scoped>
/* Базовые стили проекта */
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
.bar__email {
  font-size: 14px;
  color: var(--color-grey);
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

/* Контейнер рабочей области */
.workspace {
  flex: 1;
  min-height: 0;
}

/* Сетка для плиток-карточек */
.tiles-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 20px;
}

/* Стилизация интерактивной плитки */
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
  transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1), border-color 0.2s ease;
}
.tile-card:hover {
  transform: translateY(-3px);
  border-color: var(--color-grey);
}

.tile-card__icon-wrapper {
  padding: 12px;
  border-radius: var(--radius-lg);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
}
.tile-card__icon-wrapper--euro { background-color: #ecfdf5; }
.tile-card__icon-wrapper--search { background-color: #eff6ff; }

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

/* Лэйаут запущенного сервиса */
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

/* Стилизация старой заглушки для совместимости */
.stub {
  flex: 1;
  display: grid;
  place-content: center;
  text-align: center;
  gap: 8px;
  padding: 60px 0;
}
.stub__title {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
}
.stub__hint {
  margin: 0;
  font-size: 14px;
  color: var(--color-grey);
}

/* Плавная анимация переключения экранов */
.animate-fade {
  animation: fadeIn 0.22s cubic-bezier(0.4, 0, 0.2, 1);
}
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
