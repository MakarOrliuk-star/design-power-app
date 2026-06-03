import { defineConfig } from "vitest/config";

// Backend tests live in ./tests (outside src/), so the Railway build
// (`prisma generate && tsc` over src/**) never compiles them. `extensionAlias`
// lets Vitest resolve the source's NodeNext-style ".js" import specifiers to the
// real ".ts" files, which also makes `vi.mock("../src/lib/prisma.js")` match.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    extensionAlias: {
      ".js": [".ts", ".js"],
    },
  },
});
