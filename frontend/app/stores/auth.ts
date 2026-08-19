import { defineStore } from "pinia";
import {
  canAdminPanel as roleCanAdminPanel,
  canCreateStyles as roleCanCreateStyles,
  canEnterZone,
  type AppRole,
} from "~/utils/zones";

export interface AuthUser {
  id: string;
  email: string;
  name?: string | null;
  avatarUrl?: string | null;
  role: AppRole;
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
  const canAdminPanel = computed(() => roleCanAdminPanel(user.value?.role));
  // Zone access. The role lists live in utils/zones.ts — shared with the route
  // guard so the two can't drift — and mirror the backend requireZone /
  // requireGameZone guards. ADMIN and MANAGER reach all three zones; DESIGNER
  // reaches Design + Game; CRM only CRM; GAME_MANAGER only Game (TASK
  // game-manager, Q2).
  const canDesign = computed(() => canEnterZone(user.value?.role, "design"));
  const canCrm = computed(() => canEnterZone(user.value?.role, "crm"));
  const canGame = computed(() => canEnterZone(user.value?.role, "game"));
  const isGameManager = computed(() => user.value?.role === "GAME_MANAGER");
  const isSuperDesigner = computed(() => user.value?.role === "SUPER_DESIGNER");
  const isCrmSuper = computed(() => user.value?.role === "CRM_SUPER");
  // Image Bundles service (TASK crm-bundle, D4): CRM_SUPER plus ADMIN/MANAGER —
  // mirrors the backend requireCrmSuper guard. Plain CRM users never see it.
  const canBundles = computed(
    () =>
      user.value?.role === "CRM_SUPER" ||
      user.value?.role === "ADMIN" ||
      user.value?.role === "MANAGER",
  );
  // The Create a New Style / Library surface (TASK super-designer): visible to
  // SUPER_DESIGNER plus ADMIN/MANAGER (Phase 0 decision) — mirrors the backend
  // requireSuperDesigner guard.
  const canCreateStyles = computed(() => roleCanCreateStyles(user.value?.role));

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
    isCrmSuper,
    isGameManager,
    canGame,
    canBundles,
    canCreateStyles,
    canAdminPanel,
    canDesign,
    canCrm,
    fetchMe,
    logout,
  };
});
