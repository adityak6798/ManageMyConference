// @acceptance ACC-OPS ACC-SPEAKER
// This suite is deliberately last: its real scheduled tick and durable embed are irreversible on
// Playwright's shared fixture, so earlier journeys must observe the reset state they own.
/** Browser evidence for GAP-031's highest-risk surfaces. @spec PRD-IAM-002 PRD-OPS-004 */
import { readFile } from "node:fs/promises";
import { resolveWorktreeEnvironment } from "../../../tools/worktree-env.mjs";
import { expect, test } from "./fixtures";

const DEMO_EVENT = "00000000-0000-4000-8000-000000000001";
const WORKSHOP_EVENT = "00000000-0000-4000-8000-000000000002";
const WORKSHOP_SPEAKER = "10000000-0000-4000-8000-000000000003";
const API_ORIGIN = `http://127.0.0.1:${resolveWorktreeEnvironment().apiPort}`;

test("a scoped role receives hidden fields absent on the wire and cannot write a locked field", async ({
  page,
}) => {
  const login = await page.request.post("/api/demo-session", { data: { persona: "reviewer" } });
  expect(login.ok(), await login.text()).toBe(true);

  const response = await page.request.get(`/api/events/${WORKSHOP_EVENT}/content`);
  expect(response.ok(), await response.text()).toBe(true);
  const workspace = (await response.json()) as {
    speakers: Record<string, unknown>[];
    sessions: Record<string, unknown>[];
  };
  expect(workspace.speakers[0]).toMatchObject({ name: "Jordan Bell", bio: expect.any(String) });
  expect(workspace.speakers[0]).not.toHaveProperty("email");
  expect(workspace.sessions[0]).not.toHaveProperty("abstract");

  const locked = await page.request.patch(`/api/speaker-profiles/${WORKSHOP_SPEAKER}`, {
    data: {
      name: "Jordan Bell",
      bio: "This role must not change the biography.",
      pronouns: "she/her",
      organization: "Northwind Access",
    },
  });
  expect(locked.status(), await locked.text()).toBe(403);
  expect(await locked.json()).toMatchObject({
    error: { code: "FORBIDDEN", fieldErrors: { bio: [expect.stringContaining("cannot change")] } },
  });

  const allowedProfile = await page.request.patch(`/api/speaker-profiles/${WORKSHOP_SPEAKER}`, {
    data: { name: "Jordan Bell, Workshop Operator" },
  });
  expect(allowedProfile.ok(), await allowedProfile.text()).toBe(true);

  const sessionId = String(workspace.sessions[0]?.id);
  const allowedSession = await page.request.patch(`/api/content-sessions/${sessionId}`, {
    data: { title: "Operating the workshop room safely" },
  });
  expect(allowedSession.ok(), await allowedSession.text()).toBe(true);

  // The same scoped grant is a usable console role, not an API-only permission nobody can reach.
  await page.goto(`/sessions?event=${WORKSHOP_EVENT}`);
  await expect(page.getByRole("heading", { level: 1, name: "Sessions & speakers" })).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "Operating the workshop room safely" }),
  ).toBeVisible();
  await expect(page.getByText("jordan.workshop@example.test")).toHaveCount(0);
});

test("a report exports every format and its anonymous share stops at revocation", async ({
  page,
  browser,
}) => {
  expect(
    (await page.request.post("/api/demo-session", { data: { persona: "organizer" } })).ok(),
  ).toBe(true);
  await page.goto(`/reports?event=${DEMO_EVENT}`);
  await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();

  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Result" })).toBeVisible();
  const reportName = `Closure evidence ${Date.now()}`;
  await page.getByLabel("Report name").fill(reportName);
  await page.getByRole("button", { name: "Save report" }).click();
  await expect(page.getByRole("status")).toContainText("Report saved");
  const catalogueResponse = await page.request.get(`/api/events/${DEMO_EVENT}/reports`);
  expect(catalogueResponse.ok(), await catalogueResponse.text()).toBe(true);
  const report = (
    (await catalogueResponse.json()) as { reports: { id: string; name: string }[] }
  ).reports.find((candidate) => candidate.name === reportName);
  expect(report).toBeTruthy();

  for (const format of ["CSV", "XLSX", "JSON"] as const) {
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: `Download ${format}` }).click();
    const completed = await download;
    const path = await completed.path();
    expect(path).toBeTruthy();
    const bytes = await readFile(path as string);
    expect(bytes.byteLength).toBeGreaterThan(20);
    if (format === "CSV") expect(bytes.toString("utf8")).toContain("Title");
    if (format === "JSON") expect(JSON.parse(bytes.toString("utf8"))).toHaveProperty("rows");
    if (format === "XLSX") expect(bytes.subarray(0, 2).toString("utf8")).toBe("PK");
  }

  // The real scheduled entrypoint runs, but this local fixture deliberately has no mail provider.
  // Its truthful outcome is a visible failed run, not a claimed send; the service unit test owns
  // the successful provider boundary and this journey owns the deployed composition's fail-safe.
  const scheduled = await page.request.post(
    `/api/events/${DEMO_EVENT}/reports/${report?.id}/schedules`,
    {
      data: {
        cadence: "daily",
        minuteOfDay: 0,
        timezone: "UTC",
        recipients: ["report-evidence@example.test"],
        linkLifetimeHours: 1,
      },
    },
  );
  expect(scheduled.ok(), await scheduled.text()).toBe(true);
  const scheduleId = ((await scheduled.json()) as { schedule: { id: string } }).schedule.id;
  const tick = await page.request.post(`${API_ORIGIN}/cdn-cgi/handler/scheduled`);
  expect(tick.ok(), await tick.text()).toBe(true);
  const schedules = await page.request.get(
    `/api/events/${DEMO_EVENT}/reports/${report?.id}/schedules`,
  );
  expect(schedules.ok(), await schedules.text()).toBe(true);
  expect(await schedules.json()).toMatchObject({
    schedules: [
      {
        schedule: { id: scheduleId },
        runs: [
          {
            outcome: "failed",
            detail: "Scheduled report delivery is not configured on this deployment",
          },
        ],
      },
    ],
  });
  expect(
    (
      await page.request.delete(
        `/api/events/${DEMO_EVENT}/reports/${report?.id}/schedules/${scheduleId}`,
      )
    ).ok(),
  ).toBe(true);

  await page.getByRole("button", { name: "Create a 72-hour link" }).click();
  const issued = page.getByText("This link is shown once:");
  await expect(issued).toBeVisible();
  const url = (await issued.locator("code").innerText()).trim();
  expect(url).toMatch(/\/reports\/[A-Za-z0-9_-]+$/);

  const visitor = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const shared = await visitor.newPage();
  // The service returns the deployment's canonical public base. This isolated fixture serves the
  // same path locally, so retain the capability token while keeping the evidence on this build.
  await shared.goto(new URL(url).pathname);
  await expect(shared.getByRole("heading", { level: 1, name: reportName })).toBeVisible();
  await expect(shared.getByRole("table")).toBeVisible();

  await page.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByRole("status")).toContainText("Share link revoked");
  await shared.reload();
  await expect(shared.getByText("That share link is not available.")).toBeVisible();
  await visitor.close();
});

