// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  devtools: { enabled: true },

  // Internal authed dashboard — render client-side so the httpOnly session cookie
  // (set by the backend on :3001) drives auth without SSR cookie-forwarding.
  ssr: false,

  modules: ["@pinia/nuxt"],

  css: ["~/assets/css/main.css"],

  app: {
    head: {
      title: "Design Power",
      htmlAttrs: { lang: "ru" },
      meta: [
        { charset: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
      ],
    },
  },

  runtimeConfig: {
    public: {
      // Backend base URL — override with NUXT_PUBLIC_API_BASE in prod (Railway).
      apiBase: "http://localhost:3001",
    },
  },
});
