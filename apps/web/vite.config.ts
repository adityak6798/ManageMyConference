/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    // Bind IPv4 explicitly. Vite's default binds ::1 only, which makes the documented
    // http://127.0.0.1:5173 start URL connection-refused; browsers fall back to IPv4 for
    // "localhost", so this address works for both spellings.
    host: "127.0.0.1",
    proxy: { "/api": `http://127.0.0.1:${process.env.GREENROOM_API_PORT ?? "8787"}` },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./test/setup.ts",
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
});
