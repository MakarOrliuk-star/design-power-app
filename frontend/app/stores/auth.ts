import { defineStore } from "pinia";

export interface AuthUser {
  id: string;
  email: string;
  name?: string | null;
  avatarUrl?: string | null;
  role: "ADMIN" | "DESIGNER" | "CRM" | "MANAGER";
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
  // Zone access — ADMIN and MANAGER reach both zones; DESIGNER/CRM are walled off
  // to their own. (MANAGER = Design + CRM, but not /admin → see isAdmin.)
  const canDesign = computed(
    () => user.value?.role === "ADMIN" || user.value?.role === "MANAGER" || user.value?.role === "DESIGNER",
  );
  const canCrm = computed(
    () => user.value?.role === "ADMIN" || user.value?.role === "MANAGER" || user.value?.role === "CRM",
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

  return { user, ready, isAuthenticated, isAdmin, isCrm, isDesigner, canDesign, canCrm, fetchMe, logout };
});
