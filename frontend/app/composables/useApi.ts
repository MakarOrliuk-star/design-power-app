/**
 * Backend API client: prefixes the configured base URL and sends the session
 * cookie cross-origin (credentials: include). Use inside components/stores.
 */
export function useApi() {
  const config = useRuntimeConfig();
  return $fetch.create({
    baseURL: config.public.apiBase,
    credentials: "include",
  });
}
