// @spec ENG-DEV-001 ACC-DEMO-SMOKE
/**
 * Deterministic presentation captures for the marketing page.
 *
 * Run from the repository root:
 *   node apps/web/e2e/capture-product.mjs
 *
 * The script rebuilds the deployable web bundle, resets the isolated D1 fixture, starts the local
 * Worker, enters through the public demo door, and writes only viewport screenshots. It creates a
 * new browser context and never serializes cookies, localStorage, credentials, traces, or fixture
 * state. Expected viewport: 1440 × 900, Chromium, default color scheme and motion settings.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "@playwright/test";
import { resolveWorktreeEnvironment } from "../../../tools/worktree-env.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const environment = resolveWorktreeEnvironment(process.env, root);
const baseURL = `http://127.0.0.1:${environment.apiPort}`;
const output = path.join(root, "apps/web/public/product-captures");
const event = "00000000-0000-4000-8000-000000000001";

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    // ERROR-INTENT: connection refusals are the expected startup state and are retried until the
    // bounded deadline below; the final failure is raised with the endpoint that never answered.
    const response = await fetch(`${baseURL}/health`).catch(() => null);
    if (response?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Local capture server did not become ready at ${baseURL}.`);
}

run("npm", ["run", "setup:local"]);
run("npm", ["run", "build", "--workspace", "@greenroom/web"]);
run("npm", ["run", "reset"]);
await mkdir(output, { recursive: true });

const server = spawn("node", ["tools/browser-api-server.mjs"], {
  cwd: root,
  env: { ...process.env, GREENROOM_API_PORT: String(environment.apiPort) },
  stdio: "inherit",
});

try {
  await waitForServer();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(baseURL);
    await page.getByRole("button", { name: "Continue as organizer" }).click();
    await page.getByRole("main").waitFor();
    /*
     * The four routes, as the console addresses them.
     *
     * These were `/cfp` and `/agenda`, which are the workspace paths the hubs replaced: the
     * console now redirects them, so every capture was taken mid-redirect or on the hub's first
     * tab by accident. A capture that does not name the URL it was taken at cannot be checked
     * against the product, and the landing page prints these routes under each picture.
     */
    const captures = [
      ["overview", `/?event=${event}`],
      /*
       * The submissions queue, not the form builder at `?tab=forms`.
       *
       * Program opens here, and this is the only surface that shows the fixture's routed
       * proposals, their reviewers per round, their scores and their decisions — the review work
       * the landing copy claims two paragraphs above the picture. The form builder capture proved
       * none of it: the fixture's form has no routing rules, so the pane the caption pointed at
       * read "Routing 0", under a banner warning that the form has no public address.
       */
      ["submissions", `/program?tab=submissions&event=${event}`],
      // The week view rather than `view=room`: the fixture's two sessions run on different days,
      // so the room grid put one card beside an empty "Workshop lab" column and left the second
      // session out of frame entirely — an emptier board than the product actually has.
      ["agenda", `/schedule?tab=agenda&event=${event}&view=week`],
      ["public-event", "/events/greenroom-demo-summit"],
    ];
    for (const [name, route] of captures) {
      await page.goto(`${baseURL}${route}`);
      await page.waitForFunction(() => {
        const text = document.body.innerText;
        return (
          document.querySelector("h1") !== null &&
          // Every loading placeholder the product draws, by the prefix they share: the single
          // `.skeleton` bar became `.skeleton-rows`, `-stats`, `-form` and `-page`, so matching
          // the exact old class name silently stopped waiting for anything at all.
          !document.querySelector('[class*="skeleton"]') &&
          !document.querySelector(".landing-boot") &&
          !text.includes("Loading your workspace") &&
          !text.includes("Loading Greenroom") &&
          // Every picture in frame has actually arrived. The public event page draws speaker
          // headshots with `loading="lazy"`, so the shot fired while the first speaker's card
          // still held an empty circle: the capture showed a blank avatar the product never
          // renders. Images outside the viewport are not in a viewport screenshot and are never
          // waited for, because a lazy image below the fold never loads and would hang the wait.
          [...document.images].every((image) => {
            const box = image.getBoundingClientRect();
            const outOfFrame = box.bottom <= 0 || box.top >= window.innerHeight;
            return outOfFrame || (image.complete && image.naturalWidth > 0);
          })
        );
      });
      await page.screenshot({ path: path.join(output, `${name}.webp`), type: "webp", quality: 86 });
    }
    await context.close();
  } finally {
    await browser.close();
  }
} finally {
  server.kill("SIGTERM");
}
