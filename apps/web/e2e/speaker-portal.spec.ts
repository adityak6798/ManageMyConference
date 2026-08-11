// @acceptance ACC-SPEAKER
import { text } from "node:stream/consumers";
import { expect, type Page, test } from "@playwright/test";

// Both surfaces are event-scoped, so the journey addresses them the way the console
// links to them: /sessions?event=<uuid> for organizers, /portal?event=<uuid> for speakers.
const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const SESSIONS = `/sessions?event=${EVENT_ID}`;
const TRIAGE = `/abstracts?event=${EVENT_ID}`;
const PORTAL = `/portal?event=${EVENT_ID}`;

// The abstract this journey promotes into the programme. It is a real seeded submission
// carrying a real contact address, which is what makes it acceptable at all.
const HALLWAY = "Designing for the hallway track";
// The seeded speaker whose portal this journey works in.
const SAM = "10000000-0000-4000-8000-000000000001";
/** The onboarding checklist the seed gives Sam, and the state this journey hands back. */
const SEEDED_TASKS = ["Confirm profile details", "Upload a headshot"];

interface Workspace {
  tasks: { id: string; speakerProfileId: string; title: string; status: string }[];
}

/**
 * Put Sam's onboarding checklist back to the two open tasks the seed ships.
 *
 * Completing a task is one-way — there is no "reopen" in the product — so the portal's
 * counts would read differently on every run against a shared fixture. This closes
 * whatever is open and re-requests the seeded pair through the organizer's own route, so
 * the journey below starts from one exact state and a judge who opens the demo after a
 * run still finds a speaker with work to do.
 */
async function restoreOnboardingChecklist(page: Page) {
  // Each half of this is done by the identity the product allows to do it: only the
  // speaker may complete their own task, and only an organizer may request one.
  const become = async (persona: "organizer" | "speaker") =>
    expect((await page.request.post("/api/demo-session", { data: { persona } })).ok()).toBe(true);

  await become("organizer");
  const workspace = await page.request.get(`/api/events/${EVENT_ID}/content`);
  expect(workspace.ok(), `reading the content workspace failed: ${await workspace.text()}`).toBe(
    true,
  );
  const open = ((await workspace.json()) as Workspace).tasks.filter(
    (task) => task.speakerProfileId === SAM && task.status === "open",
  );

  if (open.length) {
    await become("speaker");
    for (const task of open)
      expect(
        (await page.request.post(`/api/events/${EVENT_ID}/tasks/${task.id}/complete`)).ok(),
        `completing ${task.title} failed`,
      ).toBe(true);
    await become("organizer");
  }

  for (const title of SEEDED_TASKS)
    expect(
      (
        await page.request.post("/api/speaker-tasks", {
          data: { profileId: SAM, title, dueAt: "2026-08-20T23:59:00.000Z" },
        })
      ).ok(),
      `requesting ${title} failed`,
    ).toBe(true);
}

