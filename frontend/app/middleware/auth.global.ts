const PUBLIC_PATHS = new Set(["/login"]);

export default defineNuxtRouteMiddleware(async (to) => {
  const auth = useAuthStore();
  if (!auth.ready) await auth.fetchMe();

  const isPublic = PUBLIC_PATHS.has(to.path);

  if (!auth.isAuthenticated && !isPublic) {
    return navigateTo("/login");
  }
  // /login doubles as the Design/CRM portal — authenticated users may visit it
  // to switch zones, so there is no redirect away from it.
  if (to.path.startsWith("/admin") && !auth.isAdmin) {
    return navigateTo("/");
  }
});
