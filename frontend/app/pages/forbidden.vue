<script setup lang="ts">
// Friendly "no access" interstitial. The zone guard (middleware/auth.global.ts)
// sends users here instead of bouncing them silently, so a Designer who opens a
// CRM link (or vice-versa) sees a calm explanation and a button back to their
// own zone rather than an abrupt redirect.
useHead({ title: "Design Power — Нет доступа" });

const auth = useAuthStore();

// Where "your section" leads, by role. ADMIN reaches both — default to Design.
const home = computed(() => {
  if (auth.canDesign) return { path: "/", label: "Перейти в Design" };
  if (auth.canCrm) return { path: "/crm", label: "Перейти в CRM" };
  return { path: "/login", label: "На страницу входа" };
});
</script>

<template>
  <div class="forbidden">
    <div class="card">
      <div class="card__icon" aria-hidden="true">🔒</div>
      <h1 class="card__title">Извините, у вас нет прав просматривать эту страницу</h1>
      <p class="card__text">Перейдите в свой раздел, чтобы продолжить работу.</p>
      <button class="card__btn" type="button" @click="navigateTo(home.path)">
        {{ home.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.forbidden {
  flex: 1;
  min-height: 0;
  display: grid;
  place-items: center;
}
.card {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 14px;
  max-width: 440px;
  padding: 40px 36px;
  background: var(--color-white);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
}
.card__icon {
  font-size: 40px;
  line-height: 1;
}
.card__title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  color: var(--color-text);
  line-height: 1.3;
}
.card__text {
  margin: 0;
  font-size: 14px;
  color: var(--color-grey);
}
.card__btn {
  margin-top: 6px;
  border: none;
  border-radius: var(--radius-pill);
  background: var(--gradient-active);
  color: var(--color-white);
  padding: 11px 26px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: transform 0.15s ease, opacity 0.15s ease;
}
.card__btn:hover {
  transform: translateY(-1px);
  opacity: 0.92;
}
.card__btn:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
</style>
