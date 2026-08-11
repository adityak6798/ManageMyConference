import { defineConfig } from "@playwright/test";
import { resolveWorktreeEnvironment } from "../../tools/worktree-env.mjs";

// Ports and artifact directories are derived from this checkout rather than defaulted, so two
// worktrees can run the suite at once without either being told which ports are free
// (`GAP-004`). `GREENROOM_API_PORT` / `GREENROOM_WEB_PORT` still override both.
const environment = resolveWorktreeEnvironment();
const { apiPort, webPort } = environment;

export default defineConfig({
  testDir: "./e2e",
  // Runs before any spec and aborts the run when a server on either port belongs to another
  // checkout. `reuseExistingServer` below is what makes that possible in the first place.
  globalSetup: "./e2e/global-setup.ts",
  outputDir: environment.playwrightOutputDir,
  reporter: [["html", { outputFolder: environment.playwrightReportDir, open: "never" }]],
  // The acceptance journeys intentionally share and mutate one deterministic local D1 fixture.
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      // The port is passed as an environment variable rather than a shell prefix so that
      // `reset` and `dev` resolve the *same* instance state directory. A prefix binds only to
      // the command it precedes, which would have reset one database and served another.
      command: "npm run setup:local && npm run reset && npm run dev --workspace @greenroom/api",
      cwd: "../..",
      env: { GREENROOM_API_PORT: String(apiPort) },
      url: `http://127.0.0.1:${apiPort}/health`,
      reuseExistingServer: !process.env.CI,
    },
    {
      // Host and port both come from vite.config.ts, which resolves them the same way this
      // file does; passing either again on the command line is how they last drifted apart.
      command: "npm run dev --workspace @greenroom/web",
      cwd: "../..",
      env: { GREENROOM_WEB_PORT: String(webPort), GREENROOM_API_PORT: String(apiPort) },
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
