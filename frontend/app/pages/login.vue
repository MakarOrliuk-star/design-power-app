<script setup lang="ts">
// Google OAuth + allowlist gate. The button hands off to the backend, which
// runs the OAuth dance and redirects back with an httpOnly session cookie.
definePageMeta({ layout: false });
useHead({ title: "Design Power — Вход" });

const config = useRuntimeConfig();
const route = useRoute();

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

function signIn() {
  window.location.href = `${config.public.apiBase}/auth/google`;
}
</script>

<template>
  <div class="login">
    <div class="card">
      <div class="brand">m<span>∿∿</span>k</div>
      <h1>Design Power</h1>

      <p v-if="errorMessage" class="error">{{ errorMessage }}</p>

      <button class="google-btn" type="button" @click="signIn">
        Войти через Google
      </button>
    </div>
  </div>
</template>

<style scoped>
.login {
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: var(--color-bg);
}
.card {
  background: var(--color-window);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: 48px;
  text-align: center;
  min-width: 340px;
}
.brand {
  font-size: 32px;
  font-weight: 700;
  letter-spacing: 1px;
}
.brand span {
  color: #7b61ff;
}
h1 {
  font-size: 18px;
  font-weight: 600;
  margin: 8px 0 24px;
}
.error {
  background: rgba(244, 115, 115, 0.12);
  color: var(--color-stop-hover);
  border: 1px solid var(--color-stop);
  border-radius: var(--radius-sm);
  padding: 10px 14px;
  margin: 0 0 20px;
  font-size: 14px;
}
.google-btn {
  width: 100%;
  padding: 12px 20px;
  border: none;
  border-radius: var(--radius-md);
  background: var(--gradient-active);
  color: var(--color-white);
  font-weight: 600;
  font-size: 15px;
}
.google-btn:hover {
  opacity: 0.92;
}
</style>
