import { defineStore } from "pinia";

/**
 * CRM favorites. Mirrors the Item-style favorites pattern in generator.ts:
 * a flat list of service keys, optimistic toggle, revert on failure. Backed by
 * /api/crm/favorites (CrmServiceFavorite table). Service keys are a static
 * front-end list — only services with real logic are favoritable.
 */
export const useCrmStore = defineStore("crm", () => {
  const favorites = ref<string[]>([]);
  const ready = ref(false);

  async function fetchFavorites() {
    try {
      const res = await useApi()<{ favorites: string[] }>("/api/crm/favorites");
      favorites.value = res.favorites;
    } catch {
      favorites.value = [];
    } finally {
      ready.value = true;
    }
  }

  function isFavorite(key: string): boolean {
    return favorites.value.includes(key);
  }

  async function toggleFavorite(key: string) {
    const wasFav = isFavorite(key);
    favorites.value = wasFav
      ? favorites.value.filter((k) => k !== key)
      : [...favorites.value, key];
    try {
      await useApi()(`/api/crm/favorites/${encodeURIComponent(key)}`, {
        method: wasFav ? "DELETE" : "POST",
      });
    } catch {
      favorites.value = wasFav
        ? [...favorites.value, key]
        : favorites.value.filter((k) => k !== key);
    }
  }

  return { favorites, ready, fetchFavorites, isFavorite, toggleFavorite };
});
