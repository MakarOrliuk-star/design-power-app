import { defineStore } from "pinia";

export interface AuthUser {
  id: string;
  email: string;
  name?: string | null;
  avatarUrl?: string | null;
  role: "ADMIN" | "DESIGNER" | "CRM" | "MANAGER" | "SUPER_DESIGNER";
}

/**
 * Session state. Populated from the backend /auth/me endpoint (Google OAuth +
 * allowlist gate). The session itself lives in an httpOnly cookie on the backend.
 */
export const useAuthStore = defineStore("auth", () => {
  const user = ref<AuthUser | null>(null);
  const ready = ref(false);

  const isAuthenticated = computed(() => user.value !== null);
  const isAdmin = computed(() => user.value?.role === "ADMIN");
  const isCrm = computed(() => user.value?.role === "CRM");
  const isDesigner = computed(() => user.value?.role === "DESIGNER");
  const isManager = computed(() => user.value?.role === "MANAGER");
  // /admin access: ADMIN sees everything; MANAGER sees ONLY the Tournaments
  // section there (the other panels stay ADMIN-only, mirrored by the backend
  // guards requireAdmin vs requireAdminOrManager).
  const canAdminPanel = computed(
    () => user.value?.role === "ADMIN" || user.value?.role === "MANAGER",
  );
  // Zone access — ADMIN and MANAGER reach both zones; DESIGNER/CRM are walled off
  // to their own. (MANAGER = Design + CRM, but not /admin → see isAdmin.)
  const canDesign = computed(
    () =>
      user.value?.role === "ADMIN" ||
      user.value?.role === "MANAGER" ||
      user.value?.role === "DESIGNER" ||
      user.value?.role === "SUPER_DESIGNER",
  );
  const canCrm = computed(
    () => user.value?.role === "ADMIN" || user.value?.role === "MANAGER" || user.value?.role === "CRM",
  );
  const isSuperDesigner = computed(() => user.value?.role === "SUPER_DESIGNER");
  // The Create a New Style / Library surface (TASK super-designer): visible to
  // SUPER_DESIGNER plus ADMIN/MANAGER (Phase 0 decision) — mirrors the backend
  // requireSuperDesigner guard.
  const canCreateStyles = computed(
    () =>
      user.value?.role === "SUPER_DESIGNER" ||
      user.value?.role === "ADMIN" ||
      user.value?.role === "MANAGER",
  );

  async function fetchMe() {
    try {
      const res = await useApi()<{ user: AuthUser }>("/auth/me");
      user.value = res.user;
    } catch {
      user.value = null;
    } finally {
      ready.value = true;
    }
  }

  async function logout() {
    try {
      await useApi()("/auth/logout", { method: "POST" });
    } finally {
      user.value = null;
    }
  }

  return {
    user,
    ready,
    isAuthenticated,
    isAdmin,
    isCrm,
    isDesigner,
    isManager,
    isSuperDesigner,
    canCreateStyles,
    canAdminPanel,
    canDesign,
    canCrm,
    fetchMe,
    logout,
  };
});
