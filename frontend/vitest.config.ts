import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Frontend unit tests run in plain Vitest (no Nuxt runtime). The Result page's
// logic was extracted into app/composables/useResult.ts precisely so it can be
// tested with just Vue's reactivity. The "~" alias mirrors Nuxt's srcDir (app/).
export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./app", import.meta.url)),
      "@": fileURLToPath(new URL("./app", import.meta.url)),
    },
  },
  test: {
    environment: "happy-dom",
    include: ["tests/**/*.test.ts"],
  },
});
