import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { exclude: ["test/*.integration.test.ts", "node_modules/**", "dist/**"] },
});
