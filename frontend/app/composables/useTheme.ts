import { ref } from "vue";

// Light/dark theme (R8). The choice is applied to <html data-theme> and persisted
// in localStorage; a module-level ref keeps it shared across components.
export type Theme = "light" | "dark";

const STORAGE_KEY = "dp-theme";
const theme = ref<Theme>("light");

export function useTheme() {
  function apply(t: Theme) {
    theme.value = t;
    if (import.meta.client) {
      document.documentElement.dataset.theme = t;
      try {
        localStorage.setItem(STORAGE_KEY, t);
      } catch {
        /* private mode / storage disabled — ignore */
      }
    }
  }

  function toggle() {
    apply(theme.value === "dark" ? "light" : "dark");
  }

  /** Read the saved choice (or OS preference) and apply it. Client-only. */
  function init() {
    if (!import.meta.client) return;
    let saved: Theme | null = null;
    try {
      saved = localStorage.getItem(STORAGE_KEY) as Theme | null;
    } catch {
      /* ignore */
    }
    const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
    apply(saved ?? (prefersDark ? "dark" : "light"));
  }

  return { theme, apply, toggle, init };
}
