import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "test-results",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "npm run dev --workspace @greenroom/api",
      cwd: "../..",
      url: "http://127.0.0.1:8787/health",
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "npm run dev --workspace @greenroom/web -- --host 127.0.0.1 --port 4173",
      cwd: "../..",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: !process.env.CI,
    },
  ],
});
