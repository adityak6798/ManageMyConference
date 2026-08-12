import { defineConfig } from "@playwright/test";
import { resolveWorktreeEnvironment } from "../../tools/worktree-env.mjs";

const environment = resolveWorktreeEnvironment();

export default defineConfig({
  name: "quality",
  testDir: "./e2e",
  testMatch: "lifecycle-demo.spec.ts",
  globalSetup: "./e2e/quality-global-setup.ts",
  outputDir: environment.playwrightOutputDir,
  reporter: [["html", { outputFolder: environment.playwrightReportDir, open: "never" }]],
  workers: 1,
  use: {
    // The Worker serves apps/web/dist, so this suite measures the deployable artifact rather
    // than Vite's module graph. It also keeps API and browser traffic on one production-like
    // origin instead of relying on Vite's development proxy.
    baseURL: `http://127.0.0.1:${environment.apiPort}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      "npm run setup:local && npm run build --workspace @greenroom/web && npm run reset && npm run dev --workspace @greenroom/api",
    cwd: "../..",
    env: { GREENROOM_API_PORT: String(environment.apiPort) },
    url: `http://127.0.0.1:${environment.apiPort}/health`,
    reuseExistingServer: false,
  },
});
