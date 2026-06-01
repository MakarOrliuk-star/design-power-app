// Hydrate the session once at startup so route middleware has user state.
export default defineNuxtPlugin(async () => {
  const auth = useAuthStore();
  if (!auth.ready) await auth.fetchMe();
});
