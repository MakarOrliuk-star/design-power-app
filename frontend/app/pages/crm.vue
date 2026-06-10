<script setup lang="ts">
// CRM zone — empty scaffold (TASK Phase 1). The real CRM logic arrives in a
// later phase; for now the page only proves the routing/auth path works and
// gives the user a way back (portal) and out (logout). It deliberately does
// not use TheToolbar — that one is wired to the Design generator store.
useHead({ title: "Design Power — CRM" });

const auth = useAuthStore();

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
      <h1 class="bar__title">CRM</h1>
      <div class="bar__user">
        <span class="bar__email">{{ auth.user?.email }}</span>
        <button class="bar__logout" type="button" @click="logout">Выйти</button>
      </div>
    </header>

    <div class="stub">
      <p class="stub__title">CRM скоро здесь</p>
      <p class="stub__hint">Раздел в разработке. Логика CRM появится в следующих фазах.</p>
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
}
.bar__logout:hover {
  border-color: var(--color-stop);
  color: var(--color-stop-hover);
}

.stub {
  flex: 1;
  min-height: 0;
  display: grid;
  place-content: center;
  text-align: center;
  gap: 8px;
  background: var(--color-white);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
}
.stub__title {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
}
.stub__hint {
  margin: 0;
  font-size: 14px;
  color: var(--color-grey);
}
</style>
