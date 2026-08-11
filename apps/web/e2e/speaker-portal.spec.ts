// @acceptance ACC-SPEAKER
import { expect, test } from "@playwright/test";

// Both surfaces are event-scoped, so the journey addresses them the way the console
// links to them: /sessions?event=<uuid> for organizers, /portal?event=<uuid> for speakers.
const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const SESSIONS = `/sessions?event=${EVENT_ID}`;
const PORTAL = `/portal?event=${EVENT_ID}`;

test("organizer tracks accepted content and speaker completes portal work", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toBeVisible();
  await page.goto(SESSIONS);

  await expect(page.getByRole("heading", { level: 1, name: "Sessions & speakers" })).toBeVisible();
  const sessions = page.getByRole("region", { name: "Accepted sessions" });
  // Each row also carries an "Edit <title>" action cell, so match the title cell exactly.
  await expect(
    sessions.getByRole("cell", { name: "Designing the calm conference", exact: false }).first(),
  ).toBeVisible();

  await page.getByRole("button", { name: "Accept demo proposal" }).click();
  await expect(
    sessions.getByRole("cell", { name: "A newly accepted session", exact: false }).first(),
  ).toBeVisible();
  await expect(sessions.getByRole("status")).toContainText(
    "Accepted proposal linked as a session.",
  );

  // The editor is an inline disclosure on the row, so only the expanded session's
  // fields are in the accessibility tree at any one time.
  await page.getByRole("button", { name: "Edit A newly accepted session" }).click();
  await expect(page.getByLabel("Session title")).toHaveValue("A newly accepted session");
  await page.getByLabel("Session title").fill("Organizer-managed session");
  await page.getByLabel("Publication readiness").selectOption("ready");
  await page.getByRole("button", { name: "Save session" }).click();
  await expect(sessions.getByRole("cell", { name: "Organizer-managed session" })).toBeVisible();
  await expect(page.getByLabel("Session title")).toHaveValue("Organizer-managed session");
  await page.getByRole("button", { name: "Close editor" }).click();
  await expect(page.getByRole("tab", { name: "Ready 1" })).toBeVisible();

  // Tasks and messages are addressed to the speaker the organizer picks, not to
  // whichever profile happens to be first in the workspace payload.
  const followUp = page.getByRole("region", { name: "Speaker follow-up" });
  await followUp.getByLabel("Speaker").selectOption({ label: "Sam Speaker — Greenroom Labs" });
  await followUp.getByLabel("Request a task").fill("Upload final presentation");
  await followUp.getByLabel("Due date").fill("2026-09-01");
  await followUp.getByRole("button", { name: "Request presentation asset" }).click();
  await expect(followUp.getByRole("status")).toContainText(
    "Requested “Upload final presentation” from Sam Speaker.",
  );

  await followUp.getByLabel("Record a communication").fill("Speaker preparation reminder sent");
  await followUp.getByRole("button", { name: "Record communication" }).click();
  await expect(followUp.getByRole("status")).toContainText("Logged a message to Sam Speaker.");
  await expect(
    page
      .getByRole("region", { name: "Communication history" })
      .getByText("Speaker preparation reminder sent"),
  ).toBeVisible();

  // ---- speaker portal ----
  await page.getByRole("combobox", { name: "Demo identity" }).selectOption("speaker");
  await expect(page.getByRole("heading", { level: 1, name: "Speaker portal" })).toBeVisible();
  await page.goto(PORTAL);

  // Seeded work plus the task the organizer just requested; the count reads as a
  // sentence, so the singular form has to be correct on the last one.
  await expect(page.getByRole("heading", { name: "3 tasks to complete" })).toBeVisible();
  await page
    .getByRole("button", { name: /^Mark complete/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "2 tasks to complete" })).toBeVisible();
  await page
    .getByRole("button", { name: /^Mark complete/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "1 task to complete" })).toBeVisible();
  await page
    .getByRole("button", { name: /^Mark complete/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "You’re all caught up" })).toBeVisible();

  const profile = page.getByRole("region", { name: "Your public profile" });
  await profile.getByLabel("Bio").fill("Speaker-managed public biography.");
  await profile.getByRole("button", { name: "Save profile" }).click();
  await expect(profile.getByRole("status")).toContainText("Profile saved.");
  // The form is controlled and re-seeded from the API, so a reload shows the stored value.
  await page.reload();
  await expect(page.getByLabel("Bio")).toHaveValue("Speaker-managed public biography.");

  const uploads = page.getByRole("region", { name: "Private uploads" });
  await uploads
    .getByLabel("Speaker asset")
    .setInputFiles({ name: "headshot.png", mimeType: "image/png", buffer: Buffer.from([1, 2, 3]) });
  await uploads.getByRole("button", { name: "Upload asset" }).click();
  await expect(uploads.getByRole("status")).toContainText("headshot.png uploaded privately.");
  await expect(uploads.getByText("Private", { exact: true })).toBeVisible();

  // Only an organizer can clear a private upload for publication. Switching identity off
  // the speaker portal lands on the organizer's own home, since /portal is not a route an
  // organizer can reach; navigate to the sessions workspace from there.
  await page.getByRole("combobox", { name: "Demo identity" }).selectOption("organizer");
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await page.goto(SESSIONS);
  await expect(page.getByRole("heading", { level: 1, name: "Sessions & speakers" })).toBeVisible();
  const assets = page.getByRole("region", { name: "Speaker assets" });
  // The publish control repeats the filename in its accessible name, so match the cell
  // that names the file and its content type.
  await expect(assets.getByRole("cell", { name: "headshot.png image/png" })).toBeVisible();
  await assets.getByRole("button", { name: /^Mark publishable/ }).click();
  // The spent control stays in place so keyboard focus survives the round trip.
  await expect(assets.getByRole("button", { name: /^Publishable/ })).toHaveAttribute(
    "aria-disabled",
    "true",
  );

  await page.getByRole("combobox", { name: "Demo identity" }).selectOption("speaker");
  await expect(page.getByRole("heading", { level: 1, name: "Speaker portal" })).toBeVisible();
  await page.goto(PORTAL);
  const calendar = page.getByRole("link", { name: "Download calendar (.ics)" });
  await expect(calendar).toBeVisible();
  const download = page.waitForEvent("download");
  await calendar.click();
  expect((await download).suggestedFilename()).toBe("greenroom-sessions.ics");
});

test("reviewers cannot call the private content workspace", async ({ request }) => {
  const session = await request.post("/api/demo-session", { data: { persona: "reviewer" } });
  expect(session.ok()).toBeTruthy();
  const response = await request.get(`/api/events/${EVENT_ID}/content`);
  expect(response.status()).toBe(403);
});
