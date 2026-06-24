// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  devtools: { enabled: true },

  // Internal authed dashboard — render client-side so the httpOnly session cookie
  // (set by the backend) drives auth without SSR cookie-forwarding.
  ssr: false,

  modules: ["@pinia/nuxt"],

  css: ["~/assets/css/main.css"],

  // Same-origin proxy: the browser talks ONLY to the frontend origin, and Nitro
  // forwards /auth + /api to the backend server-side (see server/routes). This
  // keeps the session cookie first-party — the frontend and backend live on
  // different *.up.railway.app subdomains (a public suffix → cross-site), so a
  // direct cross-origin cookie is third-party and gets blocked on mobile.
  // NB: we use a custom proxy (not Nitro routeRules) because routeRules follows
  // 3xx redirects server-side and swallows Set-Cookie, which breaks OAuth.
  // Set NUXT_BACKEND_ORIGIN on the frontend Railway service to the backend URL.

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
        // ?v=2 busts the old green icon cached by browsers / pinned tabs.
        { rel: "icon", type: "image/svg+xml", href: "/favicon.svg?v=2" },
        { rel: "alternate icon", href: "/favicon.ico?v=2" },
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
      // Empty = same-origin: useApi() and the login redirect use relative URLs
      // (/auth, /api), which Nitro proxies to the backend (see routeRules above).
      // Do NOT set NUXT_PUBLIC_API_BASE in prod — that would point the browser
      // straight at the cross-site backend and reintroduce the cookie problem.
      apiBase: "",
      googleDriveUrl: "",
    },
  },
});


//closing comment 1