test("organizer tracks accepted content and speaker completes portal work", async ({ page }) => {
  // Everything this run creates is stamped, so a second run against the same fixture
  // addresses its own rows rather than colliding with the previous run's.
  const run = Date.now();
  const requestedTask = `Upload final presentation ${run}`;
  const messageSubject = `Speaker preparation reminder ${run}`;
  const headshot = `headshot-${run}.png`;

  await page.goto("/");
  await page.getByRole("button", { name: "Continue as organizer" }).click();
  await expect(page.getByRole("combobox", { name: "Event workspace" })).toBeVisible();
  await restoreOnboardingChecklist(page);
  await page.goto(SESSIONS);

  await expect(page.getByRole("heading", { level: 1, name: "Sessions & speakers" })).toBeVisible();
  const sessions = page.getByRole("region", { name: "Accepted sessions" });
  // Each row also carries an "Edit <title>" action cell, so match the title cell exactly.
  await expect(
    sessions.getByRole("cell", { name: "Designing the calm conference", exact: false }).first(),
  ).toBeVisible();

  // Sessions are never created from this workspace: content appears here only because an
  // abstract was accepted in review, which provisions its speaker in the same request.
  // Acceptance is idempotent — a second run re-records the same decision and finds the
  // session already there — so this step survives its own re-run.
  await page.goto(TRIAGE);
  await expect(page.getByRole("heading", { level: 1, name: "Abstracts" })).toBeVisible();
  // Playwright matches accessible names by substring, and the row link, Accept and Decline
  // all contain the title, so the decision control is addressed by its own leading word.
  await page.getByRole("button", { name: `Accept ${HALLWAY}` }).click();
  const decision = page.getByRole("region", { name: "Accept this abstract" });
  await expect(decision).toContainText("links Alex Morgan (alex.morgan@example.test)");
  await decision.getByRole("button", { name: "Confirm acceptance" }).click();
  await expect(decision.getByRole("status")).toContainText(
    `“${HALLWAY}” is accepted. It is now a session in Sessions & speakers with Alex Morgan linked as its speaker.`,
  );

  await page.goto(SESSIONS);
  await expect(sessions.getByRole("cell", { name: HALLWAY, exact: false }).first()).toBeVisible();
  await expect(
    sessions.getByRole("row", { name: new RegExp(HALLWAY) }).getByText("Alex Morgan"),
  ).toBeVisible();

  // The editor is an inline disclosure on the row, so only the expanded session's
  // fields are in the accessibility tree at any one time.
  await page.getByRole("button", { name: `Edit ${HALLWAY}` }).click();
  await expect(page.getByLabel("Session title")).toHaveValue(HALLWAY);
  await page.getByLabel("Session title").fill("Organizer-managed session");
  await page.getByLabel("Publication readiness").selectOption("ready");
  await page.getByRole("button", { name: "Save session" }).click();
  await expect(sessions.getByRole("cell", { name: "Organizer-managed session" })).toBeVisible();
  await expect(page.getByLabel("Session title")).toHaveValue("Organizer-managed session");
  await page.getByRole("button", { name: "Close editor" }).click();
  await expect(page.getByRole("tab", { name: "Ready 1" })).toBeVisible();

  // Hand the session back the way acceptance created it. The edit above is the assertion;
  // leaving it applied would make the next run open an editor whose title no longer names
  // the abstract it came from, and would leave the demo carrying a placeholder title.
  await page.getByRole("button", { name: "Edit Organizer-managed session" }).click();
  await page.getByLabel("Session title").fill(HALLWAY);
  await page.getByLabel("Publication readiness").selectOption("draft");
  await page.getByRole("button", { name: "Save session" }).click();
  await expect(sessions.getByRole("cell", { name: HALLWAY, exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "Close editor" }).click();
  await expect(page.getByRole("tab", { name: "Ready 0" })).toBeVisible();

  // Tasks and messages are addressed to the speaker the organizer picks, not to
  // whichever profile happens to be first in the workspace payload.
  const followUp = page.getByRole("region", { name: "Speaker follow-up" });
  await followUp.getByLabel("Speaker").selectOption({ label: "Sam Speaker — Greenroom Labs" });
  await followUp.getByLabel("Request a task").fill(requestedTask);
  await followUp.getByLabel("Due date").fill("2026-09-01");
  await followUp.getByRole("button", { name: "Request this task" }).click();
  await expect(followUp.getByRole("status")).toContainText(
    `Requested “${requestedTask}” from Sam Speaker.`,
  );

  await followUp.getByLabel("Record a communication").fill(messageSubject);
  await followUp.getByRole("button", { name: "Record this message" }).click();
  // The announcement quotes the subject the organizer typed, so it names the record it made.
  await expect(followUp.getByRole("status")).toContainText(
    `Logged “${messageSubject}” to Sam Speaker.`,
  );
  await expect(
    page.getByRole("region", { name: "Communication history" }).getByText(messageSubject),
  ).toBeVisible();

  // ---- speaker portal ----
  await page.getByRole("combobox", { name: "Signed-in role" }).selectOption("speaker");
  await expect(page.getByRole("heading", { level: 1, name: "Speaker portal" })).toBeVisible();
  await page.goto(PORTAL);

  // The two seeded onboarding tasks plus the one the organizer just requested; the count
  // reads as a sentence, so the singular form has to be correct on the last one.
  await expect(
    page.getByRole("button", { name: new RegExp(`^Mark complete .*${requestedTask}$`) }),
  ).toBeVisible();
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
    .setInputFiles({ name: headshot, mimeType: "image/png", buffer: Buffer.from([1, 2, 3]) });
  await uploads.getByRole("button", { name: "Upload asset" }).click();
  await expect(uploads.getByRole("status")).toContainText(`${headshot} uploaded privately.`);
  await expect(uploads.getByText("Private", { exact: true }).first()).toBeVisible();

  // Only an organizer can clear a private upload for publication. Switching identity off
  // the speaker portal lands on the organizer's own home, since /portal is not a route an
  // organizer can reach; navigate to the sessions workspace from there.
  await page.getByRole("combobox", { name: "Signed-in role" }).selectOption("organizer");
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await page.goto(SESSIONS);
  await expect(page.getByRole("heading", { level: 1, name: "Sessions & speakers" })).toBeVisible();
  const assets = page.getByRole("region", { name: "Speaker assets" });
  // The publish control repeats the filename in its accessible name, so match the cell
  // that names the file and its content type.
  await expect(assets.getByRole("cell", { name: `${headshot} image/png` })).toBeVisible();
  const uploaded = assets.getByRole("row", { name: new RegExp(headshot) });
  await uploaded.getByRole("button", { name: /^Mark publishable/ }).click();
  // The spent control stays in place so keyboard focus survives the round trip. The seed
  // already ships one publishable headshot and every earlier run left another, so the
  // assertion is scoped to the row for the file this run uploaded.
  await expect(uploaded.getByRole("button", { name: /^Publishable/ })).toHaveAttribute(
    "aria-disabled",
    "true",
  );

  await page.getByRole("combobox", { name: "Signed-in role" }).selectOption("speaker");
  await expect(page.getByRole("heading", { level: 1, name: "Speaker portal" })).toBeVisible();
  await page.goto(PORTAL);
  const calendar = page.getByRole("link", { name: "Download calendar (.ics)" });
  await expect(calendar).toBeVisible();
  const started = page.waitForEvent("download");
  await calendar.click();
  const download = await started;
  expect(download.suggestedFilename()).toBe("greenroom-sessions.ics");

  // Read the bytes the speaker's calendar app would actually import, not just the filename.
  const ics = await text(await download.createReadStream());
  expect(ics).toContain("BEGIN:VCALENDAR");
  expect(ics).toContain("SUMMARY:Designing the calm conference");
  // The seeded session runs 2026-09-15T17:00:00Z; RFC 5545 writes that as a UTC DATE-TIME.
  expect(ics).toContain("DTSTART:20260915T170000Z");
  // RFC 5545 section 3.6.1 makes DTSTAMP mandatory in a VEVENT, and Outlook rejects it without one.
  expect(ics).toMatch(/\r\nDTSTAMP:\d{8}T\d{6}Z\r\n/);

  // Hand the checklist back so the demo still shows a speaker with outstanding work.
  await page.getByRole("combobox", { name: "Signed-in role" }).selectOption("organizer");
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await restoreOnboardingChecklist(page);
});

test("reviewers cannot call the private content workspace", async ({ request }) => {
  const session = await request.post("/api/demo-session", { data: { persona: "reviewer" } });
  expect(session.ok()).toBeTruthy();
  const response = await request.get(`/api/events/${EVENT_ID}/content`);
  expect(response.status()).toBe(403);
});
