/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": `http://localhost:${process.env.GREENROOM_API_PORT ?? "8787"}` },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./test/setup.ts",
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
});
