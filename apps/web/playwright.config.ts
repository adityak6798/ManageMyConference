import { defineConfig } from "@playwright/test";

const webPort = process.env.GREENROOM_WEB_PORT ?? "4173";
const apiPort = process.env.GREENROOM_API_PORT ?? "8787";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "test-results",
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: `GREENROOM_API_PORT=${apiPort} npm run dev --workspace @greenroom/api`,
      cwd: "../..",
      url: `http://127.0.0.1:${apiPort}/health`,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `GREENROOM_WEB_PORT=${webPort} npm run dev --workspace @greenroom/web -- --host 127.0.0.1`,
      cwd: "../..",
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
