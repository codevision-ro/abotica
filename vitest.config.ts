import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{apps,packages}/*/{src,scripts}/**/*.test.ts"],
    environment: "node",
  },
});
