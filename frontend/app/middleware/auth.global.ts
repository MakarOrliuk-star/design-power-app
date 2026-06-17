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
  if (isPublic) return;

  // Neutral "no access" interstitial — reachable by any authenticated role,
  // exempt from the zone walls below (otherwise it would bounce itself).
  if (to.path === "/forbidden") return;

  // Access violations land on /forbidden (a calm message + a button back to the
  // user's own zone) instead of a silent redirect.
  if (to.path.startsWith("/admin") && !auth.isAdmin) {
    return navigateTo("/forbidden");
  }

  // Zone walls: CRM-only users can't reach the Design app, and Designer-only
  // users can't reach the CRM zone. ADMIN passes both (canDesign/canCrm true).
  const isCrmRoute = to.path.startsWith("/crm");
  if (isCrmRoute && !auth.canCrm) {
    return navigateTo("/forbidden");
  }
  if (!isCrmRoute && !auth.canDesign) {
    return navigateTo("/forbidden");
  }
});