test("an organization portal publishes, records consent, and disappears when withdrawn", async ({
  page,
  browser,
}) => {
  expect(
    (await page.request.post("/api/demo-session", { data: { persona: "organizer" } })).ok(),
  ).toBe(true);
  await page.goto(`/sites?event=${DEMO_EVENT}`);
  await expect(page.getByRole("heading", { level: 1, name: "Portals" })).toBeVisible();
  await page.getByRole("button", { name: "New portal" }).click();
  const stamp = Date.now();
  const name = `Closure portal ${stamp}`;
  const slug = `closure-${stamp}`;
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Public address").fill(slug);
  await page.getByLabel("Landing heading").fill("One doorway for the community");
  await page.getByRole("button", { name: "Create portal" }).click();
  await expect(page.getByRole("status")).toContainText("Site created");

  await page.getByLabel("New notice version").fill("We use this address only for registration.");
  await page.getByRole("button", { name: "Publish notice version" }).click();
  await expect(page.getByRole("status")).toContainText("Privacy notice published");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Portal published");

  const visitor = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const publicPage = await visitor.newPage();
  await publicPage.goto(`/sites/${slug}`);
  await expect(
    publicPage.getByRole("heading", { level: 1, name: "One doorway for the community" }),
  ).toBeVisible();
  await publicPage.getByLabel("Name").fill("Riley Registrant");
  await publicPage.getByLabel("Email").fill(`riley-${stamp}@example.test`);
  await publicPage.getByLabel(/I accept privacy notice version 1/).check();
  await publicPage.getByRole("button", { name: "Register", exact: true }).click();
  await expect(publicPage.getByRole("status")).toContainText("privacy notice version 1");

  await page.getByRole("button", { name: "Show who consented" }).click();
  await expect(page.getByRole("cell", { name: `riley-${stamp}@example.test` })).toBeVisible();
  await page.getByRole("button", { name: "Unpublish" }).click();
  await expect(page.getByRole("status")).toContainText("Portal withdrawn");
  await publicPage.reload();
  await expect(
    publicPage.getByRole("heading", { level: 1, name: "Portal unavailable" }),
  ).toBeVisible();
  await visitor.close();
});

test("a persisted embed is issued, served anonymously, and withdrawn independently", async ({
  page,
}) => {
  expect(
    (await page.request.post("/api/demo-session", { data: { persona: "organizer" } })).ok(),
  ).toBe(true);
  await page.goto(`/publishing?event=${DEMO_EVENT}`);
  const issuedHeading = page.getByRole("heading", { name: "Issued embeds" });
  const issued = page.locator("section.card").filter({ has: issuedHeading });
  const name = `Closure embed ${Date.now()}`;
  await issued.getByLabel("Name").fill(name);
  await issued.getByLabel("Output").selectOption("json");
  await issued.getByRole("button", { name: "Issue embed" }).click();
  await expect(issued.getByRole("status")).toContainText("Embed issued");
  const url = (
    await issued.getByText("This address is shown once").locator("code").innerText()
  ).trim();
  const anonymous = await page.request.get(new URL(url).pathname);
  expect(anonymous.ok(), await anonymous.text()).toBe(true);
  expect(anonymous.headers()["content-type"]).toContain("application/json");

  await issued
    .getByRole("row", { name: new RegExp(name) })
    .getByRole("button", { name: "Withdraw" })
    .click();
  await expect(issued.getByRole("status")).toContainText(`Withdrew ${name}`);
  expect((await page.request.get(new URL(url).pathname)).status()).toBe(404);
});

test("the webhooks console exposes the deployed configuration failure without a fake lifecycle", async ({
  page,
}) => {
  expect(
    (await page.request.post("/api/demo-session", { data: { persona: "organizer" } })).ok(),
  ).toBe(true);
  await page.goto(`/integrations/webhooks?event=${DEMO_EVENT}`);
  await expect(page.getByRole("heading", { level: 1, name: "Webhooks" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Webhook delivery is not configured here" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(
    page.getByRole("heading", { name: "Webhook delivery is not configured here" }),
  ).toBeVisible();
});
