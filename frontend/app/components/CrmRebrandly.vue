<script setup lang="ts">
// Placeholder for the upcoming CRM-Rebrandly service (mass-managing branded
// short links). No business logic yet — the dashboard tile is disabled
// ("soon"); this stub exists so the real component can be wired in later.
</script>

<template>
  <div class="crm-stub">
    <div class="crm-stub__icon" aria-hidden="true">🔗</div>
    <h3 class="crm-stub__title">CRM-Rebrandly</h3>
    <span class="crm-stub__badge">soon</span>
    <p class="crm-stub__text">
      Сервис в разработке. Скоро здесь появится массовое создание и управление
      брендированными короткими ссылками Rebrandly прямо из CRM.
    </p>
  </div>
</template>

<style scoped>
.crm-stub {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 10px;
  padding: 60px 24px;
}
.crm-stub__icon {
  font-size: 44px;
  line-height: 1;
}
.crm-stub__title {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  color: var(--color-text);
}
.crm-stub__badge {
  text-transform: uppercase;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.5px;
  color: var(--color-grey);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  padding: 3px 12px;
}
.crm-stub__text {
  margin: 0;
  max-width: 420px;
  font-size: 14px;
  color: var(--color-grey);
  line-height: 1.5;
}
</style>
