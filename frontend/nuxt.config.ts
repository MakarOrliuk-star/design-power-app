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
      link: [
        // m∿k logo favicon (SVG, crisp at any tab size); .ico stays as fallback.
        { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
        { rel: "alternate icon", href: "/favicon.ico" },
        { rel: "preconnect", href: "https://fonts.googleapis.com" },
        { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" },
        {
          rel: "stylesheet",
          href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap",
        },
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
