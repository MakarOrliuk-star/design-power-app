export default defineNuxtRouteMiddleware(async (to) => {
  const auth = useAuthStore();
  if (!auth.ready) await auth.fetchMe();

  // The whole decision — public paths, the /login bounce, the /admin and
  // /library gates and the Design/CRM/Game zone walls — lives in utils/zones.ts
  // as a pure function, shared with the session store and unit-tested as a
  // role x route matrix (tests/gameZone.test.ts). It mirrors the backend guards
  // in middleware/auth.ts; the backend is the real wall, this layer exists so a
  // user sees /forbidden instead of a broken page.
  const redirect = guardRoute(to.path, auth.user?.role ?? null);
  if (redirect) return navigateTo(redirect);
});
