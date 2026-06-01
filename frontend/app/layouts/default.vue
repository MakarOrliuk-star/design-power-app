<script setup lang="ts">
// Base app shell: top bar + centered 1280 container. Page-specific UI (the
// generator, the gallery) is built in later phases inside the <slot/>.
const auth = useAuthStore();
const router = useRouter();

const nav = [
  { label: "Home", to: "/" },
  { label: "Result", to: "/result" },
];

async function onLogout() {
  await auth.logout();
  router.push("/login");
}
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <div class="topbar__inner">
        <NuxtLink to="/" class="brand">m<span class="brand__wave">∿∿</span>k</NuxtLink>

        <nav class="nav">
          <NuxtLink
            v-for="item in nav"
            :key="item.to"
            :to="item.to"
            class="nav__link"
            active-class="nav__link--active"
          >
            {{ item.label }}
          </NuxtLink>
          <NuxtLink
            v-if="auth.isAdmin"
            to="/admin"
            class="nav__link"
            active-class="nav__link--active"
          >
            Admin
          </NuxtLink>
        </nav>

        <div class="user">
          <span class="user__name">{{ auth.user?.name || auth.user?.email }}</span>
          <button class="user__logout" type="button" @click="onLogout">Выйти</button>
        </div>
      </div>
    </header>

    <main class="main">
      <div class="container">
        <slot />
      </div>
    </main>
  </div>
</template>

<style scoped>
.shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.topbar {
  height: var(--header-height);
  background: var(--color-window);
  border-bottom: 1px solid var(--color-border);
  position: sticky;
  top: 0;
  z-index: 10;
}

.topbar__inner {
  max-width: var(--container-width);
  height: 100%;
  margin: 0 auto;
  padding: 0 24px;
  display: flex;
  align-items: center;
  gap: 32px;
}

.brand {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 1px;
}

.brand__wave {
  color: #7b61ff;
}

.nav {
  display: flex;
  gap: 8px;
}

.nav__link {
  padding: 8px 14px;
  border-radius: var(--radius-sm);
  color: var(--color-grey);
  font-weight: 500;
}

.nav__link--active {
  color: var(--color-text);
  background: var(--color-bubble);
}

.user {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 12px;
}

.user__name {
  font-weight: 600;
}

.user__logout {
  border: 1px solid var(--color-border);
  background: var(--color-white);
  border-radius: var(--radius-sm);
  padding: 6px 12px;
  font-weight: 500;
  color: var(--color-text);
}

.user__logout:hover {
  background: var(--color-bubble);
}
</style>
