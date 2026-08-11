import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/*.integration.test.ts"],
    testTimeout: 40_000,
    hookTimeout: 40_000,
  },
});
