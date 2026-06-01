const PUBLIC_PATHS = new Set(["/login"]);

export default defineNuxtRouteMiddleware(async (to) => {
  const auth = useAuthStore();
  if (!auth.ready) await auth.fetchMe();

  const isPublic = PUBLIC_PATHS.has(to.path);

  if (!auth.isAuthenticated && !isPublic) {
    return navigateTo("/login");
  }
  if (auth.isAuthenticated && to.path === "/login") {
    return navigateTo("/");
  }
  if (to.path.startsWith("/admin") && !auth.isAdmin) {
    return navigateTo("/");
  }
});
